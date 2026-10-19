// Loads the actual unpacked extension and opens its native toolbar popup.
// Every X navigation is intercepted with a local fixture in a disposable profile.
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL, fileURLToPath} from 'node:url';
import {xPageFixture} from '../tests/x-page-fixture.mjs';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const {chromium} = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const profile = await mkdtemp(path.join(tmpdir(), 'x-cleaner-qa-'));
const context = await chromium.launchPersistentContext(profile, {
  channel: 'chrome', headless: true, viewport: {width: 1100, height: 750},
  ignoreDefaultArgs: ['--disable-extensions'], args: ['--enable-unsafe-extension-debugging', '--host-resolver-rules=MAP x.com 127.0.0.1,MAP www.x.com 127.0.0.1']
});
const results = [], errors = [], requests = [], layouts = {}, pendingCommands = new Map();
const output = path.join(root, 'output/playwright');
await mkdir(output, {recursive: true});
let worker, cdp, extensionId, currentPopup, sequence = 0;

async function poll(read, accept, message, timeout = 20000) {
  const deadline = Date.now() + timeout;
  let value;
  while (Date.now() < deadline) {
    value = await read();
    if (accept(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 60));
  }
  throw new Error(`${message}: ${JSON.stringify(value)}`);
}
const state = () => worker.evaluate(async () => (await chrome.storage.local.get('runState')).runState || null);
const popupUrl = () => `chrome-extension://${extensionId}/window.html`;
async function popupTargets() {
  const {targetInfos} = await cdp.send('Target.getTargets');
  return targetInfos.filter(target => target.type === 'page' && target.url === popupUrl());
}

