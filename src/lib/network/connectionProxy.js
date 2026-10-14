import { getProxyPoolById, getProxyPools } from "@/models";
import {
  PROXY_FAILOVER_MAX_ATTEMPTS,
  getStickyProxyPoolId,
  orderProxyCandidates,
} from "./proxyHealth.js";

// Safely normalize any value into a trimmed string.
function normalizeString(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

// ─── Proxy pool rotation state (in-memory) ─────────────────────────
const rotateState = new Map(); // providerId → { index }

/**
 * Pick one proxy pool ID from a list based on strategy.
 * round-robin: cycle sequentially (in-memory, resets on restart)
 * random:      uniform random pick
 * none/single: return first entry
 */
export function pickProxyPoolId(poolIds, strategy, providerId) {
  if (!poolIds || poolIds.length === 0) return null;
  if (poolIds.length === 1) return poolIds[0];

  if (strategy === "round-robin") {
    const state = rotateState.get(providerId) || { index: -1 };
    state.index = (state.index + 1) % poolIds.length;
    rotateState.set(providerId, state);
    return poolIds[state.index];
  }

  if (strategy === "random") {
    return poolIds[Math.floor(Math.random() * poolIds.length)];
  }

  return poolIds[0]; // "none" or unknown
}

const RELAY_POOL_TYPES = new Set(["vercel", "cloudflare", "deno", "netlify"]);

function isFailoverCandidate(pool) {
  return (
    pool &&
    pool.isActive === true &&
    normalizeString(pool.proxyUrl) &&
    !RELAY_POOL_TYPES.has(pool.type)
  );
}

/**
 * Build in-request failover options for smart proxy rotation.
 *
 * Only applies to pool-driven traffic (bound pool or rotation pick);
 * legacy, direct and relay traffic resolve to null and keep current
 * behavior. Returns null when there is nothing to add, otherwise:
 *   { connectionProxyUrl, connectionNoProxy, proxyPoolId, strictProxy,
 *     proxyScope, proxyFailovers }
 * where proxyFailovers is an ordered list of { proxyPoolId,
 * connectionProxyUrl, strictProxy } to try after the primary proxy fails —
 * so a dead proxy rotates to another proxy instead of leaking to direct.
 *
 * Order: sticky working pool for the scope first ("use the working proxy
 * until it fails"), then the already-selected primary, then the remaining
 * active pools, skipping pools inside the failure cooldown window (unless
 * that would leave no candidates at all).
 *
 * Scope isolates stickiness: a connection pinned to pool P uses
 * `pool:<P>`; shared rotation traffic uses `provider:<provider>`.
 */
export async function resolveProxyFailoverOptions(credentials = {}, provider = "") {
  try {
    const psd = credentials?.providerSpecificData || {};
    // Only pool-driven traffic: rotation picks land in connectionProxyPoolId,
    // pinned connections in proxyPoolId. Legacy/direct/relay keep as-is.
    if (psd.connectionProxyEnabled !== true || !normalizeString(psd.connectionProxyUrl)) {
      return null;
    }
    if (normalizeString(psd.vercelRelayUrl)) return null;
    const rawBoundId = normalizeString(psd.proxyPoolId || psd.connectionProxyPoolId);
    if (!rawBoundId || rawBoundId === "__none__") return null;
    const pickedId = rawBoundId;
    const scope = psd.proxyPoolId && psd.proxyPoolId !== "__none__"
      ? `pool:${psd.proxyPoolId}`
      : `provider:${provider || "shared"}`;

    let pools = [];
    try {
      pools = await getProxyPools({ isActive: true });
    } catch {
      return null;
    }
    const candidates = pools.filter(isFailoverCandidate);
    if (candidates.length === 0) return null;

    const byId = new Map(candidates.map((p) => [p.id, p]));
    const primary = byId.get(pickedId) || null;

    const ordered = orderProxyCandidates(candidates, {
      primaryId: primary ? primary.id : null,
      stickyId: getStickyProxyPoolId(scope),
      limit: PROXY_FAILOVER_MAX_ATTEMPTS,
    });
    if (ordered.length === 0) return null;
    const [first, ...others] = ordered;
    return {
      connectionProxyUrl: normalizeString(first.proxyUrl),
      connectionNoProxy: normalizeString(first.noProxy),
      proxyPoolId: first.id,
      strictProxy: first.strictProxy === true,
      proxyScope: scope,
      proxyFailovers: others
        .map((p) => ({
          proxyPoolId: p.id,
          connectionProxyUrl: normalizeString(p.proxyUrl),
          strictProxy: p.strictProxy === true,
        }))
        .filter((f) => f.connectionProxyUrl),
    };
  } catch (error) {
    console.error("[resolveProxyFailoverOptions] Failed:", error);
    return null;
  }
}

/**
 * Normalize legacy proxy configuration.
 */
function normalizeLegacyProxy(providerSpecificData = {}) {
  const connectionProxyEnabled =
    providerSpecificData?.connectionProxyEnabled === true;

  const connectionProxyUrl = normalizeString(
    providerSpecificData?.connectionProxyUrl
  );

  const connectionNoProxy = normalizeString(
    providerSpecificData?.connectionNoProxy
  );

  return {
    connectionProxyEnabled,
    connectionProxyUrl,
    connectionNoProxy,
  };
}

/**
 * Resolve final proxy configuration.
 *
 * Priority:
 * 1. Proxy Pool
 * 2. Legacy Proxy
 * 3. No Proxy
 */
export async function resolveConnectionProxyConfig(
  providerSpecificData = {}
) {
  try {
    const proxyPoolIdRaw = normalizeString(
      providerSpecificData?.proxyPoolId
    );

    // "__none__" means explicitly disabled
    const proxyPoolId =
      proxyPoolIdRaw === "__none__" ? "" : proxyPoolIdRaw;

    const legacy = normalizeLegacyProxy(providerSpecificData);

    // A strict pool must keep its guarantee even when the pool itself is not
    // usable (inactive, or saved without a url). Otherwise the unusable-pool
    // path below reports strictProxy:false and the request silently leaves
    // over the direct IP — the leak strict mode exists to prevent (#4333).
    let poolStrictProxy = false;

    /**
     * -----------------------------
     * Proxy Pool Resolution
     * -----------------------------
     */
    if (proxyPoolId) {
      const proxyPool = await getProxyPoolById(proxyPoolId);

      const proxyUrl = normalizeString(proxyPool?.proxyUrl);
      const noProxy = normalizeString(proxyPool?.noProxy);

      const isValidPool =
        proxyPool &&
        proxyPool.isActive === true &&
        proxyUrl;

      poolStrictProxy = proxyPool?.strictProxy === true;

      if (isValidPool) {
        /**
         * Vercel/Cloudflare/Deno/Netlify relay proxies use base URL rewriting
         * instead of HTTP_PROXY environment variables.
         */
        if (proxyPool.type === "vercel" || proxyPool.type === "cloudflare" || proxyPool.type === "deno" || proxyPool.type === "netlify") {
          return {
            source: proxyPool.type,

            proxyPoolId,
            proxyPool,

            connectionProxyEnabled: false,
            connectionProxyUrl: "",
            connectionNoProxy: noProxy,

            strictProxy: proxyPool.strictProxy === true,

            vercelRelayUrl: proxyUrl, // Still mapped to vercelRelayUrl in the unified payload since they use the exact same header spec
          };
        }

        /**
         * Standard proxy pool
         */
        let proxyFailovers = [];
        let proxyScope = `pool:${proxyPoolId}`;
        try {
          const allPools = await getProxyPools({ isActive: true });
          const failoverCandidates = allPools.filter(isFailoverCandidate);
          const ordered = orderProxyCandidates(failoverCandidates, {
            primaryId: proxyPoolId,
            stickyId: getStickyProxyPoolId(proxyScope),
            limit: PROXY_FAILOVER_MAX_ATTEMPTS,
          }).filter((p) => p.id !== proxyPoolId);
          proxyFailovers = ordered
            .map((p) => ({
              proxyPoolId: p.id,
              connectionProxyUrl: normalizeString(p.proxyUrl),
              strictProxy: p.strictProxy === true,
            }))
            .filter((f) => f.connectionProxyUrl);
        } catch {
          // Fail-open: single-proxy behavior without failovers.
        }
        return {
          source: "pool",

          proxyPoolId,
          proxyPool,

          connectionProxyEnabled: true,
          connectionProxyUrl: proxyUrl,
          connectionNoProxy: noProxy,

          strictProxy: proxyPool.strictProxy === true,

          proxyScope,
          proxyFailovers,
        };
      }
    }

    /**
     * -----------------------------
     * Legacy Proxy Fallback
     * -----------------------------
     */
    if (
      legacy.connectionProxyEnabled &&
      legacy.connectionProxyUrl
    ) {
      return {
        source: "legacy",

        proxyPoolId: proxyPoolId || null,
        proxyPool: null,

        strictProxy: poolStrictProxy,

        ...legacy,
      };
    }

    /**
     * -----------------------------
     * No Proxy Config
     * -----------------------------
     */
    return {
      source: "none",

      proxyPoolId: proxyPoolId || null,
      proxyPool: null,

      strictProxy: poolStrictProxy,

      ...legacy,
    };
  } catch (error) {
    console.error(
      "[resolveConnectionProxyConfig] Failed to resolve proxy config:",
      error
    );

    return {
      source: "error",

      proxyPoolId: null,
      proxyPool: null,

      connectionProxyEnabled: false,
      connectionProxyUrl: "",
      connectionNoProxy: "",

      strictProxy: false,
    };
  }
}
