import { describe, it, expect } from "vitest";
import { sniffStreamHead } from "../../open-sse/utils/sniffStream.js";

const streamOf = (parts) => new ReadableStream({
  start(c) {
    for (const p of parts) c.enqueue(new TextEncoder().encode(p));
    c.close();
  },
});
const resp = (body, ct) => new Response(body, { status: 200, headers: ct ? { "Content-Type": ct } : {} });

describe("sniffStreamHead", () => {
  it("passes SSE-looking bodies through with bytes intact", async () => {
    const body = 'data: {"a":1}\n\ndata: [DONE]\n\n';
    const out = await sniffStreamHead(resp(streamOf([body]), "text/plain"), 2048, 2000);
    expect(out.kind).toBe("sse-json");
    expect(await new Response(out.body).text()).toBe(body);
  });

  it("passes JSON bodies through", async () => {
    const out = await sniffStreamHead(resp(streamOf(['{"x":1}']), ""), 2048, 2000);
    expect(out.kind).toBe("sse-json");
  });

  it("flags HTML and empty bodies", async () => {
    const html = await sniffStreamHead(resp(streamOf(["<html><title>Oops</title>"]), "text/html"), 2048, 2000);
    expect(html.kind).toBe("html");
    expect(html.body).toBeNull();
    const empty = await sniffStreamHead(resp(streamOf([]), "text/plain"), 2048, 2000);
    expect(empty.kind).toBe("empty");
  });

  it("flags garbage without consuming callers", async () => {
    const out = await sniffStreamHead(resp(streamOf(["\x00\x01binary"]), "application/octet-stream"), 2048, 2000);
    expect(out.kind).toBe("unknown");
    expect(out.body).toBeNull();
  });
});
