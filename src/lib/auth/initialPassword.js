/**
 * Resolve the dashboard initial password from the environment.
 *
 * Env transport layers (Easypanel env-file, Docker --env-file, copy/paste)
 * commonly mangle values: surrounding quotes (`INITIAL_PASSWORD="V9!qR4"`)
 * or stray whitespace/newlines. Without normalization a password containing
 * symbols never matches what the user types, even though the comparison
 * itself is exact. Returns null when unset/blank so callers fall back to the
 * default password. No imports — safe leaf for routes and services.
 */
export function resolveInitialPassword() {
  const raw = process.env.INITIAL_PASSWORD;
  if (typeof raw !== "string") return null;
  let value = raw.trim();
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      value = value.slice(1, -1).trim();
    }
  }
  return value || null;
}
