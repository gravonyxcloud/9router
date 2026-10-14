/**
 * OpenCodeSidecarExecutor — routes completions through the genuine `opencode` CLI
 * binary instead of HTTPS, bypassing the free-tier FreeTierError gate entirely.
 *
 * Flow per request:
 *   1. Flatten the OpenAI messages array into a prompt text (stdin — no argv limits).
 *   2. Spawn `opencode run -m opencode/<model> --format json --dir <sandbox>`.
 *   3. Parse stdout JSONL events (step_start / text / step_finish) and emit them
 *      as OpenAI chat.completion.chunk SSE, so both the streaming and the
 *      non-streaming (forced SSE → JSON) downstream handlers consume it unchanged.
 *   4. Kill the child on client abort or SIDECAR_TIMEOUT_MS.
 *
 * Auth: noAuth — the child inherits the server env and uses the credentials from
 * `opencode auth login`. The agent's file/shell tools run inside SIDECAR_SANDBOX_DIR,
 * never the user's project. Client `body.tools` are NOT bridged: the agent loop
 * happens inside the sidecar (text-in/text-out lane).
 *
 * Binary discovery: OPENCODE_BIN env → PATH lookup → platform install locations.
 */
import { spawn, execFile } from "node:child_process";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import crypto from "node:crypto";
import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { buildChunk } from "../translator/concerns/chunk.js";
import { buildUsage } from "../translator/concerns/usage.js";
import { reasoningDelta } from "../translator/concerns/reasoning.js";
import { toOpenAIFinish } from "../translator/concerns/finishReason.js";
import { ROLE, OPENAI_FINISH } from "../translator/schema/index.js";
import { SSE_DONE, SSE_HEADERS } from "../utils/sseConstants.js";
import {
  SIDECAR_PROVIDER_ID,
  SIDECAR_BIN_ENV,
  SIDECAR_BASE_URL,
  SIDECAR_UPSTREAM_NAMESPACE,
  SIDECAR_TIMEOUT_MS,
  SIDECAR_KILL_GRACE_MS,
  SIDECAR_PROBE_TIMEOUT_MS,
  SIDECAR_SANDBOX_DIR,
  SIDECAR_EVENT,
  SIDECAR_STDERR_TAIL,
} from "../config/opencodeSidecar.js";

// ── binary discovery ──────────────────────────────────────────────────────────

let cachedBin = null;

function candidateBins() {
  const home = os.homedir();
  if (process.platform === "win32") {
    const localApp = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
    return [
      path.join(home, ".local", "nodejs", "node_modules", "opencode-ai", "bin", "opencode.exe"),
      path.join(process.env.APPDATA || path.join(home, "AppData", "Roaming"), "npm", "node_modules", "opencode-ai", "bin", "opencode.exe"),
      path.join(localApp, "opencode", "bin", "opencode.exe"),
    ];
  }
  return [
    path.join(home, ".opencode", "bin", "opencode"),
    path.join(home, ".local", "bin", "opencode"),
    "/usr/local/bin/opencode",
    "/opt/homebrew/bin/opencode",
  ];
}

