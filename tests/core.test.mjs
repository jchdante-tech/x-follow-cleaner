import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import "../extension/core.js";
import "../extension/runner.js";

const { normalizeHandle, validateOptions, selectScope, buildPlan, classifyRow } = globalThis.XCleanerCore;
const adapter = globalThis.XCleanerRunnerTest;
const row = (handle, extra = {}) => ({ handle, following: true, followsYou: false, relationshipVerified: true, ...extra });
const options = (mode = "all", boundary = "", dryRun = false) => ({ mode, boundary, dryRun });
const coreSource = await readFile(new URL("../extension/core.js", import.meta.url), "utf8");
const runnerSource = await readFile(new URL("../extension/runner.js", import.meta.url), "utf8");

function productionRunnerHarness(reservation, beforeWrite = async () => {}) {
  const data = { runState: reservation ? structuredClone(reservation) : null };
  const writes = [];
  let listener;
  const primary = { parentElement: null, querySelectorAll: () => [] };
  const scroller = { scrollTop: 0, scrollHeight: 1000, clientHeight: 600, scrollTo({ top }) { this.scrollTop = top; } };
  const profile = { getAttribute: () => "/owner" };
  const chrome = {
    runtime: { id: "fixture-extension", onMessage: { addListener(value) { listener = value; } } },
    storage: { local: {
      async get() { return structuredClone(data); },
      async set(value) {
        await beforeWrite(value.runState);
        writes.push(structuredClone(value.runState));
        Object.assign(data, structuredClone(value));
      },
    } },
  };
  const document = {
    documentElement: { lang: "en" }, body: {}, scrollingElement: scroller,
    querySelector(selector) {
      if (selector === 'a[data-testid="AppTabBar_Profile_Link"]') return profile;
      if (selector === '[data-testid="primaryColumn"]') return primary;
      return null;
    },
    querySelectorAll: () => [],
  };
  const context = vm.createContext({
    chrome, document, location: { hostname: "x.com", pathname: "/owner/following" },
    navigator: { onLine: true }, window: { innerHeight: 600 }, getComputedStyle: () => ({ overflowY: "visible" }),
    URL, setTimeout, Date, console, XC_TESTING: { action: 1, tick: 1 },
  });
  vm.runInContext(coreSource, context);
  vm.runInContext(runnerSource, context);
  const request = (message) => new Promise((resolve) => {
    listener(message, { id: chrome.runtime.id, url: `chrome-extension://${chrome.runtime.id}/background.js` }, resolve);
  });
  return { request, data, writes, context };
}

const reservation = (runId = "one") => ({ runId, owner: "owner", tabId: 1, phase: "scanning", preparing: true });
const startRequest = (runId = "one") => ({ type: "XC/START", runId, owner: "owner", tabId: 1, options: options("all", "", true) });
const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

test("handles accept only a real account or profile URL", () => {
  assert.equal(normalizeHandle(" @Some_One "), "some_one");
  assert.equal(normalizeHandle("https://x.com/Some_One/"), "some_one");
  assert.equal(normalizeHandle("https://twitter.com/Some_One"), "some_one");
  for (const bad of ["", "@@name", "a b", "名字", "1234567890123456", "https://evil.test/name", "https://x.com/a/following", "https://x.com/a?x=1", "https://user@x.com/a", "<script>"]) {
    assert.equal(normalizeHandle(bad), null, bad);
  }
});

test("options reject a missing boundary or string boolean", () => {
  assert.throws(() => validateOptions(options("newer")), /ID/);
  assert.throws(() => validateOptions(options("older", "bad name")), /ID/);
  assert.throws(() => validateOptions({ mode: "all", dryRun: "false" }), /布尔/);
  assert.throws(() => validateOptions({ mode: "other" }), /请选择/);
  assert.deepEqual(validateOptions({ mode: "all", boundary: "ignored" }), options());
});

test("newer and older include the boundary and use observed list order", () => {
  const rows = [row("first"), row("middle"), row("last")];
  assert.deepEqual(selectScope(rows, options("newer", "@MIDDLE")).map((item) => item.handle), ["first", "middle"]);
  assert.deepEqual(selectScope(rows, options("older", "middle")).map((item) => item.handle), ["middle", "last"]);
  assert.deepEqual(selectScope(rows, options("all")).map((item) => item.handle), ["first", "middle", "last"]);
});

