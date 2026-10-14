import { describe, it, expect } from "vitest";
import { applyCodingAgentBehavior, CODING_AGENT_INSTRUCTIONS } from "../../src/sse/agent-orchestrator.js";

describe("coding agent behavior", () => {
  it("adds a workflow to Claude Code Anthropic requests with tools", () => {
    const input = { model: "claude-opus", system: "Existing rules", tools: [{ name: "Read", input_schema: { type: "object" } }], messages: [{ role: "user", content: "Fix the bug" }] };
    const result = applyCodingAgentBehavior(input, "claude-code/2.1");
    expect(result.applied).toBe(true);
    expect(result.body.system).toContain("Existing rules");
    expect(result.body.system).toContain("Security review");
    expect(input.system).toBe("Existing rules");
  });

  it("adds a system message for OpenCode/OpenAI chat requests", () => {
    const result = applyCodingAgentBehavior({ model: "x", tools: [{ type: "function", function: { name: "read_file" } }], messages: [{ role: "user", content: "Inspect this repo" }] }, "opencode/1.0");
    expect(result.applied).toBe(true);
    expect(result.body.messages[0].role).toBe("system");
    expect(result.body.messages[0].content).toContain("verify");
  });

  it("appends instructions to Responses API requests", () => {
    const result = applyCodingAgentBehavior({ model: "x", input: [{ role: "user", content: "fix tests" }], tools: [{ type: "function", name: "read_file" }], instructions: "Keep responses short" }, "codex_cli/1.0");
    expect(result.applied).toBe(true);
    expect(result.body.instructions).toContain("Keep responses short");
    expect(result.body.instructions).toContain(CODING_AGENT_INSTRUCTIONS);
  });

  it("does not change normal API callers", () => {
    const input = { model: "x", tools: [{ type: "function" }], messages: [{ role: "user", content: "hello" }] };
    expect(applyCodingAgentBehavior(input, "my-backend/1.0")).toEqual({ body: input, applied: false, reason: "not-coding-client" });
  });

  it("does not inject when the coding client has no tools", () => {
    const input = { model: "x", messages: [{ role: "user", content: "hello" }] };
    expect(applyCodingAgentBehavior(input, "claude-code/2.1").reason).toBe("no-tools");
  });
});
