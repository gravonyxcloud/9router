/**
 * Shared response-shape converters (single source of truth).
 *
 * Lives here — not in nonStreamingHandler.js or sseToJsonHandler.js —
 * because those two import from each other (parseSSEToOpenAIResponse) and
 * must never import each other back (bundler cycle). Both import from this
 * leaf module instead.
 */
import { FORMATS } from "../../translator/formats.js";
import { fromOpenAIFinish } from "../../translator/concerns/finishReason.js";
import { sanitizeQuartetArgs } from "../../translator/concerns/toolArgs.js";
import { freshClaudeMessageId } from "../../utils/responseModelAlias.js";

export function parseToolArguments(value) {
  if (!value) return {};
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

/**
 * Convert an OpenAI Chat Completions non-streaming response body into an
 * Anthropic Claude message body. Moved verbatim from nonStreamingHandler.js.
 */
export function openAICompletionToClaudeMessage(responseBody) {
  if (!responseBody?.choices?.[0]) return responseBody;
  const choice = responseBody.choices[0];
  const message = choice.message || {};
  const content = [];

  const reasoning = message.reasoning_content || message.provider_specific_fields?.reasoning_content || "";
  if (reasoning) {
    content.push({ type: "thinking", thinking: reasoning });
  }
  if (typeof message.content === "string" && message.content.length > 0) {
    content.push({ type: "text", text: message.content });
  }
  for (const toolCall of message.tool_calls || []) {
    const fn = toolCall.function || {};
    const toolName = fn.name || toolCall.name || "";
    // Quartet args arrive in upstream camelCase (filePath/oldString/...);
    // Claude clients validate tool input strictly, so map to snake_case here.
    // (The streaming path sanitizes in openai-to-claude.js; this covers the
    // non-streaming aggregation which bypasses it.)
    const input = sanitizeQuartetArgs(toolName, parseToolArguments(fn.arguments || toolCall.arguments));
    content.push({
      type: "tool_use",
      id: toolCall.id || `toolu_${Date.now()}_${content.length}`,
      name: toolName,
      input,
    });
  }
  if (content.length === 0) content.push({ type: "text", text: "" });

  const usage = responseBody.usage || {};
  return {
    id: freshClaudeMessageId(),
    type: "message",
    role: "assistant",
    model: responseBody.model || "unknown",
    content,
    stop_reason: fromOpenAIFinish(choice.finish_reason, FORMATS.CLAUDE),
    stop_sequence: null,
    usage: {
      input_tokens: usage.prompt_tokens || usage.input_tokens || 0,
      output_tokens: usage.completion_tokens || usage.output_tokens || 0,
    },
  };
}
