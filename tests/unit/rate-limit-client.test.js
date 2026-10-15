import { describe, it, expect } from "vitest";
import {
  createErrorResult,
  unavailableResponse,
  clampRetryAfter,
  MAX_CLIENT_RETRY_AFTER_SEC,
} from "../../open-sse/utils/error.js";

describe("client retry-after cap", () => {
  it("clamps long upstream retry-after to the cap", () => {
    expect(clampRetryAfter({ "retry-after": "85" })["retry-after"]).toBe(String(MAX_CLIENT_RETRY_AFTER_SEC));
    expect(clampRetryAfter({ "Retry-After": "120" })["Retry-After"]).toBe(String(MAX_CLIENT_RETRY_AFTER_SEC));
  });

  it("leaves short values, dates and other headers alone", () => {
    expect(clampRetryAfter({ "retry-after": "12" })["retry-after"]).toBe("12");
    expect(clampRetryAfter({ "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" })["retry-after"])
      .toBe("Wed, 21 Oct 2026 07:28:00 GMT");
    expect(clampRetryAfter({ "x-should-retry": "true" })).toEqual({ "x-should-retry": "true" });
    expect(clampRetryAfter(null)).toBeNull();
  });

  it("createErrorResult carries the capped value", () => {
    const { response } = createErrorResult(429, "limited", undefined, { "retry-after": "90" });
    expect(response.headers.get("retry-after")).toBe(String(MAX_CLIENT_RETRY_AFTER_SEC));
  });

  it("unavailableResponse caps computed seconds", () => {
    const retryAt = new Date(Date.now() + 300000).toISOString();
    const res = unavailableResponse(503, "busy", retryAt, "5m");
    expect(Number(res.headers.get("retry-after"))).toBeLessThanOrEqual(MAX_CLIENT_RETRY_AFTER_SEC);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
  });
});
