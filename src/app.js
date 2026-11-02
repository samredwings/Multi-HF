import {
  parseSpaceInput, normalizeHost, parseSpaceConfig, normalizeGradioVersion, normalizeSpaceFramework, taskFromEndpoints, classifyFailure, nextQueueBatch, normalizeZeroGpuQuota,
  holdFor, normalizeOutputs, safeId, tokenHeaders, persistableResult, recoverRunningJobs, sanitizeWorkspace, readGradioStream, errorMessage,
} from "./lib/core.js";

const STORAGE_KEY = "multi-hf.workspace.v1";
const view = document.querySelector("#view");
const dialog = document.querySelector("#dialog");
const dialogContent = document.querySelector("#dialog-content");
const notice = document.querySelector("#notice");
const toast = document.querySelector("#toast");
const pageTitle = document.querySelector("#page-title");
const navCount = document.querySelector("#nav-queue-count");
const accountSummary = document.querySelector("#account-summary");
const accountTokens = new Map();
const jobFiles = new Map();
let currentTab = "queue";
let currentSpaceUi = null;
let currentSpaceMode = "native";
const gradioScriptLoads = new Map();
let loadedGradioVersion = "";
let queueBusy = false;
let queueHalted = false;
let currentAbort = null;
let attachmentDbPromise = null;
let quotaAccountId = "";
let quotaState = { data: null, error: "", loading: false, accountId: "", checkedAt: 0 };
let toastTimer;
let saveTimer;
const GEN_TIMEOUT_MS = 15 * 60 * 1000;
const META_TIMEOUT_MS = 30 * 1000;
const MAX_AUTO_RETRIES = 2;

const ATTACHMENT_DB_NAME = "multi-hf.attachments.v1";
const ATTACHMENT_DB_VERSION = 1;
function openAttachmentDb() {
  if (attachmentDbPromise) return attachmentDbPromise;
  if (!("indexedDB" in window)) return Promise.reject(new Error("This browser does not support persistent file attachments. Use a browser with IndexedDB enabled."));
  attachmentDbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(ATTACHMENT_DB_NAME, ATTACHMENT_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("attachments")) {
        const store = db.createObjectStore("attachments", { keyPath: "id" });
        store.createIndex("jobId", "jobId", { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Could not open attachment storage."));
    request.onblocked = () => reject(new Error("Attachment storage is blocked by another open app tab. Close older Multi-HF tabs and retry."));
  });
  return attachmentDbPromise;
}
function normalizeSelectedFiles(value) {
  if (!value) return [];
  return (Array.isArray(value) ? value : [value]).filter(Boolean);
}
async function persistJobAttachments(jobId, fileMap) {
  if (!fileMap?.size) return;
  const db = await openAttachmentDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction("attachments", "readwrite");
    const store = tx.objectStore("attachments");
    for (const [key, value] of fileMap.entries()) {
      const files = normalizeSelectedFiles(value).map((file) => ({
        blob: file.blob || file,
        name: file.name || "upload",
        type: file.type || file.mime || "application/octet-stream",
        size: Number(file.size || 0),
        lastModified: Number(file.lastModified || Date.now()),
      }));
      store.put({ id: `${jobId}:${key}`, jobId, key, files });
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error("Could not save an uploaded file."));
    tx.onabort = () => reject(tx.error || new Error("File attachment storage was cancelled."));
  });
}
async function loadJobAttachments(jobId) {
  const db = await openAttachmentDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("attachments", "readonly");
    const request = tx.objectStore("attachments").index("jobId").getAll(jobId);
    request.onsuccess = () => {
      const result = new Map();
      for (const record of request.result || []) {
        const restored = (record.files || []).map((item) => ({
          blob: item.blob,
          name: item.name || "upload",
          type: item.type || "application/octet-stream",
          size: Number(item.size || item.blob?.size || 0),
          lastModified: Number(item.lastModified || Date.now()),
        }));
        if (restored.length) result.set(record.key, restored.length === 1 ? restored[0] : restored);
      }
      resolve(result);
    };
    request.onerror = () => reject(request.error || new Error("Could not restore saved file attachments."));
  });
}
async function deleteJobAttachments(jobId) {
  try {
    const db = await openAttachmentDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction("attachments", "readwrite");
      const request = tx.objectStore("attachments").index("jobId").openKeyCursor(IDBKeyRange.only(jobId));
      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor) { tx.objectStore("attachments").delete(cursor.primaryKey); cursor.continue(); }
      };
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error || new Error("Could not remove saved attachments."));
    });
    jobFiles.delete(jobId);
  } catch (error) { console.warn("[Multi-HF] Attachment cleanup failed:", error); }
}
async function getJobAttachments(job) {
  if (jobFiles.has(job.id)) return jobFiles.get(job.id);
  if (!(job.files || []).length) { const empty = new Map(); jobFiles.set(job.id, empty); return empty; }
  const files = await loadJobAttachments(job.id);
  jobFiles.set(job.id, files);
  return files;
}
function isFileField(field) {
  return ["image", "video", "audio", "file", "gallery"].includes(field?.type);
}
function fileMeta(file) {
  return { name: file.name || "upload", size: Number(file.size || 0), mime: file.type || "application/octet-stream" };
}
function formatGpuTime(seconds) {
  const safe = Math.max(0, Math.floor(Number(seconds) || 0));
  return `${Math.floor(safe / 60)}m ${String(safe % 60).padStart(2, "0")}s`;
}

