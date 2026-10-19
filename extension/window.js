import { createDemoBackend } from "./demo.js";

const $ = id => document.getElementById(id);
const app = $("app");
const isExtensionPage = location.protocol === "chrome-extension:";
const isDemo = new URLSearchParams(location.search).get("demo") === "1" || !isExtensionPage;
document.documentElement.dataset.preview = String(!isExtensionPage);
const preferenceKey = isDemo ? "xcleaner:preview:preferences" : "xcleaner:preferences";
const activePhases = new Set(["scanning", "cleaning", "paused"]);
const numberFormat = new Intl.NumberFormat("zh-CN");
let runState = null;
let connection = null;
let busy = false;
let busyLabel = "";
let initialLoaded = false;
let refreshSequence = 0;
let refreshTimer;
let hasSavedPreferences = false;
let lastLogSignature = "";
let demoBackend = null;
let editingScope = false;
let reconnectedForRunId = null;
let inputMode = "pointer";
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
const disclosureAnimations = new WeakMap();
const labelAnimations = new WeakMap();

// The region stays measurable while closing; an interrupted toggle starts from
// its currently rendered height instead of jumping back to the old endpoint.
function setDisclosure(element, open, animate = true) {
  const previous = disclosureAnimations.get(element);
  if (element.dataset.expanded === String(open) && !previous) return;
  const startHeight = element.hidden ? 0 : element.getBoundingClientRect().height;
  const startOpacity = element.hidden ? 0 : Number(getComputedStyle(element).opacity);
  previous?.cancel();
  element.dataset.expanded = String(open);
  element.inert = !open;
  element.setAttribute("aria-hidden", String(!open));
  if (!animate || inputMode === "keyboard" || reducedMotion.matches || typeof element.animate !== "function") {
    element.hidden = !open;
    delete element.dataset.animating;
    disclosureAnimations.delete(element);
    return;
  }
  element.hidden = false;
  element.dataset.animating = "true";
  const endHeight = open ? element.scrollHeight : 0;
  const animation = element.animate(
    [{ height: `${startHeight}px`, opacity: startOpacity }, { height: `${endHeight}px`, opacity: open ? 1 : 0 }],
    { duration: open ? 220 : 180, easing: "cubic-bezier(0.23, 1, 0.32, 1)" }
  );
  disclosureAnimations.set(element, animation);
  animation.finished.then(() => {
    if (disclosureAnimations.get(element) !== animation) return;
    element.hidden = !open;
    delete element.dataset.animating;
    disclosureAnimations.delete(element);
  }).catch(() => {});
}

function updateLabel(element, text) {
  if (element.textContent === text) return;
  labelAnimations.get(element)?.cancel();
  element.textContent = text;
  if (!initialLoaded || inputMode === "keyboard" || typeof element.animate !== "function") return;
  const animation = element.animate([{ opacity: .55 }, { opacity: 1 }], { duration: reducedMotion.matches ? 100 : 160, easing: "cubic-bezier(0.23, 1, 0.32, 1)" });
  labelAnimations.set(element, animation);
  animation.finished.then(() => { if (labelAnimations.get(element) === animation) labelAnimations.delete(element); }).catch(() => {});
}

function scheduleRefresh() { clearTimeout(refreshTimer); refreshTimer = setTimeout(refresh, 70); }
if (isDemo) { $("demo-banner").hidden = false; demoBackend = createDemoBackend(scheduleRefresh); }

async function send(message) {
  if (isDemo) return demoBackend.send(message);
  if (!globalThis.chrome?.runtime?.id) throw new Error("扩展连接已失效，请点击浏览器图标重新打开。");
  const result = await chrome.runtime.sendMessage(message);
  if (!result) throw new Error("扩展服务没有响应，请点击浏览器图标重新打开。");
  return result;
}

