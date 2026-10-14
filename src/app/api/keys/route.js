import { NextResponse } from "next/server";
import { getApiKeys, createApiKey, createLicensedApiKey } from "@/lib/localDb";
import { getConsistentMachineId } from "@/shared/utils/machineId";

export const dynamic = "force-dynamic";

// GET /api/keys - List API keys
export async function GET() {
  try {
    const keys = await getApiKeys();
    return NextResponse.json({ keys });
  } catch (error) {
    console.log("Error fetching keys:", error);
    return NextResponse.json({ error: "Failed to fetch keys" }, { status: 500 });
  }
}

// POST /api/keys - Create new API key
export async function POST(request) {
  try {
    const body = await request.json();
    const { name, email, plan, type = "license" } = body;
    if (type === "normal") {
      if (!name?.trim()) return NextResponse.json({ error: "Informe o nome da chave." }, { status: 400 });
      const machineId = await getConsistentMachineId();
      const key = await createApiKey(name.trim(), machineId);
      return NextResponse.json({ key: key.key, name: key.name, id: key.id, machineId: key.machineId, plan: "unlimited", expiresAt: null }, { status: 201 });
    }
    if (!email || !plan) {
      return NextResponse.json({ error: "E-mail do cliente e plano são obrigatórios para uma licença." }, { status: 400 });
    }

    const result = await createLicensedApiKey({ email, plan, name: name?.trim() || email });
    return NextResponse.json({
      key: result.key.key, name: result.key.name, id: result.key.id,
      machineId: result.key.machineId, email: result.key.email, plan: result.key.plan,
      expiresAt: result.key.expiresAt, hourlyTokenLimit: result.key.hourlyTokenLimit,
    }, { status: 201 });
  } catch (error) {
    console.log("Error creating key:", error);
    return NextResponse.json({ error: "Failed to create key" }, { status: 500 });
  }
}
