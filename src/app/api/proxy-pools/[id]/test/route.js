import { NextResponse } from "next/server";
import { getProxyPoolById, updateProxyPool } from "@/models";
import { testProxyPool, testProxyOpencodeTarget, isRelayPoolType } from "@/lib/network/proxyTest";

// POST /api/proxy-pools/[id]/test - Test proxy pool entry
export async function POST(request, { params }) {
  try {
    const { id } = await params;
    const proxyPool = await getProxyPoolById(id);

    if (!proxyPool) {
      return NextResponse.json({ error: "Proxy pool not found" }, { status: 404 });
    }

    const result = await testProxyPool(proxyPool);
    const now = new Date().toISOString();

    // Second stage: a proxy may pass the generic check while its egress IP
    // is burned at the upstream (rate limit / gate). Only meaningful when
    // the generic probe passed and the pool is not a relay transport.
    let opencodeOk = null;
    let opencodeError = null;
    if (result.ok && !isRelayPoolType(proxyPool.type)) {
      try {
        const gated = await testProxyOpencodeTarget(proxyPool.proxyUrl, { timeoutMs: 8000 });
        opencodeOk = gated.ok;
        if (!gated.ok) opencodeError = gated.error || `OpenCode probe HTTP ${gated.status}`;
      } catch (err) {
        opencodeOk = false;
        opencodeError = err?.message || String(err);
      }
    }

    // A proxy burned at the upstream (rate limit / gate) is deactivated
    // like a dead one — the auto-health revival loop re-activates it once
    // the gate lifts.
    const burned = result.ok && opencodeOk === false;

    await updateProxyPool(id, {
      testStatus: result.ok && !burned ? "active" : "error",
      lastTestedAt: now,
      lastError: result.ok
        ? (burned ? opencodeError : null)
        : (result.error || `Proxy test failed with status ${result.status}`),
      isActive: result.ok && !burned,
      ...(opencodeOk === null ? {} : { opencodeOk, opencodeCheckedAt: now }),
    });

    return NextResponse.json({
      ok: result.ok,
      status: result.status,
      statusText: result.statusText || null,
      error: result.error || null,
      elapsedMs: result.elapsedMs || 0,
      testedAt: now,
      opencodeOk,
      opencodeError,
    });
  } catch (error) {
    console.log("Error testing proxy pool:", error);
    return NextResponse.json({ error: "Failed to test proxy pool" }, { status: 500 });
  }
}
