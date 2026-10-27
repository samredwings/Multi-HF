const LAYOUT = new Set([
  "state", "browserstate", "button", "markdown", "html", "label", "dataset", "form",
  "column", "row", "group", "accordion", "tabs", "tabitem", "highlightedtext", "gallery",
]);
const KNOWN_HF_HOSTS = new Set(["huggingface.co", "www.huggingface.co", "hf.co"]);

export function stripEmoji(value) {
  return String(value ?? "").replace(/\p{Extended_Pictographic}/gu, "").replace(/[\u200d\ufe0f]/g, "").replace(/\s+/g, " ").trim();
}

export function parseSpaceInput(raw) {
  const input = String(raw ?? "").trim();
  if (!input) throw new Error("Enter a Space ID (owner/name) or Hugging Face URL.");
  if (/^[\w.-]+\/[\w.-]+$/.test(input) && !input.split("/").some((part) => part.includes(".."))) {
    return { id: input, host: null };
  }
  let url;
  try { url = new URL(input.includes("://") ? input : `https://${input}`); }
  catch { throw new Error("That URL is not valid."); }
  if (url.protocol !== "https:" || url.username || url.password || url.port) throw new Error("Only public HTTPS Hugging Face URLs are supported.");
  const host = url.hostname.toLowerCase();
  if (KNOWN_HF_HOSTS.has(host)) {
    const parts = url.pathname.split("/").filter(Boolean);
    const idx = parts[0] === "spaces" ? 1 : 0;
    if (parts[idx] && parts[idx + 1] && !parts[idx].includes("..") && !parts[idx + 1].includes("..")) return { id: `${parts[idx]}/${parts[idx + 1]}`, host: null };
    throw new Error("Use a Space page URL (huggingface.co/spaces/owner/name) or an owner/name ID.");
  }
  if (host.endsWith(".hf.space") && !host.includes("..")) return { id: null, host: url.origin };
  throw new Error("This app only connects to huggingface.co, hf.co, or a *.hf.space host.");
}

export function normalizeHost(hostValue, subdomain) {
  const raw = String(hostValue ?? "").trim();
  if (/^https:\/\/[a-z0-9.-]+\.hf\.space$/i.test(raw)) return raw.replace(/\/$/, "");
  if (/^[a-z0-9.-]+\.hf\.space$/i.test(raw) && !raw.includes("..")) return `https://${raw}`;
  if (subdomain && /^[a-z0-9-]+$/i.test(subdomain)) return `https://${subdomain}.hf.space`;
  return "";
}

