// Run explicitly with PLAYWRIGHT_MODULE pointing to an installed playwright package.
import assert from 'node:assert/strict';
import {readFile, mkdir, writeFile} from 'node:fs/promises';
import {pathToFileURL, fileURLToPath} from 'node:url';
import path from 'node:path';
import {xPageFixture} from '../tests/x-page-fixture.mjs';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const {chromium} = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const browser = await chromium.launch({channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true});
const core = await readFile(path.join(root, 'extension/core.js'), 'utf8');
const runner = await readFile(path.join(root, 'extension/runner.js'), 'utf8');
const results = [];

async function exercise(name, config, options, check, interaction) {
  const page = await browser.newPage({viewport: {width: 1100, height: 750}});
  const unexpected = [];
  await page.route('**/*', route => {
    if (route.request().isNavigationRequest() && route.request().url() === 'https://x.com/owner/following') return route.fulfill({contentType: 'text/html', body: xPageFixture(config)});
    unexpected.push(route.request().url()); return route.abort();
  });
  try {
    await page.goto('https://x.com/owner/following');
    await page.evaluate(() => { window.XC_TESTING = {settle: 12, scroll: 25, action: 25, confirmation: 120, result: 220, resultStable: 35, stalled: 1500, endStable: 80, tick: 5}; });
    await page.addScriptTag({content: core});
    await page.addScriptTag({content: runner});
    if (interaction?.before) await interaction.before(page);
    await page.evaluate(async opts => XCleanerRunnerTest.handleMessage({type: 'XC/START', runId: 'fixture', owner: 'owner', tabId: 1, options: opts}), {mode: 'all', boundary: '', dryRun: false, ...options});
    if (interaction?.during) await interaction.during(page);
    await page.waitForFunction(() => ['completed','error','stopped','paused'].includes(XCleanerRunnerTest.getState()?.phase), {timeout: 10000});
    const {state, fixture} = await page.evaluate(() => ({state: XCleanerRunnerTest.getState(), fixture: {clicked: window.fixture.clicked, confirmed: window.fixture.confirmed}}));
    await check(state, fixture, page);
    assert.deepEqual(unexpected, [], 'the fixture must not call the network');
    results.push({name, pass: true, phase: state.phase, counters: state.counters});
    console.log(`PASS ${name}`);
  } catch (error) {
    results.push({name, pass: false, error: error.message});
    console.error(`FAIL ${name}: ${error.message}`);
  } finally { await page.close(); }
}

try {
  for (let repeat = 1; repeat <= 3; repeat++) {
    await exercise(`newer range and mutual protection #${repeat}`, {}, {mode: 'newer', boundary: 'boundary'}, (state, fixture) => {
      assert.equal(state.phase, 'completed'); assert.deepEqual(fixture.confirmed, ['new_one', 'boundary']); assert.equal(state.counters.removed, 2);
    });
  }
  await exercise('older range includes boundary', {}, {mode: 'older', boundary: 'boundary'}, (state, fixture) => {
    assert.equal(state.phase, 'completed'); assert.deepEqual(fixture.confirmed, ['boundary', 'old_one']);
  });
  await exercise('dry-run performs zero clicks', {}, {dryRun: true}, (state, fixture) => {
    assert.equal(state.phase, 'completed'); assert.equal(state.counters.eligible, 3); assert.deepEqual(fixture.clicked, []);
  });
  await exercise('missing boundary never widens scope', {}, {mode: 'older', boundary: 'missing'}, (state, fixture) => {
    assert.equal(state.phase, 'error'); assert.deepEqual(fixture.clicked, []);
  });
  await exercise('unsupported language preserves all rows', {lang: 'zh-Hant'}, {}, (state, fixture) => {
    assert.equal(state.phase, 'completed'); assert.equal(state.counters.eligible, 0); assert.deepEqual(fixture.clicked, []);
  });
  await exercise('a vanished row is not a confirmed unfollow', {outcome: 'vanish'}, {}, (state, fixture) => {
    assert.equal(state.phase, 'paused'); assert.equal(state.counters.removed, 0); assert.equal(state.counters.unconfirmed, 1); assert.deepEqual(fixture.confirmed, ['new_one']);
  });
  await exercise('a mismatched dialog is never confirmed', {outcome: 'mismatch'}, {}, (state, fixture) => {
    assert.equal(state.phase, 'paused'); assert.deepEqual(fixture.confirmed, []);
  });
  await exercise('rate limiting pauses after one attempted operation', {outcome: 'rate-limit'}, {}, (state, fixture) => {
    assert.equal(state.phase, 'paused'); assert.equal(state.counters.removed, 0); assert.equal(fixture.confirmed.length, 1);
  });
  await exercise('stop after dispatch retains an unconfirmed result', {outcome: 'unchanged'}, {}, (state, fixture) => {
    assert.equal(state.phase, 'stopped'); assert.equal(state.counters.removed, 0); assert.equal(state.counters.unconfirmed, 1); assert.equal(fixture.confirmed.length, 1);
  }, {during: async page => {
    await page.waitForFunction(() => fixture.confirmed.length === 1);
    await page.evaluate(async () => { await XCleanerRunnerTest.handleMessage({type: 'XC/STOP', runId: 'fixture'}); await XCleanerRunnerTest.whenIdle(); });
  }});
  await exercise('pause prevents clicks until resumed', {}, {}, (state, fixture) => {
    assert.equal(state.phase, 'completed'); assert.equal(fixture.confirmed.length, 3);
  }, {during: async page => {
    await page.evaluate(() => XCleanerRunnerTest.handleMessage({type: 'XC/PAUSE', runId: 'fixture'}));
    const before = await page.evaluate(() => fixture.confirmed.length);
    await page.waitForTimeout(120);
    assert.equal(await page.evaluate(() => fixture.confirmed.length), before);
    await page.evaluate(() => XCleanerRunnerTest.handleMessage({type: 'XC/RESUME', runId: 'fixture'}));
  }});
  const people = Array.from({length: 80}, (_, i) => ({handle: `person_${i}`, id: String(1000+i), mutual: i%4 !== 0}));
  await exercise('virtualized scrolling reads the entire observed list', {virtual: true, people}, {dryRun: true}, (state, fixture) => {
    assert.equal(state.phase, 'completed'); assert.equal(state.counters.scanned, 80); assert.equal(state.counters.eligible, 20); assert.deepEqual(fixture.confirmed, []);
  });
} finally {
  await browser.close();
  const out = path.join(root, 'output/playwright'); await mkdir(out, {recursive: true});
  await writeFile(path.join(out, 'browser-qa.json'), JSON.stringify({at: new Date().toISOString(), browser: process.env.PLAYWRIGHT_CHANNEL || 'chrome', realXAccess: false, results}, null, 2));
}
if (results.some(result => !result.pass)) process.exitCode = 1;
