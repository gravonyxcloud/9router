/**
 * In-memory proxy health: sticky working proxy + failure cooldown.
 *
 * - noteProxyPoolResult(scope, poolId, ok): success pins the pool as the
 *   sticky choice for its scope ("use the working proxy until it fails");
 *   failure clears a matching sticky and starts a cooldown window.
 * - Pools that failed within PROXY_FAIL_COOLDOWN_MS are skipped when
 *   building failover candidates, so blackholes are not re-stalled every
 *   request. When everything is cooling down, the least-recent failure wins.
 * - Pure in-memory state (resets on restart), no dependencies — safe to
 *   import from both src and open-sse.
 */

export const PROXY_FAILOVER_MAX_ATTEMPTS = 4; // primary + 3 failovers per request
export const PROXY_FAIL_COOLDOWN_MS = 5 * 60 * 1000;
const MAX_TRACKED_POOLS = 5000;

const stickyByScope = new Map(); // scope -> poolId
const failedAtByPool = new Map(); // poolId -> timestamp ms

function pruneFailed(now) {
  if (failedAtByPool.size < MAX_TRACKED_POOLS) return;
  const oldest = [...failedAtByPool.entries()]
    .sort((a, b) => a[1] - b[1])
    .slice(0, Math.floor(MAX_TRACKED_POOLS / 2));
  for (const [poolId] of oldest) failedAtByPool.delete(poolId);
}

export function noteProxyPoolResult(scope, poolId, ok) {
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
    return;
  }
  if (scope && stickyByScope.get(scope) === poolId) {
    stickyByScope.delete(scope);
  }
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
}

/**
 * Order pool candidates for failover attempts (pure, unit-testable).
 * [sticky-if-valid, primary-if-present, fresh..., least-recently-failed...],
 * capped at `limit` entries. Pools must be pre-filtered (active, non-relay,
 * with URL); identity is by pool.id.
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
  if (stickyId) push(byId.get(stickyId));
  if (primaryId) push(byId.get(primaryId));
  const rest = list.filter((p) => p && p.id && !seen.has(p.id));
  const fresh = rest.filter((p) => failedMsAgo(p.id) === Infinity);
  const cooling = rest
    .filter((p) => failedMsAgo(p.id) !== Infinity)
    .sort((a, b) => failedMsAgo(b.id) - failedMsAgo(a.id));
  for (const p of [...fresh, ...cooling]) push(p);
  return ordered.slice(0, Math.max(1, limit));
}
