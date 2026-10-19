import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {webcrypto} from 'node:crypto';

const coreSource = await readFile(new URL('../extension/core.js', import.meta.url), 'utf8');
const source = (await readFile(new URL('../extension/background.js', import.meta.url), 'utf8')).replace("import './core.js';", '');
const event = () => ({listeners: [], addListener(fn) { this.listeners.push(fn); }});
const settle = () => new Promise(resolve => setImmediate(resolve));

function harness({owner = 'owner', stored = {}, nextOwner = owner} = {}) {
  const data = structuredClone(stored), session = {};
  const tabs = new Map([[1, {id: 1, windowId: 9, url: 'https://x.com/home', status: 'complete', active: true}]]);
  const runs = new Map(), sent = [], created = [];
  let nextId = 10;
  const storage = target => ({
    async get(keys) {
      const list = typeof keys === 'string' ? [keys] : keys || Object.keys(target);
      return structuredClone(Object.fromEntries(list.filter(key => key in target).map(key => [key, target[key]])));
    },
    async set(values) { Object.assign(target, structuredClone(values)); }
  });
  const chrome = {
    runtime: {id: 'test-extension', getURL: value => `chrome-extension://test-extension/${value}`, onMessage: event(), onStartup: event(), onInstalled: event()},
    storage: {local: storage(data), session: storage(session)},
    scripting: {async executeScript() {}},
    windows: {
      async get() { return {id: 9, type: 'normal'}; },
      async update(id, options) { return {id, ...options}; },
      async create(options) { created.push(options); return {id: 99}; }
    },
    action: {onClicked: event()},
    tabs: {
      onRemoved: event(), onUpdated: event(),
      async query() { return [...tabs.values()]; },
      async get(id) { if (!tabs.has(id)) throw new Error('No tab'); return tabs.get(id); },
      async create(options) {
        const tab = {id: nextId++, windowId: 9, status: 'complete', ...options};
        tabs.set(tab.id, tab); created.push(options); return tab;
      },
      async update(id, options) { Object.assign(tabs.get(id), options); return tabs.get(id); },
      async sendMessage(tabId, message) {
        if (!tabs.has(tabId)) throw new Error('No tab');
        sent.push({tabId, ...message});
        if (message.type === 'XC/PROBE') return {ok: true, account: {handle: tabId === 1 ? owner : nextOwner}, followingPage: tabs.get(tabId).url.endsWith('/following')};
        if (message.type === 'XC/STATUS') return {ok: true, live: runs.has(tabId), state: runs.get(tabId) || null};
        if (message.type === 'XC/START') {
          const state = {...data.runState, preparing: false};
          data.runState = state; runs.set(tabId, state); return {ok: true};
        }
        if (/XC\/(STOP|PAUSE|RESUME)/.test(message.type)) {
          const state = runs.get(tabId);
          if (!state) return {ok: false, error: 'No active runner'};
          state.phase = ({'XC/STOP': 'stopped', 'XC/PAUSE': 'paused', 'XC/RESUME': 'cleaning'})[message.type];
          data.runState = structuredClone(state);
          if (message.type === 'XC/STOP') runs.delete(tabId);
          return {ok: true};
        }
      }
    }
  };
  const context = vm.createContext({chrome, URL, crypto: webcrypto, console, setTimeout, Date});
  vm.runInContext(coreSource, context);
  vm.runInContext(source, context);
  const appSender = {id: chrome.runtime.id, url: chrome.runtime.getURL('window.html')};
  const request = (message, sender = appSender) => new Promise(resolve => {
    const async = chrome.runtime.onMessage.listeners[0](message, sender, resolve);
    if (!async && !message.type.startsWith('APP/')) resolve(undefined);
  });
  return {chrome, request, data, tabs, runs, sent, created};
}

const startMessage = (extra = {}) => ({type: 'APP/START', expectedOwner: 'owner', options: {mode: 'all', boundary: '', dryRun: false}, ...extra});

test('the toolbar uses a native popup and has no independent-window click handler', async () => {
  const manifest = JSON.parse(await readFile(new URL('../extension/manifest.json', import.meta.url), 'utf8'));
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(manifest.version, pkg.version);
  assert.equal(manifest.action.default_popup, 'window.html');
  const h = harness();
  assert.equal(h.chrome.action.onClicked.listeners.length, 0);
  assert.equal(h.created.length, 0);
});

