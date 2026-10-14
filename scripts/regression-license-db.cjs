const Database = require("better-sqlite3");
const path = require("node:path");
const dbPath = path.join(process.env.APPDATA, "9router", "db", "data.sqlite");
const db = new Database(dbPath, { readonly: true });
const columns = (table) => db.prepare("PRAGMA table_info(" + table + ")").all().map((row) => row.name);
const keys = columns("apiKeys");
const usage = columns("usageHistory");
const required = ["email", "plan", "expiresAt", "hourlyTokenLimit", "orderId"];
const missing = required.filter((column) => !keys.includes(column));
const result = {
  database: dbPath,
  apiKeyLicenseColumnsPresent: missing.length === 0,
  missingLicenseColumns: missing,
  usageHistoryHasApiKey: usage.includes("apiKey"),
  usageHistoryHasTokenCounters: usage.includes("promptTokens") && usage.includes("completionTokens"),
  licenseKeyCount: db.prepare("SELECT COUNT(*) AS count FROM apiKeys WHERE plan IS NOT NULL").get().count,
};
console.log(JSON.stringify(result, null, 2));
db.close();
if (missing.length || !result.usageHistoryHasApiKey || !result.usageHistoryHasTokenCounters) process.exitCode = 1;
