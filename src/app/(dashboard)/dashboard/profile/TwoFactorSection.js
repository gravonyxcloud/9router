"use client";

import { useState, useEffect } from "react";
import { Button, Input } from "@/shared/components";

// Two-factor authentication (TOTP, Google Authenticator compatible).
// Self-contained: enrollment (setup → confirm), recovery-code display,
// disable. Secrets only travel on their dedicated responses, never via
// /api/settings (which strips them).
export default function TwoFactorSection() {
  const [enabled, setEnabled] = useState(null);
  const [step, setStep] = useState("idle"); // idle | setup | recovery
  const [secret, setSecret] = useState("");
  const [otpauthUrl, setOtpauthUrl] = useState("");
  const [qrDataUrl, setQrDataUrl] = useState("");
  const [code, setCode] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState([]);
  const [disablePassword, setDisablePassword] = useState("");
  const [disableCode, setDisableCode] = useState("");
  const [showDisable, setShowDisable] = useState(false);
  const [status, setStatus] = useState({ type: "", message: "" });
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  const refreshStatus = async () => {
    try {
      const res = await fetch("/api/auth/2fa/status");
      if (res.ok) {
        const data = await res.json();
        setEnabled(data.enabled === true);
      }
    } catch {
      /* leave unknown */
    }
  };

  useEffect(() => {
    let cancelled = false;
    fetch("/api/auth/2fa/status")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!cancelled && data) setEnabled(data.enabled === true);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const fail = (message) => setStatus({ type: "error", message });
  const okMsg = (message) => setStatus({ type: "success", message });

  const handleSetup = async () => {
    setLoading(true);
    setStatus({ type: "", message: "" });
    try {
      const res = await fetch("/api/auth/2fa/setup", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        fail(data.error || "Failed to start enrollment");
        return;
      }
      setSecret(data.secret || "");
      setOtpauthUrl(data.otpauthUrl || "");
      setQrDataUrl(data.qrDataUrl || "");
      setCode("");
      setStep("setup");
    } catch {
      fail("Failed to start enrollment");
    } finally {
      setLoading(false);
    }
  };

  const handleConfirm = async (e) => {
    e.preventDefault();
    setLoading(true);
    setStatus({ type: "", message: "" });
    try {
      const res = await fetch("/api/auth/2fa/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        fail(data.error || "Failed to confirm");
        return;
      }
      setRecoveryCodes(Array.isArray(data.recoveryCodes) ? data.recoveryCodes : []);
      setSecret("");
      setOtpauthUrl("");
      setQrDataUrl("");
      setCode("");
      setStep("recovery");
      setEnabled(true);
      okMsg("Two-factor enabled.");
    } catch {
      fail("Failed to confirm");
    } finally {
      setLoading(false);
    }
  };

  const handleDisable = async (e) => {
    e.preventDefault();
    setLoading(true);
    setStatus({ type: "", message: "" });
    try {
      const res = await fetch("/api/auth/2fa/disable", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: disablePassword, code: disableCode }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        fail(data.error || "Failed to disable");
        return;
      }
      setDisablePassword("");
      setDisableCode("");
      setShowDisable(false);
      setEnabled(false);
      okMsg("Two-factor disabled.");
    } catch {
      fail("Failed to disable");
    } finally {
      setLoading(false);
    }
  };

  const copySecret = async () => {
    try {
      await navigator.clipboard.writeText(secret);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard unavailable — user selects manually */
    }
  };

  return (
    <div className="flex flex-col gap-4 pt-4 border-t border-border/50">
      <div className="flex items-start sm:items-center justify-between gap-4">
        <div className="flex-1 min-w-0">
          <p className="font-medium text-sm sm:text-base">
            Two-factor authentication{" "}
            {enabled === true && (
              <span className="ml-1 text-[11px] px-2 py-0.5 rounded-full bg-green-500/10 text-green-600 dark:text-green-400 border border-green-500/20 align-middle">
                ON
              </span>
            )}
          </p>
          <p className="text-xs sm:text-sm text-text-muted">
            TOTP codes from Google Authenticator (or any compatible app) are required at login.
          </p>
        </div>
        {enabled === false && (
          <Button type="button" variant="secondary" loading={loading} onClick={handleSetup} className="shrink-0">
            Enable
          </Button>
        )}
      </div>

      {status.message && (
        <p className={`text-xs sm:text-sm ${status.type === "error" ? "text-red-500" : "text-green-500"}`}>
          {status.message}
        </p>
      )}

      {step === "setup" && (
        <div className="flex flex-col gap-3 p-3 rounded-lg bg-black/5 dark:bg-white/5 border border-border/50">
          <p className="text-xs sm:text-sm">
            1. Scan this QR code with your authenticator app (Google Authenticator, Authy, 1Password…):
          </p>
          {qrDataUrl ? (
            <div className="flex justify-center bg-white p-3 rounded-lg self-center">
              {/* eslint-disable-next-line @next/next/no-img-element — runtime data-URL (3KB QR), nothing to optimize */}
              <img src={qrDataUrl} alt="TOTP enrollment QR code" width={200} height={200} />
            </div>
          ) : (
            <p className="text-xs text-amber-600 dark:text-amber-400">
              QR unavailable — use the manual key below instead.
            </p>
          )}
          <p className="text-xs sm:text-sm">
            Or choose <b>Enter a setup key</b> with account <b>9Router</b> and this key:
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 font-mono text-sm break-all bg-sidebar px-2 py-1.5 rounded select-all">{secret}</code>
            <Button type="button" variant="secondary" onClick={copySecret} className="shrink-0">
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
          {otpauthUrl && (
            <p className="text-[11px] text-text-muted break-all">
              Manual setup URL: <span className="font-mono select-all">{otpauthUrl}</span>
            </p>
          )}
          <form onSubmit={handleConfirm} className="flex flex-col gap-2">
            <label className="text-xs sm:text-sm font-medium">2. Enter the 6-digit code to confirm</label>
            <div className="flex gap-2">
              <Input
                placeholder="123456"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                required
                autoFocus
                inputMode="numeric"
                autoComplete="one-time-code"
              />
              <Button type="submit" variant="primary" loading={loading} disabled={!code} className="shrink-0">
                Confirm
              </Button>
            </div>
          </form>
        </div>
      )}

      {step === "recovery" && recoveryCodes.length > 0 && (
        <div className="flex flex-col gap-3 p-3 rounded-lg bg-amber-500/10 border border-amber-500/20">
          <p className="text-xs sm:text-sm text-amber-700 dark:text-amber-300">
            <b>Save these recovery codes now</b> — each works once if you lose your phone. They will never be shown again.
          </p>
          <div className="grid grid-cols-2 gap-1.5">
            {recoveryCodes.map((c) => (
              <code key={c} className="font-mono text-sm bg-sidebar px-2 py-1 rounded select-all">{c}</code>
            ))}
          </div>
          <Button type="button" variant="secondary" onClick={() => { setStep("idle"); setRecoveryCodes([]); }} className="self-start">
            I saved them
          </Button>
        </div>
      )}

      {enabled === true && (
        <div className="flex flex-col gap-3">
          {!showDisable ? (
            <Button type="button" variant="secondary" onClick={() => setShowDisable(true)} className="self-start">
              Disable two-factor
            </Button>
          ) : (
            <form onSubmit={handleDisable} className="flex flex-col gap-3 p-3 rounded-lg bg-black/5 dark:bg-white/5 border border-border/50">
              <p className="text-xs sm:text-sm text-text-muted">
                Confirm with your password plus a current authenticator code (or an unused recovery code).
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="flex flex-col gap-2">
                  <label className="text-xs sm:text-sm font-medium">Current password</label>
                  <Input
                    type="password"
                    placeholder="Enter current password"
                    value={disablePassword}
                    onChange={(e) => setDisablePassword(e.target.value)}
                    required
                  />
                </div>
                <div className="flex flex-col gap-2">
                  <label className="text-xs sm:text-sm font-medium">Authenticator code</label>
                  <Input
                    placeholder="123456 or XXXX-XXXX"
                    value={disableCode}
                    onChange={(e) => setDisableCode(e.target.value)}
                    required
                    inputMode="numeric"
                  />
                </div>
              </div>
              <div className="flex gap-2">
                <Button type="submit" variant="primary" loading={loading} disabled={!disablePassword || !disableCode}>
                  Disable
                </Button>
                <Button type="button" variant="secondary" onClick={() => { setShowDisable(false); setDisablePassword(""); setDisableCode(""); }}>
                  Cancel
                </Button>
              </div>
            </form>
          )}
        </div>
      )}
    </div>
  );
}
