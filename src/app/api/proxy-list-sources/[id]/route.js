import { NextResponse } from "next/server";
import {
  deleteProxyListSource,
  getProxyListSourceById,
  updateProxyListSource,
} from "@/models";
import { normalizeListProtocol } from "@/lib/network/proxyListParser.js";
import { assertPublicUrl } from "@/shared/utils/ssrfGuard.js";

function normalizeSourceUpdate(body = {}) {
  const updates = {};

  if (Object.prototype.hasOwnProperty.call(body, "name")) {
    const name = typeof body?.name === "string" ? body.name.trim().slice(0, 120) : "";
    if (!name) return { error: "Name is required" };
    updates.name = name;
  }

  if (Object.prototype.hasOwnProperty.call(body, "url")) {
    const url = typeof body?.url === "string" ? body.url.trim().slice(0, 2000) : "";
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
    updates.url = parsed.toString();
  }

  if (Object.prototype.hasOwnProperty.call(body, "protocol")) {
    const protocol = normalizeListProtocol(body?.protocol);
    if (!protocol) return { error: "Protocol must be one of: auto, http, socks4, socks5" };
    updates.protocol = protocol;
  }

  if (Object.prototype.hasOwnProperty.call(body, "isActive")) {
    updates.isActive = body?.isActive === true;
  }

  if (Object.prototype.hasOwnProperty.call(body, "autoUpdate")) {
    updates.autoUpdate = body?.autoUpdate === true;
  }

  return { updates };
}

// GET /api/proxy-list-sources/[id] - Get one source
export async function GET(request, { params }) {
  try {
    const { id } = await params;
    const source = await getProxyListSourceById(id);
    if (!source) {
      return NextResponse.json({ error: "List source not found" }, { status: 404 });
    }
    return NextResponse.json({ source });
  } catch (error) {
    console.log("Error fetching proxy list source:", error);
    return NextResponse.json({ error: "Failed to fetch proxy list source" }, { status: 500 });
  }
}

// PUT /api/proxy-list-sources/[id] - Update a source
export async function PUT(request, { params }) {
  try {
    const { id } = await params;
    const existing = await getProxyListSourceById(id);
    if (!existing) {
      return NextResponse.json({ error: "List source not found" }, { status: 404 });
    }
    const body = await request.json().catch(() => ({}));
    const normalized = normalizeSourceUpdate(body);
    if (normalized.error) {
      return NextResponse.json({ error: normalized.error }, { status: 400 });
    }
    const source = await updateProxyListSource(id, normalized.updates);
    return NextResponse.json({ source });
  } catch (error) {
    console.log("Error updating proxy list source:", error);
    return NextResponse.json({ error: "Failed to update proxy list source" }, { status: 500 });
  }
}

// DELETE /api/proxy-list-sources/[id] - Remove a source.
// Imported pools are kept (they may be bound to connections); only the
// source row is deleted, so nothing the user added manually is touched.
export async function DELETE(request, { params }) {
  try {
    const { id } = await params;
    const existing = await getProxyListSourceById(id);
    if (!existing) {
      return NextResponse.json({ error: "List source not found" }, { status: 404 });
    }
    await deleteProxyListSource(id);
    return NextResponse.json({ success: true });
  } catch (error) {
    console.log("Error deleting proxy list source:", error);
    return NextResponse.json({ error: "Failed to delete proxy list source" }, { status: 500 });
  }
}
