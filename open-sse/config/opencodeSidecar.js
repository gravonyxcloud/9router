/**
 * open-sse/config/opencodeSidecar.js — constants for the opencode-sidecar lane.
 *
 * The sidecar lane routes completions through the genuine `opencode` CLI binary
 * (`opencode run -m opencode/<model> --format json`, prompt via stdin). The binary
 * authenticates to the free tier itself, so no HTTP fingerprinting is involved.
 * ALL sidecar tuning lives here — executors/registry must not hardcode these.
 */
import os from "node:os";
import path from "node:path";

// Provider identity (registry id + user-facing alias: osc/<model>).
export const SIDECAR_PROVIDER_ID = "opencode-sidecar";
export const SIDECAR_ALIAS = "osc";

// Env override for the CLI binary path (takes precedence over discovery).
export const SIDECAR_BIN_ENV = "OPENCODE_BIN";

// `opencode run` transport marker. Never fetched — execute() spawns locally.
// (Mirrors the devin://acp/stdio pattern used by the devin-cli lane.)
export const SIDECAR_BASE_URL = "sidecar://opencode/run";

// Upstream model namespace inside the CLI: osc/<id> -> opencode/<id>.
export const SIDECAR_UPSTREAM_NAMESPACE = "opencode";

// Agent runs can take minutes (model + internal tool calls). Kill past this.
export const SIDECAR_TIMEOUT_MS = 600000;
// Grace period between SIGTERM and SIGKILL on timeout/abort.
export const SIDECAR_KILL_GRACE_MS = 2000;
// `opencode --version` probe budget (local spawn, should be instant).
export const SIDECAR_PROBE_TIMEOUT_MS = 15000;

// Agent file tools (read/write/bash) run here — never the user's project dir.
// Created on demand under the OS temp dir.
export const SIDECAR_SANDBOX_DIR = path.join(os.tmpdir(), "9router-opencode-sandbox");

// `opencode run --format json` event types (one JSON object per stdout line).
export const SIDECAR_EVENT = {
  STEP_START: "step_start",
  TEXT: "text",
  REASONING: "reasoning",
  STEP_FINISH: "step_finish",
};

// step_finish part.reason -> OpenAI finish_reason.
export const SIDECAR_FINISH_MAP = {
  stop: "stop",
  length: "length",
  tool: "tool_calls",
  aborted: "stop",
  error: "stop",
};

// stderr tail kept for failure messages (bytes).
export const SIDECAR_STDERR_TAIL = 2048;

// Curated free-tier ids shown in the UI. Anything else still works via
// passthroughModels (osc/<id> -> opencode/<id>) when the CLI account is entitled.
export const SIDECAR_CURATED_MODELS = [
  { id: "big-pickle", name: "Big Pickle (Free)" },
  { id: "cat-jam-free", name: "Cat Jam Free" },
];
