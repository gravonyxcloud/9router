/**
 * Background proxy auto-health: re-tests pools every minute so the working
 * set is always known. Each tick tests the least-recently-tested batch
 * (never-tested first), so a large fleet is covered over time without
 * hammering it.
 *
 * Working pools stay active, failed ones are deactivated — and a failed
 * pool that recovers is re-activated on a later cycle (inactive pools are
 * included in the rotation of batches). Rotation prefers testStatus=active
 * pools (see auth.js), making traffic self-optimizing.
 * Fail-open everywhere: tick errors never kill the interval.
 */
import { getProxyPools, updateProxyPool } from "@/lib/db/index.js";
import { isRelayPoolType, testProxyPool, testProxyOpencodeTarget } from "@/lib/network/proxyTest.js";
import { getStickyPoolIds } from "@/lib/network/proxyHealth.js";

const DEFAULT_INTERVAL_MS = 30 * 1000;
const INITIAL_DELAY_MS = 45 * 1000;
// Maxed throughput: 200 pools/30s covers large fleets fast. Worst-case tick
// cost stays under the interval (200 / 50 concurrency * 7s ≈ 28s).
// 7s probe budget (was 2.5s): public proxies are slow — tight timeouts mark
// working-but-slow pools dead and starve the opencode-ok set. Relays (own
// deploys, cold starts) keep a longer budget. Override via env without rebuild:
// PROXY_HEALTH_BATCH_SIZE / PROXY_HEALTH_CONCURRENCY / PROXY_HEALTH_TIMEOUT_MS.
function envInt(name, fallback, min, max) {
  const raw = Number(process.env[name]);
  if (!Number.isFinite(raw) || raw <= 0) return fallback;
  return Math.min(max, Math.max(min, Math.floor(raw)));
}
const BATCH_SIZE = envInt("PROXY_HEALTH_BATCH_SIZE", 200, 10, 2000);
const TEST_CONCURRENCY = envInt("PROXY_HEALTH_CONCURRENCY", 50, 1, 200);
const TEST_TIMEOUT_MS = envInt("PROXY_HEALTH_TIMEOUT_MS", 7000, 1000, 30000);
const RELAY_TEST_TIMEOUT_MS = 10000;

let started = false;
let intervalHandle = null;
let initialTimeoutHandle = null;
let tickRunning = false;

const lastRun = { at: null, tested: 0, alive: 0, dead: 0, error: null };

export function getProxyAutoHealthStatus() {
  return {
    enabled: started,
    intervalMs: DEFAULT_INTERVAL_MS,
    batchSize: BATCH_SIZE,
    lastRun: { ...lastRun },
  };
}

