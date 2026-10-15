import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";

function rowToPool(row) {
  if (!row) return null;
  const extra = parseJson(row.data, {});
  return {
    ...extra,
    id: row.id,
    isActive: row.isActive === 1 || row.isActive === true,
    testStatus: row.testStatus,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function poolToRow(p) {
  const { id, isActive, testStatus, createdAt, updatedAt, ...rest } = p;
  return {
    id,
    isActive: isActive === false ? 0 : 1,
    testStatus: testStatus ?? null,
    data: stringifyJson(rest),
    createdAt,
    updatedAt,
  };
}

function upsert(db, p) {
  const r = poolToRow(p);
  db.run(
    `INSERT INTO proxyPools(id, isActive, testStatus, data, createdAt, updatedAt)
     VALUES(?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       isActive=excluded.isActive, testStatus=excluded.testStatus,
       data=excluded.data, updatedAt=excluded.updatedAt`,
    [r.id, r.isActive, r.testStatus, r.data, r.createdAt, r.updatedAt]
  );
}

export async function getProxyPools(filter = {}, opts = {}) {
  const db = await getAdapter();
  const where = [];
  const params = [];
  if (filter.isActive !== undefined) { where.push("isActive = ?"); params.push(filter.isActive ? 1 : 0); }
  if (filter.testStatus) { where.push("testStatus = ?"); params.push(filter.testStatus); }
  // Paginated reads for huge fleets (64k+ rows from list imports): push
  // ordering + windowing into SQL so the page never materializes everything.
  let sql = `SELECT * FROM proxyPools${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY updatedAt DESC`;
  const limit = Number(opts.limit);
  if (Number.isFinite(limit) && limit > 0) {
    sql += ` LIMIT ${Math.min(2000, Math.floor(limit))}`;
    const offset = Number(opts.offset);
    if (Number.isFinite(offset) && offset > 0) sql += ` OFFSET ${Math.floor(offset)}`;
  }
  const list = db.all(sql, params).map(rowToPool);
  if (!Number.isFinite(limit) || !(limit > 0)) {
    list.sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
  }
  return list;
}

export async function getProxyPoolsCount(filter = {}) {
  const db = await getAdapter();
  const where = [];
  const params = [];
  if (filter.isActive !== undefined) { where.push("isActive = ?"); params.push(filter.isActive ? 1 : 0); }
  if (filter.testStatus) { where.push("testStatus = ?"); params.push(filter.testStatus); }
  const sql = `SELECT COUNT(*) as c FROM proxyPools${where.length ? ` WHERE ${where.join(" AND ")}` : ""}`;
  return db.get(sql, params)?.c ?? 0;
}

export async function getProxyPoolById(id) {
  const db = await getAdapter();
  return rowToPool(db.get(`SELECT * FROM proxyPools WHERE id = ?`, [id]));
}

export async function createProxyPool(data) {
  const db = await getAdapter();
  const now = new Date().toISOString();
  const pool = {
    id: data.id || uuidv4(),
    name: data.name,
    proxyUrl: data.proxyUrl,
    noProxy: data.noProxy || "",
    type: data.type || "http",
    isActive: data.isActive !== undefined ? data.isActive : true,
    strictProxy: data.strictProxy === true,
    testStatus: data.testStatus || "unknown",
    lastTestedAt: data.lastTestedAt || null,
    lastError: data.lastError || null,
    // TXT-list provenance (preserved in the data JSON by poolToRow).
    ...(data.sourceId ? { sourceId: data.sourceId } : {}),
    ...(data.sourceName ? { sourceName: data.sourceName } : {}),
    ...(data.autoImported ? { autoImported: true } : {}),
    // OpenCode-target verdict (second-stage probe: does upstream accept
    // traffic from this egress IP?).
    ...(data.opencodeOk !== undefined ? { opencodeOk: data.opencodeOk === true } : {}),
    ...(data.opencodeCheckedAt ? { opencodeCheckedAt: data.opencodeCheckedAt } : {}),
    createdAt: now,
    updatedAt: now,
  };
  upsert(db, pool);
  return pool;
}

export async function updateProxyPool(id, data) {
  const db = await getAdapter();
  let result = null;
  db.transaction(() => {
    const row = db.get(`SELECT * FROM proxyPools WHERE id = ?`, [id]);
    if (!row) return;
    const merged = { ...rowToPool(row), ...data, updatedAt: new Date().toISOString() };
    upsert(db, merged);
    result = merged;
  });
  return result;
}

export async function deleteProxyPool(id) {
  const db = await getAdapter();
  let removed = null;
  db.transaction(() => {
    const row = db.get(`SELECT * FROM proxyPools WHERE id = ?`, [id]);
    if (!row) return;
    removed = rowToPool(row);
    db.run(`DELETE FROM proxyPools WHERE id = ?`, [id]);
  });
  return removed;
}
