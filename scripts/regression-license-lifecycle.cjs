const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");
const base = process.env.NINEROUTER_TEST_URL || "http://127.0.0.1:20128";
const envText = fs.readFileSync(path.join(process.cwd(), ".env.local"), "utf8");
const secret = (process.env.LICENSE_API_SECRET || envText.match(/^LICENSE_API_SECRET=(.*)$/m)?.[1] || "").trim();
const email = "regression-" + Date.now() + "@example.com";
const order1 = "regression-activate-" + Date.now();
const order2 = "regression-renew-" + Date.now();
async function post(route, body) {
  const r = await fetch(base + route, { method: "POST", headers: { "content-type": "application/json", "x-license-secret": secret }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
(async () => {
  let failures = 0;
  const report = (name, pass, detail) => { console.log(JSON.stringify({ test: name, pass, detail })); if (!pass) failures++; };
  let activated;
  try {
    if (secret.length < 32) throw new Error("LICENSE_API_SECRET is missing/too short");
    const activation = await post("/api/license/activate", { email, plan: "3d", orderId: order1 });
    activated = activation.body.license;
    report("activate 3-day license", activation.status === 201 && !!activated?.key && activated.email === email && activated.plan === "3d", { status: activation.status, hasKey: !!activated?.key, plan: activated?.plan });
    if (activated?.expiresAt) {
      const days = (Date.parse(activated.expiresAt) - Date.now()) / 86400000;
      report("activation expiry is about 3 days", days > 2.9 && days <= 3.01, { days: Number(days.toFixed(3)) });
    } else report("activation expiry exists", false, { status: activation.status });
    const repeated = await post("/api/license/activate", { email, plan: "3d", orderId: order1 });
    report("duplicate webhook is idempotent", repeated.status === 200 && repeated.body.reused === true && repeated.body.license?.key === activated?.key, { status: repeated.status, reused: repeated.body.reused });
    const renewed = await post("/api/license/renew", { email, plan: "7d", orderId: order2 });
    const renewedLicense = renewed.body.license;
    report("renew existing license", renewed.status === 200 && !!renewedLicense?.key && renewedLicense.key === activated?.key && renewedLicense.plan === "7d", { status: renewed.status, sameKey: renewedLicense?.key === activated?.key, plan: renewedLicense?.plan });
    if (renewedLicense?.expiresAt && activated?.expiresAt) {
      const extensionDays = (Date.parse(renewedLicense.expiresAt) - Date.parse(activated.expiresAt)) / 86400000;
      report("renewal adds 7 days to current expiry", extensionDays > 6.99 && extensionDays < 7.01, { addedDays: Number(extensionDays.toFixed(3)) });
    } else report("renewal expiry exists", false, { status: renewed.status });
    const repeatedRenewal = await post("/api/license/renew", { email, plan: "7d", orderId: order2 });
    report("duplicate renewal webhook is idempotent", repeatedRenewal.status === 200 && repeatedRenewal.body.reused === true, { status: repeatedRenewal.status, reused: repeatedRenewal.body.reused });
  } catch (e) {
    report("lifecycle test execution", false, e.message);
  } finally {
    // Delete only the uniquely generated test customer to leave the live DB unchanged.
    try {
      const dbPath = path.join(process.env.APPDATA, "9router", "db", "data.sqlite");
      const db = new Database(dbPath);
      const result = db.prepare("DELETE FROM apiKeys WHERE lower(email) = lower(?)").run(email);
      db.close();
      console.log(JSON.stringify({ cleanup: "test license records deleted", count: result.changes }));
    } catch (e) {
      console.log(JSON.stringify({ cleanup: "manual cleanup may be needed", error: e.message, email }));
      failures++;
    }
  }
  if (failures) process.exitCode = 1;
})().catch((e) => { console.error(e.message); process.exitCode = 1; });
