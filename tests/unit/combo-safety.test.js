import { describe, it, expect } from "vitest";
import {
  sanitizeComboErrorText,
  COMBO_SEAT_TIMEOUT_MS,
} from "../../open-sse/services/combo.js";

describe("combo error sanitization", () => {
  const seats = ["oc/big-pickle", "ocz/mimo-v2.6-flash"];
  it("replaces full seat ids and model parts with the combo name", () => {
    const out = sanitizeComboErrorText(
      "Upstream request failed: Model big-pickle is unavailable (oc/big-pickle, ocz/mimo-v2.6-flash)",
      seats,
      "Main",
    );
    expect(out).not.toContain("big-pickle");
    expect(out).not.toContain("oc/big-pickle");
    expect(out).not.toContain("mimo-v2.6-flash");
    expect(out).toContain("Main");
  });
  it("leaves unrelated text untouched", () => {
    expect(sanitizeComboErrorText("All combo models unavailable", seats, "Main"))
      .toBe("All combo models unavailable");
  });
  it("falls back to a generic name without combo", () => {
    expect(sanitizeComboErrorText("oc/big-pickle broke", seats, ""))
      .not.toContain("big-pickle");
  });
});

describe("combo seat timeout", () => {
  it("has a bounded default", () => {
    expect(COMBO_SEAT_TIMEOUT_MS).toBeGreaterThan(0);
    expect(COMBO_SEAT_TIMEOUT_MS).toBeLessThanOrEqual(600000);
  });
});
