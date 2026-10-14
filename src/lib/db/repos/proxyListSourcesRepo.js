import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";

export const SOURCE_PROTOCOLS = ["auto", "http", "socks4", "socks5"];

function rowToSource(row) {
  if (!row) return null;
  const extra = parseJson(row.data, {});
  return {
    ...extra,
    id: row.id,
    isActive: row.isActive === 1 || row.isActive === true,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function sourceToRow(s) {
  const { id, isActive, createdAt, updatedAt, ...rest } = s;
  return {
    id,
    isActive: isActive === false ? 0 : 1,
    data: stringifyJson(rest),
    createdAt,
    updatedAt,
  };
}

function upsert(db, s) {
  const r = sourceToRow(s);
  db.run(
    `INSERT INTO proxyListSources(id, isActive, data, createdAt, updatedAt)
     VALUES(?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       isActive=excluded.isActive,
       data=excluded.data, updatedAt=excluded.updatedAt`,
    [r.id, r.isActive, r.data, r.createdAt, r.updatedAt]
  );
}

export async function getProxyListSources(filter = {}) {
  const db = await getAdapter();
  const where = [];
  const params = [];
  if (filter.isActive !== undefined) { where.push("isActive = ?"); params.push(filter.isActive ? 1 : 0); }
  const sql = `SELECT * FROM proxyListSources${where.length ? ` WHERE ${where.join(" AND ")}` : ""}`;
  const list = db.all(sql, params).map(rowToSource);
  list.sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
  return list;
}

export async function getProxyListSourceById(id) {
  const db = await getAdapter();
  return rowToSource(db.get(`SELECT * FROM proxyListSources WHERE id = ?`, [id]));
}

export async function createProxyListSource(data) {
  const db = await getAdapter();
  const now = new Date().toISOString();
  const source = {
    id: data.id || uuidv4(),
    name: data.name,
    url: data.url,
    protocol: SOURCE_PROTOCOLS.includes(data.protocol) ? data.protocol : "auto",
    isActive: data.isActive !== undefined ? data.isActive : true,
    autoUpdate: data.autoUpdate !== undefined ? data.autoUpdate : true,
    lastFetchedAt: data.lastFetchedAt || null,
    lastStatus: data.lastStatus || null,
    lastError: data.lastError || null,
    totalFound: data.totalFound || 0,
    totalNew: data.totalNew || 0,
    totalFailed: data.totalFailed || 0,
    totalImported: data.totalImported || 0,
    createdAt: now,
    updatedAt: now,
  };
  upsert(db, source);
  return source;
}

export async function updateProxyListSource(id, data) {
  const db = await getAdapter();
  let result = null;
  db.transaction(() => {
    const row = db.get(`SELECT * FROM proxyListSources WHERE id = ?`, [id]);
    if (!row) return;
    const merged = { ...rowToSource(row), ...data, updatedAt: new Date().toISOString() };
    upsert(db, merged);
    result = merged;
  });
  return result;
}

export async function deleteProxyListSource(id) {
  const db = await getAdapter();
  let removed = null;
  db.transaction(() => {
    const row = db.get(`SELECT * FROM proxyListSources WHERE id = ?`, [id]);
    if (!row) return;
    removed = rowToSource(row);
    db.run(`DELETE FROM proxyListSources WHERE id = ?`, [id]);
  });
  return removed;
}
