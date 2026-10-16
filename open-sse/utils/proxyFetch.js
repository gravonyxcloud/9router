import { Readable } from "stream";
import { MEMORY_CONFIG } from "../config/runtimeConfig.js";
import { dbg } from "./debugLog.js";
import { isSocksProxyUrl, isStrictTls } from "../../src/lib/network/socksFetch.js";
import { PROXY_FAILOVER_MAX_ATTEMPTS, noteProxyPoolResult, isCoolingDown } from "../../src/lib/network/proxyHealth.js";

/**
 * Snapshot a 429 body for later surfacing: read the (small) error text now
 * while the socket is fresh, keeping retry-after for downstream handling.
 */
async function snapshot429(response) {
  let text = "";
  try {
    text = await response.text();
  } catch { /* ignore */ }
  let retryAfter = null;
  try {
    retryAfter = response.headers?.get?.("retry-after") || null;
  } catch { /* ignore */ }
  return { status: response.status || 429, retryAfter, text };
}

const originalFetch = globalThis.fetch;
const proxyDispatchers = new Map();

// Direct egress also races (not only as last resort): the direct IP is
// often the fastest path, and when it is burned its cooldown skips it.
// Env PROXY_DIRECT_RACE=0 disables. Strict mode never races direct.
function directRaceEnabled() {
  const raw = process.env.PROXY_DIRECT_RACE;
  if (raw == null || raw === "") return true;
  const v = String(raw).trim().toLowerCase();
  return !(v === "0" || v === "false" || v === "no" || v === "off");
}

// Cooldown bucket for the direct egress (shared across scopes — one IP).
export const DIRECT_EGRESS_ID = "direct";

// Parallel race size: how many egresses to try at once per wave (direct +
// proxies). More parallelism finds the working egress faster; each extra
// attempt is one more concurrent upstream call. Env: PROXY_RACE_SIZE.
function proxyRaceSize() {
  const raw = Number(process.env.PROXY_RACE_SIZE);
  if (!Number.isFinite(raw) || raw < 1) return 5;
  return Math.min(10, Math.floor(raw));
}

// ─── TLS fingerprinting via got-scraping (browser-like JA3) ───────────────
// Disabled: not in use. Kept commented for future re-enable.
// Restore the original block to re-enable per-host JA3 spoofing.
/*
let _gotScraping = null;
let _gotScrapingChecked = false;
const _gotScrapingLoggedHosts = new Set();

async function getGotScraping() {
  if (_gotScrapingChecked) return _gotScraping;
  _gotScrapingChecked = true;
  try {
    const mod = await import("got-scraping");
    _gotScraping = typeof mod.gotScraping === "function" ? mod.gotScraping : null;
    if (_gotScraping) dbg("TLS", "got-scraping loaded (browser-like JA3 enabled)");
  } catch (e) {
    console.warn(`[ProxyFetch] got-scraping unavailable, falling back to native fetch: ${e.message}`);
    _gotScraping = null;
  }
  return _gotScraping;
}

async function gotScrapingFetch(url, options) {
  const gs = await getGotScraping();
  if (!gs) return null;

  const method = (options.method || "GET").toUpperCase();
  const headersInit = options.headers || {};
  const headers = headersInit instanceof Headers
    ? Object.fromEntries(headersInit.entries())
    : { ...headersInit };

  return new Promise((resolve, reject) => {
    let settled = false;
    const stream = gs.stream({
      url,
      method,
      headers,
      body: method === "GET" || method === "HEAD" ? undefined : options.body,
      throwHttpErrors: false,
      retry: { limit: 0 },
      timeout: { request: undefined },
      followRedirect: false,
      decompress: true,
    });

    if (options.signal) {
      const onAbort = () => { try { stream.destroy(new Error("aborted")); } catch { } };
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener("abort", onAbort, { once: true });
    }

    stream.once("response", (res) => {
      if (settled) return;
      settled = true;
      const resHeaders = new Headers();
      for (const [k, v] of Object.entries(res.headers || {})) {
        if (Array.isArray(v)) v.forEach((x) => resHeaders.append(k, String(x)));
        else if (v != null) resHeaders.set(k, String(v));
      }
      const body = Readable.toWeb(stream);
      resolve(new Response(body, { status: res.statusCode, statusText: res.statusMessage || "", headers: resHeaders }));
    });

    stream.once("error", (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

async function tryGotScrapingFetch(url, options) {
  try {
    const res = await gotScrapingFetch(url, options);
    if (res) {
      try {
        const host = new URL(typeof url === "string" ? url : url.toString()).hostname;
        if (!_gotScrapingLoggedHosts.has(host)) {
          _gotScrapingLoggedHosts.add(host);
          dbg("TLS", `using got-scraping for ${host}`);
        }
      } catch { }
    }
    return res;
  } catch (e) {
    console.warn(`[ProxyFetch] got-scraping request failed, fallback to native fetch: ${e.message}`);
    return null;
  }
}
*/

