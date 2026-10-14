import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";
import { keyAccessFromColumns, keyAccessToColumns } from "@/shared/utils/keyAccess.js";
import { KEY_ACCESS_UNRESTRICTED } from "@/shared/constants/keyAccess.js";
import { getConsistentMachineId } from "@/shared/utils/machineId.js";

export const LICENSE_PLANS = Object.freeze({ "3d": 3, "7d": 7, "15d": 15, "30d": 30 });
export const DEFAULT_HOURLY_TOKEN_LIMIT = 80_000_000;

function rowToKey(row) {
  if (!row) return null;
  return {
    id: row.id, key: row.key, name: row.name, machineId: row.machineId,
    isActive: row.isActive === 1 || row.isActive === true,
    createdAt: row.createdAt, email: row.email || null, plan: row.plan || null,
    expiresAt: row.expiresAt || null,
    hourlyTokenLimit: Number(row.hourlyTokenLimit || DEFAULT_HOURLY_TOKEN_LIMIT),
    orderId: row.orderId || null,
    expired: Boolean(row.expiresAt && Date.parse(row.expiresAt) <= Date.now()),
    access: keyAccessFromColumns(row.accessRestricted, row.accessAllow),
  };
}

export async function getApiKeys() {
  const db = await getAdapter();
  return db.all(`SELECT * FROM apiKeys ORDER BY createdAt ASC`).map(rowToKey);
}
export async function getApiKeyById(id) {
  const db = await getAdapter();
  return rowToKey(db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]));
}
export async function getApiKeyByKey(key) {
  if (!key) return null;
  const db = await getAdapter();
  return rowToKey(db.get(`SELECT * FROM apiKeys WHERE key = ?`, [key]));
}
export async function getApiKeyByEmail(email) {
  if (!email) return null;
  const db = await getAdapter();
  return rowToKey(db.get(`SELECT * FROM apiKeys WHERE lower(email) = lower(?) ORDER BY createdAt DESC LIMIT 1`, [email.trim()]));
}

export async function createApiKey(name, machineId) {
  if (!machineId) throw new Error("machineId is required");
  const db = await getAdapter();
  const { generateApiKeyWithMachine } = await import("@/shared/utils/apiKey");
  const result = generateApiKeyWithMachine(machineId);
  const apiKey = {
    id: uuidv4(), name, key: result.key, machineId, isActive: true,
    createdAt: new Date().toISOString(), access: { restricted: false, allow: [] },
  };
  const cols = keyAccessToColumns(KEY_ACCESS_UNRESTRICTED);
  db.run(
    `INSERT INTO apiKeys(id, key, name, machineId, isActive, createdAt, accessRestricted, accessAllow, hourlyTokenLimit)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [apiKey.id, apiKey.key, apiKey.name, apiKey.machineId, 1, apiKey.createdAt, cols.accessRestricted, cols.accessAllow, DEFAULT_HOURLY_TOKEN_LIMIT]
  );
  return apiKey;
}

function normalizeEmail(email) {
  const value = typeof email === "string" ? email.trim().toLowerCase() : "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) throw new Error("A valid customer email is required");
  return value;
}
function planDays(plan) {
  const days = LICENSE_PLANS[plan];
  if (!days) throw new Error("Invalid plan. Use 3d, 7d, 15d, or 30d");
  return days;
}
function addDays(iso, days) {
  return new Date(new Date(iso).getTime() + days * 24 * 60 * 60 * 1000).toISOString();
}

export async function createLicensedApiKey({ email, plan, orderId, name }) {
  const normalizedEmail = normalizeEmail(email);
  const days = planDays(plan);
  const normalizedOrderId = typeof orderId === "string" ? orderId.trim() : "";
  const db = await getAdapter();
  if (normalizedOrderId) {
    const existingOrder = db.get(`SELECT * FROM apiKeys WHERE orderId = ?`, [normalizedOrderId]);
    if (existingOrder) {
      if (String(existingOrder.email || "").toLowerCase() !== normalizedEmail) throw new Error("orderId already belongs to another customer");
      return { key: rowToKey(existingOrder), reused: true };
    }
  }
  const machineId = await getConsistentMachineId();
  const { generateApiKeyWithMachine } = await import("@/shared/utils/apiKey");
  const generated = generateApiKeyWithMachine(machineId);
  const now = new Date().toISOString();
  const license = {
    id: uuidv4(), key: generated.key, name: name?.trim() || normalizedEmail,
    machineId, isActive: true, createdAt: now, email: normalizedEmail, plan,
    expiresAt: addDays(now, days), hourlyTokenLimit: DEFAULT_HOURLY_TOKEN_LIMIT,
    orderId: normalizedOrderId || null,
  };
  const cols = keyAccessToColumns(KEY_ACCESS_UNRESTRICTED);
  db.run(
    `INSERT INTO apiKeys(id,key,name,machineId,isActive,createdAt,accessRestricted,accessAllow,email,plan,expiresAt,hourlyTokenLimit,orderId)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [license.id, license.key, license.name, license.machineId, 1, now, cols.accessRestricted, cols.accessAllow,
      license.email, license.plan, license.expiresAt, license.hourlyTokenLimit, license.orderId]
  );
  return { key: rowToKey(db.get(`SELECT * FROM apiKeys WHERE id = ?`, [license.id])), reused: false };
}

