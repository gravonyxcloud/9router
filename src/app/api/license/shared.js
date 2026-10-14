import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextResponse } from "next/server";

function getLicenseSecret() {
  if (process.env.LICENSE_API_SECRET) return process.env.LICENSE_API_SECRET;
  // Fallback for custom-server starts that do not bootstrap dotenv variables.
  try {
    const envText = readFileSync(join(process.cwd(), ".env.local"), "utf8");
    const line = envText.split(/\r?\n/).find((item) => item.startsWith("LICENSE_API_SECRET="));
    return line ? line.slice("LICENSE_API_SECRET=".length).trim() : "";
  } catch {
    return "";
  }
}

export function authorizeLicenseRequest(request) {
  const expected = getLicenseSecret();
  const provided = request.headers.get("x-license-secret") || "";
  if (!expected || !provided) {
    return NextResponse.json({ error: "License API is not configured" }, { status: 503 });
  }
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
}

export function normalizePlan(plan) {
  const raw = String(plan ?? "").trim().toLowerCase();
  const aliases = {
    "3": "3d", "3d": "3d", "3_days": "3d", "3-days": "3d", "3 dias": "3d",
    "7": "7d", "7d": "7d", "7_days": "7d", "7-days": "7d", "7 dias": "7d",
    "15": "15d", "15d": "15d", "15_days": "15d", "15-days": "15d", "15 dias": "15d",
    "30": "30d", "30d": "30d", "30_days": "30d", "30-days": "30d", "30 dias": "30d",
  };
  return aliases[raw] || null;
}
