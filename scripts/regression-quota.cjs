const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");
const base = process.env.NINEROUTER_TEST_URL || "http://127.0.0.1:20128";
const envText = fs.readFileSync(path.join(process.cwd(), ".env.local"), "utf8");
const secret = (envText.match(/^LICENSE_API_SECRET=(.*)$/m)?.[1] || "").trim();
const email = "regression-quota-" + Date.now() + "@example.com";
const orderId = "regression-quota-" + Date.now();
(async () => {
  const report = [];
  let key = null;
  try {
    const activation = await fetch(base + "/api/license/activate", {
      method: "POST", headers: { "content-type": "application/json", "x-license-secret": secret },
      body: JSON.stringify({ email, plan: "3d", orderId })
    });
    const data = await activation.json();
    key = data.license?.key;
    report.push({ test: "create test license", pass: activation.status === 201 && !!key, status: activation.status });
    if (key) {
      const db = new Database(path.join(process.env.APPDATA, "9router", "db", "data.sqlite"));
      const timestamp = new Date().toISOString();
      db.prepare("INSERT INTO usageHistory(timestamp, provider, model, apiKey, promptTokens, completionTokens, status) VALUES(?,?,?,?,?,?,?)")
        .run(timestamp, "regression", "quota-test", key, 80000000, 0, "ok");
      db.close();
      const response = await fetch(base + "/api/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", "authorization": "Bearer " + key },
        body: JSON.stringify({ model: "claude-opus-5-5", messages: [{ role: "user", content: "regression quota check" }] })
      });
      const responseBody = await response.json().catch(() => ({}));
      report.push({ test: "80M hourly usage blocks further chat", pass: response.status === 429, status: response.status, errorPresent: !!responseBody.error });
    }
  } catch (e) {
    report.push({ test: "quota regression execution", pass: false, error: e.message });
  } finally {
    try {
      const db = new Database(path.join(process.env.APPDATA, "9router", "db", "data.sqlite"));
      if (key) db.prepare("DELETE FROM usageHistory WHERE apiKey = ?").run(key);
      const cleanup = db.prepare("DELETE FROM apiKeys WHERE lower(email) = lower(?)").run(email);
      db.close();
      report.push({ test: "cleanup test usage and license", pass: cleanup.changes >= 0, deletedLicenses: cleanup.changes });
    } catch (e) { report.push({ test: "cleanup", pass: false, error: e.message }); }
  }
  console.log(JSON.stringify(report, null, 2));
  if (report.some((item) => !item.pass)) process.exitCode = 1;
})().catch((e) => { console.error(e.message); process.exitCode = 1; });