test('range settings save before a task starts and restore in a new popup', async () => {
  const h = harness();
  const settings = {mode: 'older', boundary: '@draft_'};
  const saved = await h.request({type: 'APP/SETTINGS', settings});
  assert.equal(saved.ok, true);
  assert.deepEqual(structuredClone(saved.settings), settings);
  const state = await h.request({type: 'APP/STATE'}, {id: 'test-extension', url: 'chrome-extension://test-extension/window.html', documentId: 'new-popup-document'});
  assert.deepEqual(structuredClone(state.settings), settings);
  assert.equal(state.state, null);
  assert.equal(h.sent.length, 0);
  assert.equal(h.created.length, 0);
});

test('unfinished range drafts are retained while START still rejects them', async () => {
  const h = harness({stored: {connection: {handle: 'owner', tabId: 1}}});
  assert.equal((await h.request({type: 'APP/SETTINGS', settings: {mode: 'newer', boundary: '@'}})).ok, true);
  assert.equal((await h.request(startMessage({options: {...h.data.settings, dryRun: false}}))).ok, false);
  assert.equal(h.data.settings.boundary, '@');
  assert.equal(h.created.length, 0);
});

test('rapid popup draft messages persist in receipt order even when storage is delayed', async () => {
  const h = harness();
  const original = h.chrome.storage.local.set;
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const waiting = new Promise(resolve => { entered = resolve; });
  const writes = [];
  h.chrome.storage.local.set = async values => {
    if (values.settings) {
      writes.push(values.settings.boundary);
      if (values.settings.boundary === 'first') { entered(); await gate; }
    }
    return original(values);
  };
  const first = h.request({type: 'APP/SETTINGS', settings: {mode: 'newer', boundary: 'first'}});
  await waiting;
  const last = h.request({type: 'APP/SETTINGS', settings: {mode: 'older', boundary: 'last'}});
  let reopenedReady = false;
  const reopened = h.request({type: 'APP/STATE'}).then(value => { reopenedReady = true; return value; });
  await settle();
  assert.deepEqual(writes, ['first']);
  assert.equal(reopenedReady, false);
  release();
  assert.equal((await first).ok, true);
  assert.equal((await last).ok, true);
  assert.deepEqual(writes, ['first', 'last']);
  assert.deepEqual(h.data.settings, {mode: 'older', boundary: 'last'});
  assert.deepEqual(structuredClone((await reopened).settings), {mode: 'older', boundary: 'last'});
});

test('settings messages validate their complete schema and sender', async () => {
  const h = harness({stored: {settings: {mode: 'all', boundary: ''}}});
  for (const settings of [null, [], {mode: 'anything', boundary: ''}, {mode: 'all'}, {mode: 'all', boundary: 123}, {mode: 'all', boundary: 'a'.repeat(121)}, {mode: 'all', boundary: 'abc\n'}, {mode: 'all', boundary: 'abc\u202e'}, {mode: 'all', boundary: '', dryRun: false}]) {
    assert.equal((await h.request({type: 'APP/SETTINGS', settings})).ok, false);
  }
  const wrongSender = {id: 'test-extension', url: 'https://x.com/window.html'};
  assert.equal((await h.request({type: 'APP/SETTINGS', settings: {mode: 'older', boundary: 'valid'}}, wrongSender)).ok, false);
  assert.deepEqual(h.data.settings, {mode: 'all', boundary: ''});
});

test('reopening a popup restores the same live task without starting another one', async () => {
  const h = harness({stored: {connection: {handle: 'owner', tabId: 1}}});
  await h.request(startMessage({options: {mode: 'older', boundary: 'boundary', dryRun: true}}));
  const originalId = h.data.runState.runId;
  h.data.runState.counters.scanned = 18;
  const reopened = await h.request({type: 'APP/STATE'}, {id: 'test-extension', url: 'chrome-extension://test-extension/window.html', documentId: 'reopened'});
  assert.equal(reopened.state.runId, originalId);
  assert.equal(reopened.state.counters.scanned, 18);
  assert.equal(reopened.state.phase, 'scanning');
  assert.deepEqual(structuredClone(reopened.settings), {mode: 'older', boundary: 'boundary'});
  assert.equal(h.sent.filter(message => message.type === 'XC/START').length, 1);
  assert.equal(h.created.length, 1);
  assert.equal(h.created[0].active, true);
});

