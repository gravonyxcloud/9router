// Background auto-sync of TXT proxy-list sources — independent of inbound requests.
// Fail-open everywhere: tick errors and per-source failures never kill the interval.

import { getProxyListSources } from "@/lib/db/index.js";
import { syncProxyListSource } from "@/lib/network/proxyListSync.js";

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
const INITIAL_DELAY_MS = 30 * 1000;

let started = false;
let intervalHandle = null;
let initialTimeoutHandle = null;
let tickRunning = false;

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

export async function runProxyListAutoSyncTick() {
  if (tickRunning) return { ok: true, skipped: "overlap" };
  tickRunning = true;
  try {
    let sources = [];
    try {
      sources = await getProxyListSources({ isActive: true });
    } catch (err) {
      console.log("[ProxyListAutoSync] failed to load sources:", err?.message || err);
      return { ok: false, error: "db" };
    }
    const due = sources.filter((s) => s.autoUpdate !== false);
    const results = [];
    for (const source of due) {
      try {
        // Fast filter for background runs: short probe timeout, high
        // concurrency. Manual "sync now" uses the thorough defaults.
        const result = await syncProxyListSource(source, {
          testNew: true,
          concurrency: 20,
          testTimeoutMs: 4000,
        });
        results.push({ sourceId: source.id, ok: result.ok, found: result.found || 0, imported: result.imported || 0, failed: result.failed || 0 });
        console.log(`[ProxyListAutoSync] ${source.name}: found=${result.found || 0} imported=${result.imported || 0} failed=${result.failed || 0}${result.ok ? "" : ` error=${result.error || "unknown"}`}`);
      } catch (err) {
        console.log(`[ProxyListAutoSync] ${source.name} failed:`, err?.message || err);
        results.push({ sourceId: source.id, ok: false });
      }
    }
    return { ok: true, sources: results };
  } finally {
    tickRunning = false;
  }
}

async function safeTick() {
  try {
    await runProxyListAutoSyncTick();
  } catch (err) {
    console.log("[ProxyListAutoSync] tick failed:", err?.message || err);
  }
}

export function startProxyListAutoSync({ intervalMs } = {}) {
  if (started) return false;
  if (isTruthyEnv(process.env.DISABLE_PROXY_LIST_AUTOSYNC)) return false;
  if (isNonServerRuntime()) return false;
  started = true;
  const period = Number(intervalMs) > 0 ? Number(intervalMs) : DEFAULT_INTERVAL_MS;
  console.log(`[ProxyListAutoSync] scheduler started (interval ${Math.round(period / 1000)}s)`);
  initialTimeoutHandle = setTimeout(safeTick, INITIAL_DELAY_MS);
  if (initialTimeoutHandle.unref) initialTimeoutHandle.unref();
  intervalHandle = setInterval(safeTick, period);
  if (intervalHandle.unref) intervalHandle.unref();
  return true;
}

export function stopProxyListAutoSync() {
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
