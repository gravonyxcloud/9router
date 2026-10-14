import { NextResponse } from "next/server";
import { renewLicensedApiKey } from "@/lib/localDb";
import { authorizeLicenseRequest, normalizePlan } from "../shared.js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// POST /api/license/renew { email, plan, orderId, key? }
export async function POST(request) {
  const denied = authorizeLicenseRequest(request);
  if (denied) return denied;
  try {
    const body = await request.json();
    const email = request.headers.get("x-customer-email") || body.email;
    const key = request.headers.get("x-api-key") || body.key;
    const plan = normalizePlan(body.plan);
    if (!plan) return NextResponse.json({ error: "Invalid plan. Allowed: 3d, 7d, 15d, 30d" }, { status: 400 });
    const result = await renewLicensedApiKey({
      email,
      plan,
      orderId: body.orderId,
      key,
    });
    return NextResponse.json({
      success: true,
      reused: result.reused,
      license: {
        id: result.key.id,
        key: result.key.key,
        email: result.key.email,
        plan: result.key.plan,
        expiresAt: result.key.expiresAt,
        hourlyTokenLimit: result.key.hourlyTokenLimit,
        active: result.key.isActive && !result.key.expired,
      },
    }, { status: result.reused ? 200 : 200 });
  } catch (error) {
    const message = error?.message || "Could not renew license";
    const status = /required|valid customer email|invalid plan|does not belong|No existing license|orderId already belongs/i.test(message) ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
