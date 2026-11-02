const STORAGE_KEY = "multi-hf.diagnostics.v1";
const DEFAULT_LIMIT = 240;
const MAX_MESSAGE_LENGTH = 5000;
const SECRET_KEYS = /(authorization|cookie|set-cookie|access[_-]?token|refresh[_-]?token|token|secret|password|api[_-]?key|client[_-]?secret)/i;
const PRIVATE_CONTENT_KEYS = /(prompt|input|file|payload|content|request[_-]?body|input[_-]?data)/i;

export function sanitizeDiagnosticText(value) {
  return String(value ?? "")
    .replace(/\bhf_[A-Za-z0-9]{20,}\b/g, "[REDACTED_HF_TOKEN]")
    .replace(/\bBearer\s+[^\s"' ,;]+/gi, "Bearer [REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "[REDACTED_JWT]")
    .replace(/((?:authorization|access[_-]?token|refresh[_-]?token|token|secret|password|api[_-]?key)\s*[:=]\s*)(["']?)[^"'\s,;&}]+/gi, "$1$2[REDACTED]")
    .replace(/([?&](?:token|access_token|api_key|key|secret|authorization)=)[^&#\s]*/gi, "$1[REDACTED]")
    .slice(0, MAX_MESSAGE_LENGTH);
}

function safeValue(value, depth = 0, seen = new WeakSet()) {
  if (value == null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return sanitizeDiagnosticText(value);
  if (typeof value === "bigint") return String(value);
  if (typeof value !== "object") return String(value);
  if (depth > 5) return "[Max depth]";
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (value instanceof Error) return {
    name: sanitizeDiagnosticText(value.name || "Error"),
    message: sanitizeDiagnosticText(value.message || String(value)),
    stack: sanitizeDiagnosticText(value.stack || ""),
  };
  if (Array.isArray(value)) return value.slice(0, 40).map((item) => safeValue(item, depth + 1, seen));
  const output = {};
  for (const [key, item] of Object.entries(value).slice(0, 60)) {
    if (SECRET_KEYS.test(key)) output[key] = "[REDACTED]";
    else if (PRIVATE_CONTENT_KEYS.test(key)) output[key] = "[OMITTED]";
    else output[key] = safeValue(item, depth + 1, seen);
  }
  return output;
}

function safeUrl(value, base = "https://local.invalid") {
  try {
    const url = new URL(String(value || ""), base);
    url.search = "";
    url.hash = "";
    return sanitizeDiagnosticText(url.href);
  } catch {
    return sanitizeDiagnosticText(String(value || "")).split("?")[0].split("#")[0];
  }
}

function safeErrorBody(raw) {
  try {
    const parsed = JSON.parse(raw);
    const allow = /^(error|detail|message|code|type|status|traceback|loc|errors)$/i;
    const pick = (value, depth = 0) => {
      if (depth > 4 || value == null) return value;
      if (typeof value === "string") return sanitizeDiagnosticText(value);
      if (typeof value !== "object") return value;
      if (Array.isArray(value)) return value.slice(0, 20).map((item) => pick(item, depth + 1));
      const result = {};
      for (const [key, item] of Object.entries(value)) {
        if (!PRIVATE_CONTENT_KEYS.test(key) && !SECRET_KEYS.test(key) && allow.test(key)) result[key] = pick(item, depth + 1);
      }
      return result;
    };
    return pick(parsed);
  } catch {
    return "[Plain-text response omitted to protect submitted content]";
  }
}

function describeArgument(value) {
  if (value instanceof Error) return value.stack || value.message || value.name;
  if (typeof value === "string") return value;
  try { return JSON.stringify(value); } catch { return String(value); }
}

export function createDiagnosticReporter(options = {}) {
  const storage = options.storage ?? globalThis.localStorage;
  const now = options.now ?? (() => Date.now());
  const maxEntries = Math.max(20, Math.min(1000, Number(options.maxEntries) || DEFAULT_LIMIT));
  let entries = [];
  let installed = false;
  try {
    const saved = JSON.parse(storage?.getItem(STORAGE_KEY) || "[]");
    if (Array.isArray(saved)) entries = saved.slice(-maxEntries).map((entry) => safeValue(entry));
  } catch { entries = []; }

  function persist() {
    try { storage?.setItem(STORAGE_KEY, JSON.stringify(entries.slice(-maxEntries))); } catch { /* retain in-memory diagnostics */ }
  }
  function record(level, message, details = {}) {
    const entry = { timestamp: new Date(now()).toISOString(), level: sanitizeDiagnosticText(level || "info"), message: sanitizeDiagnosticText(message), details: safeValue(details) };
    entries.push(entry);
    if (entries.length > maxEntries) entries = entries.slice(-maxEntries);
    persist();
    return entry;
  }
  function captureError(error, context = {}) {
    const normalized = safeValue(error);
    const message = normalized && typeof normalized === "object" ? [normalized.name, normalized.message].filter(Boolean).join(": ") : String(normalized || "Unknown error");
    return record("error", message, { ...context, error: normalized });
  }
  function importNativeEntries(nativeEntries) {
    let parsed = nativeEntries;
    if (typeof parsed === "string") { try { parsed = JSON.parse(parsed); } catch { return 0; } }
    if (!Array.isArray(parsed)) return 0;
    let imported = 0;
    for (const item of parsed.slice(-200)) {
      const nativeId = String(item?.id ?? "");
      if (nativeId && entries.some((entry) => entry.details?.nativeId === nativeId)) continue;
      record("android_" + sanitizeDiagnosticText(item?.level || "log"), item?.message || "Android diagnostic", {
        nativeId: nativeId || undefined, source: item?.source || "", line: Number(item?.line || 0),
        stack: item?.stack || "", nativeTimestamp: item?.timestamp || null,
      });
      imported += 1;
    }
    return imported;
  }
  function install(target = globalThis) {
    if (installed || !target?.addEventListener) return;
    installed = true;
    target.addEventListener("error", (event) => {
      const element = event?.target;
      if (element && element !== target && (element.src || element.href || element.currentSrc)) {
        record("resource_error", "A page resource failed to load.", { tag: element.tagName || "", url: safeUrl(element.currentSrc || element.src || element.href, target.location?.href) });
        return;
      }
      captureError(event?.error || event?.message || "Uncaught JavaScript error", {
        source: safeUrl(event?.filename || "", target.location?.href), line: Number(event?.lineno || 0), column: Number(event?.colno || 0),
      });
    }, true);
    target.addEventListener("unhandledrejection", (event) => captureError(event?.reason || "Unhandled promise rejection", { source: "unhandledrejection" }));
    target.addEventListener("online", () => record("connectivity", "Network connection restored."));
    target.addEventListener("offline", () => record("connectivity", "Network connection lost."));
    if (target.console) {
      for (const method of ["error", "warn"]) {
        const original = target.console[method];
        if (typeof original !== "function") continue;
        target.console[method] = function (...args) {
          record("console_" + method, args.map(describeArgument).join(" ").slice(0, MAX_MESSAGE_LENGTH), { stack: sanitizeDiagnosticText(new Error().stack || "") });
          return Reflect.apply(original, this, args);
        };
      }
    }
    if (typeof target.fetch === "function") {
      const originalFetch = target.fetch;
      target.fetch = async function (input, init = {}) {
        const rawUrl = typeof input === "string" || input instanceof URL ? String(input) : input?.url || "";
        const method = String(init?.method || input?.method || "GET").toUpperCase();
        const url = safeUrl(rawUrl, target.location?.href);
        let response;
        try { response = await Reflect.apply(originalFetch, this, [input, init]); }
        catch (error) { captureError(error, { kind: "network_request", method, url }); throw error; }
        if (!response.ok) {
          const status = response.status;
          try {
            response.clone().text().then((body) => record("http_error", method + " " + url + " returned HTTP " + status, {
              status, url, method, response: safeErrorBody(body.slice(0, 12000)),
            })).catch(() => record("http_error", method + " " + url + " returned HTTP " + status, { status, url, method }));
          } catch { record("http_error", method + " " + url + " returned HTTP " + status, { status, url, method }); }
        }
        return response;
      };
    }
    record("lifecycle", "Diagnostic capture enabled.");
  }
  function createReport(metadata = {}) {
    return {
      reportFormatVersion: 1, generatedAt: new Date(now()).toISOString(),
      application: safeValue(metadata.application || { name: "Multi-HF", version: "unknown" }),
      environment: safeValue(metadata.environment || {}), appContext: safeValue(metadata.appContext || {}),
      privacy: {
        credentials: "Redacted",
        promptsAndSubmittedInputs: "Omitted from diagnostic context and structured HTTP error bodies",
        uploadedFiles: "Not included", workspaceContents: "Not included",
      },
      diagnostics: entries.slice(-maxEntries).map((entry) => safeValue(entry)),
    };
  }
  return {
    record, captureError, importNativeEntries, install,
    getEntries: () => entries.map((entry) => safeValue(entry)),
    createReport, clear() { entries = []; persist(); },
  };
}
