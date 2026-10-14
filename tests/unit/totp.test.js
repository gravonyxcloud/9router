import { describe, it, expect } from "vitest";
import {
  base32Encode,
  base32Decode,
  generateTotpSecret,
  totpCode,
  verifyTotp,
  buildOtpAuthUrl,
  encryptTotpSecret,
  decryptTotpSecret,
  generateRecoveryCodes,
  hashRecoveryCode,
  findRecoveryHash,
} from "@/lib/auth/totp.js";

// RFC 6238 Appendix B vectors (SHA1, ASCII secret "12345678901234567890").
const RFC_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

describe("totp — RFC 6238 vectors", () => {
  it("matches Appendix B 6-digit codes", () => {
    expect(totpCode(RFC_SECRET, 59 * 1000)).toBe("287082");
    expect(totpCode(RFC_SECRET, 1111111109 * 1000)).toBe("081804");
    expect(totpCode(RFC_SECRET, 1234567890 * 1000)).toBe("005924");
  });

  it("accepts +-1 step window, rejects outside", () => {
    expect(verifyTotp(RFC_SECRET, "287082", 59 * 1000)).toBe(true);
    expect(verifyTotp(RFC_SECRET, "287082", 89 * 1000)).toBe(true);
    expect(verifyTotp(RFC_SECRET, "287082", 120 * 1000)).toBe(false);
  });

  it("rejects wrong, malformed and bad-secret inputs", () => {
    expect(verifyTotp(RFC_SECRET, "000000", 59 * 1000)).toBe(false);
    expect(verifyTotp(RFC_SECRET, "abc", 59 * 1000)).toBe(false);
    expect(verifyTotp("!!!", "287082", 59 * 1000)).toBe(false);
  });
});

describe("totp — primitives", () => {
  it("round-trips base32", () => {
    const bytes = Buffer.from("hello-world-test-123", "utf8");
    expect(Buffer.from(base32Decode(base32Encode(bytes))).equals(bytes)).toBe(true);
  });

  it("generates 32-char secrets", () => {
    expect(generateTotpSecret()).toMatch(/^[A-Z2-7]{32}$/);
  });

  it("builds an otpauth URL", () => {
    const url = buildOtpAuthUrl({ secret: RFC_SECRET, account: "admin", issuer: "9Router" });
    expect(url.startsWith("otpauth://totp/9Router:admin?")).toBe(true);
    expect(url).toContain(`secret=${RFC_SECRET}`);
  });
});

describe("totp — storage", () => {
  it("round-trips AES-GCM and rejects wrong keys", () => {
    const enc = encryptTotpSecret(RFC_SECRET, "server-secret-x");
    expect(enc.startsWith("v1.")).toBe(true);
    expect(decryptTotpSecret(enc, "server-secret-x")).toBe(RFC_SECRET);
    expect(() => decryptTotpSecret(enc, "wrong-secret")).toThrow();
  });

  it("matches recovery codes case-insensitively and rejects unknown", () => {
    const codes = generateRecoveryCodes(10);
    expect(codes).toHaveLength(10);
    const hashes = codes.map(hashRecoveryCode);
    expect(findRecoveryHash(hashes, codes[3].toLowerCase())).toBe(hashes[3]);
    expect(findRecoveryHash(hashes, "ZZZZ-ZZZZ")).toBeNull();
  });
});
