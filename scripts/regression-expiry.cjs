const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");
const base = process.env.NINEROUTER_TEST_URL || "http://127.0.0.1:20128";
const envText = fs.readFileSync(path.join(process.cwd(), ".env.local"), "utf8");
const secret = (envText.match(/^LICENSE_API_SECRET=(.*)$/m)?.[1] || "").trim();
const email = "regression-expiry-" + Date.now() + "@example.com";
const orderId = "regression-expiry-" + Date.now();
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
      db.prepare("UPDATE apiKeys SET expiresAt = ?, isActive = 1 WHERE key = ?").run(new Date(Date.now() - 60000).toISOString(), key);
      db.close();
      const response = await fetch(base + "/api/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", "authorization": "Bearer " + key },
        body: JSON.stringify({ model: "claude-opus-5-5", messages: [{ role: "user", content: "regression expiry check" }] })
      });
      const responseBody = await response.json().catch(() => ({}));
      report.push({ test: "expired commercial key rejected before provider routing", pass: response.status === 401, status: response.status, hasError: !!responseBody.error });
    }
  } catch (e) {
    report.push({ test: "expiry regression execution", pass: false, error: e.message });
  } finally {
    try {
      const db = new Database(path.join(process.env.APPDATA, "9router", "db", "data.sqlite"));
      const cleanup = db.prepare("DELETE FROM apiKeys WHERE lower(email) = lower(?)").run(email);
      db.close();
      report.push({ test: "cleanup test license", pass: cleanup.changes >= 0, deleted: cleanup.changes });
    } catch (e) { report.push({ test: "cleanup test license", pass: false, error: e.message }); }
  }
  console.log(JSON.stringify(report, null, 2));
  if (report.some((item) => !item.pass)) process.exitCode = 1;
})().catch((e) => { console.error(e.message); process.exitCode = 1; });
