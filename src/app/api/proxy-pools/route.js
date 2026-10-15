import { NextResponse } from "next/server";
import { createProxyPool, getProviderConnections, getProxyPools, getProxyPoolsCount } from "@/models";

function toBoolean(value) {
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

const VALID_PROXY_TYPES = ["http", "socks4", "socks5", "vercel", "cloudflare", "deno", "netlify"]; // SOCKS types are accepted; runtime support is tested separately

function normalizeProxyPoolInput(body = {}) {
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const proxyUrl = typeof body?.proxyUrl === "string" ? body.proxyUrl.trim() : "";
  const noProxy = typeof body?.noProxy === "string" ? body.noProxy.trim() : "";
  const isActive = body?.isActive === undefined ? true : body.isActive === true;
  const strictProxy = body?.strictProxy === true;
  const inferredType = /^socks4:\/\//i.test(proxyUrl) ? "socks4" : /^socks5h?:\/\//i.test(proxyUrl) ? "socks5" : "http";
  const type = VALID_PROXY_TYPES.includes(body?.type) ? body.type : inferredType;

  if (!name) {
    return { error: "Name is required" };
  }

  if (!proxyUrl) {
    return { error: "Proxy URL is required" };
  }

  return { name, proxyUrl, noProxy, isActive, strictProxy, type };
}

function buildUsageMap(connections = []) {
  const usageMap = new Map();

  for (const connection of connections) {
    const proxyPoolId = connection?.providerSpecificData?.proxyPoolId;
    if (!proxyPoolId) continue;

    usageMap.set(proxyPoolId, (usageMap.get(proxyPoolId) || 0) + 1);
  }

  return usageMap;
}

// GET /api/proxy-pools - List proxy pools.
// Paginated when `limit` is present (huge fleets from list imports would
// otherwise serialize tens of thousands of rows per page load):
//   /api/proxy-pools?limit=200&offset=0 -> { proxyPools, total, limit, offset }
// Without `limit`, returns the legacy full { proxyPools } shape (dropdowns).
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const isActive = toBoolean(searchParams.get("isActive"));
    const includeUsage = searchParams.get("includeUsage") === "true";
    const rawLimit = Number(searchParams.get("limit"));
    const paged = Number.isFinite(rawLimit) && rawLimit > 0;
    const limit = paged ? Math.min(2000, Math.floor(rawLimit)) : null;
    const rawOffset = Number(searchParams.get("offset"));
    const offset = paged && Number.isFinite(rawOffset) && rawOffset > 0 ? Math.floor(rawOffset) : 0;

    const filter = {};
    if (isActive !== undefined) {
      filter.isActive = isActive;
    }

    const proxyPools = paged
      ? await getProxyPools(filter, { limit, offset })
      : await getProxyPools(filter);
    const meta = paged ? { total: await getProxyPoolsCount(filter), limit, offset } : null;

    if (!includeUsage) {
      return NextResponse.json(paged ? { proxyPools, ...meta } : { proxyPools });
    }

    const connections = await getProviderConnections();
    const usageMap = buildUsageMap(connections);

    const enrichedProxyPools = proxyPools.map((pool) => ({
      ...pool,
      boundConnectionCount: usageMap.get(pool.id) || 0,
    }));
    return NextResponse.json(paged ? { proxyPools: enrichedProxyPools, ...meta } : { proxyPools: enrichedProxyPools });

    return NextResponse.json({ proxyPools: enrichedProxyPools });
  } catch (error) {
    console.log("Error fetching proxy pools:", error);
    return NextResponse.json({ error: "Failed to fetch proxy pools" }, { status: 500 });
  }
}

// POST /api/proxy-pools - Create proxy pool
export async function POST(request) {
  try {
    const body = await request.json();
    const normalized = normalizeProxyPoolInput(body);

    if (normalized.error) {
      return NextResponse.json({ error: normalized.error }, { status: 400 });
    }

    const proxyPool = await createProxyPool(normalized);
    return NextResponse.json({ proxyPool }, { status: 201 });
  } catch (error) {
    console.log("Error creating proxy pool:", error);
    return NextResponse.json({ error: "Failed to create proxy pool" }, { status: 500 });
  }
}
