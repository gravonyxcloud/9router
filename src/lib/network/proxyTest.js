import { ProxyAgent, fetch as undiciFetch } from "undici";
import { isSocksProxyUrl, isStrictTls, socksFetch } from "./socksFetch.js";

export const RELAY_POOL_TYPES = ["vercel", "cloudflare", "deno", "netlify"];

export function isRelayPoolType(type) {
  return RELAY_POOL_TYPES.includes(String(type || "").toLowerCase());
}

/** Probe for relay-type pools (URL rewriting transport, not a real proxy). */
export async function testRelayUrl(relayUrl, timeoutMs = 10000) {
  const controller = new AbortController();
  const startedAt = Date.now();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await undiciFetch(relayUrl, {
      method: "GET",
      headers: {
        "x-relay-target": "https://httpbin.org",
        "x-relay-path": "/get",
      },
      signal: controller.signal,
    });
    return {
      ok: res.ok,
      status: res.status,
      statusText: res.statusText,
      elapsedMs: Date.now() - startedAt,
    };
  } catch (err) {
    return {
      ok: false,
      status: 500,
      error: err?.name === "AbortError" ? "Relay test timed out" : (err?.message || String(err)),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Full pool probe: relay transport or real proxy (HTTP/SOCKS). */
export async function testProxyPool(pool, { timeoutMs = 8000 } = {}) {
  if (!pool || !pool.proxyUrl) {
    return { ok: false, status: 400, error: "proxyUrl is required" };
  }
  if (isRelayPoolType(pool.type)) {
    return testRelayUrl(pool.proxyUrl, Math.min(timeoutMs, 10000));
  }
  return testProxyUrl({ proxyUrl: pool.proxyUrl, timeoutMs });
}

const OPENCODE_PROBE_URL = "https://opencode.ai/zen/v1/models";
const OPENCODE_PROBE_HEADERS = {
  "User-Agent": "opencode/1.19.0 ai-sdk/provider-utils/4.0.40 runtime/bun/1.3.14",
  "x-opencode-client": "cli",
  Authorization: "Bearer public",
  Accept: "application/json",
};

/**
 * Hard timeout race for SOCKS probes. The agent's internal connect ignores
 * req.destroy/socket timeouts (OS TCP timeout ~21s wins), so without this a
 * dead proxy burns the full OS timeout instead of the probe budget. The
 * orphaned attempt settles on its own; we just stop waiting for it.
 */
async function withHardTimeout(promise, ms, message) {
  let timer = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Second-stage probe: can this proxy actually reach OpenCode (not just the
 * open internet)? A proxy may pass a generic HEAD-to-Google check while its
 * IP is burned at the upstream (429/403) — useless for 9Router traffic.
 * Returns { ok, status, gated } where gated=true means the proxy connects
 * but upstream refuses this egress IP (rate limit / gate).
 */
export async function testProxyOpencodeTarget(proxyUrl, { timeoutMs = 8000 } = {}) {
  const normalized = normalizeString(proxyUrl);
  if (!normalized) {
    return { ok: false, gated: false, status: 400, error: "proxyUrl is required" };
  }
  const timeoutRaw = Number(timeoutMs);
  const budget = Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? Math.min(timeoutRaw, 30000) : 8000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), budget);
  const startedAt = Date.now();
  let dispatcher = null;
  if (!isSocksProxyUrl(normalized)) {
    try {
      dispatcher = new ProxyAgent({ uri: normalized });
    } catch (err) {
      clearTimeout(timer);
      return { ok: false, gated: false, status: 400, error: `Invalid proxy URL: ${err?.message || String(err)}` };
    }
  }
  const strictTls = isStrictTls();
  const attempt = async (insecure) => {
    const init = { method: "GET", headers: { ...OPENCODE_PROBE_HEADERS }, signal: controller.signal };
    let res;
    if (isSocksProxyUrl(normalized)) {
      res = await withHardTimeout(
        socksFetch(OPENCODE_PROBE_URL, init, normalized, { timeoutMs: budget, socketTimeoutMs: budget, insecure }),
        budget,
        "OpenCode probe timed out",
      );
    } else {
      const dispatch = insecure
        ? new ProxyAgent({ uri: normalized, requestTls: { rejectUnauthorized: false } })
        : dispatcher;
      try {
        res = await undiciFetch(OPENCODE_PROBE_URL, { ...init, dispatcher: dispatch });
      } finally {
        if (dispatch !== dispatcher) {
          try { await dispatch.close?.(); } catch { /* ignore */ }
        }
      }
    }
    return res;
  };
  try {
    // Insecure-first by default (probes the proxy, not the target's PKI);
    // strict-only when the operator pinned STRICT_SSL (fail closed).
    const res = !strictTls ? await attempt(true) : await attempt(false);
    // Drain a bounded prefix so keep-alive sockets don't pile up; the verdict
    // comes from the status code (catalog body is irrelevant here).
    try {
      if (res.body && typeof res.body.getReader === "function") {
        const reader = res.body.getReader();
        await reader.read();
        try { await reader.cancel(); } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
    if (res.status === 429 || res.status === 403) {
      return { ok: false, gated: true, status: res.status, error: `OpenCode gated this egress IP (HTTP ${res.status})` };
    }
    if (!res.ok) {
      return { ok: false, gated: false, status: res.status, error: `OpenCode probe HTTP ${res.status}` };
    }
    return { ok: true, gated: false, status: res.status, elapsedMs: Date.now() - startedAt };
  } catch (err) {
    const message = err?.name === "AbortError" ? "OpenCode probe timed out" : getErrorMessage(err);
    return { ok: false, gated: false, status: 500, error: message || "OpenCode probe failed" };
  } finally {
    clearTimeout(timer);
    try {
      await dispatcher?.close?.();
    } catch {
      // ignore
    }
  }
}

const DEFAULT_TEST_URL = "http://www.google.com/generate_204";
const DEFAULT_TIMEOUT_MS = 8000;

function getErrorMessage(err) {  if (!err) return "Unknown error";
  const base = err?.message || String(err);
  const causeCode = err?.cause?.code || err?.code;
  const causeMessage = err?.cause?.message;

  if (causeMessage && causeMessage !== base) {
    return causeCode ? `${base}: ${causeMessage} (${causeCode})` : `${base}: ${causeMessage}`;
  }

  if (causeCode && !base.includes(causeCode)) {
    return `${base} (${causeCode})`;
  }

  return base;
}

function normalizeString(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

export async function testProxyUrl({ proxyUrl, testUrl, timeoutMs } = {}) {
  const normalizedProxyUrl = normalizeString(proxyUrl);
  if (!normalizedProxyUrl) {
    return { ok: false, status: 400, error: "proxyUrl is required" };
  }

  const normalizedTestUrl = normalizeString(testUrl) || DEFAULT_TEST_URL;
  const timeoutMsRaw = Number(timeoutMs);
  const normalizedTimeoutMs =
    Number.isFinite(timeoutMsRaw) && timeoutMsRaw > 0
      ? Math.min(timeoutMsRaw, 30000)
      : DEFAULT_TIMEOUT_MS;

  let dispatcher;

  // SOCKS4/SOCKS5 go through socks-proxy-agent (undici ProxyAgent only
  // speaks HTTP CONNECT). This genuinely exercises the SOCKS handshake —
  // a proxy that only claims the type but refuses the protocol fails here.
  if (isSocksProxyUrl(normalizedProxyUrl)) {
    const controller = new AbortController();
    const startedAt = Date.now();
    const timer = setTimeout(() => controller.abort(), normalizedTimeoutMs);
    const attempt = (insecure) => withHardTimeout(socksFetch(
      normalizedTestUrl,
      {
        method: "GET",
        signal: controller.signal,
        headers: { "User-Agent": "9Router" },
      },
      normalizedProxyUrl,
      { timeoutMs: normalizedTimeoutMs, socketTimeoutMs: normalizedTimeoutMs, insecure },
    ), normalizedTimeoutMs, "Proxy test timed out");
    try {
      // Insecure-first by default (probes the proxy, not the target's PKI);
      // strict-only when the operator pinned STRICT_SSL (fail closed).
      const res = await attempt(!isStrictTls());
      return {
        ok: res.ok,
        status: res.status,
        statusText: "",
        url: normalizedTestUrl,
        elapsedMs: Date.now() - startedAt,
      };
    } catch (err) {
      const detail = err?.name === "AbortError" || /abort/i.test(err?.message || "")
        ? "Proxy test timed out"
        : getErrorMessage(err);
      return { ok: false, status: 500, error: detail || "Proxy test failed" };
    } finally {
      clearTimeout(timer);
    }
  }

  try {
    try {
      dispatcher = new ProxyAgent({ uri: normalizedProxyUrl });
    } catch (err) {
      return {
        ok: false,
        status: 400,
        error: `Invalid proxy URL: ${err?.message || String(err)}`,
      };
    }

    const controller = new AbortController();
    const startedAt = Date.now();
    const timer = setTimeout(() => controller.abort(), normalizedTimeoutMs);

    try {
      const res = await undiciFetch(normalizedTestUrl, {
        method: "GET",
        dispatcher,
        signal: controller.signal,
        headers: {
          "User-Agent": "9Router",
        },
      });

      return {
        ok: res.ok,
        status: res.status,
        statusText: res.statusText,
        url: normalizedTestUrl,
        elapsedMs: Date.now() - startedAt,
      };
    } catch (err) {
      const message =
        err?.name === "AbortError"
          ? "Proxy test timed out"
          : getErrorMessage(err);
      return { ok: false, status: 500, error: message };
    } finally {
      clearTimeout(timer);
    }
  } finally {
    try {
      await dispatcher?.close?.();
    } catch {
      // ignore
    }
  }
}
