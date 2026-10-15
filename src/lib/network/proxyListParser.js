/**
 * Parser for plain-text proxy lists (one proxy per line), e.g. ProxyScrape.
 *
 * Accepted line formats:
 *   scheme://[user[:pass]@]host:port   (http, https, socks4, socks4a, socks5, socks5h)
 *   [user:pass@]host:port
 *   host:port:user:pass
 *   user:pass:host:port
 *   host:port:comment   (e.g. hideip.me appends the country: 1.2.3.4:8080:Brazil)
 *   host:port
 * Blank lines and # or // comments are ignored.
 */

export const LIST_PROTOCOLS = ["http", "socks4", "socks5"];

function canonicalScheme(scheme) {
  const s = String(scheme || "").toLowerCase();
  if (s === "http" || s === "https") return "http";
  if (s === "socks4" || s === "socks4a") return "socks4";
  if (s === "socks5" || s === "socks5h") return "socks5";
  return null;
}

export function normalizeListProtocol(protocol) {
  const p = String(protocol || "auto").toLowerCase();
  if (p === "auto") return "auto";
  return LIST_PROTOCOLS.includes(p) ? p : null;
}

const IPV4_RE = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
const HOSTNAME_RE = /^(?=.{1,253}$)(?!-)[A-Za-z0-9-]{1,63}(?<!-)(\.(?!-)[A-Za-z0-9-]{1,63}(?<!-))*$/;

function validHost(host) {
  if (!host || host.length > 253) return false;
  // A dotted numeric quad must be a valid IPv4 address, not a hostname.
  if (/^\d+(\.\d+){3}$/.test(host)) return IPV4_RE.test(host);
  return IPV4_RE.test(host) || HOSTNAME_RE.test(host);
}

function ipv4Parts(host) {
  const m = String(host || "").match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
}

// Public lists must not import non-routable targets (e.g. the 0.0.0.0:80
// filler line some lists carry). Hostnames always pass; manual pools with
// local addresses are unaffected (different code path).
function routableHost(host) {
  const parts = ipv4Parts(host);
  if (!parts) return true;
  const [a, b] = parts;
  if (a === 0) return false; // 0.0.0.0/8 (unspecified)
  if (a === 127) return false; // loopback
  if (a === 10) return false; // RFC1918
  if (a === 172 && b >= 16 && b <= 31) return false; // RFC1918
  if (a === 192 && b === 168) return false; // RFC1918
  return true;
}

function validPort(port) {
  const n = Number(port);
  return Number.isInteger(n) && n >= 1 && n <= 65535;
}

function buildEntry(protocol, host, port, username, password) {
  if (!routableHost(host)) return null;
  const auth = username
    ? `${encodeURIComponent(username)}${password ? `:${encodeURIComponent(password)}` : ""}@`
    : "";
  return {
    protocol,
    host: host.toLowerCase(),
    port: Number(port),
    username: username || "",
    password: password || "",
    proxyUrl: `${protocol}://${auth}${host.toLowerCase()}:${Number(port)}`,
  };
}

function parseSchemeLine(line, defaultProtocol) {
  let parsed;
  try {
    parsed = new URL(line);
  } catch {
    return null;
  }
  const protocol = canonicalScheme(parsed.protocol.replace(/:$/, ""));
  if (!protocol) return null;
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  if (!validHost(host) || !validPort(parsed.port)) return null;
  let username = "";
  let password = "";
  try {
    username = parsed.username ? decodeURIComponent(parsed.username) : "";
    password = parsed.password ? decodeURIComponent(parsed.password) : "";
  } catch {
    username = parsed.username || "";
    password = parsed.password || "";
  }
  return buildEntry(protocol, host, parsed.port, username, password);
}

function parseBareLine(line, defaultProtocol) {
  const fallbackProtocol = defaultProtocol === "auto" ? "http" : defaultProtocol;
  // user:pass@host:port
  const atIdx = line.lastIndexOf("@");
  if (atIdx > 0) {
    const creds = line.slice(0, atIdx);
    const hostPort = line.slice(atIdx + 1);
    const colonIdx = creds.indexOf(":");
    const username = colonIdx >= 0 ? creds.slice(0, colonIdx) : creds;
    const password = colonIdx >= 0 ? creds.slice(colonIdx + 1) : "";
    const hp = hostPort.split(":");
    if (hp.length === 2 && validHost(hp[0]) && validPort(hp[1])) {
      return buildEntry(fallbackProtocol, hp[0], hp[1], username, password);
    }
    return null;
  }
  const parts = line.split(":");
  if (parts.length === 2 && validHost(parts[0]) && validPort(parts[1])) {
    return buildEntry(fallbackProtocol, parts[0], parts[1], "", "");
  }
  if (parts.length === 3 && validHost(parts[0]) && validPort(parts[1]) && parts[2].length > 0) {
    // host:port:comment — trailing label (country, anonymity, ...) is ignored.
    return buildEntry(fallbackProtocol, parts[0], parts[1], "", "");
  }
  if (parts.length === 4) {
    // host:port:user:pass
    if (validHost(parts[0]) && validPort(parts[1])) {
      return buildEntry(fallbackProtocol, parts[0], parts[1], parts[2], parts[3]);
    }
    // user:pass:host:port
    if (validHost(parts[2]) && validPort(parts[3])) {
      return buildEntry(fallbackProtocol, parts[2], parts[3], parts[0], parts[1]);
    }
  }
  return null;
}

