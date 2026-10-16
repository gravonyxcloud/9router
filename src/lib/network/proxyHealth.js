/**
 * In-memory proxy health: sticky working proxy + failure cooldown + latency.
 *
 * - noteProxyPoolResult(scope, poolId, ok, elapsedMs): success pins the pool
 *   as the sticky choice for its scope ("use the working proxy until it
 *   fails"); failure clears a matching sticky and starts a cooldown window.
 *   elapsedMs (optional) records live request latency for fastest-first
 *   ordering — a slow-but-working pool must not stay pinned forever.
 * - Pools that failed within PROXY_FAIL_COOLDOWN_MS are skipped when
 *   building failover candidates, so blackholes are not re-stalled every
 *   request. When everything is cooling down, the least-recent failure wins.
 * - Pure in-memory state (resets on restart), no dependencies — safe to
 *   import from both src and open-sse.
 */

export const PROXY_FAILOVER_MAX_ATTEMPTS = 6; // primary + 5 failovers per request
export const PROXY_FAIL_COOLDOWN_MS = 5 * 60 * 1000;
// Sticky pools slower than this lose priority and join the latency sort —
// a working proxy stays pinned (stability first); only pathological
// stickies rotate away. The 20s seat hedge still guards true stalls.
export const STICKY_SLOW_MS = 15000;
// Live latency observations older than this are ignored (stale).
export const LIVE_LATENCY_TTL_MS = 5 * 60 * 1000;
const MAX_TRACKED_POOLS = 5000;

const stickyByScope = new Map(); // scope -> poolId
const failedAtByPool = new Map(); // poolId -> timestamp ms
const liveLatencyByPool = new Map(); // poolId -> { ms, at }

function pruneFailed(now) {
  if (failedAtByPool.size < MAX_TRACKED_POOLS) return;
  const oldest = [...failedAtByPool.entries()]
    .sort((a, b) => a[1] - b[1])
    .slice(0, Math.floor(MAX_TRACKED_POOLS / 2));
  for (const [poolId] of oldest) failedAtByPool.delete(poolId);
}

export function noteProxyPoolResult(scope, poolId, ok, elapsedMs = null) {
  if (!poolId) return;
  if (ok) {
    if (scope) {
      stickyByScope.delete(scope);
      if (stickyByScope.size >= MAX_TRACKED_POOLS) {
        stickyByScope.delete(stickyByScope.keys().next().value);
      }
      stickyByScope.set(scope, poolId);
    }
    failedAtByPool.delete(poolId);
    const ms = Number(elapsedMs);
    if (Number.isFinite(ms) && ms >= 0) {
      liveLatencyByPool.set(poolId, { ms, at: Date.now() });
      if (liveLatencyByPool.size > MAX_TRACKED_POOLS) {
        liveLatencyByPool.delete(liveLatencyByPool.keys().next().value);
      }
    }
    return;
  }
  if (scope && stickyByScope.get(scope) === poolId) {
    stickyByScope.delete(scope);
  }
  liveLatencyByPool.delete(poolId);
  failedAtByPool.set(poolId, Date.now());
  pruneFailed(Date.now());
}

export function getStickyProxyPoolId(scope) {
  if (!scope) return null;
  return stickyByScope.get(scope) || null;
}

/** All currently pinned pool ids (deduplicated) — for hot-standby refresh. */
export function getStickyPoolIds() {
  return [...new Set(stickyByScope.values())].filter(Boolean);
}

/** ms since the pool last failed (Infinity when never/expired). */
export function failedMsAgo(poolId, now = Date.now()) {
  const at = failedAtByPool.get(poolId);
  if (at == null) return Infinity;
  const age = now - at;
  if (age > PROXY_FAIL_COOLDOWN_MS) {
    failedAtByPool.delete(poolId);
    return Infinity;
  }
  return age;
}

export function isCoolingDown(poolId, now = Date.now()) {
  return failedMsAgo(poolId, now) !== Infinity;
}

export function clearProxyHealth() {
  stickyByScope.clear();
  failedAtByPool.clear();
  liveLatencyByPool.clear();
}

function liveLatencyMs(poolId, now = Date.now()) {
  const entry = liveLatencyByPool.get(poolId);
  if (!entry) return null;
  if (now - entry.at > LIVE_LATENCY_TTL_MS) {
    liveLatencyByPool.delete(poolId);
    return null;
  }
  return entry.ms;
}

function persistedLatencyMs(pool) {
  if (!pool || typeof pool !== "object") return null;
  for (const key of ["opencodeLatencyMs", "latencyMs"]) {
    const ms = Number(pool[key]);
    if (Number.isFinite(ms) && ms >= 0) return ms;
  }
  return null;
}

