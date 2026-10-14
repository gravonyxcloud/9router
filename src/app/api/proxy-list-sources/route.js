import { NextResponse } from "next/server";
import {
  createProxyListSource,
  getProxyListSources,
} from "@/models";
import { normalizeListProtocol } from "@/lib/network/proxyListParser.js";
import { assertPublicUrl } from "@/shared/utils/ssrfGuard.js";

function normalizeSourceInput(body = {}) {
  const name = typeof body?.name === "string" ? body.name.trim().slice(0, 120) : "";
  const url = typeof body?.url === "string" ? body.url.trim().slice(0, 2000) : "";
  const protocol = normalizeListProtocol(body?.protocol ?? "auto");
  const isActive = body?.isActive === undefined ? true : body.isActive === true;
  const autoUpdate = body?.autoUpdate === undefined ? true : body.autoUpdate === true;

  if (!name) return { error: "Name is required" };
  if (!url) return { error: "List URL is required" };
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { error: "List URL is invalid" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { error: "List URL must be http(s)" };
  }
  try {
    assertPublicUrl(parsed.toString());
  } catch {
    return { error: "List URL must target a public host" };
  }
  if (!protocol) return { error: "Protocol must be one of: auto, http, socks4, socks5" };

  return { name, url: parsed.toString(), protocol, isActive, autoUpdate };
}

// GET /api/proxy-list-sources - List TXT proxy-list sources
export async function GET() {
  try {
    const sources = await getProxyListSources();
    return NextResponse.json({ sources });
  } catch (error) {
    console.log("Error fetching proxy list sources:", error);
    return NextResponse.json({ error: "Failed to fetch proxy list sources" }, { status: 500 });
  }
}

// POST /api/proxy-list-sources - Add a TXT proxy-list source
export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const normalized = normalizeSourceInput(body);
    if (normalized.error) {
      return NextResponse.json({ error: normalized.error }, { status: 400 });
    }
    const source = await createProxyListSource(normalized);
    return NextResponse.json({ source }, { status: 201 });
  } catch (error) {
    console.log("Error creating proxy list source:", error);
    return NextResponse.json({ error: "Failed to create proxy list source" }, { status: 500 });
  }
}
