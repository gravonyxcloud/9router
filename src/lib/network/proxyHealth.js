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

export const PROXY_FAILOVER_MAX_ATTEMPTS = 4; // primary + 3 failovers per request
export const PROXY_FAIL_COOLDOWN_MS = 5 * 60 * 1000;
// Sticky pools slower than this lose priority and join the latency sort —
// otherwise one slow-but-working proxy gets pinned and every request stalls.
export const STICKY_SLOW_MS = 4000;
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
 * Order pool candidates for failover attempts (pure, unit-testable).
 * [fast-sticky-if-valid, primary-if-present, rest by latency, cooling last],
 * capped at `limit` entries. Pools must be pre-filtered (active, non-relay,
 * with URL); identity is by pool.id.
 *
 * Latency rule: a sticky pool slower than STICKY_SLOW_MS loses its priority
 * and joins the latency sort — a slow-but-working proxy must not stall every
 * request. Within the fresh set, known latencies sort ascending and
 * never-measured pools go last (they are still covered by the background
 * rotation, which tests oldest-first).
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
  const fresh = rest
    .filter((p) => failedMsAgo(p.id, now) === Infinity)
    .sort((a, b) => poolLatencyMs(a, now) - poolLatencyMs(b, now));
  const cooling = rest
    .filter((p) => failedMsAgo(p.id, now) !== Infinity)
    .sort((a, b) => failedMsAgo(b.id, now) - failedMsAgo(a.id, now));
  for (const p of [...fresh, ...cooling]) push(p);
  return ordered.slice(0, Math.max(1, limit));
}
