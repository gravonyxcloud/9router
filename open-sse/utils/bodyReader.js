/**
 * Bounded body reader for aggregation paths (non-streaming clients).
 *
 * Streaming responses enforce inter-chunk stalls in the pipe; but the
 * sse-to-json / non-streaming handlers historically awaited
 * `response.text()` unbounded — a trickling or wedged upstream hangs the
 * client forever. This reader resets a stall timer on every chunk and throws
 * on silence, so the caller can 504 and the combo can fail over. No imports
 * (leaf, safe for handlers + plain-node checks).
 */
export class UpstreamStallError extends Error {
  constructor(stallMs) {
    super(`Upstream stalled: no body bytes for ${Math.round(stallMs / 1000)}s`);
    this.name = "UpstreamStallError";
    this.stallMs = stallMs;
  }
}

export async function readBodyWithStallTimeout(response, stallMs, onFirstByte = null) {
  const body = response?.body;
  // Non-streaming bodies (already buffered) need no stall tracking.
  if (!body || typeof body.getReader !== "function") {
    return response?.text ? await response.text() : "";
  }
  const budget = Number(stallMs) > 0 ? Number(stallMs) : 180000;
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let text = "";
  let timer = null;
  let firstByte = false;
  try {
    while (true) {
      if (timer) clearTimeout(timer);
      let chunk;
      try {
        chunk = await Promise.race([
          reader.read(),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new UpstreamStallError(budget)), budget);
          }),
        ]);
      } finally {
        if (timer) { clearTimeout(timer); timer = null; }
      }
      if (chunk.done) break;
      if (chunk.value) {
        text += typeof chunk.value === "string" ? chunk.value : decoder.decode(chunk.value, { stream: true });
        if (!firstByte) {
          firstByte = true;
          try { onFirstByte?.(); } catch { /* ignore */ }
        }
      }
    }
    try { text += decoder.decode(); } catch { /* ignore */ }
    try {
      await reader.cancel();
    } catch { /* ignore reading remainder on clean EOF */ }
    try { reader.releaseLock(); } catch { /* ignore */ }
    return text;
  } catch (err) {
    try { await reader.cancel().catch(() => {}); } catch { /* ignore */ }
    try { reader.releaseLock(); } catch { /* ignore */ }
    throw err;
  }
}

export async function readJsonWithStallTimeout(response, stallMs) {
  const text = await readBodyWithStallTimeout(response, stallMs);
  return JSON.parse(text);
}
