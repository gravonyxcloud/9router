/**
 * Egress model-name aliasing.
 *
 * Downstream clients must see the model they asked for (combo name or
 * provider/model pair), never the real upstream model id that served the
 * request. Routing, adapters and provider splits would otherwise be
 * fingerprintable from the response `model` field.
 *
 * Applied ONLY at the client-facing edge (chatCore response handlers).
 * Internal logging, usage tracking and translators keep the resolved ids.
 */

/** Overwrite client-visible model identifiers in a response object in place. */
export function applyDisplayModel(obj, displayModel) {  if (!obj || typeof obj !== "object" || typeof displayModel !== "string" || !displayModel) {
    return obj;
  }
  if (typeof obj.model === "string") obj.model = displayModel;
  if (typeof obj.modelVersion === "string") obj.modelVersion = displayModel;
  const message = obj.message;
  if (message && typeof message === "object" && typeof message.model === "string") {
    message.model = displayModel;
  }
  const response = obj.response;
  if (response && typeof response === "object" && typeof response.model === "string") {
    response.model = displayModel;
  }
  return obj;
}

const DATA_PREFIX_RE = /^(\s*data:\s*)(.*)$/s;

/**
 * TransformStream rewriting top-level model identifiers in SSE `data:` JSON
 * lines. Everything else (event lines, [DONE], unparseable lines, message
 * content) passes through byte-identical. Fail-open by construction.
 */
export function createModelAliasStream(displayModel) {
  const decoder = new TextDecoder("utf-8", { fatal: false });
  const encoder = new TextEncoder();
  let buffer = "";

  const rewriteLine = (line) => {
    const match = line.match(DATA_PREFIX_RE);
    if (!match) return line;
    const payload = match[2].trim();
    if (!payload || payload === "[DONE]") return line;
    let obj;
    try {
      obj = JSON.parse(payload);
    } catch {
      return line;
    }
    if (!obj || typeof obj !== "object") return line;
    applyDisplayModel(obj, displayModel);
    return `${match[1]}${JSON.stringify(obj)}`;
  };

  return new TransformStream({
    transform(chunk, controller) {
      buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines) {
        controller.enqueue(encoder.encode(`${rewriteLine(line)}\n`));
      }
    },
    flush(controller) {
      try {
        buffer += decoder.decode();
        if (buffer) controller.enqueue(encoder.encode(rewriteLine(buffer)));
      } catch {
        // ignore — never break the stream tail
      }
      buffer = "";
    },
  });
}

/**
 * Fresh gateway-issued identifiers. Upstream response/message ids must never
 * reach clients: their prefixes (`gen-`, `resp_`, …) fingerprint the backend.
 * Timestamp + random suffix keeps ordering useful without leaking anything.
 */
function randSuffix() {
  return Math.random().toString(36).slice(2, 8);
}

export function freshChatCompletionId() {
  return `chatcmpl-${Date.now()}-${randSuffix()}`;
}

export function freshResponsesId() {
  return `resp_${Date.now()}${randSuffix()}`;
}

export function freshClaudeMessageId() {
  return `msg_${Date.now()}${randSuffix()}`;
}