test('reopening after worker loss reports interruption without resuming actions', async () => {
  const h = harness({stored: {connection: {handle: 'owner', tabId: 1}}});
  await h.request(startMessage());
  const originalId = h.data.runState.runId;
  h.data.runState.counters.removed = 2;
  h.runs.clear();
  const reopened = await h.request({type: 'APP/STATE'});
  assert.equal(reopened.state.runId, originalId);
  assert.equal(reopened.state.phase, 'stopped');
  assert.equal(reopened.state.counters.removed, 2);
  assert.equal(h.sent.filter(message => message.type === 'XC/START').length, 1);
});

test('the controller rejects content-page requests even when the extension ID matches', async () => {
  const h = harness();
  for (const url of ['https://x.com/window.html', 'chrome-extension://another/window.html', 'file:///window.html']) {
    const reply = await h.request(startMessage(), {id: 'test-extension', url});
    assert.equal(reply.ok, false);
    assert.match(reply.error, /来源/);
  }
  assert.equal(h.created.length, 0);
});

test('connect identifies the account without starting a cleanup', async () => {
  const h = harness();
  const reply = await h.request({type: 'APP/CONNECT'});
  assert.equal(reply.connection.handle, 'owner');
  assert.equal(h.sent.some(message => message.type === 'XC/START'), false);
  const state = await h.request({type: 'APP/STATE'});
  assert.equal(state.state, null);
});

test('a start creates its own work tab and keeps the requested range and dry-run flag', async () => {
  const h = harness({stored: {connection: {handle: 'owner', tabId: 1}}});
  const reply = await h.request(startMessage({options: {mode: 'older', boundary: '@Boundary', dryRun: true}}));
  assert.equal(reply.ok, true);
  assert.equal(h.tabs.get(1).url, 'https://x.com/home');
  assert.equal(h.created[0].url, 'https://x.com/owner/following');
  assert.deepEqual(structuredClone(h.sent.find(message => message.type === 'XC/START').options), {mode: 'older', boundary: 'boundary', dryRun: true});
  assert.equal(h.data.runState.preparing, false);
});

test('a missing boundary is rejected before opening a work tab', async () => {
  const h = harness({stored: {connection: {handle: 'owner', tabId: 1}}});
  const reply = await h.request(startMessage({options: {mode: 'newer', boundary: '', dryRun: false}}));
  assert.equal(reply.ok, false);
  assert.equal(h.created.length, 0);
});

test('an account change between connecting and starting is blocked', async () => {
  const h = harness({owner: 'someone_else', stored: {connection: {handle: 'owner', tabId: 1}}});
  const reply = await h.request(startMessage());
  assert.equal(reply.ok, false);
  assert.equal(h.data.connection, null);
  assert.equal(h.sent.some(message => message.type === 'XC/START'), false);
});

test('an account change in the new work tab is also blocked', async () => {
  const h = harness({nextOwner: 'other', stored: {connection: {handle: 'owner', tabId: 1}}});
  const reply = await h.request(startMessage());
  assert.equal(reply.ok, false);
  assert.equal(h.data.runState.phase, 'stopped');
  assert.equal(h.sent.some(message => message.type === 'XC/START'), false);
});

test('simultaneous clicks and a second popup cannot start duplicate jobs', async () => {
  const h = harness({stored: {connection: {handle: 'owner', tabId: 1}}});
  const replies = await Promise.all([h.request(startMessage()), h.request(startMessage())]);
  assert.equal(replies.filter(reply => reply.ok).length, 1);
  assert.equal(h.sent.filter(message => message.type === 'XC/START').length, 1);
  assert.equal((await h.request(startMessage())).ok, false);
});

test('pause and resume target only the live run, and a lost run cannot restart itself', async () => {
  const h = harness({stored: {connection: {handle: 'owner', tabId: 1}}});
  await h.request(startMessage());
  assert.equal((await h.request({type: 'APP/CONTROL', command: 'pause'})).ok, true);
  assert.equal(h.data.runState.phase, 'paused');
  assert.equal((await h.request({type: 'APP/CONTROL', command: 'resume'})).ok, true);
  h.runs.clear();
  assert.equal((await h.request({type: 'APP/CONTROL', command: 'resume'})).ok, false);
  assert.equal(h.data.runState.phase, 'stopped');
  assert.equal(h.sent.filter(message => message.type === 'XC/START').length, 1);
});

