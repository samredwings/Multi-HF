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
