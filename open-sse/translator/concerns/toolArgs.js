/**
 * translator/concerns/toolArgs.js — arg-name translation for the OpenCode
 * built-in quartet (bash/edit/read/write).
 *
 * Upstream OpenCode-family models emit their native camelCase conventions
 * (filePath/oldString/newString/replaceAll/cmd); Claude Code validates tool
 * input strictly and rejects those ("The edit tool is rejecting these
 * parameters"), so the response side maps to snake_case. The request side
 * maps history turns back to camelCase to match the declared authentic
 * schemas. All mappers only fill absent targets (idempotent). No imports —
 * safe for executors, translators and plain-node checks.
 */

// Move args[from] to args[to] when the target is absent; drop the alias either
// way so only one spelling survives.
export function moveArgKey(args, from, to) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return;
  if (from === to) return;
  if (args[to] === undefined && args[from] !== undefined) args[to] = args[from];
  if (args[from] !== undefined) delete args[from];
}

/** Upstream camelCase -> agent snake_case (response side). */
export function sanitizeEditArgs(args) {
  moveArgKey(args, "filePath", "file_path");
  moveArgKey(args, "path", "file_path");
  moveArgKey(args, "file", "file_path");
  moveArgKey(args, "oldString", "old_string");
  moveArgKey(args, "oldText", "old_string");
  moveArgKey(args, "newString", "new_string");
  moveArgKey(args, "newText", "new_string");
  moveArgKey(args, "replaceAll", "replace_all");
  return args;
}

export function sanitizeWriteArgs(args) {
  moveArgKey(args, "filePath", "file_path");
  moveArgKey(args, "path", "file_path");
  moveArgKey(args, "file", "file_path");
  return args;
}

export function sanitizeReadArgs(args) {
  moveArgKey(args, "filePath", "file_path");
  return args;
}

export function sanitizeBashArgs(args) {
  moveArgKey(args, "cmd", "command");
  return args;
}

/** Dispatch by tool name (case-insensitive); unknown tools pass through. */
export function sanitizeQuartetArgs(name, args) {
  const lower = String(name || "").toLowerCase();
  if (lower === "read") return sanitizeReadArgs(args);
  if (lower === "edit") return sanitizeEditArgs(args);
  if (lower === "write") return sanitizeWriteArgs(args);
  if (lower === "bash") return sanitizeBashArgs(args);
  return args;
}

// Reverse maps (snake_case -> camelCase) for history turns sent upstream.
const HISTORY_ARG_MAPS = {
  edit: { file_path: "filePath", old_string: "oldString", new_string: "newString", replace_all: "replaceAll" },
  read: { file_path: "filePath" },
  write: { file_path: "filePath" },
  bash: {},
};

/** Agent snake_case -> upstream camelCase (request history side, idempotent). */
export function canonicalizeQuartetArgs(name, args) {
  const map = HISTORY_ARG_MAPS[String(name || "").toLowerCase()];
  if (!map || !args || typeof args !== "object" || Array.isArray(args)) return args;
  for (const [from, to] of Object.entries(map)) {
    if (args[to] === undefined && args[from] !== undefined) args[to] = args[from];
    if (from !== to && args[from] !== undefined) delete args[from];
  }
  return args;
}
