/**
 * src/lib/auth/totp.js — TOTP two-factor core (RFC 6238, Google Authenticator
 * compatible). Zero dependencies: HMAC-SHA1 + base32 over node:crypto.
 *
 * Secrets at rest are AES-256-GCM encrypted with a key derived from the
 * server JWT secret; recovery codes are stored as SHA-256 hashes (one-way,
 * like passwords) and consumed on use. Verification uses timing-safe compare
 * with a +-1 step window for clock skew. No imports from app code (leaf).
 */
import crypto from "node:crypto";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const TOTP_STEP_SEC = 30;
const TOTP_DIGITS = 6;
const TOTP_WINDOW = 1;

export function base32Encode(bytes) {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
      value &= bits > 0 ? (1 << bits) - 1 : 0;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(str) {
  const clean = String(str || "").trim().replace(/=+$/, "").replace(/[\s-]/g, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const char of clean) {
    const idx = BASE32_ALPHABET.indexOf(char);
    if (idx === -1) throw new Error("Invalid base32 secret");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
      value &= bits > 0 ? (1 << bits) - 1 : 0;
    }
  }
  return Buffer.from(bytes);
}

/** New random secret (160 bits, 32 base32 chars — Google Authenticator default). */
export function generateTotpSecret() {
  return base32Encode(crypto.randomBytes(20));
}

function hotp(secretBytes, counter) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac("sha1", secretBytes).update(msg).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code = ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3];
  return String(code % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, "0");
}

export function totpCode(secret, atMs = Date.now()) {
  const secretBytes = base32Decode(secret);
  const counter = Math.floor(atMs / 1000 / TOTP_STEP_SEC);
  return hotp(secretBytes, counter);
}

/** Verify a 6-digit code, accepting +-TOTP_WINDOW steps for clock skew. */
export function verifyTotp(secret, code, atMs = Date.now(), window = TOTP_WINDOW) {
  const clean = String(code || "").replace(/[\s-]/g, "");
  if (!/^\d{6}$/.test(clean)) return false;
  let secretBytes;
  try {
    secretBytes = base32Decode(secret);
  } catch {
    return false;
  }
  const counter = Math.floor(atMs / 1000 / TOTP_STEP_SEC);
  const candidate = Buffer.from(clean);
  for (let step = -window; step <= window; step++) {
    const expected = Buffer.from(hotp(secretBytes, counter + step));
    if (candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected)) return true;
  }
  return false;
}

/** otpauth:// URL for manual entry (account + secret into the authenticator app). */
export function buildOtpAuthUrl({ secret, account = "9router", issuer = "9Router" }) {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const params = new URLSearchParams({ secret: String(secret).replace(/\s/g, ""), issuer, digits: String(TOTP_DIGITS), period: String(TOTP_STEP_SEC), algorithm: "SHA1" });
  return `otpauth://totp/${label}?${params.toString()}`;
}

// ── secret encryption at rest (AES-256-GCM, key from server JWT secret) ─────

function encryptionKey(serverSecret) {
  return crypto.createHash("sha256").update(`9router-totp-v1\0${serverSecret}`).digest();
}

export function encryptTotpSecret(secret, serverSecret) {
  if (!serverSecret) throw new Error("Server secret required to encrypt TOTP secret");
  const key = encryptionKey(serverSecret);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(String(secret), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString("base64url")}.${tag.toString("base64url")}.${enc.toString("base64url")}`;
}

export function decryptTotpSecret(payload, serverSecret) {
  if (!serverSecret) throw new Error("Server secret required to decrypt TOTP secret");
  const parts = String(payload || "").split(".");
  if (parts.length !== 4 || parts[0] !== "v1") throw new Error("Invalid TOTP payload");
  const key = encryptionKey(serverSecret);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(parts[1], "base64url"));
  decipher.setAuthTag(Buffer.from(parts[2], "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(parts[3], "base64url")), decipher.final()]).toString("utf8");
}

// ── recovery codes (one-time, hashed at rest) ───────────────────────────────

const RECOVERY_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I

/** Generate `count` printable codes (`XXXX-XXXX`); show once, store hashes. */
export function generateRecoveryCodes(count = 10) {
  const codes = [];
  for (let i = 0; i < count; i++) {
    let part = "";
    for (let j = 0; j < 8; j++) {
      part += RECOVERY_ALPHABET[crypto.randomInt(RECOVERY_ALPHABET.length)];
    }
    codes.push(`${part.slice(0, 4)}-${part.slice(4)}`);
  }
  return codes;
}

export function hashRecoveryCode(code) {
  return crypto.createHash("sha256").update(String(code || "").trim().toUpperCase()).digest("hex");
}

/**
 * Timing-safe lookup of a recovery code in a hash list. Returns the matched
 * hash, or null. Caller removes it (one-time use).
 */
export function findRecoveryHash(hashes, code) {
  if (!Array.isArray(hashes) || !code) return null;
  const candidate = Buffer.from(hashRecoveryCode(code));
  for (const hash of hashes) {
    if (typeof hash !== "string") continue;
    const stored = Buffer.from(hash);
    if (stored.length === candidate.length && crypto.timingSafeEqual(stored, candidate)) return hash;
  }
  return null;
}