test('closing the work tab preserves counts but stops further work', async () => {
  const h = harness({stored: {connection: {handle: 'owner', tabId: 1}}});
  await h.request(startMessage());
  const tabId = h.data.runState.tabId;
  h.data.runState.counters.removed = 3;
  h.tabs.delete(tabId);
  h.chrome.tabs.onRemoved.listeners[0](tabId);
  await settle();
  assert.equal(h.data.runState.phase, 'stopped');
  assert.equal(h.data.runState.counters.removed, 3);
  assert.equal(h.data.connection, null);
});

test('a browser restart does not continue a previously running task', async () => {
  const h = harness({stored: {connection: {handle: 'owner', tabId: 1}, runState: {runId: 'old', phase: 'cleaning', counters: {removed: 2}, logs: []}}});
  h.chrome.runtime.onStartup.listeners[0]();
  await settle();
  assert.equal(h.data.runState.phase, 'stopped');
  assert.equal(h.data.runState.counters.removed, 2);
  assert.equal(h.sent.length, 0);
});

test('a destroyed page with an in-flight confirmation is reported as unconfirmed', async () => {
  const h = harness({stored: {runState: {runId: 'old', phase: 'cleaning', counters: {removed: 2, unconfirmed: 0}, logs: [], inFlight: {handle: 'pending', confirmationSent: true}}}});
  h.chrome.runtime.onStartup.listeners[0]();
  await settle();
  assert.equal(h.data.runState.counters.removed, 2);
  assert.equal(h.data.runState.counters.unconfirmed, 1);
  assert.equal(h.data.runState.inFlight, undefined);
  assert.match(h.data.runState.message, /pending/);
});

test('stopping during the final preparation write prevents START from being sent', async () => {
  const h = harness({stored: {connection: {handle: 'owner', tabId: 1}}});
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const waiting = new Promise(resolve => { entered = resolve; });
  const original = h.chrome.storage.local.set;
  h.chrome.storage.local.set = async values => {
    if (values.connection?.tabId === 10) { entered(); await gate; }
    return original(values);
  };
  const start = h.request(startMessage());
  await waiting;
  assert.equal((await h.request({type: 'APP/CONTROL', command: 'stop'})).ok, true);
  release();
  assert.equal((await start).ok, false);
  assert.equal(h.data.runState.phase, 'stopped');
  assert.equal(h.sent.filter(message => message.type === 'XC/START').length, 0);
});

test('a stopped-looking task that is still settling blocks a new run', async () => {
  const h = harness({stored: {connection: {handle: 'owner', tabId: 1}, runState: {runId: 'old', tabId: 1, phase: 'stopped'}}});
  h.runs.set(1, h.data.runState);
  assert.equal((await h.request(startMessage())).ok, false);
  assert.equal(h.created.length, 0);
});

test('a new work tab may briefly be about:blank while its X navigation commits', async () => {
  const h = harness({stored: {connection: {handle: 'owner', tabId: 1}}});
  const original = h.chrome.tabs.get;
  let pending = true;
  h.chrome.tabs.get = async id => {
    const tab = await original(id);
    if (id === 10 && pending) { pending = false; return {...tab, status: 'loading', url: 'about:blank', pendingUrl: tab.url}; }
    return tab;
  };
  const reply = await h.request(startMessage());
  assert.equal(reply.ok, true);
  assert.equal(h.sent.filter(message => message.type === 'XC/START').length, 1);
});

test('navigation revokes the task before awaiting an unloading page response', async () => {
  const h = harness({stored: {connection: {handle: 'owner', tabId: 1}}});
  await h.request(startMessage());
  const original = h.chrome.tabs.sendMessage;
  h.chrome.tabs.sendMessage = (id, message) => message.type === 'XC/STOP' ? new Promise(() => {}) : original(id, message);
  h.chrome.tabs.onUpdated.listeners[0](h.data.runState.tabId, {status: 'loading'});
  await settle();
  assert.equal(h.data.runState.phase, 'stopped');
});