function lookupOnPath() {
  return new Promise((resolve) => {
    const cmd = process.platform === "win32" ? "where.exe" : "which";
    const arg = process.platform === "win32" ? "opencode.exe" : "opencode";
    execFile(cmd, [arg], { timeout: 10000 }, (err, stdout) => {
      if (err) return resolve(null);
      const first = String(stdout || "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
      resolve(first || null);
    });
  });
}

export async function resolveOpencodeBin() {
  if (cachedBin) return cachedBin;
  const envBin = (process.env[SIDECAR_BIN_ENV] || "").trim();
  if (envBin && fs.existsSync(envBin)) {
    cachedBin = envBin;
    return cachedBin;
  }
  for (const candidate of candidateBins()) {
    try {
      if (fs.existsSync(candidate)) {
        cachedBin = candidate;
        return cachedBin;
      }
    } catch {
      /* ignore */
    }
  }
  const onPath = await lookupOnPath();
  cachedBin = onPath || (process.platform === "win32" ? "opencode.exe" : "opencode");
  return cachedBin;
}

/** Local health check for the UI Test button: binary exists and reports a version. */
export function probeOpencodeSidecar() {
  return (async () => {
    const bin = await resolveOpencodeBin();
    return new Promise((resolve) => {
      execFile(bin, ["--version"], { timeout: SIDECAR_PROBE_TIMEOUT_MS }, (err, stdout, stderr) => {
        if (err) {
          resolve({ ok: false, error: `opencode binary not usable (${bin}): ${err.message}` });
          return;
        }
        resolve({ ok: true, version: String(stdout || stderr || "").trim().slice(0, 64), bin });
      });
    });
  })();
}

// ── prompt flattening (OpenAI messages → stdin text) ──────────────────────────

function textOfContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const p of content) {
    if (typeof p === "string") {
      parts.push(p);
      continue;
    }
    if (!p || typeof p !== "object") continue;
    if (typeof p.text === "string") parts.push(p.text);
    else if (typeof p.input_text === "string") parts.push(p.input_text);
    else if (p.type === "image_url") parts.push("[image omitted — sidecar lane is text-only]");
    else if (p.type === "input_audio") parts.push("[audio omitted — sidecar lane is text-only]");
  }
  return parts.join("");
}

function toolCallsOf(message) {
  if (!Array.isArray(message?.tool_calls) || !message.tool_calls.length) return "";
  return message.tool_calls
    .map((tc) => {
      const fn = tc?.function || {};
      return `[assistant tool call: ${fn.name || tc?.name || "unknown"}(${fn.arguments || ""})]`;
    })
    .join("\n");
}

export function buildSidecarPrompt(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const blocks = [];
  for (const m of messages) {
    if (!m || typeof m !== "object") continue;
    const role = m.role;
    if (role === "system" || role === "developer") {
      const text = textOfContent(m.content).trim();
      if (text) blocks.push(`System:\n${text}`);
    } else if (role === "user") {
      const text = textOfContent(m.content).trim();
      if (text) blocks.push(`User:\n${text}`);
    } else if (role === "assistant") {
      const text = textOfContent(m.content).trim();
      const calls = toolCallsOf(m);
      const combined = [text, calls].filter(Boolean).join("\n");
      if (combined) blocks.push(`Assistant:\n${combined}`);
    } else if (role === "tool") {
      const name = m.name || m.tool_call_id || "tool";
      const text = textOfContent(m.content).trim();
      if (text) blocks.push(`Tool result (${name}):\n${text}`);
    }
  }
  if (!blocks.length) return "Hello";
  return blocks.join("\n\n");
}

// ── model mapping: osc/<id> (or bare id) → opencode/<id> ─────────────────────

export function toUpstreamModel(model) {
  const raw = String(model || "").trim();
  if (!raw) return `${SIDECAR_UPSTREAM_NAMESPACE}/big-pickle`;
  if (raw.startsWith(`${SIDECAR_UPSTREAM_NAMESPACE}/`)) return raw;
  const bare = raw.includes("/") ? raw.split("/").pop() : raw;
  return `${SIDECAR_UPSTREAM_NAMESPACE}/${bare}`;
}

// ── executor ──────────────────────────────────────────────────────────────────

export class OpenCodeSidecarExecutor extends BaseExecutor {
  constructor() {
    super(SIDECAR_PROVIDER_ID, PROVIDERS[SIDECAR_PROVIDER_ID]);
  }

  buildUrl() {
    return SIDECAR_BASE_URL;
  }

  transformRequest(model, body) {
    // The child always streams JSONL; downstream converts SSE → JSON when needed.
    if (body && typeof body === "object") body.stream = true;
    return body;
  }