/**
 * Effective latency for ordering (lower = faster). Live request observations
 * win over persisted probe values; pools never measured sort last.
 */
export function poolLatencyMs(pool, now = Date.now()) {
  const id = pool?.id;
  if (id) {
    const live = liveLatencyMs(id, now);
    if (live !== null) return live;
  }
  return persistedLatencyMs(pool) ?? Infinity;
}

/**
 * Host-only fingerprint for failover diversity (never credentials).
 */
export function proxyPoolHost(pool) {
  const raw = String(pool?.proxyUrl || "").trim();
  if (!raw) return "";
  const m = raw.match(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/(?:[^@/]*@)?([^\s/:]+)/);
  if (m) return m[1].toLowerCase();
  return raw.split(":")[0].toLowerCase();
}

/**
 * Spread pools so consecutive entries land on different hosts: pools behind
 * the same host usually share the same egress IP (and upstream quota), so
 * back-to-back same-host attempts burn time re-proving the same gate.
 * The head (fastest) stays fixed; the rest interleave round-robin by host.
 */
export function spreadHostsFirst(list) {
  const arr = Array.isArray(list) ? [...list] : [];
  if (arr.length <= 2) return arr;
  const [head, ...rest] = arr;
  const byHost = new Map();
  for (const p of rest) {
    const h = proxyPoolHost(p) || "(unknown)";
    if (!byHost.has(h)) byHost.set(h, []);
    byHost.get(h).push(p);
  }
  if (byHost.size <= 1) return arr;
  // Start the round-robin on a host different from the head's so the first
  // two entries never share an egress IP.
  const headHost = proxyPoolHost(head) || "(unknown)";
  const hostKeys = [...byHost.keys()];
  const startIdx = hostKeys.findIndex((h) => h !== headHost);
  const orderedKeys = startIdx > 0
    ? [...hostKeys.slice(startIdx), ...hostKeys.slice(0, startIdx)]
    : hostKeys;
  const out = [head];
  let remaining = rest.length;
  while (remaining > 0) {
    let moved = false;
    for (const h of orderedKeys) {
      const queue = byHost.get(h);
      if (queue.length) {
        out.push(queue.shift());
        remaining -= 1;
        moved = true;
      }
    }
    if (!moved) break;
  }
  return out;
}

/**
 * Order pool candidates for failover attempts (pure, unit-testable).
 * [fast-sticky-if-valid, primary-if-present, opencode-ok by latency,
 *  rest by latency, cooling last], capped at `limit` entries. Pools must be
 * pre-filtered (active, non-relay, with URL); identity is by pool.id.
 *
 * Latency rule: a sticky pool slower than STICKY_SLOW_MS loses its priority
 * and joins the latency sort — a slow-but-working proxy must not stall every
 * request. Within the fresh set, opencodeOk-verified pools come first (they
 * proved themselves against the real target, not just a generic probe),
 * then the rest by latency; never-measured pools sort last. Cooling pools
 * stay last regardless.
 */
export function orderProxyCandidates(pools, { primaryId = null, stickyId = null, limit = 4 } = {}) {
  const list = Array.isArray(pools) ? pools : [];
  const byId = new Map(list.map((p) => [p && p.id, p]));
  const ordered = [];
  const seen = new Set();
  const push = (pool) => {
    if (pool && pool.id && !seen.has(pool.id)) {
      seen.add(pool.id);
      ordered.push(pool);
    }
  };
  const now = Date.now();
  const sticky = stickyId ? byId.get(stickyId) : null;
  if (sticky && failedMsAgo(sticky.id, now) === Infinity && poolLatencyMs(sticky, now) <= STICKY_SLOW_MS) {
    push(sticky);
  }
  if (primaryId) push(byId.get(primaryId));
  const rest = list.filter((p) => p && p.id && !seen.has(p.id));
  // Fresh pools in strict tiers: opencode-verified first (proved against the
  // real target), then the rest — each tier latency-ordered with same-host
  // pools spread apart. Cooling pools keep recency order regardless.
  const byLatency = (a, b) => poolLatencyMs(a, now) - poolLatencyMs(b, now);
  const fresh = rest.filter((p) => failedMsAgo(p.id, now) === Infinity);
  const verified = spreadHostsFirst(fresh.filter((p) => p.opencodeOk === true).sort(byLatency));
  const restFresh = spreadHostsFirst(fresh.filter((p) => p.opencodeOk !== true).sort(byLatency));
  const cooling = rest
    .filter((p) => failedMsAgo(p.id, now) !== Infinity)
    .sort((a, b) => failedMsAgo(b.id, now) - failedMsAgo(a.id, now));
  for (const p of [...verified, ...restFresh, ...cooling]) push(p);
  return ordered.slice(0, Math.max(1, limit));
}
