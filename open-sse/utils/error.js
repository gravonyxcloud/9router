import { ERROR_TYPES, DEFAULT_ERROR_MESSAGES } from "../config/errorConfig.js";

/**
 * Build OpenAI-compatible error response body
 * @param {number} statusCode - HTTP status code
 * @param {string} message - Error message (server-logged by callers; never
 *   echoed — client bodies carry only the generic per-status text below)
 * @returns {object} Error response object
 */
function sanitizePublicError(message, statusCode) {
  // Anti-recon: upstream error wording (temperature dialects, quota
  // phrasing, model names) fingerprints the backend. Clients get the HTTP
  // status (needed for retries) plus a fixed message; raw detail stays in
  // server logs. Keep in sync with DEFAULT_ERROR_MESSAGES in errorConfig.js.
  if (statusCode === 400) return "Invalid request.";
  if (statusCode === 401) return "Authentication failed.";
  if (statusCode === 402) return "Payment required.";
  if (statusCode === 403) return "Forbidden.";
  if (statusCode === 404) return "Not found.";
  if (statusCode === 406) return "Model not supported.";
  if (statusCode === 408) return "Request timeout.";
  if (statusCode === 429) return "Rate limited. Retry shortly.";
  if (Number(statusCode) >= 500) return "Upstream unavailable.";
  return "The request could not be completed.";
}

export function buildErrorBody(statusCode, message) {
  const safeMessage = sanitizePublicError(message, statusCode);
  const errorInfo = ERROR_TYPES[statusCode] || 
    (statusCode >= 500 
      ? { type: "server_error", code: "internal_server_error" }
      : { type: "invalid_request_error", code: "" });

  return {
    error: {
      message: safeMessage || DEFAULT_ERROR_MESSAGES[statusCode] || "The request could not be completed.",
      type: errorInfo.type,
      code: errorInfo.code
    }
  };
}

/**
 * Create error Response object (for non-streaming)
 * @param {number} statusCode - HTTP status code
 * @param {string} message - Error message
 * @returns {Response} HTTP Response object
 */
export function errorResponse(statusCode, message, extraHeaders = null) {
  return new Response(JSON.stringify(buildErrorBody(statusCode, message)), {
    status: statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      ...extraHeaders
    }
  });
}

/**
 * Write error to SSE stream (for streaming)
 * @param {WritableStreamDefaultWriter} writer - Stream writer
 * @param {number} statusCode - HTTP status code
 * @param {string} message - Error message
 */
export async function writeStreamError(writer, statusCode, message) {
  const errorBody = buildErrorBody(statusCode, message);
  const encoder = new TextEncoder();
  await writer.write(encoder.encode(`data: ${JSON.stringify(errorBody)}\n\n`));
}

/**
 * Parse upstream provider error response
 * @param {Response} response - Fetch response from provider
 * @param {object} [executor] - Optional executor with parseError() override for provider-specific parsing
 * @returns {Promise<{statusCode: number, message: string, resetsAtMs?: number}>}
 */
export async function parseUpstreamError(response, executor = null) {
  let bodyText = "";
  try {
    bodyText = await response.text();
  } catch {
    bodyText = "";
  }

  // Let executor-specific parser extract provider-specific fields (e.g. codex resetsAtMs)
  if (executor && typeof executor.parseError === "function") {
    try {
      const parsed = executor.parseError(response, bodyText);
      if (parsed && typeof parsed === "object") {
        const msg = parsed.message || DEFAULT_ERROR_MESSAGES[response.status] || `Upstream error: ${response.status}`;
        return { statusCode: parsed.status || response.status, message: msg, resetsAtMs: parsed.resetsAtMs };
      }
    } catch { /* fall through to default parsing */ }
  }

  let message = "";
  try {
    const json = JSON.parse(bodyText);
    message = json.error?.message || json.message || json.error || bodyText;
  } catch {
    message = bodyText;
  }

  const messageStr = typeof message === "string" ? message : JSON.stringify(message);
  const finalMessage = messageStr || DEFAULT_ERROR_MESSAGES[response.status] || `Upstream error: ${response.status}`;

  return { statusCode: response.status, message: finalMessage };
}

