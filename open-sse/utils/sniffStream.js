/**
 * Peek at the first bytes of a response body without consuming it.
 *
 * Proxies sometimes strip or rewrite content-type (and some upstreams omit
 * it on valid SSE), so refusing non-SSE content-types blindly kills working
 * streams. Returns { kind, preview, body }: kind is 'sse-json' (data: /
 * event: / {/[ prefix), 'html' (< prefix), 'empty' (EOF, no bytes) or
 * 'unknown'; preview is decoded text (clamped); body is a fresh
 * ReadableStream with the buffered bytes prepended (null unless sse-json).
 * Bounded by maxBytes and timeoutMs — never hangs the request path.
 * No imports (leaf, safe for handlers + plain-node checks).
 */
export async function sniffStreamHead(response, maxBytes = 2048, timeoutMs = 5000) {
  const rawBody = response?.body;
  if (!rawBody || typeof rawBody.getReader !== "function") {
    return { kind: "unknown", preview: "", body: null };
  }
  const reader = rawBody.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: false });
  const chunks = [];
  let received = 0;
  try {
    while (received < maxBytes) {
      const chunk = await Promise.race([
        reader.read(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("sniff timeout")), timeoutMs)),
      ]);
      if (chunk.done) break;
      if (chunk.value) {
        const bytes = typeof chunk.value === "string"
          ? new TextEncoder().encode(chunk.value)
          : chunk.value;
        chunks.push(bytes);
        received += bytes.length;
      }
    }
  } catch {
    // Timeout or read error: classify whatever was buffered (possibly empty).
  } finally {
    try { reader.releaseLock(); } catch { /* ignore */ }
  }
  let preview = "";
  try {
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const joined = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      joined.set(c, offset);
      offset += c.length;
    }
    preview = decoder.decode(joined).slice(0, 512);
  } catch { /* ignore */ }
  const head = preview.trimStart();
  if (!head) return { kind: "empty", preview, body: null };
  if (head.startsWith("data:") || head.startsWith("event:") || head.startsWith("{") || head.startsWith("[")) {
    const buffered = chunks;
    let restReader = null;
    const body = new ReadableStream({
      async start(controller) {
        try {
          for (const c of buffered) controller.enqueue(c);
          restReader = rawBody.getReader();
          for (;;) {
            const { value, done } = await restReader.read();
            if (done) break;
            if (value) controller.enqueue(value);
          }
          controller.close();
        } catch (err) {
          controller.error(err);
        }
      },
      cancel(reason) {
        try { restReader?.cancel(reason); } catch { /* ignore */ }
      },
    });
    return { kind: "sse-json", preview, body };
  }
  if (head.startsWith("<")) return { kind: "html", preview, body: null };
  return { kind: "unknown", preview, body: null };
}
