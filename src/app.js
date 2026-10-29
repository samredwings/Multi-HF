import {
  parseSpaceInput, normalizeHost, parseSpaceConfig, taskFromEndpoints, classifyFailure,
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
let queueBusy = false;
let queueHalted = false;
let currentAbort = null;
let toastTimer;
let saveTimer;
const GEN_TIMEOUT_MS = 15 * 60 * 1000;
const META_TIMEOUT_MS = 30 * 1000;
const MAX_AUTO_RETRIES = 2;

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
function renderQueue() {
  const ready = waitingJobs().length;
  const done = state.jobs.filter((job) => job.status === "done").length;
  const paused = state.jobs.filter((job) => job.status === "paused").length;
  const failed = state.jobs.filter((job) => job.status === "failed").length;
  const rows = state.jobs.filter((job) => job.status !== "done").slice().reverse().slice(0, 12);
  view.innerHTML = `
    <div class="stats">${stat("Pending jobs", ready, "Waiting to run")}${stat("Completed", done, "Finished successfully")}${stat("Paused", paused, "Needs a manual decision")}${stat("Failed", failed, "Review the error details")}</div>
    <div class="section-head"><div><h2>Queue workspace</h2><p>Jobs run one at a time to keep Space state predictable.</p></div><div class="inline-actions"><button class="button button-quiet" id="queue-pause" ${queueBusy ? "" : "disabled"}>Pause queue</button><button class="button button-quiet" id="queue-cancel" ${queueBusy ? "" : "disabled"}>Cancel running job</button><button class="button button-primary" id="queue-run" ${queueBusy || !ready ? "disabled" : ""}>▶ Run queue</button></div></div>
    <div class="panel"><div class="panel-head"><div><h2>Upcoming & active</h2><div class="subtext">${queueBusy ? "A job is currently running." : queueHalted ? "Queue is paused after a quota/resource failure." : "Ready when you are."}</div></div><button class="button button-sm" id="queue-add">＋ Add job</button></div>
    ${rows.length ? `<div class="table-wrap"><table class="table"><thead><tr><th>Job</th><th>Space</th><th>Status</th><th>Updated</th><th>Action</th></tr></thead><tbody>${rows.map(jobRow).join("")}</tbody></table></div>` : `<div class="empty"><div class="empty-mark">▦</div><strong>Your queue is clear</strong><p>Add a Hugging Face Space, create a profile, and enqueue a generation job. Results and queue state stay in this browser.</p><button class="button button-primary" id="queue-empty-add">＋ Create first job</button></div>`}</div>
    <div class="section-head"><div><h2>Latest results</h2><p>Open a completed job to view its output gallery.</p></div><button class="button button-quiet button-sm" data-goto="jobs">View all jobs ↗</button></div>
    ${renderRecentResults()}`;
  document.querySelector("#queue-run")?.addEventListener("click", () => runQueue());
  document.querySelector("#queue-pause")?.addEventListener("click", () => { queueHalted = true; ping("Queue paused. The active request may finish before stopping."); });
  document.querySelector("#queue-cancel")?.addEventListener("click", () => { queueHalted = true; currentAbort?.abort(); ping("Cancelling the active request. The Space may still finish on its side."); });
  ["queue-add", "queue-empty-add"].forEach((id) => document.querySelector(`#${id}`)?.addEventListener("click", () => openNewJob()));
  bindJobActions();
  document.querySelectorAll("[data-goto]").forEach((button) => button.addEventListener("click", () => { currentTab = button.dataset.goto; render(); }));
}
function jobRow(job) {
  const model = getModel(job.modelId);
  const title = job.name || job.values?.prompt || job.apiName || "Generation job";
  return `<tr><td><div><strong>${escapeHtml(String(title).slice(0, 80))}</strong><div class="subtext">${escapeHtml(job.apiName || "API")}</div></div></td><td>${escapeHtml(model?.title || job.modelId)}<div class="subtext">${escapeHtml(model?.ref || model?.host || "Space")}</div></td><td>${statusBadge(job.status)}${job.error ? `<div class="subtext">${escapeHtml(job.error)}</div>` : ""}</td><td>${escapeHtml(fmtDate(job.updatedAt || job.createdAt))}</td><td><div class="inline-actions"><button class="button button-sm" data-job-open="${escapeHtml(job.id)}">Details</button>${["failed", "paused"].includes(job.status) ? `<button class="button button-sm" data-job-retry="${escapeHtml(job.id)}">Retry</button>` : ""}</div></td></tr>`;
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
  document.querySelector("#jobs-clear")?.addEventListener("click", () => { state.jobs = state.jobs.filter((job) => job.status !== "done"); saveState(); render(); ping("Completed jobs cleared."); });
  bindJobActions();
}
function renderSpaceUi(model) {
  const host = normalizeHost(model?.host);
  if (!host) {
    view.innerHTML = `<div class="panel"><div class="empty"><div class="empty-mark">!</div><strong>This Space has no valid live UI address</strong><p>Refresh the Space schema, then try again.</p><button class="button button-primary" id="space-ui-back">Back to workspace</button></div></div>`;
    document.querySelector("#space-ui-back")?.addEventListener("click", () => { currentSpaceUi = null; currentTab = "models"; render(); });
    return;
  }
  const standaloneUrl = model.ref
    ? `https://huggingface.co/spaces/${model.ref.split("/").map(encodeURIComponent).join("/")}`
    : host;
  const privateNote = model.private
    ? `<div class="notice error space-ui-notice">This Space is marked private. The embedded UI may require a Hugging Face sign-in and browser permissions. Multi-HF does not inject its session token into this frame; use the API form for authenticated queued jobs.</div>`
    : "";
  view.innerHTML = `
    <div class="section-head space-ui-header">
      <div><h2>Live model interface</h2><p>The selected Space's own UI is loaded below. Each Space keeps its own controls, layout, examples, and workflow.</p></div>
      <div class="inline-actions">
        <button class="button button-sm" id="space-ui-back">← Workspace</button>
        <a class="button button-sm" href="${escapeHtml(standaloneUrl)}" target="_blank" rel="noopener noreferrer">Open standalone ↗</a>
        <button class="button button-primary button-sm" id="space-ui-job">Create queued job</button>
      </div>
    </div>
    ${privateNote}
    <div class="panel space-ui-panel">
      <div class="panel-head">
        <div><h2>${escapeHtml(model.title || model.ref || host)}</h2><div class="subtext">${escapeHtml(host)}</div></div>
        <span class="badge running">LIVE SPACE UI</span>
      </div>
      <iframe class="space-ui-frame" src="${escapeHtml(host + "/")}" title="Live Hugging Face interface for ${escapeHtml(model.title || model.ref || host)}" loading="eager" referrerpolicy="no-referrer" allow="fullscreen; clipboard-write" allowfullscreen></iframe>
    </div>
    <p class="help space-ui-help">This is the model author's hosted interface, not a recreated generic form. Its inputs and results stay inside the Space and do not automatically populate Multi-HF profiles or the batch queue. Use “Create queued job” for batch runs. Some Spaces disable embedding; “Open standalone” is the fallback.</p>`;
  document.querySelector("#space-ui-back")?.addEventListener("click", () => { currentSpaceUi = null; currentTab = "models"; render(); });
  document.querySelector("#space-ui-job")?.addEventListener("click", () => { currentSpaceUi = null; currentTab = "models"; render(); openNewJob(model.id); });
}
function renderModels() {
  view.innerHTML = `<div class="section-head"><div><h2>Connected Spaces</h2><p>Discover Gradio endpoints from each Space's live configuration.</p></div><button class="button button-primary" id="models-add">＋ Add Space</button></div>
  ${state.models.length ? `<div class="card-grid">${state.models.map((model) => `<article class="model-card"><div class="inline-actions"><span class="badge ${model.task === "video" ? "running" : ""}">${escapeHtml(model.task.toUpperCase())}</span><span class="badge">${model.endpoints.length} endpoints</span></div><div class="card-title" style="margin-top:12px">${escapeHtml(model.title)}</div><div class="card-meta">${escapeHtml(model.ref || model.host)}<br>Updated ${escapeHtml(timeAgo(model.fetchedAt))}</div><div class="card-actions"><button class="button button-primary button-sm" data-model-new="${escapeHtml(model.id)}">Create job</button><button class="button button-sm" data-model-ui="${escapeHtml(model.id)}">Open interface ↗</button><button class="button button-sm" data-model-refresh="${escapeHtml(model.id)}">Refresh schema</button><button class="button button-sm" data-model-token="${escapeHtml(model.id)}">Token: ${model.sendToken || model.private ? "sent" : "not sent"}</button><a class="button button-sm" href="${escapeHtml(model.ref ? `https://huggingface.co/spaces/${model.ref}` : model.host)}" target="_blank" rel="noopener">Open Space ↗</a><button class="button button-danger button-sm" data-model-remove="${escapeHtml(model.id)}">Remove</button></div></article>`).join("")}</div>` : `<div class="panel"><div class="empty"><div class="empty-mark">◇</div><strong>Add your first Space</strong><p>Enter a Hugging Face Space ID such as <span class="kbd">owner/name</span> or its public URL. Multi-HF reads the live Gradio schema and creates a dynamic generation form.</p><button class="button button-primary" id="models-empty-add">＋ Discover Space</button></div></div>`}`;
  document.querySelector("#models-add")?.addEventListener("click", () => openAddSpace());
  document.querySelector("#models-empty-add")?.addEventListener("click", () => openAddSpace());
  document.querySelectorAll("[data-model-new]").forEach((button) => button.addEventListener("click", () => openNewJob(button.dataset.modelNew)));
  document.querySelectorAll("[data-model-ui]").forEach((button) => button.addEventListener("click", () => { currentSpaceUi = button.dataset.modelUi; render(); }));
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
  document.querySelectorAll("[data-profile-ui]").forEach((button) => button.addEventListener("click", () => { const profile = getProfile(button.dataset.profileUi); if (profile && getModel(profile.modelId)) { currentSpaceUi = profile.modelId; render(); } }));
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
    job.status = "retry"; job.error = ""; job.attempts = 0; job.updatedAt = Date.now(); job.quotaResetAt = null; queueHalted = false; saveState(); render(); ping("Job queued for manual retry.");
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
  if (!config) throw new Error(`${configError?.message || "Could not read this Space's Gradio config."} If this Space is private, connect a token; if browser access is blocked, use a browser with compatible CORS permissions.`);
  const schema = parseSpaceConfig(config);
  const id = resolvedId || prior?.id || host;
  const name = options.note || prior?.note || "";
  const model = {
    id, kind: "space", ref: resolvedId || prior?.ref || "", host,
    title: name || schema.title || apiData?.cardData?.title || resolvedId || host,
    task: taskFromEndpoints(schema.endpoints), apiPrefix: schema.apiPrefix,
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
  else if (field.type === "checkbox") input = `<label class="inline-actions"><input id="${id}" data-key="${escapeHtml(field.key)}" type="checkbox" ${value === true || (value == null && field.defaultValue === true) ? "checked" : ""}> <span>${label}</span></label>`;
  else if (field.type === "select" || field.type === "radio" || field.type === "checkboxgroup") {
    const choices = field.choices || [];
    if (field.type === "checkboxgroup") input = choices.length ? `<div class="choice-list">${choices.map((choice, i) => `<label class="inline-actions"><input type="checkbox" data-key="${escapeHtml(field.key)}" data-choice="${escapeHtml(choice.value)}" ${(Array.isArray(value) ? value : []).includes(choice.value) ? "checked" : ""}><span>${escapeHtml(choice.label)}</span></label>`).join("")}</div>` : `<input id="${id}" data-key="${escapeHtml(field.key)}" placeholder="Comma-separated values" value="${escapeHtml(Array.isArray(value) ? value.join(", ") : "")}">`;
    else input = `<select id="${id}" data-key="${escapeHtml(field.key)}">${choices.map((choice) => `<option value="${escapeHtml(choice.value)}" ${(String(value ?? field.defaultValue ?? "") === choice.value) ? "selected" : ""}>${escapeHtml(choice.label)}</option>`).join("")}${!choices.length ? `<option value="${escapeHtml(value ?? "")}">${escapeHtml(value ?? "Select a value")}</option>` : ""}</select>`;
  }
  else if (field.type === "slider") input = `<div><input id="${id}" data-key="${escapeHtml(field.key)}" type="range" min="${field.min ?? 0}" max="${field.max ?? 100}" step="${field.step ?? 1}" value="${escapeHtml(value ?? field.defaultValue ?? field.min ?? 0)}"><small id="${id}-value">${escapeHtml(value ?? field.defaultValue ?? field.min ?? 0)}</small></div>`;
  else if (field.type === "number") input = `<input id="${id}" data-key="${escapeHtml(field.key)}" type="number" ${field.min != null ? `min="${field.min}"` : ""} ${field.max != null ? `max="${field.max}"` : ""} ${field.step != null ? `step="${field.step}"` : ""} value="${escapeHtml(value ?? field.defaultValue ?? "")}">`;
  else if (["image", "video", "audio", "file"].includes(field.type)) input = `<input id="${id}" data-key="${escapeHtml(field.key)}" type="file" accept="${field.type === "image" ? "image/*" : field.type === "video" ? "video/*" : field.type === "audio" ? "audio/*" : "*/*"}" ${profileMode ? "disabled" : ""}><small>File inputs are attached when the job is enqueued. Reattach files after reloading the page.</small>`;
  else input = `<input id="${id}" data-key="${escapeHtml(field.key)}" type="text" placeholder="${escapeHtml(field.placeholder || "")}" value="${escapeHtml(value ?? field.defaultValue ?? "")}">`;
  return `<div class="field ${field.type === "textarea" ? "full" : ""}">${field.type === "checkbox" ? input : `<label for="${id}">${label}${field.type === "number" && field.min != null ? ` <span class="muted">(min ${field.min})</span>` : ""}</label>${input}`}${hint}</div>`;
}
function collectValues(container, endpoint, fileMap = null) {
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
    if (!input) continue;
    if (["image", "video", "audio", "file"].includes(field.type)) {
      if (input.files?.[0] && fileMap) fileMap.set(field.key, input.files[0]);
      values[field.key] = input.files?.[0] ? { name: input.files[0].name, size: input.files[0].size, mime: input.files[0].type } : null;
    } else if (field.type === "checkbox") values[field.key] = input.checked;
    else if (["number", "slider"].includes(field.type)) values[field.key] = input.value === "" ? null : Number(input.value);
    else values[field.key] = input.value;
  }
  return values;
}
function openNewJob(modelId = null, profile = null) {
  if (!state.models.length) { currentTab = "models"; render(); openAddSpace(); return; }
  const model = getModel(modelId) || getModel(profile?.modelId) || state.models[0];
  const endpoint = endpointFor(model, profile?.apiName || model.activeApi);
  if (!endpoint) { ping("This Space has no runnable endpoints. Refresh its schema."); return; }
  const files = new Map();
  const profiles = state.profiles.filter((p) => p.modelId === model.id);
  const accounts = [{ id: "", label: "Public / no token" }, ...connectedAccounts().filter((a) => a.enabled).map((a) => ({ id: a.id, label: a.label }))];
  showDialog(`${dialogHeader("Create generation job", "Choose a Space endpoint, set its parameters, and add the job to the persistent queue.")}
    <form id="job-form"><div class="field-grid"><div class="field"><label for="job-name">Job name</label><input id="job-name" name="name" maxlength="100" value="${escapeHtml(profile?.name || "")}" placeholder="e.g. cinematic city loop"></div><div class="field"><label for="job-model">Space</label><select id="job-model" name="modelId">${state.models.map((m) => `<option value="${escapeHtml(m.id)}" ${m.id === model.id ? "selected" : ""}>${escapeHtml(m.title)}</option>`).join("")}</select></div><div class="field"><label for="job-api">API endpoint</label><select id="job-api" name="apiName">${model.endpoints.map((ep) => `<option value="${escapeHtml(ep.apiName)}" ${ep.apiName === endpoint.apiName ? "selected" : ""}>/${escapeHtml(ep.apiName)}</option>`).join("")}</select></div><div class="field"><label for="job-account">Account for this job</label><select id="job-account" name="accountId">${accounts.map((a) => `<option value="${escapeHtml(a.id)}" ${String(profile?.accountId || model.accountId || state.settings.lastAccountId || "") === a.id ? "selected" : ""}>${escapeHtml(a.label)}</option>`).join("")}</select><small>Account selection is explicit; tokens are not silently rotated.</small></div></div><div class="section-head"><div><h2>Generation parameters</h2><p>Inputs are created from the live Gradio schema.</p></div></div><div class="field-grid" id="job-fields"></div><div class="field full" style="margin-top:16px"><label class="inline-actions"><input id="job-save-profile" type="checkbox" ${profile ? "checked" : ""}><span>Save these settings as a reusable profile</span></label></div><div class="field ${profile ? "" : "hidden"}" id="job-profile-name-wrap"><label for="job-profile-name">Profile name</label><input id="job-profile-name" value="${escapeHtml(profile?.name || "")}" placeholder="Reusable profile name"></div><div class="form-actions"><button class="button" type="button" data-close>Cancel</button><button class="button button-primary" type="submit">＋ Add to queue</button></div></form>`);
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
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const chosen = getModel(modelSelect.value); const ep = endpointFor(chosen, apiSelect.value);
    if (!chosen || !ep) { dialogError("Select a valid Space endpoint."); return; }
    const values = collectValues(form, ep, files);
    const name = String(new FormData(form).get("name") || values.prompt || ep.apiName).trim();
    const jobId = safeId("job");
    const job = { id: jobId, name, modelId: chosen.id, apiName: ep.apiName, accountId: String(new FormData(form).get("accountId") || ""), values, files: [...files.keys()], status: "ready", error: "", result: [], createdAt: Date.now(), updatedAt: Date.now() };
    state.jobs.push(job);
    jobFiles.set(jobId, files);
    if (document.querySelector("#job-save-profile").checked) {
      const profileName = String(document.querySelector("#job-profile-name").value || name).trim();
      if (profileName) {
        const existing = state.profiles.find((p) => p.name === profileName && p.modelId === chosen.id);
        const profileRecord = { id: existing?.id || safeId("profile"), name: profileName, modelId: chosen.id, apiName: ep.apiName, values: JSON.parse(JSON.stringify(values)), accountId: job.accountId, createdAt: existing?.createdAt || Date.now(), updatedAt: Date.now() };
        if (existing) Object.assign(existing, profileRecord); else state.profiles.push(profileRecord);
      }
    }
    saveState(); dialog.close(); currentTab = "queue"; render(); ping("Job added to queue.");
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
    <div class="form-actions"><button class="button" type="button" data-close>Close</button>${["failed", "paused"].includes(job.status) ? `<button class="button button-primary" id="detail-retry">Retry job</button>` : ""}<button class="button" id="detail-clone">Clone job</button></div>`);
  document.querySelector("#detail-retry")?.addEventListener("click", () => { job.status = "retry"; job.error = ""; job.attempts = 0; job.updatedAt = Date.now(); queueHalted = false; saveState(); dialog.close(); currentTab = "queue"; render(); ping("Job marked for retry."); });
  document.querySelector("#detail-clone")?.addEventListener("click", () => { const profile = { modelId: job.modelId, apiName: job.apiName, values: job.values, accountId: job.accountId, name: job.name }; dialog.close(); openNewJob(job.modelId, profile); });
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
  const form = new FormData(); form.append("files", file, file.name);
  let lastError;
  for (const url of [`${host}${apiPrefix}/upload`, `${host}/upload`]) {
    try {
      const response = await fetch(url, { method: "POST", headers, body: form, signal });
      if (!response.ok) { const err = new Error(`Upload failed (HTTP ${response.status})`); err.status = response.status; throw err; }
      const body = await response.json();
      const path = Array.isArray(body) ? body[0] : body?.path || body?.files?.[0]?.path || body?.[0]?.path;
      if (!path) throw new Error("Space upload endpoint returned no file path.");
      return { path, url: /^https?:\/\//i.test(path) ? path : `${host}/file=${path.replace(/^\//, "")}`, orig_name: file.name, size: file.size, mime_type: file.type || "application/octet-stream" };
    } catch (error) { lastError = error; if (![404, 405].includes(error.status)) break; }
  }
  throw lastError || new Error("Could not upload file input.");
}
async function callGradio(model, endpoint, values, job, headers, signal) {
  if (/^load_example(?:_(?:input|output))?(?:_\d+)?$/i.test(endpoint.apiName)) {
    throw new Error("This Space endpoint only loads a Gradio example; it cannot generate output. Refresh the Space schema and choose its inference endpoint.");
  }
  const data = [];
  const files = jobFiles.get(job.id) || new Map();
  for (const field of endpoint.fields) {
    if (field.hidden) { data.push(field.passthrough ?? field.defaultValue ?? null); continue; }
    let value = values[field.key];
    if (["image", "video", "audio", "file"].includes(field.type)) {
      const file = files.get(field.key);
      if (file) value = await uploadFile(file, model.host, model.apiPrefix || "/gradio_api", headers, signal);
      else if (value?.path || value?.url) { /* already-uploaded file reference: send as is */ }
      else if (value?.name) throw new Error(`File “${value.name}” is not available in memory. Reattach it by cloning the job before retrying.`);
      else value = null;
    }
    data.push(value ?? null);
  }
  const sessionHash = Math.random().toString(36).slice(2, 12);
  const api = encodeURIComponent(endpoint.apiName);
  const prefix = model.apiPrefix || "/gradio_api";
  let response;
  try {
    response = await fetch(`${model.host}${prefix}/call/${api}`, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ data, session_hash: sessionHash }), signal });
  } catch (error) { if (isAbortError(error)) throw error; throw new Error(`Could not reach the Space. Check its availability and browser CORS settings. ${error.message}`); }
  if (response.ok) {
    let initial;
    try { initial = await response.json(); } catch {}
    if (initial?.error || initial?.success === false) throw new Error(errorMessage(initial));
    if (initial?.event_id) {
      const stream = await fetch(`${model.host}${prefix}/call/${api}/${encodeURIComponent(initial.event_id)}`, { headers, signal });
      if (!stream.ok) { const text = (await stream.text()).slice(0, 600); const err = new Error(text || `Result stream failed (HTTP ${stream.status})`); err.status = stream.status; throw err; }
      return await readGradioStream(stream, (payload) => { job.progress = typeof payload?.progress === "number" ? payload.progress : job.progress; job.updatedAt = Date.now(); saveStateSoon(); });
    }
    if (initial?.data) return initial.data;
    if (initial?.output?.data) return initial.output.data;
  }
  // Older Gradio builds expose the synchronous run endpoint instead of /call.
  if ([404, 405, 501].includes(response.status)) {
    const fallback = await fetch(`${model.host}${prefix}/run/${api}`, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ data, session_hash: sessionHash }), signal });
    if (!fallback.ok) { const message = (await fallback.text()).slice(0, 700); const err = new Error(message || `Generation failed (HTTP ${fallback.status})`); err.status = fallback.status; throw err; }
    const output = await fallback.json();
    if (output?.error) throw new Error(typeof output.error === "string" ? output.error : JSON.stringify(output.error));
    return output?.data ?? output?.output?.data ?? output;
  }
  const message = response.ok ? "Gradio did not return an event id or output." : (await response.text()).slice(0, 700);
  const error = new Error(message || `Generation failed (HTTP ${response.status})`); error.status = response.status; throw error;
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
  queueHalted = false; queueBusy = true; clearNotice(); render();
  try {
    while (!queueHalted) {
      const job = state.jobs.find((item) => ["ready", "retry"].includes(item.status));
      if (!job) break;
      const model = getModel(job.modelId); const endpoint = endpointFor(model, job.apiName, false);
      if (!model || !endpoint) { job.status = "failed"; job.error = `Saved Space endpoint /${job.apiName} is no longer available. Refresh the Space schema and clone this job using a generation endpoint.`; job.updatedAt = Date.now(); saveState(); continue; }
      const host = normalizeHost(model.host);
      if (!host) { job.status = "failed"; job.error = "Saved Space host is not a valid *.hf.space address. Rediscover the Space and clone the job."; job.updatedAt = Date.now(); saveState(); continue; }
      if (!jobFiles.has(job.id) && (job.files || []).length) {
        const missing = (job.files || []).some((key) => job.values?.[key]?.name);
        if (missing) { job.status = "paused"; job.error = "Local file inputs are no longer in memory. Clone this job and reattach files before retrying."; job.updatedAt = Date.now(); saveState(); continue; }
      }
      if (job.accountId && (!accountTokens.has(job.accountId) || !getAccount(job.accountId)?.enabled)) {
        job.status = "paused"; job.error = "The selected account is not connected in this browser session. Connect it and retry this job."; job.updatedAt = Date.now(); saveState(); continue;
      }
      job.status = "running"; job.error = ""; job.progress = 0; job.startedAt = Date.now(); job.updatedAt = Date.now(); saveState(); render();
      let tokenSent = false;
      currentAbort = new AbortController();
      const timer = withTimeout(GEN_TIMEOUT_MS, currentAbort.signal);
      try {
        const headers = authHeaders(job.accountId, host, model.private === true || model.sendToken === true); tokenSent = Boolean(headers.Authorization);
        const raw = await callGradio({ ...model, host }, endpoint, job.values || {}, job, headers, timer.signal);
        job.result = normalizeOutputs(raw, "Output", host);
        job.status = "done"; job.error = ""; job.attempts = 0; job.finishedAt = Date.now(); job.updatedAt = Date.now(); job.progress = 1; saveState(); ping(`Completed: ${job.name || model.title}`);
      } catch (error) {
        const cancelled = currentAbort.signal.aborted;
        const timedOut = !cancelled && isAbortError(error);
        const message = timedOut ? `Request timed out after ${Math.round(GEN_TIMEOUT_MS / 60000)} minutes.` : (error.message || String(error));
        const kind = cancelled ? "cancelled" : classifyFailure(error.status, message);
        const until = holdFor(kind, message, error?.resetAt || null);
        job.error = `[${kind.toUpperCase()}] ${cancelled ? "Cancelled by you. Retry when ready." : message} (endpoint /${job.apiName}, token ${tokenSent ? "sent" : "not sent"})`; job.updatedAt = Date.now();
        if (cancelled) {
          job.status = "paused"; queueHalted = true;
        } else if (kind === "quota") {
          job.status = "paused"; job.quotaResetAt = until; queueHalted = true;
          showNotice("Quota/resource exhaustion detected. The job and queue are paused. No reset time was guessed and no other account was selected automatically.", "error");
        } else if ((kind === "waking" || kind === "transient") && (job.attempts || 0) < MAX_AUTO_RETRIES && !queueHalted) {
          // Bounded retry on the same Space and account: no rotation, no limit evasion.
          const delay = Math.min(3 * 60 * 1000, until ? Math.max(0, until - Date.now()) : 5000 * 3 ** (job.attempts || 0));
          job.attempts = (job.attempts || 0) + 1; job.status = "retry";
          job.error += ` — automatic retry ${job.attempts}/${MAX_AUTO_RETRIES} in ${Math.ceil(delay / 1000)}s.`;
          saveState(); render();
          await waitUnlessHalted(delay);
          continue;
        } else if (kind === "waking" || kind === "transient") {
          job.status = "paused"; queueHalted = true;
          showNotice(`${kind === "waking" ? "The Space appears to be waking or loading." : "A transient/network error interrupted this job."} Automatic retries are used up; it is paused for a manual retry.`, "error");
        } else if (kind === "auth") {
          job.status = "paused"; queueHalted = true;
          showNotice("Authentication failed. Check the selected account token and retry manually; account switching is not automatic.", "error");
        } else {
          job.status = "failed";
          if (kind === "policy") showNotice("The Space refused the request under its policy/safety rules. Review the prompt and the Space's own terms before retrying.", "error");
        }
        saveState();
      } finally { timer.done(); currentAbort = null; }
      render();
      if (queueHalted) break;
    }
  } finally {
    queueBusy = false; render();
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
