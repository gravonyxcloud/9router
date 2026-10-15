/**
 * Shared fetch-compatible wrapper over socks-proxy-agent.
 * undici's ProxyAgent has no SOCKS support, so SOCKS4/SOCKS5 traffic goes
 * through node:http/https with a SocksProxyAgent and a web-stream body —
 * the returned value is a native Response (ok/status/headers/body stream).
 */
const SOCKS_SCHEME_RE = /^socks[45][ah]?$/i;

// Dynamic import with CJS/ESM interop fallback (same pattern as mimoLoginSession).
let socksAgentPromise = null;
function loadSocksProxyAgent() {
  if (!socksAgentPromise) {
    socksAgentPromise = import("socks-proxy-agent")
      .then((m) => m.SocksProxyAgent || m.default?.SocksProxyAgent || m.default || null)
      .catch(() => null);
  }
  return socksAgentPromise;
}

export function isSocksProxyUrl(proxyUrl) {
  if (typeof proxyUrl !== "string") return false;
  const trimmed = proxyUrl.trim();
  if (!trimmed) return false;
  try {
    return SOCKS_SCHEME_RE.test(new URL(trimmed).protocol.replace(/:$/, ""));
  } catch {
    return false;
  }
}

export function socksProxyScheme(proxyUrl) {
  try {
    const scheme = new URL(String(proxyUrl).trim()).protocol.replace(/:$/, "").toLowerCase();
    if (scheme === "socks4" || scheme === "socks4a") return "socks4";
    if (scheme === "socks5" || scheme === "socks5h") return "socks5";
  } catch {
    // ignore
  }
  return null;
}

export const SOCKS_TLS_CERT_ERRORS = new Set([
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

export function isSocksTlsCertError(err) {
  const code = err?.cause?.code || err?.code;
  return SOCKS_TLS_CERT_ERRORS.has(code);
}

/**
 * Fail-closed TLS pinning, opt-in via env. Default (unset) accepts
 * insecure: public-pool egresses routinely present expired/self-signed
 * chain certs, so a strict-first attempt only wastes a handshake before the
 * (previously automatic) insecure retry. With STRICT_SSL=true, cert errors
 * throw instead of falling back.
 */
export function isStrictTls() {
  return process.env.STRICT_SSL === "true" || process.env.STRICT_SSL === "1";
}

// 101/204/205/304 must have a null body — `new Response(stream, {status})` throws.
const NULL_BODY_STATUS = new Set([101, 204, 205, 304]);

export async function socksFetch(url, init = {}, proxyUrl, { timeoutMs = 20000, insecure = false, socketTimeoutMs = null } = {}) {
  if (!proxyUrl) throw new Error("socks proxy URL is required");
  const SocksProxyAgent = await loadSocksProxyAgent();
  if (!SocksProxyAgent) throw new Error("socks-proxy-agent unavailable");
  const nodeUrl = new URL(String(url));
  // Literal specifiers — webpack forbids fully dynamic import().
  const protoMod = nodeUrl.protocol === "http:" ? await import("node:http") : await import("node:https");
  const lib = protoMod.default ?? protoMod;

  let headers = {};
  const raw = init?.headers;
  if (raw instanceof Headers) for (const [k, v] of raw) headers[k] = v;
  else if (raw) headers = { ...raw };

  let body = init?.body;
  if (body && typeof body !== "string" && !Buffer.isBuffer(body)) {
    if (body instanceof Uint8Array) body = Buffer.from(body);
    else if (typeof body.getReader === "function") {
      throw new Error("socks fetch does not support web-stream request bodies");
    } else body = Buffer.from(String(body));
  }
  if (body) headers["content-length"] = String(Buffer.byteLength(body));

  const agent = new SocksProxyAgent(proxyUrl);
  // NOTE: the agent must NOT be destroyed when headers arrive — the response
  // body streams through its sockets, and destroying it mid-stream aborts
  // live traffic (TLSSocket socketCloseListener "aborted"). Sockets close
  // with the response; the agent itself is GC'd. Likewise the node socket
  // timeout is only a backstop when the caller passed no AbortSignal,
  // otherwise slow streams (reasoning pauses) would be killed at 20s while
  // the rest of the stack allows minutes.
  const signal = init?.signal;
  const requestOptions = { method: init?.method || "GET", agent, headers };
  if (!signal) {
    requestOptions.timeout = timeoutMs;
  } else if (socketTimeoutMs != null && Number(socketTimeoutMs) > 0) {
    // Hard socket cap for probes: the AbortSignal path alone does not stop a
    // wedged SOCKS handshake (agent sockets outlive req.destroy), so dead
    // proxies would burn the OS TCP timeout (~21s) instead of the budget.
    // Streaming callers omit it and stay signal-driven (reasoning pauses).
    requestOptions.timeout = socketTimeoutMs;
  }
  if (insecure) requestOptions.rejectUnauthorized = false;
  return new Promise((resolve, reject) => {
    let req;
    try {
      req = lib.request(
        nodeUrl,
        requestOptions,
        (res) => {
          try {
            const outHeaders = new Headers();
            for (const [k, v] of Object.entries(res.headers || {})) {
              if (Array.isArray(v)) v.forEach((x) => outHeaders.append(k, String(x)));
              else if (v != null) outHeaders.set(k, String(v));
            }
            if (NULL_BODY_STATUS.has(res.statusCode)) {
              try { res.resume(); } catch { /* ignore */ }
              resolve(new Response(null, { status: res.statusCode, headers: outHeaders }));
              return;
            }
            // Manual web-stream bridge (no node:stream import: under the
            // Next server bundle that import can resolve without Readable).
            const stream = new ReadableStream({
              start(controller) {
                res.on("data", (chunk) => controller.enqueue(chunk));
                res.on("end", () => controller.close());
                res.on("error", (err) => controller.error(err));
              },
              cancel() {
                try { res.destroy(); } catch { /* ignore */ }
              },
            });
            resolve(new Response(stream, { status: res.statusCode || 200, headers: outHeaders }));
          } catch (err) {
            reject(err);
          }
        },
      );
    } catch (err) {
      reject(err);
      return;
    }
    if (signal) {
      if (signal.aborted) req.destroy(new Error("aborted"));
      else signal.addEventListener("abort", () => req.destroy(new Error("aborted")), { once: true });
    }
    req.on("timeout", () => req.destroy(new Error("socks fetch timeout")));
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}
