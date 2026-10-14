/**
 * Helpers for the OpenCode Zen free-tier client fingerprint.
 *
 * Live upstream probes (2026-10-14, /inference/v1/chat/completions) show the
 * free-tier gate requires streaming requests carrying the authentic OpenCode
 * built-in quartet (bash/edit/read/write) with their genuine JSON schemas —
 * dummy/empty parameters or missing tools trigger HTTP 403 FreeTierError.
 * Agent clients such as Claude Code may declare overlapping tools with
 * different casing, so those case variants are renamed (and re-schematised to
 * the authentic definitions) instead of duplicated. The response side restores
 * the caller's original spelling so downstream clients still recognise their
 * own tool calls.
 */
import { authenticToolDef } from "../config/opencodeTools.js";
import { canonicalizeQuartetArgs } from "../translator/concerns/toolArgs.js";

/** Canonical names required by the upstream free-tier gate. */
export const OPENCODE_FINGERPRINT_TOOLS = ["bash", "edit", "read", "write"];

// Request body -> names renamed for that request. transformRequest() mutates the
// same body object that chatCore passed into the executor, so a WeakMap keeps the
// mapping request-local without putting transport metadata on the wire.
const renamedToolNames = new WeakMap();

/** Canonical lowercase name when `name` is a quartet member; "" otherwise. */
export function fingerprintToolKey(name) {
  const lower = String(name ?? "").trim().toLowerCase();
  return OPENCODE_FINGERPRINT_TOOLS.includes(lower) ? lower : "";
}

/** Read a tool name from either flat ({name}) or chat ({function:{name}}) shape. */
function toolNameOf(tool) {
  if (!tool || typeof tool !== "object" || Array.isArray(tool)) return "";
  if (typeof tool.name === "string" && tool.name.trim()) return tool.name.trim();
  const fn = tool.function;
  if (fn && typeof fn === "object" && !Array.isArray(fn) && typeof fn.name === "string") {
    return fn.name.trim();
  }
  return "";
}

/**
 * Canonicalise only the fingerprint quartet and remove duplicate quartet
 * variants. Non-fingerprint tools are preserved verbatim, including tools whose
 * names differ only by case; they are outside OpenCode's fingerprint contract.
 *
 * @param {Array} tools
 * @returns {{ tools: Array, map: Map<string,string> }} map: sent name -> original name
 */
export function concealFingerprintToolNames(tools) {
  const map = new Map();
  if (!Array.isArray(tools) || tools.length === 0) return { tools, map };

  const seenQuartet = new Set();
  const out = [];
  for (const tool of tools) {
    if (!tool || typeof tool !== "object" || Array.isArray(tool)) {
      out.push(tool);
      continue;
    }

    const current = toolNameOf(tool);
    const key = fingerprintToolKey(current);
    if (!key) {
      out.push(tool);
      continue;
    }

    // `Bash` + `bash` is rejected upstream as a duplicate. Keep exactly one
    // declaration for each quartet member.
    if (seenQuartet.has(key)) continue;
    seenQuartet.add(key);

    if (current !== key) {
      map.set(key, current);
      // Re-schema renamed client tools to the authentic built-in definitions:
      // foreign/dummy schemas on a quartet name trip the upstream gate.
      const fn = tool.function && typeof tool.function === "object" && !Array.isArray(tool.function)
        ? tool.function
        : null;
      const auth = authenticToolDef(key, !fn);
      if (auth) {
        out.push(auth);
      } else if (fn) {
        out.push({ ...tool, function: { ...fn, name: key } });
      } else {
        out.push({ ...tool, name: key });
      }
    } else {
      out.push(tool);
    }
  }
  return { tools: out, map };
}

/** Append only genuinely missing quartet declarations (authentic schemas — the
 *  gate rejects dummy/empty parameters with 403 FreeTierError). */
export function appendMissingFingerprintTools(tools, flat) {
  const list = Array.isArray(tools) ? tools : [];
  for (const name of OPENCODE_FINGERPRINT_TOOLS) {
    if (list.some((tool) => fingerprintToolKey(toolNameOf(tool)) === name)) continue;
    const auth = authenticToolDef(name, flat);
    list.push(auth || (flat ? {
      type: "function",
      name,
      description: "OpenCode built-in tool.",
      parameters: { type: "object", properties: {} },
    } : {
      type: "function",
      function: {
        name,
        description: "OpenCode built-in tool.",
        parameters: { type: "object", properties: {} },
      },
    }));
  }
  return list;
}

/** Point an explicit tool_choice at a quartet member after canonicalisation. */export function retargetToolChoice(body, map) {
  if (!body || typeof body !== "object" || !map?.size) return;
  const choice = body.tool_choice;
  if (!choice || typeof choice !== "object" || Array.isArray(choice)) return;

  if (typeof choice.name === "string") {
    const key = fingerprintToolKey(choice.name);
    if (key && map.has(key)) body.tool_choice = { ...choice, name: key };
    return;
  }

  const fn = choice.function;
  if (fn && typeof fn === "object" && !Array.isArray(fn) && typeof fn.name === "string") {
    const key = fingerprintToolKey(fn.name);
    if (key && map.has(key)) {
      body.tool_choice = { ...choice, function: { ...fn, name: key } };
    }
  }
}

function canonicalizeCallArgs(key, args) {
  return canonicalizeQuartetArgs(key, args);
}

