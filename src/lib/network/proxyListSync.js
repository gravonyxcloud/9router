/**
 * Smart sync of TXT proxy-list sources into proxy pools.
 *
 * - Imports only proxies that are NOT already registered (matched by
 *   protocol://host:port, so manually added pools are never duplicated
 *   and never modified or deleted).
 * - Tests every new proxy for real (including a genuine SOCKS handshake)
 *   and records how many failed.
 * - Never throws out of the scheduler path: per-proxy and per-source
 *   failures are counted, the source row always gets fresh stats.
 */
import { fetchPublic } from "@/shared/utils/ssrfGuard.js";
import {
  createProxyPool,
  getProxyPools,
  getProxyListSourceById,
  updateProxyListSource,
} from "@/lib/db/index.js";
import { makeKv } from "../db/helpers/kvStore.js";
import {
  parseListBody,
  poolProxyIdentity,
  proxyIdentityKey,
  detectRandomApiPayload,
  randomApiEntry,
} from "./proxyListParser.js";
import { testProxyUrl } from "./proxyTest.js";

const MAX_LIST_BYTES = 5 * 1024 * 1024;
const MAX_IMPORT_PER_SYNC = 2000;
const DEFAULT_TEST_CONCURRENCY = 10;
const DEFAULT_TEST_TIMEOUT_MS = 8000;

// Cross-process sync lock (kv-backed): two server instances (or a manual
// "sync now" racing the 5-minute scheduler) must never import the same list
// concurrently — both would compute the same "new" set and duplicate every
// row. Stale locks (crashed runs) expire via TTL.
const syncLockKv = makeKv("proxyListSync");
const SYNC_LOCK_TTL_MS = 15 * 60 * 1000;
let syncLockCounter = 0;

async function acquireSyncLock(sourceId) {
  const key = `lock:${sourceId}`;
  const owner = `${process.pid}:${Date.now().toString(36)}:${syncLockCounter++}`;
  let current = null;
  try {
    current = await syncLockKv.get(key, null);
  } catch {
    return { acquired: false, failOpen: true };
  }
  const now = Date.now();
  if (current && current.at && now - current.at < SYNC_LOCK_TTL_MS) {
    return { acquired: false, failOpen: false };
  }
  try {
    await syncLockKv.set(key, { owner, at: now });
  } catch {
    return { acquired: false, failOpen: true };
  }
  // Exact-tie race: last writer wins, the loser sees a foreign owner.
  try {
    const check = await syncLockKv.get(key, null);
    if (!check || check.owner === owner) return { acquired: true, owner };
    return { acquired: false, failOpen: false };
  } catch {
    return { acquired: false, failOpen: true };
  }
}

async function releaseSyncLock(sourceId, owner) {
  if (!owner) return;
  try {
    const current = await syncLockKv.get(`lock:${sourceId}`, null);
    if (current && current.owner === owner) {
      await syncLockKv.remove(`lock:${sourceId}`);
    }
  } catch {
    // ignore
  }
}