function showError(message) { $("error-message").textContent = message || ""; $("error-message").hidden = !message; }
function showNotice(message) { $("notice").textContent = message || ""; $("notice").hidden = !message; }
function fieldError(message) {
  $("boundary-error").textContent = message || "";
  $("boundary-error").hidden = !message;
  $("boundary-input").setAttribute("aria-invalid", message ? "true" : "false");
}
function selectedScope() { return document.querySelector('input[name="scope"]:checked')?.value || "all"; }
function selectedDirection() { return document.querySelector('input[name="direction"]:checked')?.value || "newer"; }
function currentOptions(dryRun = false) {
  return { mode: selectedScope() === "all" ? "all" : selectedDirection(), boundary: $("boundary-input").value.trim().replace(/^@/, ""), dryRun };
}
function applyOptions(options = {}) {
  const custom = ["newer", "older"].includes(options.mode);
  document.querySelector(`input[name="scope"][value="${custom ? "custom" : "all"}"]`).checked = true;
  $("boundary-input").value = typeof options.boundary === "string" ? options.boundary.replace(/^@/, "") : "";
  document.querySelector(`input[name="direction"][value="${options.mode === "older" ? "older" : "newer"}"]`).checked = true;
  renderScope();
}
function renderScope() {
  const custom = selectedScope() === "custom";
  $("scope-switch").dataset.custom = String(custom);
  setDisclosure($("boundary-region"), custom, initialLoaded);
  const direction = selectedDirection();
  $("direction-switch").dataset.direction = direction;
  $("boundary-hint").textContent = direction === "older" ? "包含该账号，清理列表中它下方的关注。" : "包含该账号，清理列表中它上方的关注。";
  $("boundary-input").required = custom;
  if (!custom) fieldError("");
  renderScopeSummary();
}
function renderScopeSummary() {
  const active = activePhases.has(runState?.phase);
  const options = active ? (runState.options || {}) : currentOptions();
  const boundary = ownerHandle(options.boundary);
  $("scope-summary-value").textContent = options.mode === "all" ? "全部关注" : `@${boundary} → ${options.mode === "older" ? "较早" : "较新"}的关注（含起点）`;
  $("scope-summary").hidden = !runState;
  $("edit-scope-button").hidden = active;
  $("edit-scope-button").textContent = editingScope ? "收起设置" : "修改范围";
  $("edit-scope-button").disabled = busy;
  $("scope-fields").hidden = Boolean(runState) && (!editingScope || active);
}
function savePreferences() {
  const { mode, boundary } = currentOptions();
  if (isDemo) {
    try { localStorage.setItem(preferenceKey, JSON.stringify({ mode, boundary })); hasSavedPreferences = true; }
    catch { /* The preview remains usable without local storage. */ }
    return;
  }
  // Send now so closing the popup cannot strand a queued draft. The background
  // serializes writes in message order and owns the persistent copy.
  void send({ type: "APP/SETTINGS", settings: { mode, boundary } }).then(result => {
    if (!result.ok) throw new Error(result.error || "范围设置未能保存。");
  }).catch(() => showError("范围设置未能保存，请重新选择后再关闭面板。"));
}
try {
  const saved = isDemo ? JSON.parse(localStorage.getItem(preferenceKey) || "null") : null;
  if (saved && ["all", "newer", "older"].includes(saved.mode)) { applyOptions(saved); hasSavedPreferences = true; }
} catch { /* Fall back to the default scope when local preferences are unavailable. */ }

function safeCount(value) { return Number.isFinite(Number(value)) && Number(value) > 0 ? Math.floor(Number(value)) : 0; }
function ownerHandle(value) { return typeof value === "string" ? value.replace(/^@/, "") : ""; }
function phaseName(state) {
  const labels = { scanning: "正在检查关注", cleaning: "正在清理未回关", paused: "已暂停", stopped: "已停止", completed: state?.options?.dryRun ? "检查完成" : "清理完成", error: "需要处理" };
  return labels[state?.phase] || "准备就绪";
}
function renderLogs() {
  const logs = Array.isArray(runState?.logs) ? runState.logs : [];
  const signature = `${runState?.runId || ""}:${logs.length}:${runState?.updatedAt || ""}`;
  if (signature === lastLogSignature) return;
  lastLogSignature = signature;
  $("log-count").textContent = `${numberFormat.format(logs.length)} 条`;
  const fragment = document.createDocumentFragment();
  const names = { kept: "已保留", keep: "已保留", eligible: "待清理", candidate: "待清理", removed: "已清理", unfollowed: "已清理", unconfirmed: "待确认", skipped: "已跳过", error: "未完成", scanned: "已检查" };
  for (const entry of logs.slice(-100).reverse()) {
    const li = document.createElement("li");
    const row = document.createElement("div"); row.className = "log-row";
    const time = document.createElement("span"); time.className = "log-time";
    const date = new Date(entry.at);
    time.textContent = Number.isNaN(date.getTime()) ? "—" : date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
    const handle = document.createElement("span"); handle.className = "log-person"; handle.textContent = entry.handle ? `@${ownerHandle(entry.handle)}` : "任务记录";
    const action = document.createElement("span"); action.className = "log-action"; action.textContent = names[entry.action] || "记录";
    row.append(time, handle, action); li.append(row);
    if (entry.message) { const body = document.createElement("p"); body.className = "log-body"; body.textContent = entry.message; li.append(body); }
    fragment.append(li);
  }
  if (!logs.length) { const empty = document.createElement("li"); empty.textContent = "处理结果会显示在这里。"; fragment.append(empty); }
  $("log-list").replaceChildren(fragment);
}