// DNS cache — use Map to avoid prototype pollution via malformed hostnames
const DNS_CACHE = new Map();
const TLS_CERT_ERRORS = new Set([
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "CERT_HAS_EXPIRED",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

function isTlsCertError(err) {
  const code = err?.cause?.code || err?.code;
  return TLS_CERT_ERRORS.has(code);
}
const MITM_BYPASS_HOSTS = [
  "cloudcode-pa.googleapis.com",
  "daily-cloudcode-pa.googleapis.com",
  "api.individual.githubcopilot.com",
  "q.us-east-1.amazonaws.com",
  "codewhisperer.us-east-1.amazonaws.com",
  "api2.cursor.sh",
];
const GOOGLE_DNS_SERVERS = ["8.8.8.8", "8.8.4.4"];
const HTTPS_PORT = 443;
const HTTP_SUCCESS_MIN = 200;
const HTTP_SUCCESS_MAX = 300;

function normalizeString(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

/**
 * Resolve real IP using Google DNS (bypass system DNS)
 */
async function resolveRealIP(hostname) {
  const cached = DNS_CACHE.get(hostname);
  if (cached && Date.now() < cached.expiry) return cached.ip;

  try {
    const dns = await import("dns");
    const { promisify } = await import("util");
    const resolver = new dns.Resolver();
    resolver.setServers(GOOGLE_DNS_SERVERS);
    const resolve4 = promisify(resolver.resolve4.bind(resolver));
    const addresses = await resolve4(hostname);
    DNS_CACHE.set(hostname, { ip: addresses[0], expiry: Date.now() + MEMORY_CONFIG.dnsCacheTtlMs });
    return addresses[0];
  } catch (error) {
    console.warn(`[ProxyFetch] DNS resolve failed for ${hostname}:`, error.message);
    return null;
  }
}

/**
 * Check if request should bypass MITM DNS redirect
 */
function shouldBypassMitmDns(url) {
  try {
    const hostname = new URL(url).hostname;
    return MITM_BYPASS_HOSTS.some(host => hostname.includes(host));
  } catch { return false; }
}

function shouldBypassByNoProxy(targetUrl, noProxyValue) {
  const noProxy = normalizeString(noProxyValue);
  if (!noProxy) return false;

  let hostname;
  try { hostname = new URL(targetUrl).hostname.toLowerCase(); } catch { return false; }
  const patterns = noProxy.split(",").map((p) => p.trim().toLowerCase()).filter(Boolean);

  return patterns.some((pattern) => {
    if (pattern === "*") return true;
    if (pattern.startsWith(".")) return hostname.endsWith(pattern) || hostname === pattern.slice(1);
    return hostname === pattern || hostname.endsWith(`.${pattern}`);
  });
}

/**
 * Get proxy URL from environment
 */
function getEnvProxyUrl(targetUrl) {
  const noProxy = process.env.NO_PROXY || process.env.no_proxy;
  if (shouldBypassByNoProxy(targetUrl, noProxy)) return null;

  let protocol;
  try { protocol = new URL(targetUrl).protocol; } catch { return null; }

  if (protocol === "https:") {
    return process.env.HTTPS_PROXY || process.env.https_proxy ||
      process.env.ALL_PROXY || process.env.all_proxy;
  }

  return process.env.HTTP_PROXY || process.env.http_proxy ||
    process.env.ALL_PROXY || process.env.all_proxy;
}

/**
 * Normalize proxy URL (allow host:port)
 */
function normalizeProxyUrl(proxyUrl) {
  const normalizedInput = normalizeString(proxyUrl);
  if (!normalizedInput) return null;

  try {

    new URL(normalizedInput);
    return normalizedInput;
  } catch {
    // Allow "127.0.0.1:7890" style values
    return `http://${normalizedInput}`;
  }
}

function resolveConnectionProxyUrl(targetUrl, proxyOptions) {
  const enabled = proxyOptions?.enabled === true || proxyOptions?.connectionProxyEnabled === true;
  if (!enabled) return null;

  const proxyUrlRaw = normalizeString(proxyOptions?.url ?? proxyOptions?.connectionProxyUrl);
  if (!proxyUrlRaw) return null;

  const noProxy = normalizeString(proxyOptions?.noProxy ?? proxyOptions?.connectionNoProxy);
  if (noProxy && shouldBypassByNoProxy(targetUrl, noProxy)) return null;

  return normalizeProxyUrl(proxyUrlRaw);
}

/**
 * Create proxy dispatcher lazily (undici-compatible)
 */
async function getDispatcher(proxyUrl, insecure = false) {
  const normalized = normalizeProxyUrl(proxyUrl);
  if (!normalized && !insecure) return null;

  const key = `${normalized || "direct"}::${insecure ? "insecure" : "secure"}`;
  if (!proxyDispatchers.has(key)) {
    // Evict oldest entry if max size reached
    if (proxyDispatchers.size >= MEMORY_CONFIG.proxyDispatchersMaxSize) {
      proxyDispatchers.delete(proxyDispatchers.keys().next().value);
    }
    const { Agent, ProxyAgent } = await import("undici");
    const connect = insecure ? { rejectUnauthorized: false } : undefined;
    const dispatcher = normalized
      ? new ProxyAgent({ uri: normalized, ...(insecure ? { requestTls: connect } : {}) })
      : new Agent({ connect });
    proxyDispatchers.set(key, dispatcher);
  }

  return proxyDispatchers.get(key);
}

async function fetchWithTlsFallback(url, options, proxyUrl) {
  // SOCKS4/SOCKS5: undici dispatchers only speak HTTP CONNECT, so SOCKS
  // traffic goes through socks-proxy-agent with a streaming Response.
  // Mirrors the undici path below: retry without cert verification unless
  // the operator pinned strict TLS.
  if (proxyUrl && isSocksProxyUrl(proxyUrl)) {
    const { socksFetch } = await import("../../src/lib/network/socksFetch.js");
    // Insecure-first by default (public egresses fail strict verification
    // constantly); strict-only when the operator pinned STRICT_SSL.
    if (!isStrictTls()) {
      return await socksFetch(url, options, proxyUrl, { insecure: true });
    }
    return await socksFetch(url, options, proxyUrl);
  }
  // HTTP(S) proxies through undici: same insecure-first default.
  if (proxyUrl && !isStrictTls()) {
    const dispatcher = await getDispatcher(proxyUrl, true);
    return await originalFetch(url, { ...options, dispatcher });
  }
  try {
    const dispatcher = proxyUrl ? await getDispatcher(proxyUrl) : undefined;
    return await originalFetch(url, dispatcher ? { ...options, dispatcher } : options);
  } catch (err) {
    const isStrictSsl = process.env.STRICT_SSL === "true" || process.env.STRICT_SSL === "1";
    if (!isStrictSsl && isTlsCertError(err)) {
      if (options.body && typeof options.body.getReader === "function" && options.body.locked) {
        throw err;
      }
      // ponytail: in-memory insecure agent fallback for self-signed MITM corporate/antivirus certs
      console.warn(`[ProxyFetch] TLS cert verification failed (${err.cause?.code || err.code}), retrying with insecure TLS: ${url}`);
      const insecureDispatcher = await getDispatcher(proxyUrl, true);
      return await originalFetch(url, { ...options, dispatcher: insecureDispatcher });
    }
    throw err;
  }
}

/**
 * Create HTTPS request with manual socket connection (bypass DNS)
 */
async function createBypassRequest(parsedUrl, realIP, options) {
  const httpsModule = await import("https");
  const netModule = await import("net");
  // CJS modules expose exports via .default in ESM dynamic import context
  const https = httpsModule.default ?? httpsModule;
  const net = netModule.default ?? netModule;

  return new Promise((resolve, reject) => {
    const socket = new net.Socket();

    socket.connect(HTTPS_PORT, realIP, () => {
      const reqOptions = {
        socket,
        // SNI + cert hostname are validated against the hostname the caller
        // asked for, not the IP we connected to. This keeps the DNS-bypass
        // (avoiding /etc/hosts MITM) while still rejecting on-path attackers
        // that present a different cert. The MITM_BYPASS_HOSTS targets are
        // all public-CA-issued (Google / GitHub / AWS / Cursor) so default
        // verification works without any extra trust store.
        servername: parsedUrl.hostname,
        path: parsedUrl.pathname + parsedUrl.search,
        method: options.method || "POST",
        headers: {
          ...options.headers,
          Host: parsedUrl.hostname,
        },
      };

      const req = https.request(reqOptions, (res) => {
        const response = {
          ok: res.statusCode >= HTTP_SUCCESS_MIN && res.statusCode < HTTP_SUCCESS_MAX,
          status: res.statusCode,
          statusText: res.statusMessage,
          headers: new Map(Object.entries(res.headers)),
          body: Readable.toWeb(res),
          text: async () => {
            const chunks = [];
            for await (const chunk of res) chunks.push(chunk);
            return Buffer.concat(chunks).toString();
          },
          json: async () => JSON.parse(await response.text()),
        };
        resolve(response);
      });

      req.on("error", reject);
      if (options.body) {
        req.write(typeof options.body === "string" ? options.body : JSON.stringify(options.body));
      }
      req.end();
    });

    socket.on("error", reject);
  });
}

export async function proxyAwareFetch(url, options = {}, proxyOptions = null) {
  const targetUrl = typeof url === "string" ? url : url.toString();

  // Vercel relay: forward request via relay headers
  const vercelRelayUrl = normalizeString(proxyOptions?.vercelRelayUrl);
  if (vercelRelayUrl) {
    const parsed = new URL(targetUrl);
    const baseHeaders = options.headers instanceof Headers
      ? Object.fromEntries(options.headers.entries())
      : { ...(options.headers || {}) };
    const relayHeaders = {
      ...baseHeaders,
      "x-relay-target": `${parsed.protocol}//${parsed.host}`,
      "x-relay-path": `${parsed.pathname}${parsed.search}`,
    };
    return originalFetch(vercelRelayUrl, { ...options, headers: relayHeaders });
  }

  const connectionProxyUrl = resolveConnectionProxyUrl(targetUrl, proxyOptions);
  const envProxyUrl = connectionProxyUrl ? null : normalizeProxyUrl(getEnvProxyUrl(targetUrl));
  const proxyUrl = connectionProxyUrl || envProxyUrl;

  // MITM DNS bypass: for known MITM-intercepted hosts, resolve real IP to avoid DNS spoof
  if (shouldBypassMitmDns(targetUrl)) {
    if (proxyUrl) {
      // Proxy resolves DNS externally (not affected by /etc/hosts) — use proxy directly
      try {
        return await fetchWithTlsFallback(url, options, proxyUrl);
      } catch (proxyError) {
        if (proxyOptions?.strictProxy === true) {
          throw new Error(`[ProxyFetch] Proxy required but failed (strictProxy=true): ${proxyError.message}`);
        }
        console.warn(`[ProxyFetch] Proxy failed, falling back to direct bypass: ${proxyError.message}`);
      }
    }
    // No proxy — manually resolve real IP to bypass DNS spoof
    try {
      const parsedUrl = new URL(targetUrl);
      const realIP = await resolveRealIP(parsedUrl.hostname);
      if (realIP) return await createBypassRequest(parsedUrl, realIP, options);
    } catch (error) {
      console.warn(`[ProxyFetch] MITM bypass failed: ${error.message}`);
    }
  }

  if (proxyUrl) {
    // Smart rotation with parallel waves: race a few proxies at once and
    // take the first working egress instead of waiting out every dead one
    // in sequence. 429s never win a race (burned IP) — they cool down while
    // the wave waits for the rest. Outcomes still pin stickiness, so traffic
    // converges on working proxies. Direct fallback only when every proxy
    // failed or rate-limited (rare).
    const scope = normalizeString(proxyOptions?.proxyScope);
    const attempts = [{ proxyPoolId: proxyOptions?.proxyPoolId || null, url: proxyUrl, strict: proxyOptions?.strictProxy === true }];
    const seenUrls = new Set([proxyUrl]);
    const failovers = Array.isArray(proxyOptions?.proxyFailovers) ? proxyOptions.proxyFailovers : [];
    for (const f of failovers) {
      if (attempts.length >= PROXY_FAILOVER_MAX_ATTEMPTS) break;
      const fUrl = normalizeString(f?.connectionProxyUrl);
      if (!fUrl || seenUrls.has(fUrl)) continue;
      seenUrls.add(fUrl);
      attempts.push({ proxyPoolId: f.proxyPoolId || null, url: fUrl, strict: f.strictProxy === true });
    }
    const raceSize = proxyRaceSize();
    let strictAny = false;
    let lastError = null;
    let first429 = null;
    let directTried = false;
    // Direct egress races in the first wave (usually the fastest path when
    // clean). Skipped for strict (never leave via direct), while cooling
    // down from a recent 429/failure, or in legacy sequential mode.
    if (
      raceSize > 1 &&
      directRaceEnabled() &&
      proxyOptions?.strictProxy !== true &&
      !isCoolingDown(DIRECT_EGRESS_ID)
    ) {
      attempts.unshift({ proxyPoolId: null, url: null, strict: false, direct: true });
    }
    for (let waveStart = 0; waveStart < attempts.length; waveStart += raceSize) {
      if (options.signal?.aborted) {
        throw options.signal.reason || new Error("aborted");
      }
      const wave = attempts.slice(waveStart, waveStart + raceSize);
      const controllers = wave.map(() => new AbortController());
      const onParentAbort = () => {
        for (const c of controllers) {
          try { c.abort(); } catch { /* ignore */ }
        }
      };
      const parentSignal = options.signal;
      if (parentSignal) {
        if (parentSignal.aborted) onParentAbort();
        else parentSignal.addEventListener("abort", onParentAbort, { once: true });
      }
      const pending = new Map();
      wave.forEach((attempt, k) => {
        const task = (async () => {
          const attemptStartedAt = Date.now();
          try {
            const response = await fetchWithTlsFallback(url, { ...options, signal: controllers[k].signal }, attempt.url);
            return { k, response, elapsedMs: Date.now() - attemptStartedAt };
          } catch (error) {
            return { k, error, elapsedMs: Date.now() - attemptStartedAt };
          }
        })();
        pending.set(k, task);
      });
      let winner = null;
      try {
        while (pending.size > 0) {
          const settled = await Promise.race([...pending.values()]);
          pending.delete(settled.k);
          const attempt = wave[settled.k];
          if (settled.response) {
            const response = settled.response;
            const egressId = attempt.proxyPoolId || (attempt.direct ? DIRECT_EGRESS_ID : null);
            const egressLabel = attempt.direct ? "direct" : `pool ${attempt.proxyPoolId || "unknown"}`;
            if (attempt.direct) directTried = true;
            // 429 = this egress IP is burned (rate limited), not a transport
            // failure: cool it down and keep waiting for the rest of the wave
            // instead of pinning it sticky and surfacing the 429.
            if (response.status === 429) {
              strictAny = strictAny || attempt.strict;
              lastError = new Error(`HTTP 429 rate limited via ${egressLabel}`);
              noteProxyPoolResult(scope, egressId, false);
              if (!first429) first429 = await snapshot429(response);
              else {
                try {
                  if (response.body && typeof response.body.cancel === "function") await response.body.cancel();
                  else await response.text();
                } catch { /* drain best-effort so sockets don't pile up */ }
              }
              dbg("PROXY", `egress rate-limited (429) via ${egressLabel}, waiting wave`);
              continue;
            }
            winner = { response, attempt, elapsedMs: settled.elapsedMs };
            break;
          }
          strictAny = strictAny || attempt.strict;
          lastError = settled.error;
          if (attempt.direct) {
            directTried = true;
            noteProxyPoolResult(scope, DIRECT_EGRESS_ID, false);
            dbg("PROXY", `direct egress failed, waiting wave: ${settled.error?.message || settled.error}`);
          } else {
            noteProxyPoolResult(scope, attempt.proxyPoolId, false);
          }
        }
      } finally {
        try { parentSignal?.removeEventListener?.("abort", onParentAbort); } catch { /* ignore */ }
      }
      if (winner) {
        for (let k = 0; k < controllers.length; k++) {
          if (wave[k] === winner.attempt) continue;
          try { controllers[k].abort(); } catch { /* ignore */ }
        }
        if (winner.attempt.direct) {
          noteProxyPoolResult(scope, DIRECT_EGRESS_ID, true, winner.elapsedMs);
          dbg("PROXY", `race won by direct egress in ${winner.elapsedMs}ms`);
        } else {
          noteProxyPoolResult(scope, winner.attempt.proxyPoolId, true, winner.elapsedMs);
        }
        if (waveStart > 0 || wave.indexOf(winner.attempt) > 0) {
          dbg("PROXY", `race won by pool ${winner.attempt.proxyPoolId || "unknown"} in ${winner.elapsedMs}ms`);
        }
        return winner.response;
      }
      // Wave exhausted with no usable response — next wave (if any).
    }
    // No wave produced a usable response: surface the first 429 (rebuilt —
    // the original body was consumed racing the wave) for downstream
    // account/combo fallback, else fail into direct/strict handling below.
    if (first429) {
      const headers = { "Content-Type": "application/json" };
      if (first429.retryAfter) headers["retry-after"] = first429.retryAfter;
      return new Response(first429.text, { status: 429, headers });
    }
    const finalMessage = lastError?.message || String(lastError || "all proxies failed");
    // If strictProxy is enabled, fail hard instead of falling back to direct
    if (strictAny || proxyOptions?.strictProxy === true) {
      throw new Error(`[ProxyFetch] Proxy required but failed (strictProxy=true): ${finalMessage}`);
    }
    // Direct already raced (and lost/failed) — retrying it verbatim adds
    // nothing; surface the failure so account/combo fallback can proceed.
    if (directTried) {
      throw new Error(`[ProxyFetch] All egresses failed (direct + proxies): ${finalMessage}`);
    }
    if (attempts.length === 1) {
      console.warn(`[ProxyFetch] Proxy failed, falling back to direct: ${finalMessage}`);
    } else {
      console.warn(`[ProxyFetch] All ${attempts.length} proxies failed, falling back to direct: ${finalMessage}`);
    }
    return fetchWithTlsFallback(url, options, null);
  }

  // Strict mode means "never leave over the direct IP". Reaching here with a
  // proxy configured but unresolved is exactly that case — an inactive or
  // empty pool, or every proxy removed — so refuse instead of silently
  // exposing the real address (#4333). The catch blocks above only cover a
  // proxy that was actually tried.
  //
  // Gate on a proxy being *intended*: callers like the Qoder executor set
  // strictProxy to mean "do not replay this request directly if the proxy
  // fails" (a replayed COSY signature returns 403), not "a proxy is required".
  // With nothing configured they must keep working.
  const proxyIntended = proxyOptions?.proxyPoolId
    || proxyOptions?.enabled === true
    || proxyOptions?.connectionProxyEnabled === true
    || !!normalizeString(proxyOptions?.url ?? proxyOptions?.connectionProxyUrl);
  if (proxyOptions?.strictProxy === true && proxyIntended) {
    throw new Error("[ProxyFetch] Proxy required but none resolved (strictProxy=true)");
  }

  // got-scraping disabled — use native fetch directly
  // (Re-enable per-host by wrapping with tryGotScrapingFetch when needed)
  return fetchWithTlsFallback(url, options, null);
}

/**
 * Patched global fetch with env-proxy support and MITM DNS bypass
 */
async function patchedFetch(url, options = {}) {
  return proxyAwareFetch(url, options, null);
}

// Idempotency guard — only patch once to avoid wrapping multiple times
if (globalThis.fetch !== patchedFetch) {
  globalThis.fetch = patchedFetch;
}

export default patchedFetch;