export async function renewLicensedApiKey({ email, plan, orderId, key: suppliedKey }) {
  const normalizedEmail = normalizeEmail(email);
  const days = planDays(plan);
  const normalizedOrderId = typeof orderId === "string" ? orderId.trim() : "";
  const db = await getAdapter();
  if (normalizedOrderId) {
    const existingOrder = db.get(`SELECT * FROM apiKeys WHERE orderId = ?`, [normalizedOrderId]);
    if (existingOrder) {
      if (String(existingOrder.email || "").toLowerCase() !== normalizedEmail) throw new Error("orderId already belongs to another customer");
      return { key: rowToKey(existingOrder), reused: true };
    }
  }
  if (typeof suppliedKey !== "string" || !suppliedKey.trim()) throw new Error("API key is required for renewal");
  const row = db.get(`SELECT * FROM apiKeys WHERE key = ? AND lower(email) = lower(?)`, [suppliedKey.trim(), normalizedEmail]);
  if (!row) throw new Error("API key does not belong to this email");
  const now = new Date().toISOString();
  const base = row.expiresAt && Date.parse(row.expiresAt) > Date.now() ? row.expiresAt : now;
  const expiresAt = addDays(base, days);
  db.run(`UPDATE apiKeys SET plan = ?, expiresAt = ?, isActive = 1, orderId = ?, hourlyTokenLimit = ? WHERE id = ?`,
    [plan, expiresAt, normalizedOrderId || row.orderId || null, DEFAULT_HOURLY_TOKEN_LIMIT, row.id]);
  return { key: rowToKey(db.get(`SELECT * FROM apiKeys WHERE id = ?`, [row.id])), reused: false };
}

export async function updateApiKey(id, data) {
  const db = await getAdapter();
  let result = null;
  db.transaction(() => {
    const row = db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]);
    if (!row) return;
    const merged = { ...rowToKey(row), ...data };
    const cols = keyAccessToColumns(merged.access);
    db.run(
      `UPDATE apiKeys SET key = ?, name = ?, machineId = ?, isActive = ?, accessRestricted = ?, accessAllow = ? WHERE id = ?`,
      [merged.key, merged.name, merged.machineId, merged.isActive ? 1 : 0, cols.accessRestricted, cols.accessAllow, id]
    );
    result = rowToKey(db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]));
  });
  return result;
}
export async function deleteApiKey(id) {
  const db = await getAdapter();
  const res = db.run(`DELETE FROM apiKeys WHERE id = ?`, [id]);
  return (res?.changes ?? 0) > 0;
}
export async function validateApiKey(key) {
  const db = await getAdapter();
  const row = db.get(`SELECT isActive, expiresAt FROM apiKeys WHERE key = ?`, [key]);
  if (!row || !(row.isActive === 1 || row.isActive === true)) return false;
  if (row.expiresAt && Date.parse(row.expiresAt) <= Date.now()) return false;
  return true;
}


// Rolling-hour usage from the gateway's persisted request accounting.
export async function getHourlyTokenUsage(key) {
  const db = await getAdapter();
  const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const row = db.get(
    `SELECT COALESCE(SUM(promptTokens + completionTokens), 0) AS total
     FROM usageHistory WHERE apiKey = ? AND timestamp >= ?`,
    [key, since]
  );
  const license = await getApiKeyByKey(key);
  return {
    used: Number(row?.total || 0),
    limit: Number(license?.hourlyTokenLimit || DEFAULT_HOURLY_TOKEN_LIMIT),
    resetAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  };
}
