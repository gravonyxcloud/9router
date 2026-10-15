import { describe, it, expect, beforeEach } from "vitest";
import {
  orderProxyCandidates,
  noteProxyPoolResult,
  poolLatencyMs,
  clearProxyHealth,
  STICKY_SLOW_MS,
} from "../../src/lib/network/proxyHealth.js";

const pool = (id, extra = {}) => ({ id, proxyUrl: `http://${id}:8080`, ...extra });

describe("proxyHealth latency ordering", () => {
  beforeEach(() => clearProxyHealth());

  it("sorts fresh pools fastest-first by persisted latency", () => {
    const pools = [pool("slow", { latencyMs: 6000 }), pool("fast", { latencyMs: 300 }), pool("unknown")];
    const ordered = orderProxyCandidates(pools, { limit: 3 }).map((p) => p.id);
    expect(ordered[0]).toBe("fast");
    expect(ordered).toContain("slow");
    expect(ordered).toContain("unknown");
  });

  it("prefers opencode-stage latency over generic probe latency", () => {
    const p = pool("a", { latencyMs: 500, opencodeLatencyMs: 4500 });
    expect(poolLatencyMs(p)).toBe(4500);
  });

  it("keeps a fast sticky first", () => {
    const pools = [pool("slow", { latencyMs: 6000 }), pool("fast", { latencyMs: 300 })];
    noteProxyPoolResult("s", "fast", true, 250);
    const ordered = orderProxyCandidates(pools, { stickyId: "fast", limit: 2 }).map((p) => p.id);
    expect(ordered[0]).toBe("fast");
  });

  it("demotes a slow sticky into latency order", () => {
    const pools = [pool("slow", { latencyMs: STICKY_SLOW_MS + 1000 }), pool("fast", { latencyMs: 300 })];
    noteProxyPoolResult("s", "slow", true, STICKY_SLOW_MS + 1000);
    const ordered = orderProxyCandidates(pools, { stickyId: "slow", limit: 2 }).map((p) => p.id);
    expect(ordered[0]).toBe("fast");
  });

  it("live observations override persisted values and expire", () => {
    const pools = [pool("a", { latencyMs: 5000 })];
    noteProxyPoolResult("s", "a", true, 200);
    expect(poolLatencyMs(pools[0])).toBe(200);
  });

  it("keeps primary second and cooling last", () => {
    const pools = [pool("p1", { latencyMs: 100 }), pool("p2", { latencyMs: 200 })];
    const ordered = orderProxyCandidates(pools, { primaryId: "p2", limit: 2 }).map((p) => p.id);
    expect(ordered).toContain("p1");
    expect(ordered).toContain("p2");
  });
});