function render() {
  const phase = runState?.phase || "idle";
  const active = activePhases.has(phase);
  const connected = Boolean(connection?.handle);
  const needsReconnect = phase === "error" && reconnectedForRunId !== runState.runId;
  app.dataset.phase = phase;
  app.dataset.hasRun = String(Boolean(runState));
  app.dataset.connected = String(connected);
  $("account-name").textContent = connected ? `@${ownerHandle(connection.handle)}` : "尚未连接 X";
  $("account-note").textContent = connected ? (isDemo ? "预览账号" : "已连接") : "使用浏览器中已登录的账号";
  $("connect-button").textContent = connected ? "重新连接" : "连接";
  $("connect-button").disabled = busy || active;
  $("focus-x-button").hidden = !connected;
  $("scope-fields").disabled = busy || active || !initialLoaded;
  $("check-button").disabled = busy || needsReconnect || !connected || !initialLoaded;
  $("check-button").hidden = active;
  $("stop-button").hidden = !active;
  $("stop-button").disabled = busy;
  $("stop-button").textContent = runState?.options?.dryRun ? "停止本次检查" : "停止本次清理";
  $("primary-button").disabled = busy || (!active && !needsReconnect && (!connected || !initialLoaded));
  $("primary-button").dataset.busy = String(busy);
  updateLabel($("primary-label"), busy ? busyLabel : needsReconnect ? "重新连接 X" : phase === "error" ? "重试清理" : phase === "paused" ? "继续" : active ? "暂停" : "清理未回关");
  $("primary-icon").toggleAttribute("hidden", active || phase === "error");
  $("progress-panel").hidden = !runState;
  $("footer-text").textContent = active ? "面板可关闭，请保留 X 工作页" : "记录仅保存在本机";
  renderScopeSummary();
  if (runState) {
    updateLabel($("phase-name"), phaseName(runState));
    $("run-message").textContent = runState.message || "";
    $("run-kind").textContent = runState.options?.dryRun ? "仅检查" : "清理任务";
    $("run-kind").hidden = phase === "completed" && !runState.options?.dryRun;
    const counters = runState.counters || {};
    $("count-scanned").textContent = numberFormat.format(safeCount(counters.scanned));
    $("count-kept").textContent = numberFormat.format(safeCount(counters.kept));
    $("count-removed").textContent = numberFormat.format(safeCount(runState.options?.dryRun ? counters.eligible : counters.removed));
    $("removed-label").textContent = runState.options?.dryRun ? "待清理" : "已清理";
    const unconfirmed = safeCount(counters.unconfirmed);
    $("unconfirmed-note").hidden = !unconfirmed;
    $("unconfirmed-note").textContent = `${numberFormat.format(unconfirmed)} 个账号的取关结果未确认，请查看 X 页面。`;
    renderLogs();
  }
}

async function refresh() {
  const request = ++refreshSequence;
  try {
    const result = await send({ type: "APP/STATE" });
    if (request !== refreshSequence) return;
    if (!result.ok) throw new Error(result.error || "无法读取当前状态。");
    const oldRunId = runState?.runId;
    runState = result.state || null;
    connection = result.connection || null;
    if (oldRunId !== runState?.runId) { editingScope = false; reconnectedForRunId = null; }
    if (!initialLoaded && !hasSavedPreferences) applyOptions(result.settings || {});
    if (runState && activePhases.has(runState.phase) && (!initialLoaded || oldRunId !== runState.runId)) applyOptions(runState.options || {});
    initialLoaded = true;
    render();
  } catch (error) { if (request === refreshSequence) { showError(error.message || "无法连接扩展服务。"); render(); } }
}

