import { NextResponse } from "next/server";
import { getProxyListSourceById } from "@/models";
import { syncProxyListSource } from "@/lib/network/proxyListSync.js";

// POST /api/proxy-list-sources/[id]/sync - Fetch the list now and import new proxies
export async function POST(request, { params }) {
  try {
    const { id } = await params;
    const source = await getProxyListSourceById(id);
    if (!source) {
      return NextResponse.json({ error: "List source not found" }, { status: 404 });
    }
    const result = await syncProxyListSource(source, {
      testNew: true,
      concurrency: 10,
      testTimeoutMs: 8000,
    });
    return NextResponse.json({ result });
  } catch (error) {
    console.log("Error syncing proxy list source:", error);
    return NextResponse.json({ error: "Failed to sync proxy list source" }, { status: 500 });
  }
}
