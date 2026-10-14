import { NextResponse } from "next/server";
import { getProxyAutoHealthStatus } from "@/sse/services/proxyAutoHealth.js";

// GET /api/proxy-pools/auto-health - Background 1-minute tester status
export async function GET() {
  try {
    return NextResponse.json(getProxyAutoHealthStatus());
  } catch (error) {
    console.log("Error getting proxy auto-health status:", error);
    return NextResponse.json({ error: "Failed to get auto-health status" }, { status: 500 });
  }
}