async function perform(label, operation) {
  if (busy) return;
  busy = true; busyLabel = label; showError(""); showNotice(""); render();
  try { await operation(); }
  catch (error) { showError(error.message || "操作没有完成，请稍后再试。"); }
  finally { busy = false; busyLabel = ""; await refresh(); render(); }
}
async function control(command) {
  if (busy || !runState || !activePhases.has(runState.phase)) return;
  await perform(command === "pause" ? "正在暂停…" : command === "resume" ? "正在继续…" : "正在停止…", async () => {
    const result = await send({ type: "APP/CONTROL", command });
    if (!result.ok) throw new Error(result.error || "任务状态未能更新。");
    if (result.message) showNotice(result.message);
  });
}
async function start(dryRun = false) {
  if (busy) return;
  if (activePhases.has(runState?.phase)) { showError("已有任务正在进行，请先停止当前任务。"); return; }
  if (runState?.phase === "error" && reconnectedForRunId !== runState.runId) { showError("请先重新连接 X，再重试本次清理。"); return; }
  if (!connection?.handle) { showError("请先连接 X，确认当前账号后再开始。"); return; }
  const options = currentOptions(dryRun);
  fieldError("");
  if (options.mode !== "all" && !/^[A-Za-z0-9_]{1,15}$/.test(options.boundary)) { fieldError("请输入有效用户名，只含字母、数字或下划线。"); $("boundary-input").focus(); return; }
  if (options.mode === "all") options.boundary = "";
  savePreferences();
  await perform(dryRun ? "正在开始检查…" : "正在开始清理…", async () => {
    const result = await send({ type: "APP/START", options, expectedOwner: ownerHandle(connection.handle) });
    if (!result.ok) throw new Error(result.error || "任务未能开始。");
  });
}

$("clean-form").addEventListener("submit", event => {
  event.preventDefault();
  if (busy) return;
  if (runState?.phase === "error" && reconnectedForRunId !== runState.runId) void connectAccount();
  else if (runState?.phase === "paused") void control("resume");
  else if (["scanning", "cleaning"].includes(runState?.phase)) void control("pause");
  else void start(false);
});
$("check-button").addEventListener("click", () => void start(true));
$("stop-button").addEventListener("click", () => void control("stop"));
async function connectAccount() {
  if (busy || activePhases.has(runState?.phase)) return;
  await perform("正在连接…", async () => {
    const result = await send({ type: "APP/CONNECT" });
    if (!result.ok) throw new Error(result.error || "连接没有完成。");
    if (result.connection) {
      connection = result.connection;
      if (runState?.phase === "error") reconnectedForRunId = runState.runId;
    }
    if (runState?.phase === "error" && result.connection) showNotice("已重新连接，确认范围后可以重试清理。");
    else if (result.message) showNotice(result.message);
  });
}
$("connect-button").addEventListener("click", () => void connectAccount());
$("edit-scope-button").addEventListener("click", () => {
  if (busy || activePhases.has(runState?.phase)) return;
  editingScope = !editingScope;
  renderScopeSummary();
});
$("focus-x-button").addEventListener("click", async () => {
  try { const result = await send({ type: "APP/FOCUS_X" }); if (!result.ok) throw new Error(result.error || "无法打开 X 页面。"); if (result.message) showNotice(result.message); }
  catch (error) { showError(error.message); }
});
document.querySelectorAll('input[name="scope"]').forEach(input => input.addEventListener("change", () => { renderScope(); savePreferences(); showError(""); }));
document.querySelectorAll('input[name="direction"]').forEach(input => input.addEventListener("change", () => { renderScope(); savePreferences(); }));
$("boundary-input").addEventListener("input", () => { fieldError(""); savePreferences(); });
$("export-button").addEventListener("click", () => {
  if (!runState) return;
  try {
    const report = { exportedAt: new Date().toISOString(), preview: isDemo, runId: runState.runId, owner: runState.owner, options: runState.options, phase: runState.phase, counters: runState.counters, message: runState.message, updatedAt: runState.updatedAt, logs: runState.logs || [] };
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = `x-cleaner-${ownerHandle(runState.owner) || "report"}-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.append(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    showNotice("结果已导出为 JSON 文件。");
  } catch { showError("导出失败，请稍后重试。"); }
});

document.addEventListener("pointerdown", () => { inputMode = "pointer"; app.dataset.input = inputMode; }, { passive: true });
document.addEventListener("keydown", () => { inputMode = "keyboard"; app.dataset.input = inputMode; });
reducedMotion.addEventListener("change", () => { if (reducedMotion.matches) setDisclosure($("boundary-region"), selectedScope() === "custom", false); });
if (!isDemo && globalThis.chrome?.storage?.onChanged) chrome.storage.onChanged.addListener(scheduleRefresh);
window.addEventListener("focus", scheduleRefresh);
document.addEventListener("visibilitychange", () => { if (!document.hidden) scheduleRefresh(); });
window.addEventListener("pagehide", () => { clearTimeout(refreshTimer); demoBackend?.dispose(); });
renderScope(); render(); void refresh();