test("missing boundary aborts plan creation before any candidate is returned", () => {
  assert.throws(() => buildPlan([row("first"), row("last")], options("newer", "missing")), /不会取消关注/);
  assert.throws(() => buildPlan([], options("older", "missing")), /不会取消关注/);
});

test("mutuals and unknown relationships are always retained", () => {
  const plan = buildPlan([
    row("nonmutual"),
    row("mutual", { followsYou: true }),
    row("unknown", { followsYou: null }),
    row("unchecked", { relationshipVerified: false }),
    row("missingstate", { following: null }),
    row("alreadygone", { following: false }),
  ], options());
  assert.deepEqual(plan.candidates.map((item) => item.handle), ["nonmutual"]);
  assert.deepEqual(plan.protected.map((item) => item.handle), ["mutual", "alreadygone"]);
  assert.deepEqual(plan.unknown.map((item) => item.handle), ["unknown", "unchecked", "missingstate"]);
});

test("plan has no blue-check or follower-count threshold", () => {
  const plan = buildPlan([
    row("blue", { isBlueVerified: true, followers: 9_000_000 }),
    row("normal", { isBlueVerified: false, followers: 1 }),
  ], options());
  assert.equal(plan.candidates.length, 2);
});

test("duplicate observations cannot erase a positive follows-you marker", () => {
  for (const rows of [[row("same", { followsYou: true }), row("SAME")], [row("same"), row("SAME", { followsYou: true })]]) {
    const plan = buildPlan(rows, options());
    assert.equal(plan.scopeCount, 1);
    assert.equal(plan.candidates.length, 0);
    assert.equal(plan.protected.length, 1);
  }
});

test("identity changes or conflicting reads prevent eligibility", () => {
  const changedId = buildPlan([row("same", { userId: "1" }), row("same", { userId: "2" })], options());
  assert.equal(changedId.candidates.length, 0);
  const changedRelation = buildPlan([row("same"), row("same", { followsYou: null })], options());
  assert.equal(changedRelation.candidates.length, 0);
});

test("dry run preserves the same plan without mutation", () => {
  const source = [Object.freeze(row("one")), Object.freeze(row("two", { followsYou: true }))];
  Object.freeze(source);
  const dry = buildPlan(source, options("all", "", true));
  const live = buildPlan(source, options());
  assert.equal(dry.options.dryRun, true);
  assert.deepEqual(dry.candidates, live.candidates);
  assert.equal(source[0].handle, "one");
});

test("an unknown value is not a negative relationship", () => {
  for (const value of [null, undefined, 0, "false", ""]) assert.notEqual(classifyRow(row("a", { followsYou: value })), "eligible");
  assert.notEqual(classifyRow(row("a", { relationshipVerified: "true" })), "eligible");
});

test("only an exact account-ID action testid identifies follow state", () => {
  const button = (id) => ({ getAttribute: () => id });
  assert.deepEqual(adapter.actionState(button("123-unfollow")), { state: "following", userId: "123" });
  assert.deepEqual(adapter.actionState(button("123-follow")), { state: "follow", userId: "123" });
  for (const bad of ["follow", "unfollow", "danger-unfollow", "123-unfollow-extra", ""]) assert.equal(adapter.actionState(button(bad)).state, "unknown");
});

test("negative relationship requires two complete stable supported-language rows", () => {
  const stable = { handle: "one", complete: true, supported: true, userId: "12", following: true, followsYou: null };
  assert.equal(adapter.stableRelationship(stable, { ...stable }).followsYou, false);
  for (const patch of [{ complete: false }, { supported: false }, { userId: "13" }, { following: false }]) {
    assert.notEqual(adapter.stableRelationship(stable, { ...stable, ...patch }).followsYou, false);
  }
  assert.equal(adapter.stableRelationship(stable, { ...stable, followsYou: true }).followsYou, true);
  assert.equal(adapter.stableRelationship({ ...stable, followsYou: true }, stable).followsYou, true);
  assert.equal(adapter.stableRelationship(stable, { ...stable, handle: "other" }), null);
});

test("limit and rejection messages are distinguishable", () => {
  assert.equal(adapter.alertKind("Too many requests. Try again later."), "rate-limited");
  assert.equal(adapter.alertKind("操作过于频繁，请稍后再试"), "rate-limited");
  assert.equal(adapter.alertKind("Something went wrong"), "rejected");
  assert.equal(adapter.alertKind("关注成功"), null);
});

