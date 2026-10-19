import './core.js';

const Core = globalThis.XCleanerCore;
const ACTIVE = new Set(['scanning', 'cleaning', 'paused']);
const X_URLS = ['https://x.com/*', 'https://www.x.com/*'];
const WINDOW_URL = chrome.runtime.getURL('window.html');
let starting = false;
let preparation = null;
let settingsQueue = Promise.resolve();

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const read = keys => chrome.storage.local.get(keys);
const write = value => chrome.storage.local.set(value);
const errorText = error => error instanceof Error ? error.message : String(error);

function isXUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && ['x.com', 'www.x.com'].includes(url.hostname);
  } catch { return false; }
}

function isAppSender(sender) {
  if (sender.id !== chrome.runtime.id || !sender.url) return false;
  try {
    const url = new URL(sender.url);
    const expected = new URL(WINDOW_URL);
    return url.protocol === expected.protocol && url.host === expected.host && url.pathname === expected.pathname;
  } catch { return false; }
}

async function send(tabId, message) {
  return chrome.tabs.sendMessage(tabId, message, {frameId: 0});
}

async function probe(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (!isXUrl(tab.url) || tab.incognito) throw new Error('请连接普通浏览窗口中已登录的 X 页面。');
  try {
    return await send(tabId, {type: 'XC/PROBE'});
  } catch {
    // Already-open pages may predate installation. Both scripts are idempotent.
    await chrome.scripting.executeScript({target: {tabId}, files: ['core.js', 'runner.js']});
    return send(tabId, {type: 'XC/PROBE'});
  }
}

function connectionFrom(result, tabId) {
  const handle = Core.normalizeHandle(result?.account?.handle);
  if (!result?.ok || !handle) return null;
  return {handle, name: String(result.account.name || handle).slice(0, 100), tabId};
}

async function markStopped(runId, message) {
  const {runState} = await read('runState');
  if (runState?.runId !== runId || !ACTIVE.has(runState.phase)) return;
  const now = Date.now();
  const logs = [...(runState.logs || [])];
  const counters = {...runState.counters};
  if (runState.inFlight?.confirmationSent) {
    counters.unconfirmed = (counters.unconfirmed || 0) + 1;
    const handle = runState.inFlight.handle;
    message += ` @${handle} 的取关结果待核对。`;
    logs.push({at: now, handle, action: 'unconfirmed', message: '工作页面在核对结果前中断，不能确认取关是否完成。'});
  }
  const next = {
    ...runState, phase: 'stopped', preparing: false, message, updatedAt: now,
    counters, logs: [...logs, {at: now, handle: '', action: 'stopped', message}].slice(-500)
  };
  delete next.inFlight;
  await write({runState: next});
}

async function reconcile() {
  const {runState} = await read('runState');
  if (!runState || !ACTIVE.has(runState.phase) || starting) return;
  if (runState.preparing) {
    await markStopped(runState.runId, '上次准备过程已中断，请重新开始。');
    return;
  }
  try {
    const response = await send(runState.tabId, {type: 'XC/STATUS'});
    const liveRun = response?.state || response?.runState || response;
    if (response?.live === false || liveRun?.runId !== runState.runId) {
      await markStopped(runState.runId, '工作页面已刷新或运行已中断，请重新开始。');
    }
  } catch {
    await markStopped(runState.runId, '工作页面已关闭或失去连接，请重新开始。');
  }
}

async function appState() {
  // Each native popup is a new document. Its first read also validates the worker.
  await settingsQueue.catch(() => {});
  await reconcile();
  const {runState, connection, settings} = await read(['runState', 'connection', 'settings']);
  return {
    ok: true, state: runState || null, connection: connection || null,
    settings: settings || {mode: 'all', boundary: ''}
  };
}

function validateSettings(settings) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('范围设置无效。');
  if (Object.keys(settings).some(key => !['mode', 'boundary'].includes(key))) throw new Error('范围设置包含不支持的字段。');
  if (!['all', 'newer', 'older'].includes(settings.mode)) throw new Error('范围选项无效。');
  if (typeof settings.boundary !== 'string' || settings.boundary.length > 120 || /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(settings.boundary)) throw new Error('账号输入格式无效。');
  // Preserve an unfinished input as a draft. START still validates a complete ID.
  return {mode: settings.mode, boundary: settings.boundary};
}

async function saveSettings(settings) {
  const next = validateSettings(settings);
  const saved = settingsQueue.catch(() => {}).then(() => write({settings: next}));
  settingsQueue = saved;
  await saved;
  return {ok: true, settings: next};
}