export function parseProxyLine(line, defaultProtocol = "http") {
  if (typeof line !== "string") return null;
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("//")) return null;
  const fallback = normalizeListProtocol(defaultProtocol) || "http";
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) {
    return parseSchemeLine(trimmed, fallback);
  }
  return parseBareLine(trimmed, fallback);
}

export function parseProxyList(text, defaultProtocol = "http") {
  const entries = [];
  const seen = new Set();
  let skipped = 0;
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const entry = parseProxyLine(rawLine, defaultProtocol);
    if (!entry) {
      if (rawLine.trim() && !rawLine.trim().startsWith("#") && !rawLine.trim().startsWith("//")) skipped += 1;
      continue;
    }
    const key = proxyIdentityKey(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push(entry);
  }
  return { entries, skipped };
}

/** Stable identity for dedupe: protocol://host:port (lowercased). */
export function proxyIdentityKey({ protocol, host, port }) {
  return `${String(protocol || "http").toLowerCase()}://${String(host || "").toLowerCase()}:${Number(port)}`;
}

/**
 * Parse JSON proxy catalogs (GeoNode shape): { data: [{ ip, port,
 * protocols: ["http"|"socks4"|"socks5", ...] }] } — a root array works too.
 * Entries without a recognizable protocol fall back to defaultProtocol.
 * Throws when the JSON has no recognizable proxy array.
 */
export function parseProxyListJson(text, defaultProtocol = "http") {
  const fallback = normalizeListProtocol(defaultProtocol) || "http";
  let parsed;
  try {
    parsed = JSON.parse(String(text || ""));
  } catch {
    throw new Error("URL did not return a recognizable proxy list (invalid JSON)");
  }
  const items = Array.isArray(parsed) ? parsed : parsed?.data;
  if (!Array.isArray(items)) {
    throw new Error("URL did not return a recognizable proxy list (no data array)");
  }
  const entries = [];
  const seen = new Set();
  let skipped = 0;
  for (const item of items) {
    if (!item || typeof item !== "object") { skipped += 1; continue; }
    const host = String(item.ip || item.host || item.hostname || "").trim();
    const port = item.port;
    if (!validHost(host) || !routableHost(host) || !validPort(port)) { skipped += 1; continue; }
    const declared = Array.isArray(item.protocols) ? item.protocols : [];
    let protocol = null;
    for (const raw of declared) {
      protocol = canonicalScheme(raw);
      if (protocol) break;
    }
    if (!protocol) protocol = fallback === "auto" ? "http" : fallback;
    const entry = buildEntry(
      protocol,
      host,
      port,
      item.username ? String(item.username) : "",
      item.password ? String(item.password) : "",
    );
    if (!entry) { skipped += 1; continue; }
    const key = proxyIdentityKey(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push(entry);
  }
  if (entries.length === 0) {
    throw new Error("URL did not return a recognizable proxy list (no usable entries)");
  }
  return { entries, skipped };
}

/** Parse a fetched list body: JSON catalogs or plain text (auto-detected). */
export function parseListBody(text, defaultProtocol = "http") {
  if (/^\s*[{[]/.test(String(text || ""))) {
    return parseProxyListJson(text, defaultProtocol);
  }
  return parseProxyList(text, defaultProtocol);
}

/** Identity of an already-registered pool (parsed from its proxyUrl). */
export function poolProxyIdentity(pool) {
  if (!pool || typeof pool.proxyUrl !== "string" || !pool.proxyUrl.trim()) return null;
  const trimmed = pool.proxyUrl.trim();
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) {
    const entry = parseSchemeLine(trimmed, "http");
    return entry ? proxyIdentityKey(entry) : `raw:${trimmed.toLowerCase()}`;
  }
  const entry = parseBareLine(trimmed, "http");
  return entry ? proxyIdentityKey(entry) : `raw:${trimmed.toLowerCase()}`;
}

/**
 * Detect a "random proxy API" payload: a single JSON object (not a catalog
 * array) carrying one working proxy, e.g.
 *   {"proxy":"1.2.3.4:8080","http":"http://1.2.3.4:8080","latency":1444,"lastOk":"..."}
 * Returns the parsed object, or null for list bodies / anything else.
 */
export function detectRandomApiPayload(text) {
  let parsed;
  try {
    parsed = JSON.parse(String(text || ""));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const hint = parsed.proxy ?? parsed.http ?? parsed.proxyUrl ?? parsed.url;
  if (typeof hint !== "string" || !hint.trim()) return null;
  return parsed;
}

/**
 * Build a pool entry from a random-API payload. The measured `latency` seeds
 * latencyMs/opencodeLatencyMs so fastest-first routing works immediately;
 * `lastOk` seeds opencodeCheckedAt. Returns null when unparseable.
 */
export function randomApiEntry(payload, defaultProtocol = "http") {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const fallback = normalizeListProtocol(defaultProtocol) || "http";
  const raw = String(payload.http || payload.proxyUrl || payload.url || payload.proxy || "").trim();
  if (!raw) return null;
  let entry = null;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw)) {
    entry = parseSchemeLine(raw, fallback);
  } else {
    entry = parseBareLine(raw, fallback);
  }
  if (!entry) return null;
  const latency = Number(payload.latency ?? payload.latencyMs ?? payload.ms);
  if (Number.isFinite(latency) && latency >= 0) {
    entry.latencyMs = Math.round(latency);
    entry.opencodeLatencyMs = Math.round(latency);
  }
  const checkedAt = payload.lastOk || payload.checkedAt || payload.lastChecked;
  if (checkedAt && !Number.isNaN(new Date(checkedAt).getTime())) {
    entry.opencodeCheckedAt = new Date(checkedAt).toISOString();
  }
  return entry;
}
