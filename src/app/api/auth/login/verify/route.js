import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getSettings, updateSettings } from "@/lib/localDb";
import { verifyTotp, decryptTotpSecret, findRecoveryHash } from "@/lib/auth/totp";
import {
  setDashboardAuthCookie,
  verifyLoginChallenge,
  getServerSecret,
} from "@/lib/auth/dashboardSession";
import { checkLock, recordFail, recordSuccess, getClientIp } from "@/lib/auth/loginLimiter";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const NO_STORE = { "Cache-Control": "no-store" };

// Second login step. Accepts a valid challenge (proves password auth within
// the last 5 minutes) plus either a current TOTP code or an unused recovery
// code. Rate-limited per IP like the password step. Only here is the session
// cookie issued.
export async function POST(request) {
  try {
    const ip = getClientIp(request);
    const lock = checkLock(ip);
    if (lock.locked) {
      return NextResponse.json(
        { error: `Too many failed attempts. Try again in ${lock.retryAfter}s.`, retryAfter: lock.retryAfter },
        { status: 429, headers: { ...NO_STORE, "Retry-After": String(lock.retryAfter) } },
      );
    }

    const { challenge, code } = await request.json();
    if (!(await verifyLoginChallenge(challenge))) {
      return NextResponse.json({ error: "Expired or invalid challenge. Log in again." }, { status: 401, headers: NO_STORE });
    }
    const settings = await getSettings();
    if (settings?.totp?.enabled !== true) {
      return NextResponse.json({ error: "Two-factor is not enabled" }, { status: 409, headers: NO_STORE });
    }

    let secret = null;
    try {
      secret = decryptTotpSecret(settings.totp.secretEnc, getServerSecret());
    } catch {
      return NextResponse.json({ error: "Two-factor data corrupted. Reset via host CLI." }, { status: 500, headers: NO_STORE });
    }

    let viaRecovery = null;
    if (!verifyTotp(secret, code)) {
      viaRecovery = findRecoveryHash(settings.totp.recovery, code);
      if (!viaRecovery) {
        const { remainingBeforeLock } = recordFail(ip);
        const postLock = checkLock(ip);
        if (postLock.locked) {
          return NextResponse.json(
            { error: `Too many failed attempts. Try again in ${postLock.retryAfter}s.`, retryAfter: postLock.retryAfter },
            { status: 429, headers: { ...NO_STORE, "Retry-After": String(postLock.retryAfter) } },
          );
        }
        return NextResponse.json(
          { error: `Invalid code. ${remainingBeforeLock} attempt(s) left before lockout.` },
          { status: 401, headers: NO_STORE },
        );
      }
      // One-time use: burn the recovery code now.
      await updateSettings({
        totp: {
          ...settings.totp,
          recovery: (settings.totp.recovery || []).filter((h) => h !== viaRecovery),
        },
      });
    }

    recordSuccess(ip);
    const cookieStore = await cookies();
    await setDashboardAuthCookie(cookieStore, request);
    return NextResponse.json({ success: true, viaRecovery: !!viaRecovery }, { headers: NO_STORE });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500, headers: NO_STORE });
  }
}