function canonicalizeHistoryCall(call) {
  if (!call || typeof call !== "object" || Array.isArray(call)) return;
  const fn = call.function && typeof call.function === "object" && !Array.isArray(call.function)
    ? call.function
    : null;
  // Responses flat shape: {type:"function_call", name, arguments}
  const rawName = fn ? fn.name : call.name;
  const key = fingerprintToolKey(rawName);
  if (!key) return;
  if (fn) {
    if (fn.name !== key) fn.name = key;
    if (typeof fn.arguments === "string") {
      try {
        fn.arguments = JSON.stringify(canonicalizeCallArgs(key, JSON.parse(fn.arguments)));
      } catch {
        /* leave unparseable arguments untouched */
      }
    } else if (fn.arguments && typeof fn.arguments === "object") {
      canonicalizeCallArgs(key, fn.arguments);
    }
    return;
  }
  if (call.name !== key) call.name = key;
  if (typeof call.arguments === "string") {
    try {
      call.arguments = JSON.stringify(canonicalizeCallArgs(key, JSON.parse(call.arguments)));
    } catch {
      /* leave unparseable arguments untouched */
    }
  } else if (call.arguments && typeof call.arguments === "object") {
    canonicalizeCallArgs(key, call.arguments);
  }
}

/**
 * Canonicalise prior-turn tool calls in message history (names to lowercase
 * quartet + args to the authentic camelCase schemas). Upstream validates
 * history turns against the declared tool schemas; snake_case args from agent
 * clients would otherwise poison multi-turn conversations.
 */
export function canonicalizeHistoryTools(body) {
  if (!body || typeof body !== "object") return;
  if (Array.isArray(body.messages)) {
    for (const m of body.messages) {
      if (!m || typeof m !== "object" || Array.isArray(m)) continue;
      if (Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) canonicalizeHistoryCall(tc);
      }
    }
  }
  if (Array.isArray(body.input)) {
    for (const item of body.input) {
      if (item?.type === "function_call") canonicalizeHistoryCall(item);
      if (item?.type === "function_call_output") {
        // Outputs carry no schema — leave untouched.
      }
    }
  }
}

/**
 * Full request-side pass: canonicalise quartet case variants, remove duplicate
 * quartet declarations, append missing members and preserve the legacy
 * tool_choice defaults used by the OpenCode executor.
 *
 * @param {object} body
 * @param {boolean} flat - true for Responses tools ({name}), false for chat tools
 * @returns {Map<string,string>} map: sent name -> original name
 */
export function applyFingerprintTools(body, flat) {
  if (!body || typeof body !== "object") return new Map();

  canonicalizeHistoryTools(body);
  const hadClientTools = Array.isArray(body.tools) && body.tools.length > 0;
  const { tools, map } = concealFingerprintToolNames(body.tools);
  body.tools = appendMissingFingerprintTools(tools, flat);
  retargetToolChoice(body, map);

  // Preserve the existing executor semantics. Responses uses auto when the
  // fingerprint helper supplies tools; chat requests with no caller tools use
  // none so the injected decoys cannot be selected.
  if (!body.tool_choice) {
    if (flat) body.tool_choice = "auto";
    else if (!hadClientTools) body.tool_choice = "none";
  }

  recordRenamedToolNames(body, map);
  return map;
}

/** Store the rename map for `body`. */
export function recordRenamedToolNames(body, map) {
  if (!body || typeof body !== "object" || !map?.size) return;
  renamedToolNames.set(body, map);
}

/** Retrieve the rename map for `body`. */
export function takeRenamedToolNames(body) {
  if (!body || typeof body !== "object") return null;
  return renamedToolNames.get(body) || null;
}

// Response side -------------------------------------------------------------

/** Restore caller tool spellings in supported response/event shapes. */
export function restoreToolNames(payload, map) {
  if (!map?.size || !payload) return payload;
  if (Array.isArray(payload)) return payload.map((item) => restoreToolNames(item, map));
  if (typeof payload !== "object") return payload;

  let out = payload;
  const put = (key, value) => {
    if (out === payload) out = { ...payload };
    out[key] = value;
  };

  // Claude streaming content_block_start event.
  if (payload.type === "content_block_start") {
    const block = payload.content_block;
    if (block?.type === "tool_use" && typeof block.name === "string" && map.has(block.name)) {
      put("content_block", { ...block, name: map.get(block.name) });
    }
  }

  // Claude non-streaming message body.
  if (Array.isArray(payload.content)) {
    put("content", payload.content.map((block) =>
      block?.type === "tool_use" && typeof block.name === "string" && map.has(block.name)
        ? { ...block, name: map.get(block.name) }
        : block));
  }

  // OpenAI Chat Completions, both streaming delta and JSON message shapes.
  if (Array.isArray(payload.choices)) {
    put("choices", payload.choices.map((choice) => {
      let changed = false;
      const next = { ...choice };
      for (const holder of ["delta", "message"]) {
        const value = choice?.[holder];
        if (!value || !Array.isArray(value.tool_calls) || value.tool_calls.length === 0) continue;
        const calls = value.tool_calls.map((call) => {
          const name = call?.function?.name;
          if (typeof name === "string" && map.has(name)) {
            changed = true;
            return { ...call, function: { ...call.function, name: map.get(name) } };
          }
          return call;
        });
        next[holder] = { ...value, tool_calls: calls };
      }
      return changed ? next : choice;
    }));
  }

  // OpenAI Responses final JSON body.
  if (Array.isArray(payload.output)) {
    put("output", payload.output.map((item) =>
      item?.type === "function_call" && typeof item.name === "string" && map.has(item.name)
        ? { ...item, name: map.get(item.name) }
        : item));
  }

  // OpenAI Responses SSE events such as response.output_item.added/done.
  const item = payload.item;
  if (item?.type === "function_call" && typeof item.name === "string" && map.has(item.name)) {
    put("item", { ...item, name: map.get(item.name) });
  }

  return out;
}