async function connect() {
  await reconcile();
  const {runState, connection} = await read(['runState', 'connection']);
  if (ACTIVE.has(runState?.phase)) {
    return {ok: true, connection, message: '清理运行中，继续使用当前账号。'};
  }
  const tabs = await chrome.tabs.query({url: X_URLS});
  tabs.sort((a, b) => Number(b.active) - Number(a.active) || (b.lastAccessed || 0) - (a.lastAccessed || 0));
  for (const tab of tabs) {
    try {
      const next = connectionFrom(await probe(tab.id), tab.id);
      if (next) {
        await write({connection: next});
        return {ok: true, connection: next};
      }
    } catch { /* Another X tab may still have a ready account. */ }
  }
  await write({connection: null});
  if (tabs.length) {
    await focusTab(tabs[0].id);
  } else {
    await chrome.tabs.create({url: 'https://x.com/home', active: true});
  }
  return {ok: true, connection: null, message: '请在 X 页面登录，加载完成后回到这里点击连接。'};
}

async function focusTab(tabId) {
  const tab = await chrome.tabs.get(tabId);
  await chrome.tabs.update(tabId, {active: true});
  await chrome.windows.update(tab.windowId, {focused: true});
}

async function ensureReservation(runId) {
  if (preparation?.runId === runId && preparation.cancelled) throw new Error('准备已停止。');
  const {runState} = await read('runState');
  if ((preparation?.runId === runId && preparation.cancelled) || runState?.runId !== runId || !ACTIVE.has(runState.phase)) {
    throw new Error('准备已停止。');
  }
  return runState;
}

async function waitForOwner(tabId, owner, runId) {
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    await ensureReservation(runId);
    const tab = await chrome.tabs.get(tabId);
    const destination = tab.pendingUrl || tab.url;
    // tabs.create may initially report about:blank before committing its URL.
    if (destination && destination !== 'about:blank' && !isXUrl(destination)) throw new Error('工作页面已离开 X，已停止。');
    if (tab.status === 'complete' && isXUrl(tab.url)) {
      let result;
      try { result = await probe(tabId); } catch { /* The content script may be mounting. */ }
      const next = connectionFrom(result, tabId);
      if (next) {
        if (next.handle.toLowerCase() !== owner.toLowerCase()) throw new Error('登录账号发生变化，请重新连接账号。');
        if (result.followingPage) return next;
      }
    }
    await delay(600);
  }
  throw new Error('X 关注列表未能加载，请检查页面后重试。');
}

async function start(message) {
  if (starting) throw new Error('正在准备，请勿重复开始。');
  starting = true;
  let runId;
  try {
    const options = Core.validateOptions(message.options);
    await settingsQueue.catch(() => {});
    const {runState, connection} = await read(['runState', 'connection']);
    if (ACTIVE.has(runState?.phase)) throw new Error('已有任务运行中，请先停止当前任务。');
    if (Number.isInteger(runState?.tabId)) {
      let status;
      try { status = await send(runState.tabId, {type: 'XC/STATUS'}); } catch { /* A closed document cannot keep running. */ }
      if (status?.live) throw new Error('上一个任务正在收尾，请稍后再开始。');
    }
    const owner = Core.normalizeHandle(message.expectedOwner);
    if (!owner || connection?.handle?.toLowerCase() !== owner.toLowerCase()) throw new Error('请先连接并确认当前 X 账号。');
    const current = connectionFrom(await probe(connection.tabId), connection.tabId);
    if (!current || current.handle.toLowerCase() !== owner.toLowerCase()) {
      await write({connection: null});
      throw new Error('X 登录账号已改变，请重新连接。');
    }
    runId = crypto.randomUUID();
    preparation = {runId, cancelled: false, tabId: null};
    const initial = {
      runId, owner, tabId: null, options, phase: 'scanning', preparing: true,
      counters: {scanned: 0, eligible: 0, kept: 0, removed: 0, unconfirmed: 0},
      message: '正在打开你的关注列表…', updatedAt: Date.now(), logs: []
    };
    await write({runState: initial, settings: {mode: options.mode, boundary: options.boundary || ''}});
    await ensureReservation(runId);
    // The native toolbar popup closes when this tab is activated. The background
    // prepares the job and the content worker owns it independently of that UI.
    // A dedicated tab also preserves the user's existing reading tab.
    const sourceTab = await chrome.tabs.get(connection.tabId);
    const sourceWindow = await chrome.windows.get(sourceTab.windowId);
    const createOptions = {url: `https://x.com/${owner}/following`, active: true};
    if (sourceWindow.type === 'normal') createOptions.windowId = sourceTab.windowId;
    const workTab = await chrome.tabs.create(createOptions);
    preparation.tabId = workTab.id;
    const reserved = await ensureReservation(runId);
    await write({runState: {...reserved, tabId: workTab.id}});
    const next = await waitForOwner(workTab.id, owner, runId);
    await ensureReservation(runId);
    await write({connection: next});
    await ensureReservation(runId);
    const response = await send(workTab.id, {type: 'XC/START', runId, owner, tabId: workTab.id, options});
    if (preparation.cancelled) {
      await send(workTab.id, {type: 'XC/STOP', runId}).catch(() => {});
      throw new Error('准备已停止。');
    }
    if (!response?.ok) throw new Error(response?.error || '无法启动清理，请重新加载扩展。');
    return {ok: true};
  } catch (error) {
    if (runId) await markStopped(runId, errorText(error));
    throw error;
  } finally { preparation = null; starting = false; }
}

