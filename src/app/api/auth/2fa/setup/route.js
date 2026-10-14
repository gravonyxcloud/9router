import { NextResponse } from "next/server";
import { getSettings, updateSettings } from "@/lib/localDb";
import { generateTotpSecret, buildOtpAuthUrl, encryptTotpSecret } from "@/lib/auth/totp";
import { getServerSecret } from "@/lib/auth/dashboardSession";
import QRCode from "qrcode";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const NO_STORE = { "Cache-Control": "no-store" };
const PENDING_TTL_MS = 10 * 60 * 1000;

// Start TOTP enrollment (dashboard-authenticated via guard). Generates a
// secret kept as PENDING until confirmed — nothing is enabled yet. The
// plaintext secret is returned once for the user to type into the
// authenticator app (Google Authenticator: "Enter a setup key").
export async function POST() {
  try {
    const settings = await getSettings();
    if (settings?.totp?.enabled) {
      return NextResponse.json({ error: "Two-factor is already enabled" }, { status: 409, headers: NO_STORE });
    }
    const secret = generateTotpSecret();
    const secretEnc = encryptTotpSecret(secret, getServerSecret());
    await updateSettings({
      totpPending: { secretEnc, createdAt: new Date().toISOString() },
    });
    const otpauthUrl = buildOtpAuthUrl({ secret, account: "dashboard", issuer: "9Router" });
    let qrDataUrl = null;
    try {
      qrDataUrl = await QRCode.toDataURL(otpauthUrl, { width: 220, margin: 1 });
    } catch {
      // QR is convenience only — manual key entry below still works.
    }
    return NextResponse.json(
      {
        secret,
        otpauthUrl,
        qrDataUrl,
        expiresInSec: Math.floor(PENDING_TTL_MS / 1000),
      },
      { headers: NO_STORE },
    );
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500, headers: NO_STORE });
  }
}