/**
 * Create error result for chatCore handler
 * @param {number} statusCode - HTTP status code
 * @param {string} message - Error message
 * @param {number} [resetsAtMs] - Optional precise cooldown expiry (ms epoch) for provider-specific quota errors
 * @returns {{ success: false, status: number, error: string, response: Response, resetsAtMs?: number }}
 */
export function createErrorResult(statusCode, message, resetsAtMs, extraHeaders = null) {
  return {
    success: false,
    status: statusCode,
    error: message,
    resetsAtMs,
    response: errorResponse(statusCode, message, clampRetryAfter(extraHeaders))
  };
}

/**
 * Cap client-facing retry-after at 30s. Upstream rate limits arrive with long
 * windows (85s+) that make clients back off forever; meanwhile our proxy
 * rotation + cooldowns free fresh egress much sooner, so clients should retry
 * sooner, not later. Only numeric values are clamped (HTTP dates pass through).
 */
export const MAX_CLIENT_RETRY_AFTER_SEC = 30;

export function clampRetryAfter(extraHeaders) {
  if (!extraHeaders || typeof extraHeaders !== "object" || Array.isArray(extraHeaders)) return extraHeaders;
  const out = { ...extraHeaders };
  for (const key of Object.keys(out)) {
    if (String(key).toLowerCase() !== "retry-after") continue;
    const n = Number(out[key]);
    if (Number.isFinite(n) && n > MAX_CLIENT_RETRY_AFTER_SEC) out[key] = String(MAX_CLIENT_RETRY_AFTER_SEC);
  }
  return out;
}

/**
 * Create unavailable response when all accounts are rate limited
 * @param {number} statusCode - Original error status code
 * @param {string} message - Error message (without retry info)
 * @param {string} retryAfter - ISO timestamp when earliest account becomes available
 * @param {string} retryAfterHuman - Human-readable retry info e.g. "reset after 30s"
 * @returns {Response}
 */
export function unavailableResponse(statusCode, message, retryAfter, retryAfterHuman, extraHeaders = null) {
  const computed = Math.max(Math.ceil((new Date(retryAfter).getTime() - Date.now()) / 1000), 1);
  // Capped (see MAX_CLIENT_RETRY_AFTER_SEC): long upstream windows stall
  // clients while proxy rotation already frees fresh egress sooner.
  const retryAfterSec = Math.min(computed, MAX_CLIENT_RETRY_AFTER_SEC);
  const msg = `${message} (${retryAfterHuman})`;
  return new Response(
    JSON.stringify({ error: { message: msg } }),
    {
      status: statusCode,
      headers: {
        ...extraHeaders,
        "Content-Type": "application/json",
        // Intentionally mis-cased to prevent duplicate headers
        "retry-after": String(retryAfterSec)
      }
    }
  );
}

/**
 * Format provider error with context
 * @param {Error} error - Original error
 * @param {string} provider - Provider name
 * @param {string} model - Model name
 * @param {number|string} statusCode - HTTP status code or error code
 * @returns {string} Formatted error message
 */
export function formatProviderError(error, provider, model, statusCode) {
  const code = statusCode || error.code || "FETCH_FAILED";
  const message = error.message || "Unknown error";
  // Expose low-level cause (e.g. UND_ERR_SOCKET, ECONNRESET, ETIMEDOUT) for diagnosing fetch failures
  const causeCode = error.cause?.code;
  const causeMsg = error.cause?.message;
  const causeStr = causeCode || causeMsg ? ` (cause: ${[causeCode, causeMsg].filter(Boolean).join(": ")})` : "";
  return `[${code}]: ${message}${causeStr}`;
}