function readWorkspace() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    return {
      models: Array.isArray(parsed.models) ? parsed.models : [],
      profiles: Array.isArray(parsed.profiles) ? parsed.profiles : [],
      jobs: Array.isArray(parsed.jobs) ? recoverRunningJobs(parsed.jobs) : [],
      accounts: Array.isArray(parsed.accounts) ? parsed.accounts.map((a) => ({ ...a, connected: false })) : [],
      settings: { lastAccountId: "", ...(parsed.settings || {}) },
    };
  } catch { return { models: [], profiles: [], jobs: [], accounts: [], settings: { lastAccountId: "" } }; }
}
let state = readWorkspace();
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
const fmtDate = (value) => { const date = new Date(value); return Number.isNaN(+date) ? "—" : date.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }); };
const timeAgo = (value) => { const mins = Math.max(0, Math.floor((Date.now() - Number(value || 0)) / 60000)); return mins < 1 ? "just now" : mins < 60 ? `${mins}m ago` : mins < 1440 ? `${Math.floor(mins / 60)}h ago` : `${Math.floor(mins / 1440)}d ago`; };
const getModel = (id) => state.models.find((model) => model.id === id);
const getProfile = (id) => state.profiles.find((profile) => profile.id === id);
const getAccount = (id) => state.accounts.find((account) => account.id === id);
const connectedAccounts = () => state.accounts.filter((account) => account.connected && accountTokens.has(account.id));
const waitingJobs = () => state.jobs.filter((job) => ["ready", "retry"].includes(job.status));
function saveState() {
  const persisted = {
    models: state.models,
    profiles: state.profiles,
    jobs: state.jobs.map(({ result, ...job }) => ({ ...job, result: persistableResult(result) })),
    accounts: state.accounts.map(({ token, connected, ...account }) => ({ ...account, connected: false })),
    settings: state.settings,
  };
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(persisted)); }
  catch (error) { showNotice(`Workspace storage is full. Export your data and remove old jobs. ${error.message}`, "error"); }
}
function saveStateSoon() { clearTimeout(saveTimer); saveTimer = setTimeout(saveState, 1000); }
function ping(message) {
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 3500);
}
function showNotice(message, kind = "") {
  notice.textContent = message;
  notice.className = `notice ${kind}`.trim();
  notice.hidden = false;
}
function clearNotice() { notice.hidden = true; notice.textContent = ""; notice.className = "notice"; }
function showDialog(content) {
  dialogContent.innerHTML = `<div class="dialog-inner">${content}</div>`;
  if (!dialog.open) dialog.showModal();
  dialogContent.querySelectorAll("[data-close]").forEach((button) => button.addEventListener("click", () => dialog.close()));
}
// A modal <dialog> sits in the top layer, so toasts are hidden behind it. Show errors inside the dialog instead.
function dialogError(message) {
  console.error("[Multi-HF]", message);
  const inner = dialogContent.querySelector(".dialog-inner");
  if (!inner) { ping(message); return; }
  let box = inner.querySelector("#dialog-error");
  if (!box) {
    box = document.createElement("div"); box.id = "dialog-error"; box.className = "notice error"; box.setAttribute("role", "alert"); box.style.marginBottom = "14px";
    inner.querySelector(".dialog-header")?.after(box);
  }
  box.textContent = message; box.hidden = false; box.scrollIntoView?.({ block: "nearest" });
}
function dialogHeader(title, description = "") {
  return `<div class="dialog-header"><div><h2>${escapeHtml(title)}</h2><p>${escapeHtml(description)}</p></div><button class="close" type="button" data-close aria-label="Close dialog">✕</button></div>`;
}
function render() {
  const spaceUiModel = currentSpaceUi ? getModel(currentSpaceUi) : null;
  if (currentSpaceUi && !spaceUiModel) currentSpaceUi = null;
  const title = { queue: "Generation queue", jobs: "Job history", models: "Spaces & models", profiles: "Generation profiles", accounts: "Hugging Face accounts" }[currentTab];
  pageTitle.textContent = spaceUiModel ? `${spaceUiModel.title} · Model interface` : title;
  document.querySelectorAll("[data-tab]").forEach((button) => button.classList.toggle("active", !spaceUiModel && button.dataset.tab === currentTab));
  navCount.textContent = String(waitingJobs().length);
  const connected = connectedAccounts().length;
  accountSummary.textContent = connected ? `${connected} account${connected === 1 ? "" : "s"} connected` : "No account connected";
  if (spaceUiModel) renderSpaceUi(spaceUiModel);
  else if (currentTab === "queue") renderQueue();
  else if (currentTab === "jobs") renderJobs();
  else if (currentTab === "models") renderModels();
  else if (currentTab === "profiles") renderProfiles();
  else renderAccounts();
}
function stat(label, value, foot) {
  return `<div class="stat"><div class="stat-label">${escapeHtml(label)}</div><div class="stat-value">${escapeHtml(value)}</div><div class="stat-foot">${escapeHtml(foot)}</div></div>`;
}
function statusBadge(status) {
  const cls = status === "done" ? "done" : status === "running" ? "running" : status === "paused" ? "paused" : status === "failed" ? "failed" : status === "ready" || status === "retry" ? "ready" : "";
  const text = { ready: "READY", retry: "RETRY", running: "RUNNING", done: "COMPLETE", failed: "FAILED", paused: "PAUSED" }[status] || String(status || "UNKNOWN").toUpperCase();
  return `<span class="badge ${cls}">${escapeHtml(text)}</span>`;
}
function renderQuotaPanel() {
  const accounts = connectedAccounts();
  const preferred = quotaAccountId || state.settings.lastAccountId || accounts[0]?.id || "";
  const options = accounts.map((account) => `<option value="${escapeHtml(account.id)}" ${account.id === preferred ? "selected" : ""}>${escapeHtml(account.label)}</option>`).join("");
  let quotaBody = "";
  if (!accounts.length) quotaBody = '<p class="help">Connect a Hugging Face account to check its ZeroGPU allowance. The queue can still run public Spaces without a token.</p>';
  else if (quotaState.loading) quotaBody = '<p class="help">Checking the selected account’s ZeroGPU quota…</p>';
  else if (quotaState.data && quotaState.accountId === preferred) {
    const quota = quotaState.data;
    const pct = quota.base > 0 ? Math.max(0, Math.min(100, quota.remaining / quota.base * 100)) : 0;
    quotaBody = `<div class="quota-metrics"><div><span class="muted">Remaining</span><strong>${formatGpuTime(quota.remaining)}</strong></div><div><span class="muted">Daily allowance</span><strong>${formatGpuTime(quota.base)}</strong></div><div><span class="muted">Paid overage used</span><strong>${formatGpuTime(quota.overquotaUsed)}</strong></div></div><div class="quota-meter"><span style="width:${pct}%"></span></div><p class="help">${quota.resetsAt ? "Quota resets " + escapeHtml(fmtDate(quota.resetsAt)) : "Reset time not reported yet"} · refreshed ${escapeHtml(timeAgo(quotaState.checkedAt))}</p>`;
  } else if (quotaState.error && quotaState.accountId === preferred) quotaBody = `<p class="help">${escapeHtml(quotaState.error)}</p>`;
  else quotaBody = '<p class="help">Check your account’s remaining ZeroGPU GPU-seconds. Requires a fine-grained token with “Billing → Read billing usage and payment method status” permission.</p>';
  return `<div class="panel quota-panel"><div class="panel-head"><div><h2>ZeroGPU allowance</h2><div class="subtext">Live GPU-seconds for the selected Hugging Face account</div></div><div class="inline-actions">${accounts.length ? `<select id="quota-account" aria-label="Quota account">${options}</select>` : ""}<button class="button button-sm" id="quota-refresh" ${!accounts.length || quotaState.loading ? "disabled" : ""}>${quotaState.loading ? "Checking…" : "Refresh quota"}</button></div></div><div class="panel-body">${quotaBody}</div></div>`;
}
function renderQueue() {
  const ready = waitingJobs().length;
  const done = state.jobs.filter((job) => job.status === "done").length;
  const paused = state.jobs.filter((job) => job.status === "paused").length;
  const failed = state.jobs.filter((job) => job.status === "failed").length;
  const rows = state.jobs.filter((job) => job.status !== "done").slice().reverse().slice(0, 16);
  const running = state.jobs.filter((job) => job.status === "running").length;
  view.innerHTML = `
    <div class="stats">${stat("Pending jobs", ready, "Waiting to run")}${stat("In progress", running, "Preparing or running on a Space")}${stat("Completed", done, "Finished successfully")}${stat("Paused / failed", paused + failed, "Review before retrying")}</div>
    <div class="section-head"><div><h2>Queue workspace</h2><p>The scheduler groups jobs by Space and account, prepares all uploads first, then submits the batch to the Space queue.</p></div><div class="inline-actions"><button class="button button-quiet" id="queue-pause" ${queueBusy ? "" : "disabled"}>Pause queue</button><button class="button button-quiet" id="queue-cancel" ${queueBusy ? "" : "disabled"}>Cancel active batch</button><button class="button button-primary" id="queue-run" ${queueBusy || !ready ? "disabled" : ""}>▶ Run queue (${ready})</button></div></div>
    ${renderQuotaPanel()}
    <div class="panel"><div class="panel-head"><div><h2>Upcoming & active</h2><div class="subtext">${queueBusy ? "The active Space batch is being prepared or processed." : queueHalted ? "Queue is paused. Review the affected job before continuing." : "Jobs are staged and will run when you start the queue."}</div></div><button class="button button-sm" id="queue-add">＋ Add job</button></div>
    ${rows.length ? `<div class="table-wrap"><table class="table"><thead><tr><th>Job</th><th>Space</th><th>Status</th><th>Updated</th><th>Action</th></tr></thead><tbody>${rows.map(jobRow).join("")}</tbody></table></div>` : `<div class="empty"><div class="empty-mark">▦</div><strong>Your queue is clear</strong><p>Add a Hugging Face Space, configure its prompt and image/reference inputs, then stage one or more runs before starting the batch.</p><button class="button button-primary" id="queue-empty-add">＋ Create first job</button></div>`}</div>
    <div class="section-head"><div><h2>Latest results</h2><p>Open a completed job to view its output gallery.</p></div><button class="button button-quiet button-sm" data-goto="jobs">View all jobs ↗</button></div>
    ${renderRecentResults()}`;
  document.querySelector("#queue-run")?.addEventListener("click", () => runQueue());
  document.querySelector("#queue-pause")?.addEventListener("click", () => { queueHalted = true; ping("Queue paused. The active Space batch will be allowed to finish."); render(); });
  document.querySelector("#queue-cancel")?.addEventListener("click", () => { queueHalted = true; currentAbort?.abort(); ping("Cancelling the active batch. Requests already accepted by the Space may still finish remotely."); render(); });
  ["queue-add", "queue-empty-add"].forEach((id) => document.querySelector(`#${id}`)?.addEventListener("click", () => openNewJob()));
  document.querySelector("#quota-account")?.addEventListener("change", (event) => { quotaAccountId = event.target.value; quotaState = { data: null, error: "", loading: false, accountId: "", checkedAt: 0 }; render(); });
  document.querySelector("#quota-refresh")?.addEventListener("click", () => refreshZeroGpuQuota(quotaAccountId || state.settings.lastAccountId || connectedAccounts()[0]?.id || ""));
  bindJobActions();
  document.querySelectorAll("[data-goto]").forEach((button) => button.addEventListener("click", () => { currentTab = button.dataset.goto; render(); }));
}
function jobRow(job) {
  const model = getModel(job.modelId);
  const title = job.name || job.values?.prompt || job.apiName || "Generation job";
  const stateText = job.phase ? `<div class="subtext">${escapeHtml(job.phase)}</div>` : job.error ? `<div class="subtext">${escapeHtml(job.error)}</div>` : "";
  const action = job.status === "paused" && job.remoteEventId
    ? `<button class="button button-sm" data-job-resume="${escapeHtml(job.id)}">Resume remote</button>`
    : ["failed", "paused"].includes(job.status) ? `<button class="button button-sm" data-job-retry="${escapeHtml(job.id)}">Retry new run</button>` : "";
  return `<tr><td><div><strong>${escapeHtml(String(title).slice(0, 80))}</strong><div class="subtext">${escapeHtml(job.apiName || "API")}</div></div></td><td>${escapeHtml(model?.title || job.modelId)}<div class="subtext">${escapeHtml(model?.ref || model?.host || "Space")}</div></td><td>${statusBadge(job.status)}${stateText}</td><td>${escapeHtml(fmtDate(job.updatedAt || job.createdAt))}</td><td><div class="inline-actions"><button class="button button-sm" data-job-open="${escapeHtml(job.id)}">Details</button>${action}</div></td></tr>`;
}
function renderRecentResults() {
  const completed = state.jobs.filter((job) => job.status === "done" && Array.isArray(job.result) && job.result.length).slice(-3).reverse();
  if (!completed.length) return `<div class="panel"><div class="empty"><div class="empty-mark">◫</div><strong>No results yet</strong><p>Once a queued job completes, its output media will appear here.</p></div></div>`;
  return `<div class="card-grid">${completed.map((job) => `<div class="profile-card"><div class="card-title">${escapeHtml(job.name || job.apiName || "Result")}</div><div class="card-meta">${escapeHtml(getModel(job.modelId)?.title || job.modelId)} · ${escapeHtml(fmtDate(job.updatedAt))}</div><div class="card-actions"><button class="button button-sm" data-job-open="${escapeHtml(job.id)}">Open result gallery (${job.result.length})</button></div></div>`).join("")}</div>`;
}
function renderJobs() {
  const rows = state.jobs.slice().reverse();
  view.innerHTML = `<div class="section-head"><div><h2>All jobs</h2><p>${rows.length} saved job record${rows.length === 1 ? "" : "s"}. Output links are kept with each completed job.</p></div><div class="inline-actions"><button class="button" id="jobs-clear">Clear completed</button><button class="button button-primary" id="jobs-add">＋ New job</button></div></div>
  <div class="panel">${rows.length ? `<div class="table-wrap"><table class="table"><thead><tr><th>Job</th><th>Space / API</th><th>Status</th><th>Created</th><th>Controls</th></tr></thead><tbody>${rows.map(jobRow).join("")}</tbody></table></div>` : `<div class="empty"><div class="empty-mark">◷</div><strong>No saved jobs</strong><p>Jobs you enqueue will be recorded here so you can retry or inspect them later.</p><button class="button button-primary" id="jobs-empty-add">＋ Create a job</button></div>`}</div>`;
  document.querySelector("#jobs-add")?.addEventListener("click", () => openNewJob());
  document.querySelector("#jobs-empty-add")?.addEventListener("click", () => openNewJob());
  document.querySelector("#jobs-clear")?.addEventListener("click", async () => { const removed = state.jobs.filter((job) => job.status === "done"); for (const job of removed) await deleteJobAttachments(job.id); state.jobs = state.jobs.filter((job) => job.status !== "done"); saveState(); render(); ping("Completed jobs and their saved attachments cleared."); });
  bindJobActions();
}
function ensureGradioComponent(version) {
  if (customElements.get("gradio-app")) {
    return loadedGradioVersion === version
      ? Promise.resolve()
      : Promise.reject(new Error("A different Gradio UI version is already active in this browser session. Use the iframe or reload before switching versions."));
  }
  if (gradioScriptLoads.has(version)) return gradioScriptLoads.get(version);
  const pending = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    const timeout = setTimeout(() => reject(new Error("The Gradio web component timed out while loading.")), 15000);
    script.type = "module";
    script.src = "https://gradio.s3-us-west-2.amazonaws.com/" + encodeURIComponent(version) + "/gradio.js";
    script.onload = () => customElements.whenDefined("gradio-app").then(() => {
      clearTimeout(timeout);
      loadedGradioVersion = version;
      resolve();
    }, reject);
    script.onerror = () => { clearTimeout(timeout); reject(new Error("The matching Gradio web component could not be loaded.")); };
    document.head.append(script);
  });
  gradioScriptLoads.set(version, pending);
  return pending;
}
function mountSpaceIframe(mount, model) {
  const frame = document.createElement("iframe");
  frame.className = "space-ui-frame";
  frame.src = normalizeHost(model.host) + "/";
  frame.title = "Hosted Hugging Face interface for " + (model.title || model.ref || model.host);
  frame.loading = "eager";
  frame.referrerPolicy = "no-referrer";
  frame.allow = "fullscreen; clipboard-write";
  frame.allowFullscreen = true;
  mount.replaceChildren(frame);
}
async function mountNativeGradio(mount, model, version) {
  mount.innerHTML = '<div class="space-ui-loading" role="status">Loading the Space\'s native Gradio interface…</div>';
  try {
    await ensureGradioComponent(version);
    if (!mount.isConnected || currentSpaceUi !== model.id || currentSpaceMode !== "native") return;
    const app = document.createElement("gradio-app");
    app.setAttribute("src", normalizeHost(model.host) + "/");
    app.setAttribute("initial-height", "720px");
    app.style.display = "block";
    app.style.width = "100%";
    app.style.minHeight = "680px";
    mount.replaceChildren(app);
  } catch (error) {
    if (!mount.isConnected || currentSpaceUi !== model.id) return;
    gradioScriptLoads.delete(version);
    currentSpaceMode = "iframe";
    renderSpaceUi(model);
    const note = document.createElement("p");
    note.className = "help space-ui-fallback-note";
    note.textContent = "Native Gradio embedding failed (" + error.message + "). Showing the hosted page in an iframe instead.";
    document.querySelector("#space-ui-mount")?.after(note);
  }
}
function renderSpaceUi(model) {
  const host = normalizeHost(model?.host);
  if (!host) {
    view.innerHTML = '<div class="panel"><div class="empty"><div class="empty-mark">!</div><strong>This Space has no valid live UI address</strong><p>Refresh the Space schema, then try again.</p><button class="button button-primary" id="space-ui-back">Back to workspace</button></div></div>';
    document.querySelector("#space-ui-back")?.addEventListener("click", () => { currentSpaceUi = null; currentTab = "models"; render(); });
    return;
  }
  const version = model.framework === "gradio" ? normalizeGradioVersion(model.gradioVersion) : "";
  if (!version) currentSpaceMode = "iframe";
  const standaloneUrl = model.ref
    ? "https://huggingface.co/spaces/" + model.ref.split("/").map(encodeURIComponent).join("/")
    : host;
  const privateNote = model.private
    ? '<div class="notice error space-ui-notice">This Space is marked private. Native embedding may require a Hugging Face sign-in. Multi-HF does not inject its session token into the hosted UI; use authenticated API jobs where supported.</div>'
    : "";
  const modeButton = version
    ? '<button class="button button-sm" id="space-ui-toggle">' + (currentSpaceMode === "native" ? "Use iframe fallback" : "Use native Gradio UI") + '</button>'
    : '<span class="badge warning">' + escapeHtml((model.framework || "unknown").toUpperCase()) + ' · hosted UI mode</span>';
  view.innerHTML = `
    <div class="section-head space-ui-header">
      <div><h2>Model interface</h2><p>Framework: ${escapeHtml((model.framework || "unknown").toUpperCase())}. Multi-HF loads the Space's own hosted UI; Gradio uses its matching web component when available.</p></div>
      <div class="inline-actions">
        <button class="button button-sm" id="space-ui-back">← Workspace</button>
        ${modeButton}
        <a class="button button-sm" href="${escapeHtml(standaloneUrl)}" target="_blank" rel="noopener noreferrer">Open standalone ↗</a>
        <button class="button button-primary button-sm" id="space-ui-job" ${model.endpoints.length ? "" : "disabled title=\"This Space has no exposed API endpoint\""}>Create queued job</button>
      </div>
    </div>
    ${privateNote}
    <div class="panel space-ui-panel">
      <div class="panel-head">
        <div><h2>${escapeHtml(model.title || model.ref || host)}</h2><div class="subtext">${escapeHtml(host)} · ${version ? "Gradio " + escapeHtml(version) : escapeHtml((model.framework || "unknown").toUpperCase() + " hosted UI")}</div></div>
        <span class="badge running">${currentSpaceMode === "native" ? "NATIVE GRADIO UI" : "HOSTED SPACE UI"}</span>
      </div>
      <div id="space-ui-mount" class="space-ui-mount"></div>
    </div>
    <p class="help space-ui-help">The hosted interface preserves the author's own layout and controls. Use the API job form when you want to save parameters as profiles or add runs to the batch queue. Private-space browser authentication and Spaces that block embedding remain subject to Hugging Face permissions.</p>`;
  const mount = document.querySelector("#space-ui-mount");
  if (currentSpaceMode === "native" && version) mountNativeGradio(mount, model, version);
  else mountSpaceIframe(mount, model);
  document.querySelector("#space-ui-back")?.addEventListener("click", () => { currentSpaceUi = null; currentTab = "models"; render(); });
  document.querySelector("#space-ui-toggle")?.addEventListener("click", () => { currentSpaceMode = currentSpaceMode === "native" ? "iframe" : "native"; renderSpaceUi(model); });
  document.querySelector("#space-ui-job")?.addEventListener("click", () => { if (!model.endpoints.length) return; currentSpaceUi = null; currentTab = "models"; render(); openNewJob(model.id); });
}
function renderModels() {
  view.innerHTML = `<div class="section-head"><div><h2>Connected Spaces</h2><p>Discover Gradio endpoints from each Space's live configuration.</p></div><button class="button button-primary" id="models-add">＋ Add Space</button></div>
  ${state.models.length ? `<div class="card-grid">${state.models.map((model) => `<article class="model-card"><div class="inline-actions"><span class="badge ${model.task === "video" ? "running" : ""}">${escapeHtml(model.task.toUpperCase())}</span><span class="badge">${escapeHtml((model.framework || "unknown").toUpperCase())}</span><span class="badge">${model.endpoints.length} API endpoints</span></div><div class="card-title" style="margin-top:12px">${escapeHtml(model.title)}</div><div class="card-meta">${escapeHtml(model.ref || model.host)}<br>Updated ${escapeHtml(timeAgo(model.fetchedAt))}</div><div class="card-actions"><button class="button button-primary button-sm" data-model-new="${escapeHtml(model.id)}" ${model.endpoints.length ? "" : "disabled title=\"No API endpoint detected\""}>Create job</button><button class="button button-sm" data-model-ui="${escapeHtml(model.id)}">Open interface ↗</button><button class="button button-sm" data-model-refresh="${escapeHtml(model.id)}">Refresh schema</button><button class="button button-sm" data-model-token="${escapeHtml(model.id)}">Token: ${model.sendToken || model.private ? "sent" : "not sent"}</button><a class="button button-sm" href="${escapeHtml(model.ref ? `https://huggingface.co/spaces/${model.ref}` : model.host)}" target="_blank" rel="noopener">Open Space ↗</a><button class="button button-danger button-sm" data-model-remove="${escapeHtml(model.id)}">Remove</button></div></article>`).join("")}</div>` : `<div class="panel"><div class="empty"><div class="empty-mark">◇</div><strong>Add your first Space</strong><p>Enter a Hugging Face Space ID such as <span class="kbd">owner/name</span> or its public URL. Multi-HF reads the live Gradio schema and creates a dynamic generation form.</p><button class="button button-primary" id="models-empty-add">＋ Discover Space</button></div></div>`}`;
  document.querySelector("#models-add")?.addEventListener("click", () => openAddSpace());
  document.querySelector("#models-empty-add")?.addEventListener("click", () => openAddSpace());
  document.querySelectorAll("[data-model-new]").forEach((button) => button.addEventListener("click", () => openNewJob(button.dataset.modelNew)));
  document.querySelectorAll("[data-model-ui]").forEach((button) => button.addEventListener("click", () => { currentSpaceUi = button.dataset.modelUi; currentSpaceMode = "native"; render(); }));
  document.querySelectorAll("[data-model-token]").forEach((button) => button.addEventListener("click", () => {
    const model = getModel(button.dataset.modelToken); if (!model) return;
    if (model.private) { ping("This Space is private, so your token is always sent to it."); return; }
    if (!model.sendToken && !confirm("Send your selected account's token to this Space? Its owner can see it. Use a fine-grained read-only token.")) return;
    model.sendToken = !model.sendToken; saveState(); render();
  }));
  document.querySelectorAll("[data-model-refresh]").forEach((button) => button.addEventListener("click", () => discoverSpace(button.dataset.modelRefresh)));
  document.querySelectorAll("[data-model-remove]").forEach((button) => button.addEventListener("click", () => {
    const id = button.dataset.modelRemove;
    if (!confirm("Remove this Space from your saved workspace? Existing job history stays in place.")) return;
    state.models = state.models.filter((model) => model.id !== id); state.profiles = state.profiles.filter((profile) => profile.modelId !== id); saveState(); render();
  }));
}
function renderProfiles() {
  view.innerHTML = `<div class="section-head"><div><h2>Reusable profiles</h2><p>Profiles save a Space, endpoint, and parameter values for quick batch creation.</p></div><button class="button button-primary" id="profiles-new">＋ New profile</button></div>
  ${state.profiles.length ? `<div class="card-grid">${state.profiles.map((profile) => `<article class="profile-card"><div class="card-title">${escapeHtml(profile.name)}</div><div class="card-meta">${escapeHtml(getModel(profile.modelId)?.title || profile.modelId)}<br>${escapeHtml(profile.apiName)} · updated ${escapeHtml(timeAgo(profile.updatedAt))}</div><div class="card-actions"><button class="button button-primary button-sm" data-profile-use="${escapeHtml(profile.id)}">Use profile</button><button class="button button-sm" data-profile-ui="${escapeHtml(profile.id)}">Open model UI ↗</button><button class="button button-sm" data-profile-edit="${escapeHtml(profile.id)}">Edit</button><button class="button button-danger button-sm" data-profile-remove="${escapeHtml(profile.id)}">Delete</button></div></article>`).join("")}</div>` : `<div class="panel"><div class="empty"><div class="empty-mark">▤</div><strong>No profiles saved</strong><p>Open a Space, set the prompt and generation parameters, then save those settings as a reusable profile.</p><button class="button button-primary" id="profiles-empty-new">＋ Create profile</button></div></div>`}`;
  document.querySelector("#profiles-new")?.addEventListener("click", () => openNewProfile());
  document.querySelector("#profiles-empty-new")?.addEventListener("click", () => openNewProfile());
  document.querySelectorAll("[data-profile-use]").forEach((button) => button.addEventListener("click", () => { const profile = getProfile(button.dataset.profileUse); if (profile) openNewJob(profile.modelId, profile); }));
  document.querySelectorAll("[data-profile-ui]").forEach((button) => button.addEventListener("click", () => { const profile = getProfile(button.dataset.profileUi); if (profile && getModel(profile.modelId)) { currentSpaceUi = profile.modelId; currentSpaceMode = "native"; render(); } }));
  document.querySelectorAll("[data-profile-edit]").forEach((button) => button.addEventListener("click", () => { const profile = getProfile(button.dataset.profileEdit); if (profile) openNewProfile(profile); }));
  document.querySelectorAll("[data-profile-remove]").forEach((button) => button.addEventListener("click", () => { state.profiles = state.profiles.filter((p) => p.id !== button.dataset.profileRemove); saveState(); render(); ping("Profile deleted."); }));
}
function renderAccounts() {
  view.innerHTML = `<div class="section-head"><div><h2>Accounts</h2><p>Tokens are kept in memory only. Reconnect after a page refresh.</p></div><button class="button button-primary" id="account-add">＋ Connect account</button></div>
  <div class="account-warning">Access tokens are never written to localStorage or exported. Use a fine-grained Hugging Face token with the minimum permissions required for the Spaces you use. This browser sends the token directly to the Hugging Face host selected for the request.</div>
  ${state.accounts.length ? `<div class="card-grid">${state.accounts.map((account) => `<article class="account-card"><div class="inline-actions"><span class="badge ${account.connected ? "ready" : ""}">${account.connected ? "CONNECTED" : "SESSION EXPIRED"}</span>${account.enabled ? "" : `<span class="badge warning">DISABLED</span>`}</div><div class="card-title" style="margin-top:12px">${escapeHtml(account.label)}</div><div class="card-meta">${escapeHtml(account.username ? `@${account.username}` : "Username not verified")}<br>${account.connected ? "Token available in this tab" : "Reconnect token to use private Spaces"}</div><div class="card-actions"><button class="button button-primary button-sm" data-account-connect="${escapeHtml(account.id)}">${account.connected ? "Replace token" : "Connect token"}</button><button class="button button-sm" data-account-enable="${escapeHtml(account.id)}">${account.enabled ? "Disable" : "Enable"}</button><button class="button button-danger button-sm" data-account-remove="${escapeHtml(account.id)}">Remove</button></div></article>`).join("")}</div>` : `<div class="panel"><div class="empty"><div class="empty-mark">◎</div><strong>No account connected</strong><p>Public Spaces can be discovered without a token. Connect an account to access private Spaces and authenticated API endpoints.</p><button class="button button-primary" id="accounts-empty-add">＋ Connect account</button></div></div>`}
  <div class="panel" style="margin-top:18px"><div class="panel-head"><div><h2>Resource and quota behavior</h2><div class="subtext">Transparent failure handling, no guessed reset timers.</div></div></div><div class="panel-body"><div class="field-grid"><div><div class="card-title">Quota exhausted</div><p class="card-meta">The active job is paused and the queue stops. Retry only when the service reports eligibility or you deliberately select another permitted resource.</p></div><div><div class="card-title">Auth / transient errors</div><p class="card-meta">Errors are shown on the job. Select an account or Space manually before retrying; tokens are not silently switched between accounts.</p></div></div></div></div>`;
  document.querySelector("#account-add")?.addEventListener("click", () => openAccountDialog());
  document.querySelector("#accounts-empty-add")?.addEventListener("click", () => openAccountDialog());
  document.querySelectorAll("[data-account-connect]").forEach((button) => button.addEventListener("click", () => openAccountDialog(getAccount(button.dataset.accountConnect))));
  document.querySelectorAll("[data-account-enable]").forEach((button) => button.addEventListener("click", () => { const account = getAccount(button.dataset.accountEnable); if (account) account.enabled = !account.enabled; saveState(); render(); }));
  document.querySelectorAll("[data-account-remove]").forEach((button) => button.addEventListener("click", () => { const id = button.dataset.accountRemove; accountTokens.delete(id); state.accounts = state.accounts.filter((a) => a.id !== id); saveState(); render(); ping("Account removed."); }));
}
function bindJobActions() {
  document.querySelectorAll("[data-job-open]").forEach((button) => button.addEventListener("click", () => openJobDetails(button.dataset.jobOpen)));
  document.querySelectorAll("[data-job-retry]").forEach((button) => button.addEventListener("click", () => {
    const job = state.jobs.find((item) => item.id === button.dataset.jobRetry);
    if (!job) return;
    job.status = "retry"; job.error = ""; job.attempts = 0; job.remoteEventId = ""; job.phase = ""; job.updatedAt = Date.now(); job.quotaResetAt = null; queueHalted = false; saveState(); render(); ping("Job queued as a fresh generation request.");
  }));
  document.querySelectorAll("[data-job-resume]").forEach((button) => button.addEventListener("click", () => {
    const job = state.jobs.find((item) => item.id === button.dataset.jobResume);
    if (!job?.remoteEventId) return;
    job.status = "retry"; job.error = ""; job.phase = "Reconnecting to the submitted Space task"; job.updatedAt = Date.now(); queueHalted = false; saveState(); render(); runQueue();
  }));
}
function openAccountDialog(existing = null) {
  showDialog(`${dialogHeader(existing ? "Connect account" : "Add Hugging Face account", "The access token stays in memory for this browser tab only.")}
  <form id="account-form"><div class="field-grid"><div class="field"><label for="account-label">Account label</label><input id="account-label" name="label" required maxlength="60" value="${escapeHtml(existing?.label || "")}" placeholder="Personal account"></div><div class="field"><label for="account-username">Hugging Face username (optional)</label><input id="account-username" name="username" maxlength="80" value="${escapeHtml(existing?.username || "")}" placeholder="username"></div><div class="field full"><label for="account-token">Access token</label><input id="account-token" name="token" type="password" required autocomplete="off" placeholder="hf_…"><small>Use a read token for public/private Space discovery and the minimum inference permissions needed for your workload. The token is not persisted.</small></div></div><div class="account-warning">Do not paste this token into prompts, profiles, exports, or issue reports. This app calls Hugging Face endpoints from your browser; browser extensions and shared devices remain a local security risk.</div><div class="form-actions"><button class="button" type="button" data-close>Cancel</button><button class="button button-primary" type="submit">Connect session</button></div></form>`);
  document.querySelector("#account-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const label = String(form.get("label") || "").trim(); const username = String(form.get("username") || "").trim(); const token = String(form.get("token") || "").trim();
    if (!token) { dialogError("Enter a token to connect this session."); return; }
    let account = existing ? getAccount(existing.id) : null;
    const created = !account;
    if (!account) { account = { id: safeId("account"), label, username, enabled: true, createdAt: Date.now(), connected: false }; state.accounts.push(account); }
    account.label = label; account.username = username; account.connected = true; account.enabled = true; accountTokens.set(account.id, token); state.settings.lastAccountId = account.id;
    const submit = event.currentTarget.querySelector("[type=submit]"); submit.disabled = true; submit.textContent = "Checking token…";
    try {
      const response = await fetch("https://huggingface.co/api/whoami-v2", { headers: { Authorization: `Bearer ${token}` } });
      if (response.status === 401 || response.status === 403) throw new Error("Hugging Face rejected this token. Check that it is active and has the required access.");
      if (response.ok) { const data = await response.json(); if (data.name && !username) account.username = data.name; }
      else if (response.status !== 404) throw new Error(`Token validation returned HTTP ${response.status}.`);
      saveState(); dialog.close(); render(); ping(`Connected ${account.label} for this session.`);
    } catch (error) {
      if (/Failed to fetch|NetworkError/i.test(String(error))) {
        // A CORS/network failure does not prove a token is invalid. Keep the token session-only but warn.
        saveState(); dialog.close(); render(); showNotice("Token could not be verified from this browser (network/CORS). It remains session-only; try a public Space or inspect browser/network permissions.", "error");
      } else {
        accountTokens.delete(account.id); account.connected = false;
        if (created) state.accounts = state.accounts.filter((a) => a.id !== account.id);
        saveState(); submit.disabled = false; submit.textContent = "Connect session"; dialogError(error.message || "Token check failed.");
      }
    }
  });
}
function openAddSpace() {
  const accounts = [{ id: "", label: "Public / no token" }, ...connectedAccounts().map((a) => ({ id: a.id, label: a.label }))];
  showDialog(`${dialogHeader("Discover a Hugging Face Space", "Multi-HF reads the live Gradio /config schema and builds an endpoint form.")}
  <form id="space-form"><div class="field-grid"><div class="field full"><label for="space-ref">Space URL or owner/name</label><input id="space-ref" name="ref" required placeholder="owner/space-name or https://huggingface.co/spaces/owner/name"><small>Public Spaces work without a token. ${connectedAccounts().length ? "" : "For a private Space, first connect your token under Accounts. "}CORS or private-space permissions can still block browser access.</small></div><div class="field"><label for="space-account">Use account</label><select id="space-account" name="accountId">${accounts.map((a) => `<option value="${escapeHtml(a.id)}">${escapeHtml(a.label)}</option>`).join("")}</select></div><div class="field"><label for="space-note">Optional label</label><input id="space-note" name="note" maxlength="90" placeholder="My animation Space"></div><div class="field full"><label class="inline-actions"><input type="checkbox" name="sendToken"> <span>Send my token to this Space (some GPU/ZeroGPU Spaces need it to use your quota)</span></label><small>Off by default. The Space's owner can see any token you send, so use a fine-grained read-only token.</small></div></div><div class="form-actions"><button class="button" type="button" data-close>Cancel</button><button class="button button-primary" type="submit">Discover Space</button></div></form>`);
  document.querySelector("#space-form").addEventListener("submit", async (event) => {
    event.preventDefault(); const form = new FormData(event.currentTarget); const ref = String(form.get("ref") || "").trim(); const accountId = String(form.get("accountId") || ""); const note = String(form.get("note") || "").trim(); const sendToken = form.get("sendToken") === "on" && Boolean(accountId);
    const submit = event.currentTarget.querySelector("[type=submit]"); submit.disabled = true; submit.textContent = "Discovering…";
    try { await discoverSpace(null, { ref, accountId, note, sendToken }); dialog.close(); }
    catch (error) { submit.disabled = false; submit.textContent = "Discover Space"; dialogError(error.message || "Space discovery failed."); }
  });
}
// Tokens only go to huggingface.co, or to a *.hf.space host the Hub reported as private.
function authHeaders(accountId, url, privateSpace = false) {
  const token = accountId ? accountTokens.get(accountId) : null;
  return tokenHeaders(token, url, { privateSpace });
}
function withTimeout(ms, parent) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  const onAbort = () => controller.abort();
  if (parent) { if (parent.aborted) controller.abort(); else parent.addEventListener("abort", onAbort, { once: true }); }
  return { signal: controller.signal, done() { clearTimeout(timer); parent?.removeEventListener("abort", onAbort); } };
}
const isAbortError = (error) => error?.name === "AbortError" || error?.name === "TimeoutError";
async function fetchJson(url, options = {}, failureMessage = "Request failed") {
  const timer = withTimeout(META_TIMEOUT_MS);
  let response;
  try { response = await fetch(url, { ...options, signal: timer.signal }); }
  catch (error) { timer.done(); throw isAbortError(error) ? new Error(`${failureMessage}: the request timed out.`) : error; }
  timer.done();
  if (!response.ok) {
    let message = ""; try { const body = await response.json(); message = body?.error || body?.detail || body?.message || ""; } catch { try { message = (await response.text()).slice(0, 500); } catch {} }
    const error = new Error(message || `${failureMessage} (HTTP ${response.status})`); error.status = response.status; throw error;
  }
  return response.json();
}
async function refreshZeroGpuQuota(accountId = "", quiet = false) {
  if (!accountId || !accountTokens.has(accountId) || !getAccount(accountId)?.enabled) {
    quotaState = { data: null, error: "Connect an enabled Hugging Face account to read its ZeroGPU allowance.", loading: false, accountId, checkedAt: 0 };
    if (!quiet) render();
    return null;
  }
  quotaState = { ...quotaState, loading: true, accountId, error: "" };
  if (!quiet) render();
  try {
    const url = "https://huggingface.co/api/spaces/zero-gpu/quota";
    const raw = await fetchJson(url, { headers: authHeaders(accountId, url) }, "ZeroGPU quota request failed");
    const data = normalizeZeroGpuQuota(raw);
    quotaState = { data, error: "", loading: false, accountId, checkedAt: Date.now() };
    return data;
  } catch (error) {
    const message = error.message || String(error);
    const permission = /401|403|permission|billing|unauthorized/i.test(message);
    quotaState = {
      data: null,
      error: permission
        ? "This token cannot read billing usage. Enable “Billing → Read billing usage and payment method status” in its fine-grained permissions, then refresh."
        : "Could not read ZeroGPU quota: " + message,
      loading: false,
      accountId,
      checkedAt: Date.now(),
    };
    return null;
  } finally {
    if (!quiet && currentTab === "queue") render();
  }
}
async function discoverSpace(modelId = null, options = {}) {
  clearNotice();
  const prior = modelId ? getModel(modelId) : null;
  const ref = options.ref || prior?.ref || prior?.host || modelId;
  const accountId = options.accountId || prior?.accountId || state.settings.lastAccountId || "";
  let parsedInput = parseSpaceInput(ref);
  let host = parsedInput.host;
  let resolvedId = parsedInput.id;
  let apiData = null;
  if (resolvedId) {
    const hubUrl = `https://huggingface.co/api/spaces/${resolvedId.split("/").map(encodeURIComponent).join("/")}`;
    apiData = await fetchJson(hubUrl, { headers: authHeaders(accountId, hubUrl) }, "Space metadata request failed");
    host = normalizeHost(apiData.host, apiData.subdomain || apiData.cardData?.subdomain);
    if (!host && apiData.runtime?.stage && typeof apiData.subdomain === "string") host = normalizeHost(null, apiData.subdomain);
    if (!host) throw new Error("Hugging Face did not return a Space host. Check that the Space exists and is accessible.");
  }
  if (!host) throw new Error("Could not resolve the Space's public host.");
  let config; let configError;
  for (const suffix of ["/config", "/gradio_api/config"]) {
    try { config = await fetchJson(`${host}${suffix}`, { headers: authHeaders(accountId, `${host}${suffix}`, apiData?.private === true || options.sendToken === true || prior?.sendToken === true) }, "Could not read the Gradio config"); break; }
    catch (error) { configError = error; if (error.status !== 404 && error.status !== 405) break; }
  }
  let schema;
  let framework;
  const uiOnlySchema = () => ({
    title: apiData?.cardData?.title || resolvedId || host,
    apiPrefix: "/gradio_api",
    gradioVersion: normalizeGradioVersion(apiData?.sdk_version, apiData?.cardData?.sdk_version),
    endpoints: [],
  });
  if (config) {
    try {
      schema = parseSpaceConfig(config);
      framework = "gradio";
    } catch (error) {
      framework = normalizeSpaceFramework(apiData?.sdk || apiData?.cardData?.sdk);
      if (!apiData || framework === "unknown") throw error;
      schema = uiOnlySchema();
    }
  } else {
    framework = normalizeSpaceFramework(apiData?.sdk || apiData?.cardData?.sdk);
    // A direct *.hf.space URL may not reveal its Hub SDK metadata. Keep it
    // usable as a hosted UI rather than rejecting a valid Space address.
    if (!apiData && framework === "unknown") framework = "custom";
    if (framework === "unknown") {
      throw new Error(`${configError?.message || "Could not read this Space's Gradio config."} If this Space is private, connect a token; if browser access is blocked, use a browser with compatible CORS permissions.`);
    }
    schema = uiOnlySchema();
  }
  const id = resolvedId || prior?.id || host;
  const name = options.note || prior?.note || "";
  const model = {
    id, kind: "space", ref: resolvedId || prior?.ref || "", host,
    title: name || schema.title || apiData?.cardData?.title || resolvedId || host,
    task: taskFromEndpoints(schema.endpoints), apiPrefix: schema.apiPrefix,
    gradioVersion: normalizeGradioVersion(schema.gradioVersion, apiData?.sdk_version, apiData?.cardData?.sdk_version),
    framework,
    endpoints: schema.endpoints, activeApi: schema.endpoints[0]?.apiName || "", accountId, private: apiData?.private === true, sendToken: options.sendToken ?? prior?.sendToken === true,
    hardware: apiData?.runtime?.hardware?.current || apiData?.runtime?.hardware || "Unknown", fetchedAt: Date.now(), note: name,
  };
  const existingIndex = state.models.findIndex((item) => item.id === id || item.host === host);
  if (existingIndex >= 0) state.models.splice(existingIndex, 1, model); else state.models.push(model);
  saveState(); render(); ping(`Discovered ${model.title}: ${model.endpoints.length} API endpoints.`);
  return model;
}
function endpointFor(model, apiName, fallback = true) {
  const exact = model?.endpoints?.find((endpoint) => endpoint.apiName === apiName);
  return exact || (fallback ? model?.endpoints?.[0] : undefined);
}
function inputElement(field, value, profileMode = false) {
  if (field.hidden) return "";
  const id = `f-${field.key}`;
  const label = escapeHtml(field.label || field.key);
  const hint = field.hint ? `<small>${escapeHtml(field.hint)}</small>` : "";
  let input = "";
  if (field.type === "textarea") input = `<textarea id="${id}" data-key="${escapeHtml(field.key)}" placeholder="${escapeHtml(field.placeholder || "")}" rows="3">${escapeHtml(value ?? field.defaultValue ?? "")}</textarea>`;
  else if (field.type === "json") input = '<textarea id="' + id + '" data-key="' + escapeHtml(field.key) + '" rows="6" spellcheck="false">' + escapeHtml(value ?? field.defaultValue ?? "{}") + '</textarea>';
  else if (field.type === "color") input = '<input id="' + id + '" data-key="' + escapeHtml(field.key) + '" type="color" value="' + escapeHtml(value ?? field.defaultValue ?? "#000000") + '">';
  else if (["date", "time", "datetime-local"].includes(field.type)) input = '<input id="' + id + '" data-key="' + escapeHtml(field.key) + '" type="' + field.type + '" value="' + escapeHtml(value ?? field.defaultValue ?? "") + '">';
  else if (field.type === "checkbox") input = `<label class="inline-actions"><input id="${id}" data-key="${escapeHtml(field.key)}" type="checkbox" ${value === true || (value == null && field.defaultValue === true) ? "checked" : ""}> <span>${label}</span></label>`;
  else if (field.type === "select" || field.type === "radio" || field.type === "checkboxgroup") {
    const choices = field.choices || [];
    if (field.type === "checkboxgroup") input = choices.length ? `<div class="choice-list">${choices.map((choice) => `<label class="inline-actions"><input type="checkbox" data-key="${escapeHtml(field.key)}" data-choice="${escapeHtml(choice.value)}" ${(Array.isArray(value) ? value : []).includes(choice.value) ? "checked" : ""}><span>${escapeHtml(choice.label)}</span></label>`).join("")}</div>` : `<input id="${id}" data-key="${escapeHtml(field.key)}" placeholder="Comma-separated values" value="${escapeHtml(Array.isArray(value) ? value.join(", ") : "")}">`;
    else input = `<select id="${id}" data-key="${escapeHtml(field.key)}">${choices.map((choice) => `<option value="${escapeHtml(choice.value)}" ${(String(value ?? field.defaultValue ?? "") === choice.value) ? "selected" : ""}>${escapeHtml(choice.label)}</option>`).join("")}${!choices.length ? `<option value="${escapeHtml(value ?? "")}">${escapeHtml(value ?? "Select a value")}</option>` : ""}</select>`;
  }
  else if (field.type === "slider") input = `<div><input id="${id}" data-key="${escapeHtml(field.key)}" type="range" min="${field.min ?? 0}" max="${field.max ?? 100}" step="${field.step ?? 1}" value="${escapeHtml(value ?? field.defaultValue ?? field.min ?? 0)}"><small id="${id}-value">${escapeHtml(value ?? field.defaultValue ?? field.min ?? 0)}</small></div>`;
  else if (field.type === "number") input = `<input id="${id}" data-key="${escapeHtml(field.key)}" type="number" ${field.min != null ? `min="${field.min}"` : ""} ${field.max != null ? `max="${field.max}"` : ""} ${field.step != null ? `step="${field.step}"` : ""} value="${escapeHtml(value ?? field.defaultValue ?? "")}">`;
  else if (isFileField(field)) {
    const acceptMap = { image: "image/*", video: "video/*", audio: "audio/*", gallery: "image/*", file: "*/*" };
    const accept = (field.fileTypes || []).map((item) => ({ image: "image/*", video: "video/*", audio: "audio/*" }[item] || item)).filter(Boolean);
    const hasMultiple = field.multiple === true || field.type === "gallery";
    const existing = normalizeSelectedFiles(value);
    const fileSummary = existing.length ? `Saved attachment: ${existing.map((file) => escapeHtml(file.name || "upload")).join(", ")}. It will be reused when cloning this job unless you choose a replacement.` : (hasMultiple ? "Select one or more files. Attachments are kept in browser storage for queued jobs." : "Select the source or reference file. The original file is stored with the queued job.");
    input = `<input id="${id}" data-key="${escapeHtml(field.key)}" type="file" accept="${escapeHtml(accept.length ? accept.join(",") : acceptMap[field.type] || "*/*")}" ${hasMultiple ? "multiple" : ""} ${profileMode ? "disabled" : ""}><small>${fileSummary}</small>`;
  }
  else input = `<input id="${id}" data-key="${escapeHtml(field.key)}" type="text" placeholder="${escapeHtml(field.placeholder || "")}" value="${escapeHtml(value ?? field.defaultValue ?? "")}">`;
  const full = ["textarea", "json", "gallery"].includes(field.type);
  return `<div class="field ${full ? "full" : ""}">${field.type === "checkbox" ? input : `<label for="${id}">${label}${field.type === "number" && field.min != null ? ` <span class="muted">(min ${field.min})</span>` : ""}</label>${input}`}${hint}</div>`;
}
function collectValues(container, endpoint, fileMap = null, fallbackValues = {}) {
  const values = {};
  for (const field of endpoint.fields) {
    if (field.hidden) { values[field.key] = field.passthrough ?? field.defaultValue ?? null; continue; }
    if (field.type === "checkboxgroup") {
      const boxes = [...container.querySelectorAll(`input[type=checkbox][data-key="${CSS.escape(field.key)}"]`)].filter((input) => input.checked);
      const fallback = container.querySelector(`input[data-key="${CSS.escape(field.key)}"]:not([data-choice])`);
      values[field.key] = boxes.length ? boxes.map((input) => input.dataset.choice) : fallback?.value.split(",").map((v) => v.trim()).filter(Boolean) || [];
      continue;
    }
    const input = container.querySelector(`[data-key="${CSS.escape(field.key)}"]`);
    if (!input) { if (Object.hasOwn(fallbackValues, field.key)) values[field.key] = fallbackValues[field.key]; continue; }
    if (isFileField(field)) {
      const selected = [...(input.files || [])];
      if (selected.length) {
        const multiple = field.multiple === true || field.type === "gallery";
        if (fileMap) fileMap.set(field.key, multiple ? selected : selected[0]);
        values[field.key] = multiple ? selected.map(fileMeta) : fileMeta(selected[0]);
      } else values[field.key] = Object.hasOwn(fallbackValues, field.key) ? fallbackValues[field.key] : null;
    } else if (field.type === "checkbox") values[field.key] = input.checked;
    else if (["number", "slider"].includes(field.type)) values[field.key] = input.value === "" ? null : Number(input.value);
    else if (field.type === "json") { try { values[field.key] = JSON.parse(input.value); } catch { throw new Error((field.label || field.key) + " must contain valid JSON."); } }
    else values[field.key] = input.value;
  }
  return values;
}
function openNewJob(modelId = null, profile = null) {
  if (!state.models.length) { currentTab = "models"; render(); openAddSpace(); return; }
  const model = getModel(modelId) || getModel(profile?.modelId) || state.models[0];
  const endpoint = endpointFor(model, profile?.apiName || model.activeApi);
  if (!endpoint) { ping("This Space has no discovered Gradio API. Its hosted interface is available, but queued jobs are not."); return; }
  const files = new Map();
  const profiles = state.profiles.filter((p) => p.modelId === model.id);
  const accounts = [{ id: "", label: "Public / no token" }, ...connectedAccounts().filter((a) => a.enabled).map((a) => ({ id: a.id, label: a.label }))];
  showDialog(`${dialogHeader("Build generation job", "Set the prompt, source image, reference images, and model-specific parameters. Stage several runs before starting the GPU queue.")}
    <form id="job-form"><div class="field-grid"><div class="field"><label for="job-name">Job name</label><input id="job-name" name="name" maxlength="100" value="${escapeHtml(profile?.name || "")}" placeholder="e.g. cinematic city loop"></div><div class="field"><label for="job-runs">Repeat jobs</label><input id="job-runs" name="runs" type="number" min="1" max="10" step="1" value="1"><small>Stage up to 10 identical runs in one batch. Set the model seed to random when supported for different outputs.</small></div><div class="field"><label for="job-model">Space</label><select id="job-model" name="modelId">${state.models.map((m) => `<option value="${escapeHtml(m.id)}" ${m.id === model.id ? "selected" : ""}>${escapeHtml(m.title)}</option>`).join("")}</select></div><div class="field"><label for="job-api">API endpoint</label><select id="job-api" name="apiName">${model.endpoints.map((ep) => `<option value="${escapeHtml(ep.apiName)}" ${ep.apiName === endpoint.apiName ? "selected" : ""}>/${escapeHtml(ep.apiName)}</option>`).join("")}</select></div><div class="field"><label for="job-account">Account for this job</label><select id="job-account" name="accountId">${accounts.map((a) => `<option value="${escapeHtml(a.id)}" ${String(profile?.accountId || model.accountId || state.settings.lastAccountId || "") === a.id ? "selected" : ""}>${escapeHtml(a.label)}</option>`).join("")}</select><small>Account selection is explicit; tokens are not silently rotated.</small></div></div><div class="section-head"><div><h2>Model inputs</h2><p>Controls are generated from this Space’s live Gradio API schema. Source and reference uploads are saved with the queued job.</p></div></div><div class="field-grid" id="job-fields"></div><div class="field full" style="margin-top:16px"><label class="inline-actions"><input id="job-save-profile" type="checkbox" ${profile ? "checked" : ""}><span>Save these settings as a reusable profile</span></label></div><div class="field ${profile ? "" : "hidden"}" id="job-profile-name-wrap"><label for="job-profile-name">Profile name</label><input id="job-profile-name" value="${escapeHtml(profile?.name || "")}" placeholder="Reusable profile name"></div><div class="form-actions"><button class="button" type="button" data-close>Cancel</button><button class="button button-primary" type="submit">＋ Add to queue</button></div></form>`);
  const form = document.querySelector("#job-form");
  const modelSelect = document.querySelector("#job-model"); const apiSelect = document.querySelector("#job-api");
  function refillEndpoints(selectedApi = "") {
    const chosen = getModel(modelSelect.value);
    apiSelect.innerHTML = (chosen?.endpoints || []).map((ep) => `<option value="${escapeHtml(ep.apiName)}" ${ep.apiName === selectedApi ? "selected" : ""}>/${escapeHtml(ep.apiName)}</option>`).join("");
    refillFields();
  }
  function refillFields() {
    const chosen = getModel(modelSelect.value); const ep = endpointFor(chosen, apiSelect.value);
    const stored = profile && profile.modelId === chosen?.id && profile.apiName === ep?.apiName ? profile.values : {};
    document.querySelector("#job-fields").innerHTML = (ep?.fields || []).filter((f) => !f.hidden).map((field) => inputElement(field, stored?.[field.key])).join("") || `<p class="help">No visible parameters were detected. This endpoint may require inputs unsupported by this form.</p>`;
    files.clear();
    document.querySelectorAll("input[type=range]").forEach((input) => input.addEventListener("input", () => { const output = document.querySelector(`#${CSS.escape(input.id)}-value`); if (output) output.textContent = input.value; }));
  }
  modelSelect.addEventListener("change", () => { refillEndpoints(); const options = [{ id: "", label: "Public / no token" }, ...connectedAccounts().filter((a) => a.enabled).map((a) => ({ id: a.id, label: a.label }))]; document.querySelector("#job-account").innerHTML = options.map((a) => `<option value="${escapeHtml(a.id)}">${escapeHtml(a.label)}</option>`).join(""); });
  apiSelect.addEventListener("change", refillFields);
  refillFields();
  document.querySelector("#job-save-profile").addEventListener("change", (event) => { document.querySelector("#job-profile-name-wrap").classList.toggle("hidden", !event.target.checked); });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const submit = form.querySelector('[type="submit"]');
    submit.disabled = true;
    submit.textContent = "Saving attachments and staging jobs…";
    const savedAttachmentJobs = [];
    try {
      const chosen = getModel(modelSelect.value);
      const ep = endpointFor(chosen, apiSelect.value);
      if (!chosen || !ep) throw new Error("Select a valid Space endpoint.");
      const fallbackValues = profile && profile.modelId === chosen.id && profile.apiName === ep.apiName ? (profile.values || {}) : {};
      const values = collectValues(form, ep, files, fallbackValues);
      if (profile?.sourceJobId && chosen.id === profile.modelId && ep.apiName === profile.apiName) {
        const originalFiles = await loadJobAttachments(profile.sourceJobId);
        for (const field of ep.fields.filter(isFileField)) {
          if (!files.has(field.key) && originalFiles.has(field.key)) files.set(field.key, originalFiles.get(field.key));
          if (!files.has(field.key) && values[field.key] && (values[field.key].name || (Array.isArray(values[field.key]) && values[field.key].length))) {
            throw new Error('The original attachment for "' + (field.label || field.key) + '" is unavailable. Select it again before cloning this job.');
          }
        }
      }
      const formData = new FormData(form);
      const runCount = Math.max(1, Math.min(10, Number(formData.get("runs")) || 1));
      const baseName = String(formData.get("name") || values.prompt || ep.apiName).trim();
      const accountId = String(formData.get("accountId") || "");
      const batchId = safeId("batch");
      const jobsToAdd = [];
      for (let index = 0; index < runCount; index += 1) {
        const jobId = safeId("job");
        const jobFileMap = new Map([...files.entries()].map(([key, value]) => [key, Array.isArray(value) ? value.slice() : value]));
        await persistJobAttachments(jobId, jobFileMap);
        savedAttachmentJobs.push(jobId);
        jobFiles.set(jobId, jobFileMap);
        jobsToAdd.push({
          id: jobId,
          batchId,
          name: runCount > 1 ? baseName + " #" + (index + 1) : baseName,
          modelId: chosen.id,
          apiName: ep.apiName,
          accountId,
          values: JSON.parse(JSON.stringify(values)),
          files: [...jobFileMap.keys()],
          status: "ready",
          error: "",
          result: [],
          createdAt: Date.now() + index,
          updatedAt: Date.now(),
        });
      }
      state.jobs.push(...jobsToAdd);
      if (document.querySelector("#job-save-profile").checked) {
        const profileName = String(document.querySelector("#job-profile-name").value || baseName).trim();
        if (profileName) {
          const profileValues = JSON.parse(JSON.stringify(values));
          for (const field of ep.fields.filter(isFileField)) delete profileValues[field.key];
          const existing = state.profiles.find((item) => item.name === profileName && item.modelId === chosen.id);
          const profileRecord = {
            id: existing?.id || safeId("profile"),
            name: profileName,
            modelId: chosen.id,
            apiName: ep.apiName,
            values: profileValues,
            accountId,
            createdAt: existing?.createdAt || Date.now(),
            updatedAt: Date.now(),
          };
          if (existing) Object.assign(existing, profileRecord);
          else state.profiles.push(profileRecord);
        }
      }
      saveState();
      dialog.close();
      currentTab = "queue";
      render();
      ping(runCount === 1 ? "Job added to queue with saved attachments." : runCount + " jobs staged with their attachments.");
    } catch (error) {
      for (const id of savedAttachmentJobs) await deleteJobAttachments(id);
      submit.disabled = false;
      submit.textContent = "＋ Add to queue";
      dialogError(error.message || "Could not stage this generation job.");
    }
  });
}
function openNewProfile(existing = null) {
  if (existing) { openNewJob(existing.modelId, existing); return; }
  if (!state.models.length) { currentTab = "models"; render(); openAddSpace(); return; }
  openNewJob(state.models[0].id);
  ping("In the job form, enable ‘Save these settings as a reusable profile’ before adding it.");
}
function openJobDetails(jobId) {
  const job = state.jobs.find((item) => item.id === jobId); if (!job) return;
  const model = getModel(job.modelId);
  const result = Array.isArray(job.result) ? job.result : [];
  showDialog(`${dialogHeader(job.name || "Generation job", `${model?.title || job.modelId} · /${job.apiName}`)}
    <div class="field-grid"><div><div class="label">Status</div><p>${statusBadge(job.status)}</p></div><div><div class="label">Last updated</div><p class="card-meta">${escapeHtml(fmtDate(job.updatedAt))}</p></div><div class="field full"><label>Error / event details</label><div class="panel-body" style="border:1px solid var(--line);border-radius:8px;white-space:pre-wrap;word-break:break-word">${escapeHtml(job.error || "No error recorded.")}</div></div></div>
    <div class="section-head"><div><h2>Output gallery</h2><p>${result.length} normalized output item${result.length === 1 ? "" : "s"}</p></div></div>${renderResults(result)}
    <div class="form-actions"><button class="button" type="button" data-close>Close</button>${job.status === "paused" && job.remoteEventId ? `<button class="button button-primary" id="detail-resume">Resume remote event</button>` : ""}${["failed", "paused"].includes(job.status) ? `<button class="button" id="detail-retry">Retry as new request</button>` : ""}<button class="button" id="detail-clone">Clone job</button></div>`);
  document.querySelector("#detail-resume")?.addEventListener("click", () => { if (!job.remoteEventId) return; job.status = "retry"; job.error = ""; job.phase = "Reconnecting to submitted event"; job.updatedAt = Date.now(); queueHalted = false; saveState(); dialog.close(); currentTab = "queue"; render(); runQueue(); });
  document.querySelector("#detail-retry")?.addEventListener("click", () => { job.status = "retry"; job.error = ""; job.attempts = 0; job.remoteEventId = ""; job.phase = ""; job.quotaResetAt = null; job.updatedAt = Date.now(); queueHalted = false; saveState(); dialog.close(); currentTab = "queue"; render(); ping("Job marked for a fresh generation request."); });
  document.querySelector("#detail-clone")?.addEventListener("click", () => { const profile = { modelId: job.modelId, apiName: job.apiName, values: job.values, accountId: job.accountId, name: job.name, sourceJobId: job.id }; dialog.close(); openNewJob(job.modelId, profile); });
}
function renderResults(result) {
  if (!result.length) return `<div class="panel"><div class="empty"><div class="empty-mark">◫</div><strong>No media output to show</strong><p>Once the endpoint returns outputs, they will be shown here.</p></div></div>`;
  return `<div class="result-grid">${result.map((item) => {
    const label = escapeHtml(item.label || "Output");
    if (item.kind === "image" && item.url) return `<div class="result-item"><a href="${escapeHtml(item.url)}" target="_blank" rel="noopener"><img loading="lazy" src="${escapeHtml(item.url)}" alt="${label}"></a><div class="result-caption">${label} · <a href="${escapeHtml(item.url)}" download target="_blank" rel="noopener">Download</a></div></div>`;
    if (item.kind === "video" && item.url) return `<div class="result-item"><video controls preload="metadata" src="${escapeHtml(item.url)}"></video><div class="result-caption">${label} · <a href="${escapeHtml(item.url)}" download target="_blank" rel="noopener">Download</a></div></div>`;
    if (item.kind === "audio" && item.url) return `<div class="result-item"><audio controls preload="metadata" src="${escapeHtml(item.url)}"></audio><div class="result-caption">${label} · <a href="${escapeHtml(item.url)}" download target="_blank" rel="noopener">Download</a></div></div>`;
    if (item.url) return `<div class="result-item"><div class="result-caption">${label}<br><a href="${escapeHtml(item.url)}" target="_blank" rel="noopener">Open or download file ↗</a></div></div>`;
    return `<div class="result-item"><div class="result-caption"><strong>${label}</strong><pre style="white-space:pre-wrap;overflow-wrap:anywhere;color:#d9e3f1">${escapeHtml(item.text || "")}</pre></div></div>`;
  }).join("")}</div>`;
}
async function uploadFile(file, host, apiPrefix, headers, signal) {
  const blob = file?.blob || file;
  const filename = file?.name || blob?.name || "upload";
  if (!(blob instanceof Blob)) throw new Error("A saved upload is not available as a browser file. Reattach it and retry.");
  const form = new FormData();
  form.append("files", blob, filename);
  let lastError;
  for (const url of [host + apiPrefix + "/upload", host + "/upload"]) {
    try {
      const response = await fetch(url, { method: "POST", headers, body: form, signal });
      if (!response.ok) {
        const message = (await response.text()).slice(0, 500);
        const error = new Error(message || ("Upload failed (HTTP " + response.status + ")"));
        error.status = response.status;
        throw error;
      }
      const body = await response.json();
      const first = Array.isArray(body) ? body[0] : (body?.files?.[0] || body);
      const path = typeof first === "string" ? first : (first?.path || first?.url);
      if (!path) throw new Error("Space upload endpoint returned no file path.");
      const urlValue = typeof first === "object" && first?.url
        ? first.url
        : (/^https?:\/\//i.test(path) ? path : host + "/file=" + String(path).replace(/^\//, ""));
      return {
        ...(typeof first === "object" ? first : {}),
        path: typeof first === "object" && first?.path ? first.path : path,
        url: urlValue,
        orig_name: first?.orig_name || filename,
        size: Number(first?.size || file?.size || blob.size || 0),
        mime_type: first?.mime_type || file?.type || blob.type || "application/octet-stream",
      };
    } catch (error) {
      lastError = error;
      if (![404, 405].includes(error.status)) break;
    }
  }
  throw lastError || new Error("Could not upload file input.");
}
async function prepareGradioJob(job, model, endpoint, headers, signal) {
  if (job.remoteEventId) return { job, model, endpoint, headers, prefix: model.apiPrefix || "/gradio_api", api: encodeURIComponent(endpoint.apiName), sessionHash: Math.random().toString(36).slice(2, 12) };
  if (/^load_example(?:_(?:input|output))?(?:_\d+)?$/i.test(endpoint.apiName)) {
    throw new Error("This Space endpoint only loads a Gradio example; choose its inference endpoint.");
  }
  const files = await getJobAttachments(job);
  const data = [];
  const prefix = model.apiPrefix || "/gradio_api";
  for (const field of endpoint.fields) {
    if (field.hidden) {
      data.push(field.passthrough ?? field.defaultValue ?? null);
      continue;
    }
    let value = job.values?.[field.key];
    if (isFileField(field)) {
      const selected = normalizeSelectedFiles(files.get(field.key));
      if (selected.length) {
        const uploaded = await Promise.all(selected.map((file) => uploadFile(file, model.host, prefix, headers, signal)));
        if (field.type === "gallery") {
          value = uploaded.map((imageFile) => ({ image: imageFile, caption: null }));
        } else if (field.multiple === true) {
          value = uploaded;
        } else {
          value = uploaded[0];
        }
      } else if (value?.path || value?.url) {
        // A previously uploaded Gradio FileData value can be reused.
      } else if (Array.isArray(value) && value.some((item) => item?.name)) {
        throw new Error("One or more files for “" + (field.label || field.key) + "” are missing. Clone the job and attach them again.");
      } else if (value?.name) {
        throw new Error("The file for “" + (field.label || field.key) + "” is missing. Clone the job and attach it again.");
      } else {
        value = null;
      }
    }
    data.push(value ?? null);
  }
  return {
    job,
    model,
    endpoint,
    headers,
    data,
    prefix,
    api: encodeURIComponent(endpoint.apiName),
    sessionHash: Math.random().toString(36).slice(2, 12),
  };
}
async function submitGradioJob(prepared, signal) {
  const job = prepared.job;
  if (job.remoteEventId) return { ...prepared, eventId: job.remoteEventId };
  const body = JSON.stringify({ data: prepared.data, session_hash: prepared.sessionHash });
  let response;
  try {
    response = await fetch(prepared.model.host + prepared.prefix + "/call/" + prepared.api, {
      method: "POST",
      headers: { ...prepared.headers, "Content-Type": "application/json" },
      body,
      signal,
    });
  } catch (error) {
    if (isAbortError(error)) throw error;
    const uncertain = new Error("The submission connection failed before an event ID was returned. The Space may or may not have accepted it; check the hosted Space queue before retrying to avoid duplicate GPU work. " + error.message);
    uncertain.submissionUncertain = true;
    throw uncertain;
  }
  if ([404, 405, 501].includes(response.status)) {
    // Legacy Gradio /run is synchronous; only this fallback has to wait here.
    const legacy = await fetch(prepared.model.host + prepared.prefix + "/run/" + prepared.api, {
      method: "POST",
      headers: { ...prepared.headers, "Content-Type": "application/json" },
      body,
      signal,
    });
    if (!legacy.ok) {
      const message = (await legacy.text()).slice(0, 700);
      const error = new Error(message || ("Generation failed (HTTP " + legacy.status + ")"));
      error.status = legacy.status;
      throw error;
    }
    const output = await legacy.json();
    if (output?.error) throw new Error(typeof output.error === "string" ? output.error : JSON.stringify(output.error));
    return { ...prepared, immediateData: output?.data ?? output?.output?.data ?? output };
  }
  let initial = {};
  try { initial = await response.json(); }
  catch {
    const error = new Error("Gradio returned an invalid submission response.");
    error.status = response.status;
    throw error;
  }
  if (!response.ok || initial?.error || initial?.success === false) {
    const error = new Error(errorMessage(initial) || ("Generation submission failed (HTTP " + response.status + ")"));
    error.status = response.status;
    throw error;
  }
  if (initial?.event_id) return { ...prepared, eventId: String(initial.event_id) };
  if (Object.hasOwn(initial || {}, "data")) return { ...prepared, immediateData: initial.data };
  if (Object.hasOwn(initial?.output || {}, "data")) return { ...prepared, immediateData: initial.output.data };
  throw new Error("Gradio accepted the request but returned neither an event ID nor result data.");
}
async function waitForGradioJob(submission, signal) {
  if (Object.hasOwn(submission, "immediateData")) return submission.immediateData;
  if (!submission.eventId) throw new Error("The submitted job has no event ID to monitor.");
  const streamUrl = submission.model.host + submission.prefix + "/call/" + submission.api + "/" + encodeURIComponent(submission.eventId);
  const stream = await fetch(streamUrl, { headers: submission.headers, signal });
  if (!stream.ok) {
    const message = (await stream.text()).slice(0, 600);
    const error = new Error(message || ("Result stream failed (HTTP " + stream.status + ")"));
    error.status = stream.status;
    throw error;
  }
  return await readGradioStream(stream, (payload) => {
    submission.job.progress = typeof payload?.progress === "number" ? payload.progress : submission.job.progress;
    submission.job.phase = "Waiting in Space queue / receiving output";
    submission.job.updatedAt = Date.now();
    saveStateSoon();
  });
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Wait for `ms`, waking early if the user pauses the queue. Returns false when paused.
async function waitUnlessHalted(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (queueHalted) return false; await sleep(Math.min(250, end - Date.now())); }
  return !queueHalted;
}
async function runQueue() {
  if (queueBusy) return;
  queueHalted = false;
  queueBusy = true;
  clearNotice();
  const controller = new AbortController();
  const jobTimers = new Map();
  currentAbort = controller;

  function failJob(job, error, tokenSent = false, timerSignal = null) {
    const cancelled = controller.signal.aborted;
    const timedOut = !cancelled && Boolean(timerSignal?.aborted);
    const message = timedOut ? ("Request timed out after " + Math.round(GEN_TIMEOUT_MS / 60000) + " minutes.") : (error?.message || String(error));
    const kind = cancelled ? "cancelled" : classifyFailure(error?.status, message);
    const until = holdFor(kind, message, error?.resetAt || null);
    job.error = "[" + kind.toUpperCase() + "] " + (cancelled ? "Cancelled locally; the Space may still finish an already-submitted event." : message) +
      " (endpoint /" + job.apiName + ", token " + (tokenSent ? "sent" : "not sent") + ")";
    job.updatedAt = Date.now();
    job.phase = "";
    if (cancelled) {
      job.status = "paused";
      queueHalted = true;
    } else if (error?.submissionUncertain) {
      // Never automatically re-submit a POST whose acceptance is unknown.
      job.status = "paused";
      queueHalted = true;
      showNotice("The Space may have accepted a request but the browser did not receive its event ID. Check the Space queue before starting a fresh run.", "error");
    } else if (kind === "quota") {
      job.status = "paused";
      job.quotaResetAt = until;
      queueHalted = true;
      showNotice("ZeroGPU or Space quota is exhausted. The submitted batch is being allowed to finish; remaining jobs are paused.", "error");
    } else if (kind === "auth") {
      job.status = "paused";
      queueHalted = true;
      showNotice("Authentication failed. Check the selected account and retry after reconnecting it.", "error");
    } else if ((kind === "waking" || kind === "transient") && (job.attempts || 0) < MAX_AUTO_RETRIES) {
      job.attempts = (job.attempts || 0) + 1;
      job.status = "retry";
      job.phase = job.remoteEventId ? "Reconnecting to submitted event" : "Will retry submission";
      job.error += " — automatic retry " + job.attempts + "/" + MAX_AUTO_RETRIES + " will reuse the same event when one exists.";
    } else if (kind === "waking" || kind === "transient") {
      job.status = "paused";
      queueHalted = true;
      showNotice("The Space could not complete this job after bounded retries. It is paused for a manual decision.", "error");
    } else {
      job.status = "failed";
      if (kind === "policy") showNotice("The Space refused the request under its policy/safety rules. Review the prompt before retrying.", "error");
    }
    saveState();
    return (job.status === "retry") ? Math.min(30000, 5000 * (3 ** Math.max(0, (job.attempts || 1) - 1))) : 0;
  }

  try {
    while (!queueHalted) {
      const batch = nextQueueBatch(state.jobs);
      if (!batch.length) break;
      const model = getModel(batch[0].modelId);
      const host = normalizeHost(model?.host);
      if (!model || !host) {
        for (const job of batch) {
          job.status = "failed";
          job.error = "The saved Space or host is no longer available. Rediscover it and clone this job.";
          job.updatedAt = Date.now();
        }
        saveState();
        render();
        continue;
      }

      if (/zero(?:[-\s]?gpu|[-\s]?(?:a10g|t4|l4|a100))/i.test(String(model.hardware || "")) && batch[0].accountId && accountTokens.has(batch[0].accountId)) {
        const quota = await refreshZeroGpuQuota(batch[0].accountId, true);
        if (quota && quota.remaining <= 0) {
          for (const job of batch) {
            job.status = "paused";
            job.phase = "";
            job.error = "The selected account has no ZeroGPU GPU-seconds remaining. Refresh the quota after its reset, then retry.";
            job.updatedAt = Date.now();
          }
          queueHalted = true;
          saveState();
          showNotice("No ZeroGPU time remains on the selected account. No generation request was submitted.", "error");
          break;
        }
      }

      const entries = [];
      for (const job of batch) {
        const endpoint = endpointFor(model, job.apiName, false);
        if (!endpoint) {
          job.status = "failed";
          job.phase = "";
          job.error = "Saved Space endpoint /" + job.apiName + " is no longer available. Refresh the Space schema and clone this job.";
          job.updatedAt = Date.now();
          continue;
        }
        if (job.accountId && (!accountTokens.has(job.accountId) || !getAccount(job.accountId)?.enabled)) {
          job.status = "paused";
          job.phase = "";
          job.error = "The selected account is not connected in this browser session. Connect it and retry this job.";
          job.updatedAt = Date.now();
          queueHalted = true;
          continue;
        }
        const timer = withTimeout(GEN_TIMEOUT_MS, controller.signal);
        jobTimers.set(job.id, timer);
        job.status = "running";
        job.phase = job.remoteEventId ? "Reconnecting to submitted event" : "Preparing uploads";
        job.error = "";
        job.progress = 0;
        job.startedAt = job.startedAt || Date.now();
        job.updatedAt = Date.now();
        const headers = authHeaders(job.accountId, host, model.private === true || model.sendToken === true);
        entries.push({ job, endpoint, timer, headers, tokenSent: Boolean(headers.Authorization) });
      }
      saveState();
      render();
      if (queueHalted) {
        for (const entry of entries) {
          entry.job.status = "ready";
          entry.job.phase = "";
          entry.timer.done();
          jobTimers.delete(entry.job.id);
        }
        saveState();
        break;
      }
      if (!entries.length) continue;

      // Upload all user-provided images/files before any inference request starts.
      let uploadCursor = 0;
      const preparedResults = new Array(entries.length);
      const worker = async () => {
        while (uploadCursor < entries.length) {
          const index = uploadCursor++;
          const entry = entries[index];
          try {
            const prepared = await prepareGradioJob(entry.job, { ...model, host }, entry.endpoint, entry.headers, entry.timer.signal);
            entry.job.phase = entry.job.remoteEventId ? "Ready to resume remote event" : "Uploads prepared";
            entry.job.updatedAt = Date.now();
            preparedResults[index] = { ...entry, prepared };
          } catch (error) {
            const retryDelay = failJob(entry.job, error, entry.tokenSent, entry.timer.signal);
            preparedResults[index] = { ...entry, error, retryDelay };
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(3, entries.length) }, () => worker()));
      saveState();
      render();

      // POSTs return event IDs quickly; the Space's own queue handles actual GPU execution.
      const submissions = [];
      for (const item of preparedResults) {
        if (!item || item.error) continue;
        if (queueHalted || controller.signal.aborted) {
          item.job.status = "ready";
          item.job.phase = "";
          item.job.updatedAt = Date.now();
          continue;
        }
        try {
          item.job.phase = "Submitting to Space queue";
          item.job.updatedAt = Date.now();
          render();
          const submitted = await submitGradioJob(item.prepared, item.timer.signal);
          if (submitted.eventId) {
            item.job.remoteEventId = submitted.eventId;
            item.job.phase = "Submitted · waiting for Space GPU queue";
          } else {
            item.job.phase = "Legacy synchronous endpoint";
          }
          item.job.updatedAt = Date.now();
          saveState();
          submissions.push({ ...item, submission: submitted });
        } catch (error) {
          item.retryDelay = failJob(item.job, error, item.tokenSent, item.timer.signal);
        }
      }
      saveState();

      // Attach all event streams concurrently; do not wait for job 1's image before monitoring job 2.
      await Promise.all(submissions.map(async (item) => {
        try {
          const raw = await waitForGradioJob(item.submission, item.timer.signal);
          item.job.result = normalizeOutputs(raw, "Output", host);
          item.job.status = "done";
          item.job.error = "";
          item.job.phase = "Complete";
          item.job.remoteEventId = "";
          item.job.attempts = 0;
          item.job.finishedAt = Date.now();
          item.job.updatedAt = Date.now();
          item.job.progress = 1;
          saveState();
          ping("Completed: " + (item.job.name || model.title));
        } catch (error) {
          item.retryDelay = failJob(item.job, error, item.tokenSent);
        } finally {
          item.timer.done();
          jobTimers.delete(item.job.id);
        }
      }));

      // Jobs that were prepared but not accepted remain safely staged for the next run.
      for (const item of preparedResults) {
        if (item && !item.error && !submissions.some((submitted) => submitted.job.id === item.job.id) && item.job.status === "running") {
          item.job.status = "ready";
          item.job.phase = "";
          item.job.updatedAt = Date.now();
          item.timer.done();
          jobTimers.delete(item.job.id);
        }
      }
      for (const item of preparedResults) {
        if (item?.error) {
          item.timer.done();
          jobTimers.delete(item.job.id);
        }
      }
      saveState();
      render();

      if (/zero(?:[-\s]?gpu|[-\s]?(?:a10g|t4|l4|a100))/i.test(String(model.hardware || "")) && batch[0].accountId) {
        await refreshZeroGpuQuota(batch[0].accountId, true);
      }
      if (!queueHalted) {
        const retryJobs = state.jobs.filter((job) => ["ready", "retry"].includes(job.status));
        if (retryJobs.some((job) => job.status === "retry")) {
          const delay = Math.max(0, ...retryJobs.filter((job) => job.status === "retry").map((job) => Math.min(30000, 5000 * (3 ** Math.max(0, (job.attempts || 1) - 1)))));
          if (delay) await waitUnlessHalted(delay);
        }
      }
    }
  } catch (error) {
    showNotice("Queue manager stopped: " + (error?.message || String(error)), "error");
  } finally {
    for (const timer of jobTimers.values()) timer.done();
    jobTimers.clear();
    currentAbort = null;
    queueBusy = false;
    saveState();
    render();
    if (!queueHalted) ping("Queue run finished.");
  }
}
function exportWorkspace() {
  const blob = new Blob([JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), workspace: { ...state, accounts: state.accounts.map(({ token, connected, ...account }) => ({ ...account, connected: false })) } }, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob); const a = document.createElement("a"); a.href = url; a.download = `multi-hf-workspace-${new Date().toISOString().slice(0, 10)}.json`; a.click(); URL.revokeObjectURL(url); ping("Workspace exported. Account tokens are excluded.");
}
function importWorkspace(data) {
  const imported = sanitizeWorkspace(data);
  if (!confirm(`Import ${imported.models.length} Space(s), ${imported.profiles.length} profile(s) and ${imported.jobs.length} job(s), replacing the current workspace? Tokens are never imported.`)) return;
  state = imported;
  accountTokens.clear(); jobFiles.clear(); saveState(); render(); ping("Workspace imported. Reconnect accounts to use private Spaces.");
}
document.querySelectorAll("[data-tab]").forEach((button) => button.addEventListener("click", () => { currentSpaceUi = null; currentTab = button.dataset.tab; render(); }));
document.querySelector("#quick-add").addEventListener("click", () => openNewJob());
document.querySelector("#export-data").addEventListener("click", exportWorkspace);
document.querySelector("#import-data").addEventListener("click", () => document.querySelector("#import-file").click());
document.querySelector("#import-file").addEventListener("change", async (event) => {
  const file = event.target.files?.[0]; if (!file) return;
  try { importWorkspace(JSON.parse(await file.text())); } catch (error) { ping(error.message || "Could not import this file."); }
  event.target.value = "";
});
dialog.addEventListener("click", (event) => { if (event.target === dialog) dialog.close(); });
document.addEventListener("keydown", (event) => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "j") { event.preventDefault(); openNewJob(); } });

render();

if ("serviceWorker" in navigator && location.protocol !== "file:") navigator.serviceWorker.register("./service-worker.js").catch(() => {});
