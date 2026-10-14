const fs = require("node:fs");
const path = require("node:path");
const base = process.env.NINEROUTER_TEST_URL || "http://127.0.0.1:20128";
const envPath = path.join(process.cwd(), ".env.local");
const envText = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
const match = envText.match(/^LICENSE_API_SECRET=(.*)$/m);
const secret = (process.env.LICENSE_API_SECRET || match?.[1] || "").trim();

async function request(route, body, headers = {}) {
  const response = await fetch(base + route, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}
(async () => {
  const results = [];
  const health = await fetch(base + "/api/health");
  results.push({ test: "health endpoint", pass: health.status === 200, status: health.status });
  const models = await fetch(base + "/api/v1/models");
  results.push({ test: "models endpoint", pass: models.status === 200, status: models.status });
  const noAuth = await request("/api/license/activate", { email: "regression@example.com", plan: "3d", orderId: "regression-no-auth" });
  results.push({ test: "activation rejects missing secret", pass: [401, 503].includes(noAuth.status), status: noAuth.status });
  if (secret.length >= 32) {
    const headers = { "x-license-secret": secret };
    const invalidActivate = await request("/api/license/activate", { email: "regression@example.com", plan: "not-a-plan", orderId: "regression-invalid-activate" }, headers);
    results.push({ test: "activation rejects invalid plan", pass: invalidActivate.status === 400, status: invalidActivate.status });
    const invalidRenew = await request("/api/license/renew", { email: "regression@example.com", plan: "not-a-plan", orderId: "regression-invalid-renew" }, headers);
    results.push({ test: "renewal rejects invalid plan", pass: invalidRenew.status === 400, status: invalidRenew.status });
  } else {
    results.push({ test: "authenticated API tests", pass: false, status: "LICENSE_API_SECRET missing/short in local environment" });
  }
  console.log(JSON.stringify(results, null, 2));
  if (results.some((item) => !item.pass)) process.exitCode = 1;
})().catch((error) => { console.error(error.message); process.exitCode = 1; });
