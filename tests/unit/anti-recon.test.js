import { describe, it, expect } from "vitest";
import {
  freshChatCompletionId,
  freshResponsesId,
  freshClaudeMessageId,
  applyDisplayModel,
} from "../../open-sse/utils/responseModelAlias.js";
import { buildErrorBody } from "../../open-sse/utils/error.js";

describe("anti-recon ids", () => {
  it("issues fresh gateway ids that never embed upstream values", () => {
    expect(freshChatCompletionId()).toMatch(/^chatcmpl-\d+-[a-z0-9]+$/);
    expect(freshResponsesId()).toMatch(/^resp_\d+[a-z0-9]+$/);
    expect(freshClaudeMessageId()).toMatch(/^msg_\d+[a-z0-9]+$/);
    // uniqueness across a burst (no Date.now() collisions)
    const ids = new Set(Array.from({ length: 50 }, freshChatCompletionId));
    expect(ids.size).toBe(50);
  });

  it("still rewrites model fields to the display alias", () => {
    const obj = { model: "oc/big-pickle", choices: [{ delta: {} }] };
    applyDisplayModel(obj, "Main");
    expect(obj.model).toBe("Main");
  });
});

describe("anti-recon error bodies", () => {
  const bodies = [
    buildErrorBody(400, "Expected temperature to be at most 2, received 5"),
    buildErrorBody(429, "`temperature` The number must be `<= 2.0`."),
    buildErrorBody(502, "Upstream request failed: Model big-pickle is unavailable (cause: wat)"),
    buildErrorBody(503, "oc/mimo-v2.6-flash is overloaded, capacity gone"),
  ];
  it("never echoes vendor wording, model ids or providers", () => {
    for (const b of bodies) {
      const text = JSON.stringify(b);
      expect(text).not.toMatch(/temperature|big-pickle|mimo|oc\/|\(cause:|Upstream request failed/i);
    }
  });
  it("keeps status-specific type/code with a fixed message", () => {
    expect(buildErrorBody(429, "anything").error).toEqual({
      message: "Rate limited. Retry shortly.",
      type: "rate_limit_error",
      code: "rate_limit_exceeded",
    });
    expect(buildErrorBody(400, "anything").error.message).toBe("Invalid request.");
    expect(buildErrorBody(500, "anything").error.message).toBe("Upstream unavailable.");
  });
});
