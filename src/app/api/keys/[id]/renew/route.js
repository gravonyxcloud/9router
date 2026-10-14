import { NextResponse } from "next/server";
import { getApiKeyById, renewLicensedApiKey } from "@/lib/localDb";
import { normalizePlan } from "@/app/api/license/shared.js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request, { params }) {
  try {
    const { id } = await params;
    const body = await request.json();
    const plan = normalizePlan(body.plan);
    if (!plan) return NextResponse.json({ error: "Plano inválido. Escolha 3, 7, 15 ou 30 dias." }, { status: 400 });
    const existing = await getApiKeyById(id);
    if (!existing) return NextResponse.json({ error: "Chave não encontrada." }, { status: 404 });
    if (!existing.email || !existing.expiresAt) return NextResponse.json({ error: "Esta chave não é uma licença por plano." }, { status: 400 });
    const result = await renewLicensedApiKey({ email: existing.email, key: existing.key, plan });
    return NextResponse.json({ success: true, license: {
      id: result.key.id, key: result.key.key, name: result.key.name,
      email: result.key.email, plan: result.key.plan, createdAt: result.key.createdAt,
      expiresAt: result.key.expiresAt, hourlyTokenLimit: result.key.hourlyTokenLimit,
      isActive: result.key.isActive, expired: result.key.expired
    } });
  } catch (error) {
    return NextResponse.json({ error: error?.message || "Falha ao renovar licença." }, { status: 500 });
  }
}