function isTruthyEnv(value) {
  if (value == null || value === "") return false;
  const v = String(value).trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function isNonServerRuntime() {
  if (typeof window !== "undefined") return true;
  const phase = process.env.NEXT_PHASE || "";
  if (
    phase === "phase-production-build" ||
    phase === "phase-export" ||
    phase === "phase-static"
  ) {
    return true;
  }
  if (process.env.NEXT_RUNTIME === "edge") return true;
  return false;
}

// Hot standby: re-test the pools traffic actually depends on FIRST every
// tick (current stickies + fastest opencode-verified), so failover data is
// never stale and a replacement is instantly ready when one drops. The rest
// of the batch keeps rotating oldest-first over the fleet.
const HOT_STANDBY_SIZE = 20;

function pickHotStandby(testable) {
  if (!testable.length) return [];
  const hotIds = new Set();
  try {
    for (const id of getStickyPoolIds()) hotIds.add(id);
  } catch { /* health module unavailable — skip */ }
  const byId = new Map(testable.map((p) => [p.id, p]));
  const hot = [];
  for (const id of hotIds) {
    const pool = byId.get(id);
    if (pool && hot.length < HOT_STANDBY_SIZE) hot.push(pool);
  }
  if (hot.length < HOT_STANDBY_SIZE) {
    const lat = (p) => {
      for (const key of ["opencodeLatencyMs", "latencyMs"]) {
        const ms = Number(p?.[key]);
        if (Number.isFinite(ms) && ms >= 0) return ms;
      }
      return Infinity;
    };
    const rest = testable
      .filter((p) => p?.opencodeOk === true && !hot.some((h) => h.id === p.id))
      .sort((a, b) => lat(a) - lat(b));
    for (const p of rest) {
      if (hot.length >= HOT_STANDBY_SIZE) break;
      hot.push(p);
    }
  }
  return hot;
}

function oldestFirst(pools) {
  return [...pools].sort((a, b) => {
    const ta = a.lastTestedAt ? new Date(a.lastTestedAt).getTime() : 0;
    const tb = b.lastTestedAt ? new Date(b.lastTestedAt).getTime() : 0;
    return ta - tb;
  });
}

async function mapWithConcurrency(items, concurrency, fn) {
  const results = new Array(items.length);
  let index = 0;
  async function worker() {
    while (index < items.length) {
      const current = index++;
      try {
        results[current] = await fn(items[current], current);
      } catch (err) {
        results[current] = { ok: false, error: err?.message || String(err) };
      }
    }
  }
  const workers = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return results;
}

export async function runProxyAutoHealthTick() {
  if (tickRunning) return { ok: true, skipped: "overlap" };
  tickRunning = true;
  try {
    let pools = [];
    try {
      // All pools (active AND inactive): failures deactivate, recoveries
      // re-activate — the batch rotation covers the whole fleet over time.
      pools = await getProxyPools();
    } catch (err) {
      lastRun.error = "db";
      console.log("[ProxyAutoHealth] failed to load pools:", err?.message || err);
      return { ok: false, error: "db" };
    }
    const testable = pools.filter((p) => p.proxyUrl);
    if (testable.length === 0) {
      lastRun.at = new Date().toISOString();
      lastRun.tested = 0;
      lastRun.alive = 0;
      lastRun.dead = 0;
      lastRun.error = null;
      return { ok: true, tested: 0 };
    }
    const hot = pickHotStandby(testable);
    const hotIds = new Set(hot.map((p) => p.id));
    const batch = [
      ...hot,
      ...oldestFirst(testable.filter((p) => !hotIds.has(p.id))).slice(0, Math.max(0, BATCH_SIZE - hot.length)),
    ].slice(0, BATCH_SIZE);
    const results = await mapWithConcurrency(batch, TEST_CONCURRENCY, async (pool) => {
      // Stage 1: cheap generic probe. Stage 2 (only on pass, non-relay):
      // can this egress IP actually reach OpenCode, or is it burned
      // (rate limit / gate)? Burned counts as failed — revival loop
      // re-activates once the gate lifts.
      const stamp = async (patch) => {
        try {
          await updateProxyPool(pool.id, { lastTestedAt: new Date().toISOString(), ...patch });
        } catch {
          // stats must never break the tick
        }
      };
      try {
        const timeoutMs = isRelayPoolType(pool.type) ? RELAY_TEST_TIMEOUT_MS : TEST_TIMEOUT_MS;
        const result = await testProxyPool(pool, { timeoutMs });
        if (!result.ok) {
          await stamp({
            isActive: false,
            testStatus: "error",
            lastError: (result.error || `HTTP ${result.status}` || "probe failed").slice(0, 500),
          });
          return { ok: false };
        }
        const probeMs = Number(result.elapsedMs);
        const latencyPatch = Number.isFinite(probeMs) && probeMs >= 0 ? { latencyMs: Math.round(probeMs) } : {};
        if (!isRelayPoolType(pool.type)) {
          let gated = null;
          try {
            gated = await testProxyOpencodeTarget(pool.proxyUrl, { timeoutMs: TEST_TIMEOUT_MS });
          } catch (err) {
            gated = { ok: false, gated: false, error: String(err?.message || err) };
          }
          const now = new Date().toISOString();
          if (!gated.ok) {
            await stamp({
              isActive: false,
              testStatus: "error",
              lastError: (gated.error || `OpenCode probe HTTP ${gated.status}`).slice(0, 500),
              opencodeOk: false,
              opencodeCheckedAt: now,
              ...latencyPatch,
            });
            return { ok: false };
          }
          const gatedMs = Number(gated.elapsedMs);
          await stamp({
            isActive: true,
            testStatus: "active",
            lastError: null,
            opencodeOk: true,
            opencodeCheckedAt: now,
            ...latencyPatch,
            ...(Number.isFinite(gatedMs) && gatedMs >= 0 ? { opencodeLatencyMs: Math.round(gatedMs) } : {}),
          });
          return { ok: true };
        }
        await stamp({ isActive: true, testStatus: "active", lastError: null, ...latencyPatch });
        return { ok: true };
      } catch (err) {
        try {
          await updateProxyPool(pool.id, {
            isActive: false,
            testStatus: "error",
            lastTestedAt: new Date().toISOString(),
            lastError: String(err?.message || err).slice(0, 500),
          });
        } catch {
          // ignore
        }
        return { ok: false };
      }
    });
    const alive = results.filter((r) => r?.ok).length;
    lastRun.at = new Date().toISOString();
    lastRun.tested = batch.length;
    lastRun.alive = alive;
    lastRun.dead = batch.length - alive;
    lastRun.error = null;
    console.log(`[ProxyAutoHealth] tested=${batch.length} alive=${alive} dead=${batch.length - alive}`);
    return { ok: true, tested: batch.length, alive, dead: batch.length - alive };
  } finally {
    tickRunning = false;
  }
}

async function safeTick() {
  try {
    await runProxyAutoHealthTick();
  } catch (err) {
    console.log("[ProxyAutoHealth] tick failed:", err?.message || err);
  }
}

export function startProxyAutoHealth({ intervalMs } = {}) {
  if (started) return false;
  if (isTruthyEnv(process.env.DISABLE_PROXY_AUTO_HEALTH)) return false;
  if (isNonServerRuntime()) return false;
  started = true;
  const period = Number(intervalMs) > 0 ? Number(intervalMs) : DEFAULT_INTERVAL_MS;
  console.log(`[ProxyAutoHealth] scheduler started (interval ${Math.round(period / 1000)}s)`);
  initialTimeoutHandle = setTimeout(safeTick, INITIAL_DELAY_MS);
  if (initialTimeoutHandle.unref) initialTimeoutHandle.unref();
  intervalHandle = setInterval(safeTick, period);
  if (intervalHandle.unref) intervalHandle.unref();
  return true;
}

export function stopProxyAutoHealth() {
  if (initialTimeoutHandle) {
    clearTimeout(initialTimeoutHandle);
    initialTimeoutHandle = null;
  }
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
  started = false;
}
