import { describe, it, expect, beforeEach } from "vitest";
import {
  orderProxyCandidates,
  noteProxyPoolResult,
  poolLatencyMs,
  clearProxyHealth,
  STICKY_SLOW_MS,
  proxyPoolHost,
  spreadHostsFirst,
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

describe("proxyHealth host diversity", () => {
  const withHost = (id, host) => ({ id, proxyUrl: `http://${host}:8080` });

  it("strips credentials from host fingerprints", () => {
    expect(proxyPoolHost({ proxyUrl: "http://user:pw@1.2.3.4:8080" })).toBe("1.2.3.4");
    expect(proxyPoolHost({})).toBe("");
  });

  it("interleaves hosts keeping the head fixed", () => {
    const out = spreadHostsFirst([
      withHost("a", "1.1.1.1"), withHost("b", "1.1.1.1"),
      withHost("c", "2.2.2.2"), withHost("d", "1.1.1.1"),
    ]).map((p) => p.id);
    expect(out).toEqual(["a", "c", "b", "d"]);
  });

  it("separates same-host pools in candidate order", () => {
    const pools = [
      withHost("s1", "1.1.1.1"), withHost("s2", "1.1.1.1"), withHost("f", "2.2.2.2"),
    ];
    pools[0].latencyMs = 100; pools[1].latencyMs = 200; pools[2].latencyMs = 150;
    const ordered = orderProxyCandidates(pools, { limit: 3 }).map((p) => p.id);
    expect(ordered).toEqual(["s1", "f", "s2"]);
  });
});
