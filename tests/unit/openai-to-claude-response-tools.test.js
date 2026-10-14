import { describe, expect, it } from "vitest";
import { openaiToClaudeResponse } from "../../open-sse/translator/response/openai-to-claude.js";

function createState() {
  return { toolCalls: new Map(), nextBlockIndex: 0 };
}

function getInputJsonDelta(events) {
  return events.find((event) => event.type === "content_block_delta" && event.delta?.type === "input_json_delta")?.delta.partial_json;
}

describe("openaiToClaudeResponse tool argument sanitization", () => {
  it("drops invalid Read pages and clamps numeric bounds", () => {
    const state = createState();

    openaiToClaudeResponse({
      id: "chatcmpl-test-read",
      model: "test-model",
      choices: [{ delta: { tool_calls: [{ index: 0, id: "toolu_read", function: { name: "Read" } }] } }],
    }, state);

    const events = openaiToClaudeResponse({
      id: "chatcmpl-test-read",
      model: "test-model",
      choices: [{
        delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ file_path: "F:/repo/file.js", offset: -5, limit: 999999999, pages: "" }) } }] },
        finish_reason: "tool_calls",
      }],
    }, state);

    expect(JSON.parse(getInputJsonDelta(events))).toEqual({
      file_path: "F:/repo/file.js",
      offset: 0,
      limit: 2000,
    });
  });

  it("keeps valid PDF pages", () => {    const state = createState();

    openaiToClaudeResponse({
      id: "chatcmpl-test-pdf",
      model: "test-model",
      choices: [{ delta: { tool_calls: [{ index: 0, id: "toolu_pdf", function: { name: "proxy_Read" } }] } }],
    }, state);

    const events = openaiToClaudeResponse({
      id: "chatcmpl-test-pdf",
      model: "test-model",
      choices: [{
        delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ file_path: "F:/repo/doc.pdf", pages: "1-3" }) } }] },
        finish_reason: "tool_calls",
      }],
    }, state);

    expect(JSON.parse(getInputJsonDelta(events))).toEqual({
      file_path: "F:/repo/doc.pdf",
      pages: "1-3",
    });
  });

  it("maps upstream camelCase Edit args to snake_case", () => {
    const state = createState();

    openaiToClaudeResponse({
      id: "chatcmpl-test-edit",
      model: "test-model",
      choices: [{ delta: { tool_calls: [{ index: 0, id: "toolu_edit", function: { name: "edit" } }] } }],
    }, state);

    const events = openaiToClaudeResponse({
      id: "chatcmpl-test-edit",
      model: "test-model",
      choices: [{
        delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ filePath: "a.txt", oldString: "x", newString: "y", replaceAll: true }) } }] },
        finish_reason: "tool_calls",
      }],
    }, state);

    expect(JSON.parse(getInputJsonDelta(events))).toEqual({
      file_path: "a.txt",
      old_string: "x",
      new_string: "y",
      replace_all: true,
    });
  });

  it("maps Write filePath and Bash cmd to agent spellings", () => {
    const writeState = createState();
    openaiToClaudeResponse({
      id: "chatcmpl-test-write",
      model: "test-model",
      choices: [{ delta: { tool_calls: [{ index: 0, id: "toolu_write", function: { name: "write" } }] } }],
    }, writeState);
    const writeEvents = openaiToClaudeResponse({
      id: "chatcmpl-test-write",
      model: "test-model",
      choices: [{
        delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ filePath: "b.txt", content: "hi" }) } }] },
        finish_reason: "tool_calls",
      }],
    }, writeState);
    expect(JSON.parse(getInputJsonDelta(writeEvents))).toEqual({
      file_path: "b.txt",
      content: "hi",
    });

    const bashState = createState();
    openaiToClaudeResponse({
      id: "chatcmpl-test-bash",
      model: "test-model",
      choices: [{ delta: { tool_calls: [{ index: 0, id: "toolu_bash", function: { name: "bash" } }] } }],
    }, bashState);
    const bashEvents = openaiToClaudeResponse({
      id: "chatcmpl-test-bash",
      model: "test-model",
      choices: [{
        delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ cmd: "ls" }) } }] },
        finish_reason: "tool_calls",
      }],
    }, bashState);
    expect(JSON.parse(getInputJsonDelta(bashEvents))).toEqual({ command: "ls" });
  });
});
