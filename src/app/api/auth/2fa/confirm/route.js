import { NextResponse } from "next/server";
import { getSettings, updateSettings } from "@/lib/localDb";
import {
  verifyTotp,
  decryptTotpSecret,
  generateRecoveryCodes,
  hashRecoveryCode,
} from "@/lib/auth/totp";
import { getServerSecret } from "@/lib/auth/dashboardSession";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const NO_STORE = { "Cache-Control": "no-store" };
const PENDING_TTL_MS = 10 * 60 * 1000;

// Confirm enrollment with a code from the authenticator app. Enables 2FA and
// returns the recovery codes IN PLAINTEXT exactly once — the UI must display
// them for saving; only hashes are persisted.
export async function POST(request) {
  try {
    const { code } = await request.json();
    const settings = await getSettings();
    if (settings?.totp?.enabled) {
      return NextResponse.json({ error: "Two-factor is already enabled" }, { status: 409, headers: NO_STORE });
    }
    const pending = settings?.totpPending;
    if (!pending?.secretEnc || !pending?.createdAt) {
      return NextResponse.json({ error: "No pending enrollment. Start setup first." }, { status: 400, headers: NO_STORE });
    }
    if (Date.now() - new Date(pending.createdAt).getTime() > PENDING_TTL_MS) {
      await updateSettings({ totpPending: null });
      return NextResponse.json({ error: "Enrollment expired. Start setup again." }, { status: 410, headers: NO_STORE });
    }
    let secret;
    try {
      secret = decryptTotpSecret(pending.secretEnc, getServerSecret());
    } catch {
      await updateSettings({ totpPending: null });
      return NextResponse.json({ error: "Enrollment corrupted. Start setup again." }, { status: 400, headers: NO_STORE });
    }
    if (!verifyTotp(secret, code)) {
      return NextResponse.json({ error: "Invalid code. Check the authenticator app time." }, { status: 401, headers: NO_STORE });
    }
    const recoveryCodes = generateRecoveryCodes(10);
    await updateSettings({
      totp: {
        enabled: true,
        secretEnc: pending.secretEnc,
        recovery: recoveryCodes.map(hashRecoveryCode),
        enrolledAt: new Date().toISOString(),
      },
      totpPending: null,
    });
    return NextResponse.json({ success: true, recoveryCodes }, { headers: NO_STORE });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500, headers: NO_STORE });
  }
}