test("production action delay defaults to twelve seconds", () => {
  assert.equal(adapter.timing.action, 12_000);
});

test("missing profile links cannot become an account named undefined", () => {
  for (const missing of [undefined, null, "", " "]) assert.equal(adapter.handleFromHref(missing), null);
  assert.equal(adapter.handleFromHref("/real_user"), "real_user");
  assert.equal(adapter.handleFromHref("https://evil.test/real_user"), null);
});

test("only explicitly supported relationship locales allow negative inference", () => {
  const original = globalThis.document;
  try {
    for (const language of ["en", "en-US", "zh", "zh-CN", "zh-Hans", "zh-Hans-CN"]) {
      globalThis.document = { documentElement: { lang: language } };
      assert.equal(adapter.languageSupported(), true, language);
    }
    for (const language of ["", "zh-TW", "zh-Hant", "zh-HK", "ja", "fr", "ko"]) {
      globalThis.document = { documentElement: { lang: language } };
      assert.equal(adapter.languageSupported(), false, language);
    }
  } finally {
    if (original === undefined) delete globalThis.document;
    else globalThis.document = original;
  }
});

test("production starts require the exact live preparing reservation", async () => {
  for (const stored of [null, { ...reservation(), runId: "old" }, { ...reservation(), owner: "other" }, { ...reservation(), tabId: 2 }, { ...reservation(), preparing: false }, { ...reservation(), phase: "stopped" }]) {
    const h = productionRunnerHarness(stored);
    const response = await h.request(startRequest());
    assert.equal(response.ok, false);
    assert.match(response.error, /预约/);
    assert.equal(h.writes.length, 0);
  }
});

test("STOP waits for the final storage write and keeps START locked until then", async () => {
  let releaseWrite;
  let signalWrite;
  const finalWrite = new Promise((resolve) => { signalWrite = resolve; });
  const gate = new Promise((resolve) => { releaseWrite = resolve; });
  const h = productionRunnerHarness(reservation(), async (snapshot) => {
    if (snapshot.phase === "stopped") {
      signalWrite();
      await gate;
    }
  });
  assert.equal((await h.request(startRequest())).ok, true);
  let stopAcknowledged = false;
  const stopping = h.request({ type: "XC/STOP", runId: "one" }).then((result) => { stopAcknowledged = true; return result; });
  await finalWrite;
  await pause(10);
  assert.equal(stopAcknowledged, false);
  assert.equal((await h.request({ type: "XC/STATUS" })).live, true);
  assert.equal((await h.request(startRequest("two"))).ok, false);
  releaseWrite();
  assert.equal((await stopping).ok, true);
  assert.equal((await h.request({ type: "XC/STATUS" })).live, false);
  assert.equal(h.data.runState.phase, "stopped");
  const lastWriteCount = h.writes.length;
  await pause(30);
  assert.equal(h.writes.length, lastWriteCount, "there is no late write after STOP acknowledges");
});

test("an old runner stops without writing over a newer reservation", async () => {
  const h = productionRunnerHarness(reservation());
  assert.equal((await h.request(startRequest())).ok, true);
  h.data.runState = reservation("new-owner-run");
  await pause(700);
  const status = await h.request({ type: "XC/STATUS" });
  assert.equal(status.live, false);
  assert.equal(status.state.phase, "stopped");
  assert.equal(h.data.runState.runId, "new-owner-run");
  assert.equal(h.data.runState.preparing, true);
});

test("a background stop revokes the page worker even without a STOP message", async () => {
  const h = productionRunnerHarness(reservation());
  assert.equal((await h.request(startRequest())).ok, true);
  h.data.runState = { ...h.data.runState, phase: "stopped", message: "controller cancelled" };
  await pause(700);
  const status = await h.request({ type: "XC/STATUS" });
  assert.equal(status.live, false);
  assert.equal(status.state.phase, "stopped");
  assert.equal(h.data.runState.phase, "stopped");
  assert.equal(h.writes.filter((snapshot) => snapshot.phase === "cleaning").length, 0);
});

test("production does not expose fixture controls or read their timing overrides", () => {
  const h = productionRunnerHarness(reservation());
  assert.equal(vm.runInContext("typeof XCleanerRunnerTest", h.context), "undefined");
});