async function control(command) {
  const types = {pause: 'XC/PAUSE', resume: 'XC/RESUME', stop: 'XC/STOP'};
  if (!types[command]) throw new Error('无效的操作。');
  if (command === 'stop' && preparation) preparation.cancelled = true;
  const {runState} = await read('runState');
  if (!runState || !ACTIVE.has(runState.phase)) throw new Error('当前没有运行中的任务。');
  if (runState.preparing) {
    if (command === 'stop') {
      await markStopped(runState.runId, '已停止准备。');
      if (Number.isInteger(runState.tabId)) await send(runState.tabId, {type: 'XC/STOP', runId: runState.runId}).catch(() => {});
      return {ok: true};
    }
    throw new Error('正在打开关注列表，可以停止后重新开始。');
  }
  try {
    const status = await send(runState.tabId, {type: 'XC/STATUS'});
    const liveRun = status?.state || status?.runState || status;
    if (status?.live === false || liveRun?.runId !== runState.runId) throw new Error('原任务已中断，不能继续。');
    const result = await send(runState.tabId, {type: types[command], runId: runState.runId});
    if (!result?.ok) throw new Error(result?.error || '操作未完成。');
    return result;
  } catch (error) {
    await markStopped(runState.runId, errorText(error));
    throw error;
  }
}

async function focusX() {
  const {runState, connection} = await read(['runState', 'connection']);
  const id = ACTIVE.has(runState?.phase) ? runState.tabId : connection?.tabId;
  if (Number.isInteger(id)) {
    try { await focusTab(id); return {ok: true}; } catch { /* Tab was closed. */ }
  }
  await chrome.tabs.create({url: 'https://x.com/home', active: true});
  return {ok: true};
}

async function dispatch(message) {
  switch (message.type) {
    case 'APP/STATE': return appState();
    case 'APP/SETTINGS': return saveSettings(message.settings);
    case 'APP/CONNECT': return connect();
    case 'APP/START': return start(message);
    case 'APP/CONTROL': return control(message.command);
    case 'APP/FOCUS_X': return focusX();
    default: throw new Error('未知操作。');
  }
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (!message?.type?.startsWith('APP/')) return false;
  if (!isAppSender(sender)) { respond({ok: false, error: '请求来源无效。'}); return false; }
  dispatch(message).then(respond, error => respond({ok: false, error: errorText(error)}));
  return true;
});

chrome.tabs.onRemoved.addListener(tabId => {
  void (async () => {
    const {runState, connection} = await read(['runState', 'connection']);
    if (runState?.tabId === tabId) await markStopped(runState.runId, '工作页面已关闭，任务已停止。');
    if (connection?.tabId === tabId) await write({connection: null});
  })().catch(console.error);
});
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status !== 'loading' && !change.url) return;
  void (async () => {
    const {runState} = await read('runState');
    if (runState?.tabId !== tabId || runState.preparing || !ACTIVE.has(runState.phase)) return;
    // Revoke the persisted task first: a document being unloaded may never reply.
    await markStopped(runState.runId, '工作页面已刷新或导航，任务已停止。');
    try { await send(tabId, {type: 'XC/STOP', runId: runState.runId}); } catch { /* Navigation may have destroyed the runner. */ }
  })().catch(console.error);
});

async function stopAfterRestart() {
  const {runState} = await read('runState');
  if (runState) await markStopped(runState.runId, '浏览器或扩展已重启，请重新开始。');
  await write({connection: null});
}
chrome.runtime.onStartup.addListener(() => { void stopAfterRestart().catch(console.error); });
chrome.runtime.onInstalled.addListener(() => { void stopAfterRestart().catch(console.error); });