// Native action popups are browser UI, absent from Playwright's context.pages().
// A nested CDP session inspects the real popup document without opening a fake tab.
function popupCommand(popup, method, params = {}) {
  const id = ++sequence, key = `${popup.sessionId}:${id}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pendingCommands.delete(key); reject(new Error(`Popup command timed out: ${method}`)); }, 10000);
    pendingCommands.set(key, {resolve, reject, timer});
    cdp.send('Target.sendMessageToTarget', {sessionId: popup.sessionId, message: JSON.stringify({id, method, params})}).catch(error => {
      clearTimeout(timer); pendingCommands.delete(key); reject(error);
    });
  });
}
async function evaluatePopup(popup, expression) {
  const result = await popupCommand(popup, 'Runtime.evaluate', {expression, returnByValue: true, awaitPromise: true, userGesture: true});
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result.value;
}
async function detachPopup(popup) {
  if (popup?.sessionId) {
    await cdp.send('Target.detachFromTarget', {sessionId: popup.sessionId}).catch(() => {});
    popup.sessionId = null;
  }
}
async function closePopup(popup = currentPopup) {
  if (!popup) return;
  await detachPopup(popup);
  await cdp.send('Target.closeTarget', {targetId: popup.targetId}).catch(() => {});
  await poll(popupTargets, targets => !targets.some(target => target.targetId === popup.targetId), 'Popup did not close');
  if (currentPopup === popup) currentPopup = null;
}
async function openPopup() {
  await closePopup();
  for (const target of await popupTargets()) await cdp.send('Target.closeTarget', {targetId: target.targetId});
  const {targetInfos} = await cdp.send('Target.getTargets', {filter: [{type: 'tab', exclude: false}, {exclude: true}]});
  const tab = targetInfos.find(item => item.url.endsWith('/owner/following')) || targetInfos.find(item => item.url.endsWith('/home')) || targetInfos[0];
  assert.ok(tab, 'a browser tab target exists');
  await cdp.send('Extensions.triggerAction', {id: extensionId, targetId: tab.targetId});
  const [target] = await poll(popupTargets, targets => targets.length === 1, 'Native toolbar popup did not open');
  const {sessionId} = await cdp.send('Target.attachToTarget', {targetId: target.targetId, flatten: false});
  currentPopup = {targetId: target.targetId, sessionId};
  await popupCommand(currentPopup, 'Runtime.enable');
  await poll(() => evaluatePopup(currentPopup, `document.readyState === 'complete' && !!document.getElementById('connect-button')`), Boolean, 'Popup document did not load');
  return currentPopup;
}
const click = (popup, id) => evaluatePopup(popup, `document.getElementById(${JSON.stringify(id)}).click(); true`);
const phase = popup => evaluatePopup(popup, `document.getElementById('app').dataset.phase`);
async function screenshot(popup, file) {
  let last = '', stable = 0;
  layouts[file] = await poll(() => evaluatePopup(popup, `({width:innerWidth,height:innerHeight,scrollHeight:document.documentElement.scrollHeight,footerBottom:document.getElementById('footer-text').getBoundingClientRect().bottom})`), layout => {
    const serialized = JSON.stringify(layout);
    stable = serialized === last ? stable + 1 : 0; last = serialized;
    return stable >= 3;
  }, 'Popup layout did not settle', 5000);
  const {data} = await popupCommand(popup, 'Page.captureScreenshot', {format: 'png', captureBeyondViewport: false});
  await writeFile(path.join(output, file), Buffer.from(data, 'base64'));
}
async function startAndReleasePopup(popup, buttonId) {
  // Detach before the actual click: keeping a debugger attached can hold a popup
  // open after it loses focus and would conceal its real production lifecycle.
  await poll(() => evaluatePopup(popup, `!document.getElementById(${JSON.stringify(buttonId)}).disabled`), Boolean, 'Start control is still disabled');
  await evaluatePopup(popup, `setTimeout(() => document.getElementById(${JSON.stringify(buttonId)}).click(), 70); true`);
  await detachPopup(popup);
  await poll(popupTargets, targets => !targets.some(target => target.targetId === popup.targetId), 'Work-tab activation did not dismiss the native popup');
  currentPopup = null;
}

try {
  let followingLoads = 0;
  const smallList = [{handle: 'candidate', id: '101', mutual: false}, {handle: 'friend', id: '102', mutual: true}];
  const longList = Array.from({length: 20}, (_, index) => ({handle: `person_${index}`, id: String(200 + index), mutual: index % 4 !== 0}));
  await context.route('https://**/*', route => {
    const request = route.request(), url = new URL(request.url());
    requests.push(request.url());
    if (['x.com', 'www.x.com'].includes(url.hostname) && request.isNavigationRequest()) {
      const long = url.pathname.endsWith('/following') && ++followingLoads === 1;
      return route.fulfill({contentType: 'text/html', body: xPageFixture({people: long ? longList : smallList, virtual: long})});
    }
    return route.abort();
  });
  const basePage = context.pages()[0];
  cdp = await context.browser().newBrowserCDPSession();
  cdp.on('Target.receivedMessageFromTarget', event => {
    const reply = JSON.parse(event.message), key = `${event.sessionId}:${reply.id}`;
    const pending = pendingCommands.get(key);
    if (pending) {
      clearTimeout(pending.timer); pendingCommands.delete(key);
      if (reply.error) pending.reject(new Error(reply.error.message)); else pending.resolve(reply.result);
    } else if (reply.method === 'Runtime.exceptionThrown') errors.push(reply.params.exceptionDetails.exception?.description || reply.params.exceptionDetails.text);
  });
  ({id: extensionId} = await cdp.send('Extensions.loadUnpacked', {path: path.join(root, 'extension')}));
  worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const manifest = await worker.evaluate(() => chrome.runtime.getManifest());
  assert.equal(manifest.version, '0.1.2');
  assert.equal(manifest.action.default_popup, 'window.html');
  const windowCount = await worker.evaluate(async () => (await chrome.windows.getAll()).length);
  results.push('actual Manifest V3 v0.1.2 loads with a native toolbar popup');

  let popup = await openPopup();
  assert.equal(await evaluatePopup(popup, `document.getElementById('demo-banner').hidden`), true);
  assert.equal(await evaluatePopup(popup, `document.getElementById('primary-button').disabled`), true);
  assert.equal(await worker.evaluate(async () => (await chrome.windows.getAll()).length), windowCount);
  const geometry = await evaluatePopup(popup, `({width:innerWidth,height:innerHeight,scrollHeight:document.documentElement.scrollHeight,footerBottom:document.getElementById('footer-text').getBoundingClientRect().bottom})`);
  assert.equal(geometry.width, 380, 'native popup preserves the designed 380px width');
  assert.ok(geometry.scrollHeight < 600, `idle popup content exceeds Chrome popup height: ${JSON.stringify(geometry)}`);
  assert.ok(geometry.footerBottom <= geometry.height, 'idle popup footer is fully visible');
  await screenshot(popup, 'extension-disconnected.png');
  results.push(`toolbar popup is ${geometry.width}×${geometry.height}px with visible footer, no demo fallback and no independent window`);

  await poll(() => evaluatePopup(popup, `!document.getElementById('scope-fields').disabled`), Boolean, 'Popup is still restoring its initial settings');
  await evaluatePopup(popup, `document.querySelector('input[name="scope"][value="custom"]').click(); document.getElementById('boundary-input').value='draft_boundary'; document.getElementById('boundary-input').dispatchEvent(new Event('input',{bubbles:true})); document.querySelector('input[name="direction"][value="older"]').click(); true`);
  await poll(() => worker.evaluate(async () => (await chrome.storage.local.get('settings')).settings), settings => settings?.mode === 'older' && settings.boundary === 'draft_boundary', 'Draft settings were not saved');
  const firstTarget = popup.targetId;
  await closePopup(popup);
  popup = await openPopup();
  assert.notEqual(popup.targetId, firstTarget);
  await poll(() => evaluatePopup(popup, `({scope:document.querySelector('input[name="scope"]:checked').value,boundary:document.getElementById('boundary-input').value,direction:document.querySelector('input[name="direction"]:checked').value})`), value => value.scope === 'custom' && value.boundary === 'draft_boundary' && value.direction === 'older', 'Reopened popup did not restore the draft');
  assert.equal(await state(), null);
  results.push('closing and reopening the native popup restores unsent range settings without a task');
  await evaluatePopup(popup, `document.querySelector('input[name="scope"][value="all"]').click(); true`);
  await poll(() => worker.evaluate(async () => (await chrome.storage.local.get('settings')).settings), settings => settings?.mode === 'all', 'All scope was not saved');
  await closePopup(popup);

  await basePage.goto('https://x.com/home');
  popup = await openPopup();
  await click(popup, 'connect-button');
  await poll(() => evaluatePopup(popup, `document.getElementById('account-name').textContent`), value => value === '@owner', 'Connection was not displayed');
  results.push('popup connects through background and isolated content script to the fixture owner');
  await startAndReleasePopup(popup, 'check-button');
  let run = await poll(state, value => value?.phase === 'scanning' && value.preparing === false, 'Dry-run did not start after popup closed');
  const dryRunId = run.runId;
  popup = await openPopup();
  await poll(() => phase(popup), value => value === 'scanning', 'Reopened popup did not display the active run');
  await click(popup, 'primary-button');
  await poll(state, value => value?.phase === 'paused', 'Pause did not reach the independent worker');
  await closePopup(popup);
  popup = await openPopup();
  await poll(() => phase(popup), value => value === 'paused', 'Reopened popup did not restore paused state');
  assert.equal((await state()).runId, dryRunId);
  await screenshot(popup, 'extension-reopened-paused.png');
  await click(popup, 'primary-button');
  await poll(state, value => value?.phase === 'scanning', 'Resume did not continue the existing worker');
  await closePopup(popup);
  run = await poll(state, value => value?.phase === 'completed', 'Dry-run did not finish with popup closed', 25000);
  assert.equal(run.runId, dryRunId); assert.equal(run.options.dryRun, true);
  assert.equal(run.counters.scanned, 20); assert.equal(run.counters.eligible, 5); assert.equal(run.counters.removed, 0);
  let work = context.pages().filter(page => page.url().endsWith('/owner/following')).at(-1);
  assert.deepEqual(await work.evaluate(() => fixture.confirmed), []);
  results.push('popup dismissal preserves scanning; reopen, pause, close, reopen and resume keep the same run');
  results.push('dry-run completes while the popup is closed and changes no follow state');

  popup = await openPopup();
  await poll(() => phase(popup), value => value === 'completed', 'Reopened popup did not restore completed dry-run');
  await startAndReleasePopup(popup, 'primary-button');
  run = await poll(state, value => value?.runId !== dryRunId && value?.phase === 'completed', 'Cleanup did not finish with the popup closed', 25000);
  assert.equal(run.counters.removed, 1); assert.equal(run.counters.kept, 1);
  work = context.pages().filter(page => page.url().endsWith('/owner/following')).at(-1);
  assert.deepEqual(await work.evaluate(() => fixture.confirmed), ['candidate']);
  popup = await openPopup();
  await poll(() => evaluatePopup(popup, `document.getElementById('count-removed').textContent`), value => value === '1', 'Reopened popup lost final counters');
  await screenshot(popup, 'extension-completed.png');
  results.push('cleanup survives popup dismissal, confirms one non-mutual and restores final counts on reopen');

  const completedId = run.runId;
  await startAndReleasePopup(popup, 'primary-button');
  run = await poll(state, value => value?.runId !== completedId && value?.phase === 'scanning' && value.preparing === false, 'Reload test did not start');
  const reloadedId = run.runId;
  await worker.evaluate(tabId => chrome.tabs.reload(tabId), run.tabId);
  await poll(state, value => value?.phase === 'stopped', 'Reloading the work tab did not stop the run');
  popup = await openPopup();
  await poll(() => phase(popup), value => value === 'stopped', 'Reopened popup did not report the interrupted task');
  assert.equal((await state()).runId, reloadedId);
  assert.equal(await worker.evaluate(async () => (await chrome.windows.getAll()).length), windowCount);
  results.push('work-tab reload stops actions; reopening reports interruption without restarting or extra windows');
  assert.deepEqual(errors, []);
  console.log(results.map(result => `PASS ${result}`).join('\n'));
} catch (error) {
  errors.push(error.message); console.error(error); process.exitCode = 1;
  if (worker) console.error('Stored state', JSON.stringify(await worker.evaluate(async () => await chrome.storage.local.get(null)).catch(() => null), null, 2));
  if (currentPopup?.sessionId) {
    console.error('Popup text', await evaluatePopup(currentPopup, 'document.body.innerText').catch(() => 'unavailable'));
    await screenshot(currentPopup, 'extension-failure.png').catch(() => {});
  }
} finally {
  await writeFile(path.join(output, 'extension-qa.json'), JSON.stringify({at: new Date().toISOString(), realXAccess: false, nativeToolbarPopup: true, browser: 'Google Chrome, macOS', results, errors, layouts, interceptedRequests: requests}, null, 2));
  for (const pending of pendingCommands.values()) clearTimeout(pending.timer);
  await context.close(); await rm(profile, {recursive: true, force: true});
}
