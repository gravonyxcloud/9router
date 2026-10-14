import { NextResponse } from "next/server";
import { createLicensedApiKey } from "@/lib/localDb";
import { authorizeLicenseRequest, normalizePlan } from "../shared.js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Server-to-server endpoint: call only after the payment provider confirms payment.
// POST /api/license/activate { email, plan: "3d"|"7d"|"15d"|"30d", orderId, name? }
export async function POST(request) {
  const denied = authorizeLicenseRequest(request);
  if (denied) return denied;
  try {
    const body = await request.json();
    const email = request.headers.get("x-customer-email") || body.email;
    const plan = normalizePlan(body.plan);
    if (!plan) return NextResponse.json({ error: "Invalid plan. Allowed: 3d, 7d, 15d, 30d" }, { status: 400 });
    const result = await createLicensedApiKey({
      email,
      plan,
      orderId: body.orderId,
      name: body.name,
    });
    return NextResponse.json({
      success: true,
      reused: result.reused,
      license: {
        id: result.key.id,
        key: result.key.key,
        email: result.key.email,
        plan: result.key.plan,
        createdAt: result.key.createdAt,
        expiresAt: result.key.expiresAt,
        hourlyTokenLimit: result.key.hourlyTokenLimit,
        active: result.key.isActive && !result.key.expired,
      },
    }, { status: result.reused ? 200 : 201 });
  } catch (error) {
    const message = error?.message || "Could not activate license";
    const status = /required|valid customer email|invalid plan|orderId already belongs/i.test(message) ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
