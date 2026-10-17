// A combo seat pointing at a retired model (HTTP 410, "has been deprecated",
// "model not found") must roll over to the next seat instead of surfacing the
// upstream error — see open-sse/services/combo.js + config/errorConfig.js.
import { describe, expect, it } from "vitest";
import { isModelGoneError, MODEL_GONE_TTL_MS } from "../../open-sse/config/errorConfig.js";
import { checkFallbackError } from "../../open-sse/services/accountFallback.js";

describe("gone-model errors fall through the combo", () => {
  it("routes status 410 to the next model", () => {
    expect(checkFallbackError(410, "").shouldFallback).toBe(true);
  });

  it("routes the opencode deprecation message", () => {
    const msg = "Model muse-spark-1.3-contributor-free has been deprecated.";
    expect(isModelGoneError(410, msg)).toBe(true);
    expect(checkFallbackError(410, msg).shouldFallback).toBe(true);
  });

  it("detects 'model <id> was not found' phrasing", () => {
    expect(isModelGoneError(400, "The model test-xyz was not found")).toBe(true);
  });

  it("does not classify a request-scoped 400 as gone", () => {
    expect(isModelGoneError(400, "invalid temperature value")).toBe(false);
    expect(checkFallbackError(400, "invalid temperature value").shouldFallback).toBe(false);
  });

  it("keeps a sane skip window", () => {
    expect(MODEL_GONE_TTL_MS).toBeGreaterThanOrEqual(60_000);
  });
});