  async execute({ model, body, credentials, signal, log }) {
    const upstreamModel = toUpstreamModel(model || body?.model);
    const promptText = buildSidecarPrompt(body);
    const bin = await resolveOpencodeBin();
    try {
      fs.mkdirSync(SIDECAR_SANDBOX_DIR, { recursive: true });
    } catch {
      /* ignore */
    }

    const dbg = (...args) => {
      try {
        log?.debug?.("SIDECAR", args.join(" "));
      } catch {
        /* ignore */
      }
    };
    dbg(`spawn ${bin} run -m ${upstreamModel} (prompt ${promptText.length}B via stdin)`);

    const child = spawn(bin, ["run", "-m", upstreamModel, "--format", "json", "--dir", SIDECAR_SANDBOX_DIR], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    // Prompt via stdin (no Windows argv length limits). Close immediately after.
    try {
      child.stdin.write(promptText);
      child.stdin.end();
    } catch {
      /* EPIPE when the child exits instantly — surfaced via close/exit below */
    }

    let stderrTail = "";
    child.stderr?.on("data", (chunk) => {
      stderrTail = (stderrTail + chunk.toString("utf8")).slice(-SIDECAR_STDERR_TAIL);
    });
    child.on("error", () => {
      /* spawn failure (ENOENT) surfaces via exit code -2 / close below */
    });

    const responseId = `chatcmpl-sidecar-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
    const created = Math.floor(Date.now() / 1000);
    const displayModel = String(model || body?.model || upstreamModel);
    const encoder = new TextEncoder();
    const state = {
      chunkIndex: 0,
      lastTextByPart: new Map(),
      usage: null,
      finishReason: null,
      textEmitted: false,
      finished: false,
      toolEventCount: 0,
    };

    const emit = (controller, obj) => {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
    };
    const emitDelta = (controller, delta) => {
      if (state.chunkIndex === 0) delta = { role: ROLE.ASSISTANT, ...delta };
      state.chunkIndex++;
      emit(controller, buildChunk({ id: responseId, created, model: displayModel }, delta));
    };

    const applyTextEvent = (controller, event) => {
      const part = event?.part || {};
      const partId = part.id || "default";
      const text = typeof part.text === "string" ? part.text : "";
      if (!text) return;
      const prev = state.lastTextByPart.get(partId) || "";
      let deltaText = text;
      // `run --format json` re-emits the full part text per event (snapshot style);
      // forward only the unseen suffix. Pure deltas (not starting with prev) pass through.
      if (prev && text.startsWith(prev)) deltaText = text.slice(prev.length);
      state.lastTextByPart.set(partId, text);
      if (!deltaText) return;
      state.textEmitted = true;
      emitDelta(controller, { content: deltaText });
    };

    const applyReasoningEvent = (controller, event) => {
      const part = event?.part || {};
      const text = typeof part.text === "string" ? part.text : "";
      if (!text) return;
      state.chunkIndex++;
      emit(controller, buildChunk(
        { id: responseId, created, model: displayModel },
        reasoningDelta(text, state.chunkIndex === 1)
      ));
    };

    const applyStepFinish = (event) => {
      const part = event?.part || {};
      const reason = toOpenAIFinish(part.reason || "stop", "commandcode");
      state.finishReason = reason === undefined ? OPENAI_FINISH.STOP : reason;
      const tokens = part.tokens || {};
      const num = (v) => (typeof v === "number" ? v : 0);
      if (tokens && (tokens.total || tokens.input || tokens.output)) {
        state.usage = buildUsage({
          promptTokens: num(tokens.input),
          completionTokens: num(tokens.output),
          totalTokens: num(tokens.total) || num(tokens.input) + num(tokens.output),
          cachedTokens: num(tokens.cache?.read),
          reasoningTokens: num(tokens.reasoning),
        });
      }
    };

    const handleEvent = (controller, event) => {
      if (!event || typeof event !== "object") return;
      switch (event.type) {
        case SIDECAR_EVENT.TEXT:
          applyTextEvent(controller, event);
          break;
        case SIDECAR_EVENT.REASONING:
          applyReasoningEvent(controller, event);
          break;
        case SIDECAR_EVENT.STEP_FINISH:
          applyStepFinish(event);
          break;
        default:
          // step_start, internal tool calls (executed inside the sidecar sandbox),
          // and future event kinds carry no client-visible text.
          if (typeof event.type === "string" && event.type.includes("tool")) state.toolEventCount++;
          break;
      }
    };

    const killChild = (sig) => {
      try {
        if (!child.killed && child.exitCode === null) child.kill(sig);
      } catch {
        /* ignore */
      }
    };

    const stream = new ReadableStream({
      start(controller) {
        let buffer = "";
        let closeTimer = null;

        const finishOk = () => {
          if (state.finished) return;
          state.finished = true;
          if (closeTimer) clearTimeout(closeTimer);
          const finalChunk = buildChunk(
            { id: responseId, created, model: displayModel },
            {},
            state.finishReason || OPENAI_FINISH.STOP
          );
          if (state.usage) finalChunk.usage = state.usage;
          emit(controller, finalChunk);
          controller.enqueue(encoder.encode(SSE_DONE));
          try {
            controller.close();
          } catch {
            /* ignore */
          }
          const killTimer = setTimeout(() => killChild("SIGKILL"), SIDECAR_KILL_GRACE_MS);
          killTimer.unref?.();
        };

        const finishError = (message) => {
          if (state.finished) return;
          state.finished = true;
          if (closeTimer) clearTimeout(closeTimer);
          try {
            controller.error(new Error(message));
          } catch {
            /* ignore */
          }
          killChild("SIGKILL");
        };

        const onTimeout = () => {
          dbg(`timeout after ${SIDECAR_TIMEOUT_MS}ms (tools used: ${state.toolEventCount})`);
          killChild("SIGKILL");
          if (state.textEmitted) finishOk();
          else finishError(`opencode sidecar timed out after ${SIDECAR_TIMEOUT_MS / 1000}s with no output`);
        };
        closeTimer = setTimeout(onTimeout, SIDECAR_TIMEOUT_MS);
        closeTimer.unref?.();

        if (signal) {
          if (signal.aborted) {
            killChild("SIGKILL");
            try {
              controller.close();
            } catch {
              /* ignore */
            }
            return;
          }
          signal.addEventListener("abort", () => {
            dbg("client aborted — killing sidecar child");
            killChild("SIGKILL");
            if (!state.finished) {
              state.finished = true;
              if (closeTimer) clearTimeout(closeTimer);
              try {
                controller.close();
              } catch {
                /* ignore */
              }
            }
          }, { once: true });
        }

        child.stdout?.on("data", (chunk) => {
          buffer += chunk.toString("utf8");
          let nl;
          while ((nl = buffer.indexOf("\n")) !== -1) {
            const line = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);
            if (!line) continue;
            let event = null;
            try {
              event = JSON.parse(line);
            } catch {
              continue; // banner/log lines are not JSON
            }
            try {
              handleEvent(controller, event);
            } catch (err) {
              dbg(`event handler error: ${err?.message}`);
            }
          }
        });

        child.on("close", (code) => {
          dbg(`child closed code=${code} text=${state.textEmitted} tools=${state.toolEventCount}`);
          if (state.finished) return;
          if (code === 0 || state.textEmitted) {
            finishOk();
            return;
          }
          const detail = stderrTail.trim().slice(-400) || `exit code ${code}`;
          finishError(`opencode sidecar failed before producing output: ${detail}`);
        });
      },
      cancel() {
        killChild("SIGKILL");
      },
    });

    const response = new Response(stream, {
      status: 200,
      headers: { ...SSE_HEADERS },
    });
    return { response, url: SIDECAR_BASE_URL, headers: {}, transformedBody: body };
  }
}

export default OpenCodeSidecarExecutor;
