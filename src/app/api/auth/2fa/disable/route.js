import { NextResponse } from "next/server";
import { getSettings, updateSettings } from "@/lib/localDb";
import { verifyTotp, decryptTotpSecret, findRecoveryHash } from "@/lib/auth/totp";
import { getServerSecret, verifyDashboardPassword } from "@/lib/auth/dashboardSession";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const NO_STORE = { "Cache-Control": "no-store" };

// Disable 2FA. Requires the dashboard password PLUS either a current TOTP
// code or an unused recovery code (so a stolen session alone cannot silently
// strip the second factor).
export async function POST(request) {
  try {
    const { password, code } = await request.json();
    const settings = await getSettings();
    if (!settings?.totp?.enabled) {
      return NextResponse.json({ error: "Two-factor is not enabled" }, { status: 409, headers: NO_STORE });
    }
    if (!(await verifyDashboardPassword(password))) {
      return NextResponse.json({ error: "Invalid password" }, { status: 401, headers: NO_STORE });
    }
    let secret = null;
    try {
      secret = decryptTotpSecret(settings.totp.secretEnc, getServerSecret());
    } catch {
      return NextResponse.json({ error: "Two-factor data corrupted. Reset via host CLI." }, { status: 500, headers: NO_STORE });
    }
    const totpOk = verifyTotp(secret, code);
    const recoveryOk = !totpOk && findRecoveryHash(settings.totp.recovery, code);
    if (!totpOk && !recoveryOk) {
      return NextResponse.json({ error: "Invalid authenticator code" }, { status: 401, headers: NO_STORE });
    }
    await updateSettings({ totp: null, totpPending: null });
    return NextResponse.json({ success: true }, { headers: NO_STORE });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500, headers: NO_STORE });
  }
}
