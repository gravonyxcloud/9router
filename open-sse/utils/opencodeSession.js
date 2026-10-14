/**
 * Shared OpenCode free-tier session helpers.
 *
 * The real OpenCode CLI mints `x-opencode-session` client-side as
 * `ses_` + 12 lowercase-hex chars derived from `~(Date.now() * 0x1000 + counter)`
 * + 14 random base62 chars (see `Identifier.ascending("session")` in the CLI).
 * Upstream's free-tier gate rejects anything else with 403 FreeTierError:
 * sha256-derived ("translated") ids and purely random ids have no valid
 * timestamp structure and always fail. Every free-tier executor must therefore
 * send either a forwarded genuine-client session or a freshly minted one —
 * never a hash-derived id.
 */
import crypto from "crypto";
import { MEMORY_CONFIG } from "../config/runtimeConfig.js";

export const OPENCODE_SESSION_RE = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;
const BASE62_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

let mintLastTimestamp = 0;
let mintCounter = 0;

/**
 * Mint a canonical client session id (matches the real CLI ascending scheme).
 */
export function mintOpencodeSessionId(timestamp = Date.now()) {
  if (timestamp !== mintLastTimestamp) {
    mintLastTimestamp = timestamp;
    mintCounter = 0;
  }
  mintCounter++;

  const current = BigInt(timestamp) * 0x1000n + BigInt(mintCounter);
  const value = ~current;
  const time = Array.from({ length: 6 }, (_, index) =>
    Number((value >> BigInt(40 - 8 * index)) & 0xffn)
      .toString(16)
      .padStart(2, "0")
  ).join("");
  const bytes = crypto.randomBytes(14);
  let randomPart = "";
  for (let i = 0; i < 14; i++) {
    randomPart += BASE62_CHARS[bytes[i] % 62];
  }
  return `ses_${time}${randomPart}`;
}

// sessionManager junk: `randomUUID() + Date.now()` — stable per connection but
// carries no conversation identity and must never seed an upstream session id.
const JUNK_SEED_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\d+$/;
export function isJunkSessionSeed(value) {
  return typeof value === "string" && JUNK_SEED_RE.test(value.trim());
}

function shaHex(text, length) {
  return crypto.createHash("sha256").update(text).digest("hex").slice(0, length);
}

// Stable upstream sessions: one minted id per key, evicted after TTL like the
// other session stores. Values are always freshly minted (valid timestamps).
const stableSessions = new Map();
const MAX_STABLE_SESSIONS = 1000;
const stableSessionCleanup = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of stableSessions) {
    if (now - entry.lastUsed > MEMORY_CONFIG.sessionTtlMs) {
      stableSessions.delete(key);
    }
  }
}, MEMORY_CONFIG.sessionCleanupIntervalMs);
if (stableSessionCleanup.unref) stableSessionCleanup.unref();

export function stableOpencodeSession(key) {
  const existing = stableSessions.get(key);
  if (existing) {
    existing.lastUsed = Date.now();
    stableSessions.delete(key);
    stableSessions.set(key, existing);
    return existing.sessionId;
  }
  const sessionId = mintOpencodeSessionId();
  if (stableSessions.size >= MAX_STABLE_SESSIONS) {
    stableSessions.delete(stableSessions.keys().next().value);
  }
  stableSessions.set(key, { sessionId, lastUsed: Date.now() });
  return sessionId;
}

export function opencodeIdentityKey(credentials, scope) {
  const connectionId = credentials?.connectionId || credentials?.id;
  if (connectionId) return `${scope}:conn:${String(connectionId).slice(0, 128)}`;
  const raw = credentials?.rawHeaders || {};
  const auth = raw.authorization || raw.Authorization || raw["x-api-key"] || raw["X-Api-Key"] || "";
  if (auth) {
    return `${scope}:auth:${shaHex(String(auth), 32)}`;
  }
  return `${scope}:default`;
}

/**
 * Conversation-scoped stable key. Meaningful seeds (downstream conversation
 * ids such as `claude:<uuid>`) isolate conversations for cache affinity;
 * junk seeds (sessionManager UUID+timestamp placeholders) are ignored so
 * anonymous traffic shares one stable session instead of minting per request.
 */
export function opencodeConversationKey({ scope, credentials, providerSessionId, clientTool }) {
  const seed = typeof providerSessionId === "string" ? providerSessionId.trim() : "";
  const seedPart = seed && !isJunkSessionSeed(seed)
    ? shaHex(`${clientTool || "generic"}\0${seed}`, 16)
    : "default";
  return `${opencodeIdentityKey(credentials, scope)}|tool:${clientTool || "generic"}|seed:${seedPart}`;
}
