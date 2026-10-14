import { NextResponse } from "next/server";
import { getSettings } from "@/lib/localDb";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const NO_STORE = { "Cache-Control": "no-store" };

// Public shape only: whether a second step is required. Never leaks secrets,
// hashes, pending state or recovery counts.
export async function GET() {
  try {
    const settings = await getSettings();
    return NextResponse.json({ enabled: settings?.totp?.enabled === true }, { headers: NO_STORE });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500, headers: NO_STORE });
  }
}
