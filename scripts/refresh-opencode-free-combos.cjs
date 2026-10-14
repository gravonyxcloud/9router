const Database = require("better-sqlite3");

const DB_PATH = "C:/Users/Gabriel/AppData/Roaming/9router/db/data.sqlite";
const CATALOG_URL = "https://opencode.ai/zen/v1/models";

async function main() {
  const response = await fetch(CATALOG_URL);
  if (!response.ok) throw new Error("OpenCode model catalog returned HTTP " + response.status);
  const payload = await response.json();
  const catalog = Array.isArray(payload.data) ? payload.data : [];
  const freeIds = catalog
    .map((model) => model?.id)
    .filter((id) => typeof id === "string" && (id === "big-pickle" || id.endsWith("-free")))
    .map((id) => "oc/" + id);
  if (!freeIds.length) throw new Error("No free OpenCode models found; database was not changed.");

  const db = new Database(DB_PATH);
  try {
    const combos = db.prepare("SELECT id, name, models FROM combos ORDER BY name").all();
    if (!combos.length) throw new Error("No combos found; database was not changed.");
    const update = db.prepare("UPDATE combos SET models = ?, updatedAt = ? WHERE id = ?");
    const now = new Date().toISOString();
    const tx = db.transaction(() => {
      for (const combo of combos) {
        const existing = JSON.parse(combo.models || "[]");
        // Refresh OpenCode entries from the live catalog while retaining any other provider entries.
        const otherProviders = existing.filter((model) => typeof model !== "string" || !model.startsWith("oc/"));
        const merged = [...new Set([...otherProviders, ...freeIds])];
        update.run(JSON.stringify(merged), now, combo.id);
      }
    });
    tx();
    console.log(JSON.stringify({
      catalog: CATALOG_URL,
      freeModelsUpdated: freeIds,
      combosUpdated: combos.length,
      combos: db.prepare("SELECT name, models FROM combos ORDER BY name").all().map((row) => ({
        name: row.name,
        models: JSON.parse(row.models || "[]"),
      })),
    }, null, 2));
  } finally {
    db.close();
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