async function fetchProxyListText(url) {
  let parsed;
  try {
    parsed = new URL(String(url || "").trim());
  } catch {
    throw new Error("Invalid list URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("List URL must be http(s)");
  }
  // fetchPublic re-validates every redirect hop against SSRF (DNS-resolved).
  const res = await fetchPublic(parsed.toString(), {
    headers: { Accept: "text/plain,text/*,*/*", "User-Agent": "9Router" },
  });
  if (!res.ok) {
    throw new Error(`List URL returned HTTP ${res.status}`);
  }
  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.length;
      if (received > MAX_LIST_BYTES) {
        throw new Error("List file too large (max 5MB)");
      }
      chunks.push(value);
    }
  } finally {
    try { reader.releaseLock(); } catch { /* ignore */ }
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text;
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

export async function syncProxyListSource(sourceOrId, options = {}) {
  const startedAt = new Date().toISOString();
  const source = typeof sourceOrId === "object" && sourceOrId
    ? sourceOrId
    : await getProxyListSourceById(sourceOrId);

  if (!source) {
    return { ok: false, sourceId: null, found: 0, skipped: 0, imported: 0, newActive: 0, failed: 0, error: "List source not found", fetchedAt: startedAt };
  }

  // Serialize overlapping runs (manual click vs scheduler, or two server
  // instances). A skipped-as-locked run touches no stats.
  const lock = await acquireSyncLock(source.id);
  if (!lock.acquired && !lock.failOpen) {
    return { ok: false, sourceId: source.id, found: 0, skipped: 0, imported: 0, newActive: 0, failed: 0, error: "sync already running", fetchedAt: startedAt };
  }
  try {
    return await runSync(source, startedAt, options);
  } finally {
    await releaseSyncLock(source.id, lock.owner);
  }
}

const RANDOM_HARVEST_DEFAULT = 25;
const RANDOM_HARVEST_MAX = 100;
const RANDOM_HARVEST_CONCURRENCY = 5;

async function runRandomHarvest(source, startedAt, options = {}) {
  const fail = async (error) => {
    const message = error?.message || String(error);
    try {
      await updateProxyListSource(source.id, {
        lastFetchedAt: startedAt,
        lastStatus: "error",
        lastError: message.slice(0, 500),
      });
    } catch { /* stats must never break the caller */ }
    return { ok: false, sourceId: source.id, found: 0, skipped: 0, imported: 0, newActive: 0, failed: 0, error: message, fetchedAt: startedAt };
  };
  const rawHarvest = Number(source?.data?.harvest ?? options.harvest ?? RANDOM_HARVEST_DEFAULT);
  const polls = Math.min(RANDOM_HARVEST_MAX, Math.max(1, Number.isFinite(rawHarvest) ? Math.floor(rawHarvest) : RANDOM_HARVEST_DEFAULT));
  const protocol = source.protocol || "auto";

  const pollOnce = async () => {
    try {
      const text = await fetchProxyListText(source.url);
      const payload = detectRandomApiPayload(text);
      if (!payload) return null;
      return randomApiEntry(payload, protocol);
    } catch {
      return null;
    }
  };
  const results = await mapWithConcurrency(
    Array.from({ length: polls }, (_, i) => i),
    RANDOM_HARVEST_CONCURRENCY,
    pollOnce,
  );
  const seen = new Set();
  const unique = [];
  for (const entry of results) {
    if (!entry) continue;
    const key = proxyIdentityKey(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(entry);
  }
  if (unique.length === 0) {
    return fail(new Error("Random API returned no usable proxies"));
  }

  let existingIdentities = new Set();
  try {
    const pools = await getProxyPools();
    existingIdentities = new Set(pools.map(poolProxyIdentity).filter(Boolean));
  } catch (err) {
    return fail(new Error(`Failed to load existing pools: ${err?.message || err}`));
  }

  let imported = 0;
  let failed = 0;
  for (const entry of unique) {
    if (existingIdentities.has(proxyIdentityKey(entry))) continue;
    try {
      // Pre-verified by the random API against the real target: import
      // active with its measured latency seeded, so fastest-first routing
      // works immediately. Our auto-health re-verifies on rotation.
      // lastTestedAt stays null so the rotation tests these first.
      await createProxyPool({
        name: `${source.name} — ${entry.host}:${entry.port}`,
        proxyUrl: entry.proxyUrl,
        noProxy: "",
        type: entry.protocol,
        isActive: true,
        testStatus: "active",
        lastTestedAt: null,
        lastError: null,
        latencyMs: entry.latencyMs,
        opencodeLatencyMs: entry.opencodeLatencyMs,
        opencodeOk: true,
        opencodeCheckedAt: entry.opencodeCheckedAt || new Date().toISOString(),
        sourceId: source.id,
        sourceName: source.name,
        autoImported: true,
      });
      imported += 1;
      existingIdentities.add(proxyIdentityKey(entry));
    } catch {
      failed += 1;
    }
  }

  const stats = {
    lastFetchedAt: new Date().toISOString(),
    lastStatus: "ok",
    lastError: null,
    totalFound: unique.length,
    totalNew: unique.length,
    totalFailed: failed,
    totalImported: imported,
  };
  try {
    await updateProxyListSource(source.id, stats);
  } catch { /* ignore */ }
  return { ok: true, sourceId: source.id, found: unique.length, skipped: 0, imported, newActive: imported, failed, fetchedAt: startedAt };
}

async function runSync(source, startedAt, options = {}) {  const {
    testNew = true,
    concurrency = DEFAULT_TEST_CONCURRENCY,
    testTimeoutMs = DEFAULT_TEST_TIMEOUT_MS,
  } = options;
  const fail = async (error) => {
    const message = error?.message || String(error);
    try {
      await updateProxyListSource(source.id, {
        lastFetchedAt: startedAt,
        lastStatus: "error",
        lastError: message.slice(0, 500),
      });
    } catch { /* stats must never break the caller */ }
    return { ok: false, sourceId: source.id, found: 0, skipped: 0, imported: 0, newActive: 0, failed: 0, error: message, fetchedAt: startedAt };
  };
  let text;
  try {
    text = await fetchProxyListText(source.url);
  } catch (err) {
    return fail(err);
  }

  // Random-proxy-API shape (single working proxy per call, e.g. a /v1/random
  // endpoint): poll it repeatedly and harvest the working set instead of
  // parsing a list. Auto-detected from the payload — no source-kind config.
  const randomPayload = detectRandomApiPayload(text);
  if (randomPayload) {
    return runRandomHarvest(source, startedAt, options);
  }

  let entries = [];
  try {
    ({ entries } = parseListBody(text, source.protocol || "auto"));
  } catch (err) {
    return fail(err);
  }
  const found = entries.length;

  let existingIdentities = new Set();
  try {
    const pools = await getProxyPools();
    existingIdentities = new Set(pools.map(poolProxyIdentity).filter(Boolean));
  } catch (err) {
    return fail(new Error(`Failed to load existing pools: ${err?.message || err}`));
  }

  const fresh = entries.filter((entry) => !existingIdentities.has(proxyIdentityKey(entry)));
  const capped = fresh.slice(0, MAX_IMPORT_PER_SYNC);
  const skipped = found - fresh.length;

  let imported = 0;
  let newActive = 0;
  let failed = 0;

  const testOne = async (entry) => {
    if (!testNew) return { entry, passed: true, testStatus: "unknown", lastError: null };
    try {
      const result = await testProxyUrl({ proxyUrl: entry.proxyUrl, timeoutMs: testTimeoutMs });
      if (result.ok) return { entry, passed: true, testStatus: "active", lastError: null };
      return { entry, passed: false, testStatus: "error", lastError: (result.error || `HTTP ${result.status}`).slice(0, 500) };
    } catch (err) {
      return { entry, passed: false, testStatus: "error", lastError: String(err?.message || err).slice(0, 500) };
    }
  };

  // Process in chunks so progress is visible incrementally (pools appear
  // and stats update as each chunk completes instead of only at the end).
  const CHUNK_SIZE = 200;
  for (let offset = 0; offset < capped.length; offset += CHUNK_SIZE) {
    const chunk = capped.slice(offset, offset + CHUNK_SIZE);
    const tested = await mapWithConcurrency(chunk, concurrency, testOne);

    for (const item of tested) {
      if (!item || !item.entry) {
        failed += 1;
        continue;
      }
      try {
        // Imported proxies are active by default, even when the probe failed:
        // testStatus/lastError still record the failure for monitoring, and the
        // user can deactivate or health-check later. Manual pools are untouched.
        await createProxyPool({
          name: `${source.name} · ${item.entry.host}:${item.entry.port}`,
          proxyUrl: item.entry.proxyUrl,
          noProxy: "",
          type: item.entry.protocol,
          isActive: true,
          testStatus: item.testStatus,
          lastTestedAt: new Date().toISOString(),
          lastError: item.lastError,
          sourceId: source.id,
          sourceName: source.name,
          autoImported: true,
        });
        imported += 1;
        newActive += 1;
        if (!item.passed) failed += 1;
      } catch {
        failed += 1;
      }
    }

    try {
      await updateProxyListSource(source.id, {
        lastFetchedAt: startedAt,
        lastStatus: "ok",
        lastError: null,
        totalFound: found,
        totalNew: capped.length,
        totalFailed: failed,
        totalImported: imported,
      });
    } catch { /* ignore */ }
  }

  const stats = {
    lastFetchedAt: new Date().toISOString(),
    lastStatus: "ok",
    lastError: null,
    totalFound: found,
    totalNew: capped.length,
    totalFailed: failed,
    totalImported: imported,
  };
  try {
    await updateProxyListSource(source.id, stats);
  } catch { /* ignore */ }

  return { ok: true, sourceId: source.id, found, skipped, imported, newActive, failed, fetchedAt: startedAt };
}