function record(value) { return value && typeof value === "object" && !Array.isArray(value) ? value : null; }
function number(value) { return typeof value === "number" && Number.isFinite(value) ? value : undefined; }
function parseChoices(raw) {
  if (!Array.isArray(raw)) return [];
  const choices = [];
  for (const item of raw) {
    if (typeof item === "string" || typeof item === "number") {
      const value = String(item); choices.push({ label: stripEmoji(value) || value, value });
    } else if (Array.isArray(item) && item.length > 1) {
      const value = String(item[1]); choices.push({ label: stripEmoji(item[0]) || value, value });
    } else {
      const itemRecord = record(item);
      if (itemRecord && "value" in itemRecord) {
        const value = String(itemRecord.value); choices.push({ label: stripEmoji(itemRecord.label ?? value) || value, value });
      }
    }
  }
  return choices;
}
function typeFor(rawType, props) {
  const type = String(rawType || "textbox").toLowerCase();
  if (LAYOUT.has(type)) return "skip";
  if (type === "textbox") return Number(props.lines ?? 1) > 1 || /prompt|caption|description|negative/i.test(String(props.label ?? "")) ? "textarea" : "text";
  if (type === "slider") return "slider";
  if (type === "number") return "number";
  if (type === "checkbox") return "checkbox";
  if (type === "checkboxgroup") return "checkboxgroup";
  if (type === "dropdown") return "select";
  if (type === "radio") return "radio";
  if (["image", "sketchpad", "imageeditor"].includes(type)) return "image";
  if (type === "video") return "video";
  if (type === "audio") return "audio";
  if (["file", "uploadbutton"].includes(type)) return "file";
  return "text";
}
function defaultFor(type, value, choices) {
  if (type === "checkbox") return value === true;
  if (type === "checkboxgroup") return Array.isArray(value) ? value.map(String) : [];
  if (["number", "slider"].includes(type)) return typeof value === "number" ? value : (value ?? null);
  if (["select", "radio"].includes(type)) return value == null ? (choices[0]?.value ?? "") : String(value);
  return typeof value === "string" ? value : "";
}
function toField(component) {
  const props = component?.props ?? {};
  const id = component?.id ?? 0;
  const mapped = typeFor(component?.type, props);
  const hidden = mapped === "skip" || props.visible === false;
  const type = mapped === "skip" ? "text" : mapped;
  const choices = parseChoices(props.choices);
  const rawLabel = typeof props.label === "string" ? props.label : "";
  const field = {
    key: `c${id}`, label: stripEmoji(rawLabel) || (hidden ? "" : `Input ${id}`), type, hidden,
    hint: typeof props.info === "string" ? stripEmoji(props.info).slice(0, 180) : "",
    placeholder: typeof props.placeholder === "string" ? stripEmoji(props.placeholder) : "",
    min: number(props.minimum ?? props.min), max: number(props.maximum ?? props.max), step: number(props.step),
    choices, allowCustom: props.allow_custom_value === true, defaultValue: defaultFor(type, props.value, choices),
    passthrough: hidden && props.value && typeof props.value === "object" ? props.value : undefined,
  };
  if (["image", "video", "audio", "file"].includes(type)) field.defaultValue = null;
  return field;
}
function score(endpoint) {
  const outputs = endpoint.outputs.map((out) => out.type);
  let value = 0;
  if (outputs.includes("video")) value += 50;
  if (outputs.includes("image") || outputs.includes("gallery")) value += 40;
  if (outputs.includes("audio")) value += 12;
  if (/^(infer|generate|predict)$/i.test(endpoint.apiName)) value += 30;
  else if (/generat|infer|predict|txt2|text_to|image_to|i2v|t2v/i.test(endpoint.apiName)) value += 16;
  if (endpoint.fields.some((field) => !field.hidden && ["textarea", "image", "text"].includes(field.type))) value += 6;
  return value;
}
export function parseSpaceConfig(config) {
  const root = record(config);
  if (!root || !Array.isArray(root.components)) throw new Error("This Space did not return a valid Gradio /config document.");
  const components = new Map();
  for (const item of root.components) { const comp = record(item); if (comp && typeof comp.id === "number") components.set(comp.id, comp); }
  const endpoints = [];
  for (const rawDep of Array.isArray(root.dependencies) ? root.dependencies : []) {
    const dep = record(rawDep);
    if (!dep) continue;
    const apiName = typeof dep.api_name === "string" ? dep.api_name.replace(/^\//, "") : "";
    if (!apiName || ["false", "null", "lambda"].includes(apiName) || apiName.startsWith("_") || apiName.startsWith("js_") || !/^[\w.-]+$/.test(apiName)) continue;
    const inputs = Array.isArray(dep.inputs) ? dep.inputs.filter((id) => typeof id === "number") : [];
    const outputs = Array.isArray(dep.outputs) ? dep.outputs.filter((id) => typeof id === "number") : [];
    if (!outputs.length) continue;
    endpoints.push({
      apiName,
      fields: inputs.map((id) => toField(components.get(id) ?? { id, type: "textbox" })),
      outputs: outputs.map((id) => {
        const comp = components.get(id); const type = String(comp?.type ?? "text").toLowerCase();
        return { key: `o${id}`, label: stripEmoji(comp?.props?.label ?? "Output") || "Output", type };
      }),
    });
  }
  const media = endpoints.filter((ep) => ep.outputs.some((out) => ["image", "video", "audio", "gallery", "file"].includes(out.type)));
  const ordered = (media.length ? media : endpoints).slice().sort((a, b) => score(b) - score(a));
  if (!ordered.length) throw new Error("No runnable API endpoints were found in this Space configuration.");
  return { title: stripEmoji(root.title) || "Hugging Face Space", apiPrefix: typeof root.api_prefix === "string" && root.api_prefix.startsWith("/") ? root.api_prefix : "/gradio_api", endpoints: ordered.slice(0, 12) };
}
export function taskFromEndpoints(endpoints) {
  const types = endpoints.flatMap((endpoint) => endpoint.outputs.map((out) => out.type));
  if (types.includes("video")) return "video";
  if (types.includes("image") || types.includes("gallery")) return "image";
  return "other";
}

const POLICY = /content policy|safety filter|moderation|nsfw filter|flagged as|blocked by safety/i;
const AUTH = /invalid token|unauthorized|\b401\b|expired token|not authenticated|authentication required/i;
const QUOTA = /zero\s*gpu|gpu quota|quota exceeded|out of credits|insufficient credit|payment required|monthly (included )?credit|depleted|spend limit|exceeded your (free|gpu|quota)|no gpu quota/i;
const WAKING = /asleep|waking|is starting|space is (sleep|start|build|paused)|currently loading|loading (the )?model|model is loading|building replica/i;
const TRANSIENT = /timeout|timed out|econnreset|socket hang up|network|fetch failed|bad gateway|gateway timeout|connection (closed|reset|dropped|aborted)|runtime (has )?(ended|expired)|upstream|overloaded|rate limit|too many requests|\b429\b|\b502\b|\b503\b|\b504\b|\b524\b|disconnected/i;
export function classifyFailure(status, message = "") {
  const text = `${status ?? ""} ${message}`;
  if (POLICY.test(text)) return "policy";
  if (status === 401 || AUTH.test(text)) return "auth";
  if (status === 402 || QUOTA.test(text)) return "quota";
  if (WAKING.test(text)) return "waking";
  if (status === 429 || status === 502 || status === 503 || status === 504 || TRANSIENT.test(text) || (status != null && status >= 500)) return "transient";
  if (status === 400 || status === 404 || status === 422) return "fatal";
  return status == null && !message ? "transient" : "fatal";
}
export function holdFor(kind, message, resetsAt = null, now = Date.now()) {
  if (kind === "quota") {
    if (resetsAt) { const parsed = Date.parse(resetsAt); if (Number.isFinite(parsed) && parsed > now) return parsed; }
    return null;
  }
  if (kind === "transient" && /rate limit|too many requests|\b429\b/i.test(message)) return now + 2 * 60 * 1000;
  return null;
}
export function normalizeOutputs(value, label = "Output", baseUrl = "") {
  if (value == null) return [];
  if (Array.isArray(value)) return value.flatMap((item, index) => normalizeOutputs(item, `${label} ${index + 1}`, baseUrl));
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return [];
    if (/^data:image\//i.test(trimmed)) return [{ kind: "image", url: trimmed, label }];
    if (/^data:video\//i.test(trimmed)) return [{ kind: "video", url: trimmed, label }];
    if (/^data:audio\//i.test(trimmed)) return [{ kind: "audio", url: trimmed, label }];
    if (/^https?:\/\//i.test(trimmed) || trimmed.startsWith("/file=") || trimmed.startsWith("file=")) {
      const absolute = /^https?:\/\//i.test(trimmed) ? trimmed : `${baseUrl}${trimmed.startsWith("/file=") ? trimmed : `/file=${trimmed.replace(/^\//, "")}`}`;
      const clean = trimmed.split(/[?#]/)[0].toLowerCase();
      const kind = /\.(mp4|webm|mov|m4v)$/.test(clean) ? "video" : /\.(mp3|wav|ogg|m4a|flac)$/.test(clean) ? "audio" : /\.(png|jpe?g|webp|gif|avif)$/.test(clean) || /\/file=/.test(trimmed) ? "image" : "file";
      return [{ kind, url: absolute, label }];
    }
    return [{ kind: "text", text: trimmed.slice(0, 5000), label }];
  }
  const rec = record(value);
  if (!rec) return [{ kind: "text", text: String(value), label }];
  if (rec.video || rec.image || rec.audio) return normalizeOutputs(rec.video ?? rec.image ?? rec.audio, label, baseUrl);
  if (typeof rec.url === "string" || typeof rec.path === "string") {
    const raw = String(rec.url ?? rec.path);
    const mime = String(rec.mime_type ?? rec.mimeType ?? "").toLowerCase();
    const inferred = mime.startsWith("video/") ? "video" : mime.startsWith("audio/") ? "audio" : mime.startsWith("image/") ? "image" : undefined;
    const results = normalizeOutputs(raw, String(rec.orig_name ?? rec.name ?? label), baseUrl);
    if (inferred && results[0]) results[0].kind = inferred;
    return results;
  }
  if (typeof rec.text === "string") return [{ kind: "text", text: rec.text.slice(0, 5000), label }];
  if (Array.isArray(rec.data)) return normalizeOutputs(rec.data, label, baseUrl);
  return [{ kind: "text", text: JSON.stringify(rec).slice(0, 5000), label }];
}
export function safeId(prefix = "id") { return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`; }

// ---------------------------------------------------------------------------
// Token policy: a token may go to the Hub API, and to a *.hf.space host only
// when the Hub reported that Space as private. Anyone can publish a public
// Space, so public hosts must never receive a user's token.
export function tokenHeaders(token, url, { privateSpace = false } = {}) {
  if (!token) return {};
  let target;
  try { target = new URL(url); } catch { return {}; }
  if (target.protocol !== "https:" || target.username || target.password || target.port) return {};
  const host = target.hostname.toLowerCase();
  if (host === "huggingface.co" || host === "www.huggingface.co") return { Authorization: `Bearer ${token}` };
  if (privateSpace && /^[a-z0-9-]+\.hf\.space$/.test(host)) return { Authorization: `Bearer ${token}` };
  return {};
}

// ---------------------------------------------------------------------------
// Storage / import hygiene
const MAX_INLINE_STORED = 50_000;
const JOB_STATUSES = new Set(["ready", "retry", "running", "done", "failed", "paused"]);
const RESULT_KINDS = new Set(["image", "video", "audio", "file", "text"]);
const FIELD_TYPES = new Set(["text", "textarea", "number", "slider", "checkbox", "checkboxgroup", "select", "radio", "image", "video", "audio", "file"]);
const text = (value, max = 500) => (typeof value === "string" ? value.slice(0, max) : "");
const finite = (value) => (typeof value === "number" && Number.isFinite(value) ? value : undefined);

/** Large inline (data:) media would blow the localStorage quota; keep a note instead. */
export function persistableResult(result) {
  if (!Array.isArray(result)) return [];
  return result.map((item) => (typeof item?.url === "string" && item.url.startsWith("data:") && item.url.length > MAX_INLINE_STORED
    ? { kind: "text", label: item.label || "Output", text: "Inline media was too large to store in this browser. Re-run the job to regenerate it." }
    : item));
}

/** A job left in "running" by a closed tab must not be stuck forever, and must not silently re-spend quota. */
export function recoverRunningJobs(jobs, now = Date.now()) {
  return (Array.isArray(jobs) ? jobs : []).map((job) => (job?.status === "running"
    ? { ...job, status: "paused", error: "Interrupted by a page reload. Retry when ready.", updatedAt: now }
    : job));
}

function cleanEndpoint(raw) {
  const ep = record(raw);
  if (!ep || typeof ep.apiName !== "string" || !/^[\w.-]+$/.test(ep.apiName)) return null;
  const fields = (Array.isArray(ep.fields) ? ep.fields : []).map(record).filter((f) => f && typeof f.key === "string" && /^c\d+$/.test(f.key) && FIELD_TYPES.has(f.type));
  const outputs = (Array.isArray(ep.outputs) ? ep.outputs : []).map(record).filter((o) => o && typeof o.key === "string").map((o) => ({ key: o.key, label: text(o.label, 120) || "Output", type: text(o.type, 40) || "text" }));
  return { apiName: ep.apiName, fields: fields.map((f) => ({ ...f, choices: Array.isArray(f.choices) ? f.choices : [] })), outputs };
}
function cleanResult(raw) {
  const item = record(raw);
  if (!item || !RESULT_KINDS.has(item.kind)) return null;
  if (item.kind === "text") return { kind: "text", text: text(item.text, 5000), label: text(item.label, 120) || "Output" };
  const url = text(item.url, 2_000_000);
  if (!/^(https:\/\/|data:(image|video|audio)\/)/i.test(url)) return null;
  return { kind: item.kind, url, label: text(item.label, 120) || "Output" };
}

/** Validate an imported workspace. Hosts are re-checked, so a crafted file cannot aim a saved token at another site. */
export function sanitizeWorkspace(data) {
  const root = record(data?.workspace) ?? record(data);
  if (!root || !Array.isArray(root.models) || !Array.isArray(root.jobs) || !Array.isArray(root.profiles)) throw new Error("This file is not a Multi-HF workspace export.");
  const models = [];
  for (const raw of root.models) {
    const m = record(raw);
    if (!m || typeof m.id !== "string") continue;
    const host = normalizeHost(m.host);
    if (!host) continue;
    const endpoints = (Array.isArray(m.endpoints) ? m.endpoints : []).map(cleanEndpoint).filter(Boolean);
    if (!endpoints.length) continue;
    models.push({
      id: text(m.id, 200), kind: "space", host, endpoints,
      ref: /^[\w.-]+\/[\w.-]+$/.test(m.ref ?? "") ? m.ref : "",
      title: text(m.title, 200) || host, note: text(m.note, 200),
      task: ["image", "video", "other"].includes(m.task) ? m.task : "other",
      apiPrefix: /^\/[\w./-]*$/.test(m.apiPrefix ?? "") ? m.apiPrefix : "/gradio_api",
      activeApi: endpoints.some((e) => e.apiName === m.activeApi) ? m.activeApi : endpoints[0].apiName,
      accountId: text(m.accountId, 100), hardware: text(m.hardware, 80) || "Unknown",
      fetchedAt: finite(m.fetchedAt) ?? 0, private: m.private === true,
    });
  }
  const known = new Set(models.map((m) => m.id));
  const profiles = root.profiles.map(record).filter((p) => p && typeof p.id === "string" && known.has(p.modelId)).map((p) => ({
    id: text(p.id, 100), name: text(p.name, 120), modelId: p.modelId, apiName: text(p.apiName, 100),
    values: record(p.values) ?? {}, accountId: text(p.accountId, 100), createdAt: finite(p.createdAt) ?? 0, updatedAt: finite(p.updatedAt) ?? 0,
  }));
  const jobs = root.jobs.map(record).filter((j) => j && typeof j.id === "string" && known.has(j.modelId)).map((j) => ({
    id: text(j.id, 100), name: text(j.name, 200), modelId: j.modelId, apiName: text(j.apiName, 100), accountId: text(j.accountId, 100),
    values: record(j.values) ?? {}, files: Array.isArray(j.files) ? j.files.filter((f) => typeof f === "string") : [],
    status: JOB_STATUSES.has(j.status) ? j.status : "failed", error: text(j.error, 2000),
    result: (Array.isArray(j.result) ? j.result : []).map(cleanResult).filter(Boolean),
    createdAt: finite(j.createdAt) ?? 0, updatedAt: finite(j.updatedAt) ?? 0, startedAt: finite(j.startedAt), finishedAt: finite(j.finishedAt),
    progress: finite(j.progress), attempts: 0,
  }));
  const accounts = (Array.isArray(root.accounts) ? root.accounts : []).map(record).filter((a) => a && typeof a.id === "string").map((a) => ({
    id: text(a.id, 100), label: text(a.label, 60) || "Account", username: text(a.username, 80), enabled: a.enabled !== false, createdAt: finite(a.createdAt) ?? 0, connected: false,
  }));
  return { models, profiles, jobs: recoverRunningJobs(jobs), accounts, settings: { lastAccountId: text(record(root.settings)?.lastAccountId, 100) } };
}

// ---------------------------------------------------------------------------
// Gradio SSE reader (handles LF and CRLF, string error payloads, `generating` events)
function errorMessage(payload) {
  if (typeof payload === "string") return payload;
  const raw = payload?.message ?? payload?.error ?? payload?.output?.error ?? (payload?.raw && payload.raw !== "null" ? payload.raw : "");
  return typeof raw === "string" && raw ? raw : "Gradio endpoint returned an error (the Space gave no details).";
}
export async function readGradioStream(response, onProgress) {
  if (!response.body) throw new Error("The Space returned an empty result stream.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = ""; let lastData = null;
  const handle = (block) => {
    let event = "message"; const dataLines = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
    }
    if (!dataLines.length) return { done: false };
    const dataText = dataLines.join("\n");
    if (dataText === "[DONE]") return { done: true, data: lastData };
    let payload; try { payload = JSON.parse(dataText); } catch { payload = { raw: dataText }; }
    if (event === "error" || payload?.msg === "unexpected_error" || (payload && !Array.isArray(payload) && payload.success === false)) throw new Error(errorMessage(payload));
    if (event === "complete" || event === "process_completed") return { done: true, data: payload?.output?.data ?? payload?.data ?? payload };
    if (event === "message" && payload?.is_generating === false && payload?.data) lastData = payload.data;
    if (["generating", "process_generating", "heartbeat", "estimation"].includes(event)) onProgress?.(payload);
    return { done: false };
  };
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer = (buffer + decoder.decode(value || new Uint8Array(), { stream: !done })).replace(/\r\n/g, "\n");
      const blocks = buffer.split("\n\n"); buffer = blocks.pop() ?? "";
      if (done && buffer.trim()) { blocks.push(buffer); buffer = ""; }
      for (const block of blocks) { const result = handle(block); if (result.done) return result.data; }
      if (done) break;
    }
  } finally { reader.cancel().catch(() => {}); }
  if (lastData != null) return lastData;
  throw new Error("Gradio stream ended before a completed output was received.");
}
