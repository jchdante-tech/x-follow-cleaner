(() => {
  "use strict";

  if (globalThis.__XC_RUNNER_VERSION__) return;
  globalThis.__XC_RUNNER_VERSION__ = "1.0.0";

  const core = globalThis.XCleanerCore;
  const hasChrome = typeof chrome !== "undefined" && !!chrome.runtime?.onMessage && !!chrome.storage?.local;
  // The extension never reads a configuration or control signal from the X page.
  const testSettings = !hasChrome && globalThis.XC_TESTING && typeof globalThis.XC_TESTING === "object" ? globalThis.XC_TESTING : {};
  const timing = {
    settle: testSettings.settle ?? 700,
    scroll: testSettings.scroll ?? 900,
    action: testSettings.action ?? 12_000,
    confirmation: testSettings.confirmation ?? 5_000,
    result: testSettings.result ?? 7_000,
    resultStable: testSettings.resultStable ?? 1_200,
    stalled: testSettings.stalled ?? 30_000,
    endStable: testSettings.endStable ?? 9_000,
    tick: testSettings.tick ?? 150,
  };
  const task = { active: false, starting: false, startCancelled: false, startingRunId: null, startDone: null, paused: false, stopped: false, state: null, token: 0, protectedHandles: new Set(), confirmationHandle: null, inFlight: null, completion: null, ownershipCheckedAt: 0 };
  let writeQueue = Promise.resolve();

  class Halt extends Error {
    constructor(message, code = "stopped") {
      super(message);
      this.name = "Halt";
      this.code = code;
    }
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const cleanText = (value) => String(value || "").replace(/\s+/g, " ").trim();
  const textOf = (element) => cleanText(element?.innerText ?? element?.textContent);

  function handleFromHref(href) {
    if (typeof href !== "string" || !href.trim()) return null;
    try {
      const url = new URL(href, "https://x.com");
      if (!["x.com", "www.x.com", "twitter.com", "www.twitter.com"].includes(url.hostname)) return null;
      const match = url.pathname.match(/^\/([A-Za-z0-9_]{1,15})\/?$/);
      return match ? core.normalizeHandle(match[1]) : null;
    } catch {
      return null;
    }
  }

  function accountFromPage() {
    const link = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]');
    const handle = handleFromHref(link?.getAttribute("href"));
    if (!handle) return null;
    const switcher = document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"]');
    const lines = String(switcher?.innerText || "").split("\n").map(cleanText).filter(Boolean);
    const name = lines.find((line) => !line.startsWith("@") && !/more|更多/i.test(line)) || handle;
    const avatar = switcher?.querySelector('img[src]')?.getAttribute("src");
    return { handle, name, ...(avatar && /^https:\/\//.test(avatar) ? { avatar } : {}) };
  }

  function isFollowingPage(owner) {
    const match = location.pathname.match(/^\/([A-Za-z0-9_]{1,15})\/following\/?$/);
    return ["x.com", "www.x.com"].includes(location.hostname) && !!match && core.normalizeHandle(match[1]) === owner;
  }

  function assertContext() {
    if (task.stopped) throw new Halt("任务已停止。");
    const account = accountFromPage();
    if (!account || account.handle !== task.state.owner) throw new Halt("登录账号发生变化或无法确认，任务已停止。", "account-changed");
    if (!isFollowingPage(task.state.owner)) throw new Halt("页面已离开本人的关注列表，任务已停止。", "page-changed");
  }

  function primaryColumn() {
    return document.querySelector('[data-testid="primaryColumn"]');
  }

  function isVisible(element) {
    if (!element?.isConnected) return false;
    if (element.closest('[hidden], [aria-hidden="true"]')) return false;
    return element.getClientRects().length > 0;
  }

  function visibleAlerts() {
    return [...document.querySelectorAll('[data-testid="toast"], [role="alert"], [aria-live="assertive"]')]
      .filter(isVisible).map(textOf).filter(Boolean);
  }

  function alertKind(text) {
    if (/rate.?limit|too many (?:requests|actions)|try again later|temporarily (?:unable|restricted)|limit exceeded|操作过于频繁|请求过多|稍后再试|暂时无法|达到.{0,8}上限|频率限制|操作受限/i.test(text)) return "rate-limited";
    if (/something went wrong|failed|unable to|error|try again|出了点问题|出错|失败|错误|重试|无法/i.test(text)) return "rejected";
    return null;
  }

  function loadingVisible() {
    const primary = primaryColumn();
    return !!primary && [...primary.querySelectorAll('[role="progressbar"], [aria-busy="true"]')].some(isVisible);
  }

  function readListError() {
    const alerts = visibleAlerts();
    const primary = primaryColumn();
    const retryButtons = primary ? [...primary.querySelectorAll('button')].filter(isVisible).map(textOf).filter((text) => /^(Retry|Try again|重试|再试一次)$/i.test(text)) : [];
    return [...alerts, ...retryButtons].find((text) => alertKind(text)) || (retryButtons.length ? retryButtons[0] : null);
  }

  function languageSupported() {
    const language = String(document.documentElement.lang || "").toLowerCase();
    return /^en(?:-|$)/.test(language) || language === "zh" || language === "zh-cn" || /^zh-hans(?:-|$)/.test(language);
  }

  function hasFollowMarker(row) {
    const indicator = row.querySelector('[data-testid="userFollowIndicator"]');
    if (indicator && /Follows you|关注了你|正在关注你|关注你/i.test(textOf(indicator))) return true;
    return /(?:^|\n)\s*(?:Follows you|关注了你|正在关注你|关注你)\s*(?:\n|$)/i.test(String(row.innerText || ""));
  }

  function actionState(button) {
    const testid = button?.getAttribute("data-testid") || "";
    const match = testid.match(/^(\d+)-(unfollow|follow)$/);
    if (match) return { state: match[2] === "unfollow" ? "following" : "follow", userId: match[1] };
    return { state: "unknown", userId: null };
  }

  function accountRow(row) {
    if (!row?.isConnected) return null;
    const links = [...row.querySelectorAll('a[href]')];
    const handleLink = links.find((link) => {
      const handle = handleFromHref(link.getAttribute("href"));
      return handle && textOf(link).toLowerCase().split(/\s+/).includes(`@${handle}`);
    });
    const handle = handleFromHref(handleLink?.getAttribute("href"));
    if (!handle) return null;
    const buttons = [...row.querySelectorAll('button[data-testid]')];
    const actionButtons = buttons.filter((button) => actionState(button).state !== "unknown");
    const button = actionButtons.length === 1 ? actionButtons[0] : null;
    const action = actionState(button);
    const matchingLinks = links.filter((link) => handleFromHref(link.getAttribute("href")) === handle);
    const name = matchingLinks.map(textOf).find((text) => text && !text.startsWith("@")) || handle;
    const marker = hasFollowMarker(row);
    const complete = !!button && !button.disabled && matchingLinks.length >= 1 && !!handleLink &&
      !row.querySelector('[role="progressbar"], [aria-busy="true"]') &&
      action.state !== "unknown" && textOf(row).toLowerCase().includes(`@${handle}`);
    return {
      handle, name, userId: action.userId,
      following: action.state === "following" ? true : action.state === "follow" ? false : null,
      followsYou: marker ? true : null,
      relationshipVerified: marker,
      complete,
      supported: languageSupported(),
      button,
      element: row,
    };
  }

  function visibleRows() {
    const primary = primaryColumn();
    if (!primary) throw new Halt("无法识别 X 关注列表，任务已停止。", "dom-unknown");
    return [...primary.querySelectorAll('[data-testid="UserCell"]')].map(accountRow).filter(Boolean);
  }

  function rowFor(handle) {
    return visibleRows().find((row) => row.handle === handle) || null;
  }

  function stableRelationship(first, second) {
    if (!first || !second || first.handle !== second.handle) return null;
    if (first.followsYou === true || second.followsYou === true) return { ...second, followsYou: true, relationshipVerified: true };
    const stable = first.complete && second.complete && first.supported && second.supported &&
      first.userId && first.userId === second.userId && first.following === true && second.following === true;
    return { ...second, followsYou: stable ? false : null, relationshipVerified: !!stable };
  }

  function serializableRow(row) {
    return {
      handle: row.handle, name: row.name, userId: row.userId,
      following: row.following, followsYou: row.followsYou,
      relationshipVerified: row.relationshipVerified === true,
      checkedAt: Date.now(),
    };
  }

  function log(handle, action, message) {
    if (!task.state) return;
    task.state.logs.push({ at: Date.now(), handle: handle || "", action, message });
    task.state.logs = task.state.logs.slice(-500);
  }

  function sameRun(left, right) {
    return !!left && !!right && left.runId === right.runId && left.owner === right.owner && left.tabId === right.tabId;
  }

  function terminalPhase(phase) {
    return ["completed", "stopped", "error"].includes(phase);
  }

  async function assertOwnership(force = false) {
    if (!hasChrome || !task.state) return;
    if (!force && Date.now() - task.ownershipCheckedAt < 500) return;
    const identity = { runId: task.state.runId, owner: task.state.owner, tabId: task.state.tabId };
    const stored = (await chrome.storage.local.get("runState")).runState;
    if (!sameRun(identity, stored)) {
      task.stopped = true;
      throw new Halt("任务归属已变化，旧任务已停止。", "ownership-lost");
    }
    if (terminalPhase(stored.phase)) {
      task.stopped = true;
      throw new Halt("任务已被控制窗口停止，页面操作已取消。", "cancelled");
    }
    task.ownershipCheckedAt = Date.now();
  }

  function persist() {
    if (!task.state) return Promise.resolve();
    task.state.updatedAt = Date.now();
    const snapshot = JSON.parse(JSON.stringify(task.state));
    if (!hasChrome) {
      if (typeof testSettings.onState === "function") testSettings.onState(snapshot);
      return Promise.resolve();
    }
    writeQueue = writeQueue.catch(() => {}).then(async () => {
      const stored = (await chrome.storage.local.get("runState")).runState;
      if (!sameRun(snapshot, stored)) {
        task.stopped = true;
        throw new Halt("任务归属已变化，旧任务不再写入记录。", "ownership-lost");
      }
      if (terminalPhase(stored.phase) && !terminalPhase(snapshot.phase)) {
        task.stopped = true;
        throw new Halt("任务已被停止，旧进度不会覆盖停止状态。", "cancelled");
      }
      await chrome.storage.local.set({ runState: snapshot });
    });
    return writeQueue;
  }

  async function checkpoint(forceOwnership = false) {
    if (task.stopped) throw new Halt("任务已停止。");
    while (task.paused && !task.stopped) {
      assertContext();
      await assertOwnership();
      await sleep(timing.tick);
    }
    assertContext();
    await assertOwnership(forceOwnership);
    assertContext();
  }

  async function wait(ms) {
    let remaining = ms;
    while (remaining > 0) {
      await checkpoint();
      const period = Math.min(timing.tick, remaining);
      const before = Date.now();
      await sleep(period);
      remaining -= Math.max(1, Date.now() - before);
    }
    await checkpoint();
  }

  async function pauseForReview(message, code) {
    task.paused = true;
    task.state.previousPhase = task.state.phase;
    task.state.phase = "paused";
    task.state.message = message;
    task.state.pauseReason = code;
    log("", "paused", message);
    await persist();
    await checkpoint();
  }

  function scrollArea() {
    const primary = primaryColumn();
    let element = primary;
    while (element && element !== document.body && element !== document.documentElement) {
      const style = getComputedStyle(element);
      if (/(auto|scroll)/.test(style.overflowY) && element.scrollHeight > element.clientHeight + 100) return element;
      element = element.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  }

  function scrollPosition() {
    const element = scrollArea();
    const viewport = element === document.scrollingElement || element === document.documentElement ? window.innerHeight : element.clientHeight;
    return { top: element.scrollTop, height: element.scrollHeight, viewport, atBottom: element.scrollHeight - viewport - element.scrollTop <= 80 };
  }

  function scrollTo(top) {
    const element = scrollArea();
    element.scrollTo({ top, behavior: "instant" });
  }

  function exactFollowingTotal() {
    const expectedPath = `/${task.state.owner}/following`;
    for (const link of document.querySelectorAll('a[href]')) {
      let path;
      try { path = new URL(link.getAttribute("href"), "https://x.com").pathname.toLowerCase().replace(/\/$/, ""); } catch { continue; }
      if (path !== expectedPath) continue;
      for (const value of [link.getAttribute("title"), link.getAttribute("aria-label"), textOf(link)]) {
        if (!value || /\d\s*(?:K|M|B|万|萬|亿|億)/i.test(value)) continue;
        const match = value.match(/(?:^|\s)([0-9][0-9,\u00a0 ]*)\s*(?:Following|正在关注|正在關注|关注|關注)(?:\s|$)/i);
        if (match) {
          const total = Number(match[1].replace(/[,\s\u00a0]/g, ""));
          if (Number.isSafeInteger(total) && total >= 0) return total;
        }
      }
    }
    return null;
  }

  function emptyFollowingVisible() {
    const primary = primaryColumn();
    if (!primary || loadingVisible()) return false;
    const text = textOf(primary);
    return /You (?:aren[’']t|are not) following anyone|You haven[’']t followed anyone|你还没有关注任何人|你尚未关注任何人|你還沒有跟隨任何人/i.test(text);
  }

  function mergeObservation(rows, row) {
    const saved = serializableRow(row);
    const previous = rows.get(row.handle);
    if (saved.followsYou === true || previous?.followsYou === true) {
      saved.followsYou = true;
      saved.relationshipVerified = true;
      task.protectedHandles.add(row.handle);
    }
    if (previous?.inconsistent || (previous?.userId && saved.userId && previous.userId !== saved.userId)) {
      saved.followsYou = null;
      saved.relationshipVerified = false;
      saved.inconsistent = true;
    }
    rows.set(row.handle, saved);
  }

  async function scanScope() {
    const rows = new Map();
    await checkpoint();
    scrollTo(0);
    await wait(timing.scroll);
    const expected = exactFollowingTotal();
    task.state.expectedFollowing = expected;
    let lastProgressAt = Date.now();
    let stableBottomSince = 0;
    let lastBottomSignature = "";
    let stableBottomPasses = 0;
    let rounds = 0;
    while (rounds++ < 10_000) {
      await checkpoint();
      const error = readListError();
      if (error) throw new Halt(`X 未正常加载关注列表：${error}`, alertKind(error) || "list-error");
      const firstRows = visibleRows();
      const first = new Map(firstRows.map((row) => [row.handle, row]));
      await wait(timing.settle);
      const secondRows = visibleRows();
      const previousSize = rows.size;
      for (const row of secondRows) {
        if (row.following === false) continue;
        const stable = stableRelationship(first.get(row.handle), row);
        if (stable) mergeObservation(rows, stable);
      }
      if (rows.size > previousSize) {
        lastProgressAt = Date.now();
        stableBottomSince = 0;
        stableBottomPasses = 0;
      }
      task.state.counters.scanned = rows.size;
      task.state.message = `正在检查关注列表，已读取 ${rows.size} 个账号。`;
      await persist();
      await checkpoint();
      if (task.state.options.mode === "newer" && rows.has(task.state.options.boundary)) {
        task.state.scanEndReason = "boundary-found";
        return [...rows.values()];
      }
      if (Number.isInteger(expected) && rows.size >= expected && (expected > 0 || emptyFollowingVisible())) {
        task.state.scanEndReason = "known-total-reached";
        return [...rows.values()];
      }
      if (!rows.size && emptyFollowingVisible()) {
        task.state.scanEndReason = "explicit-empty-list";
        return [];
      }
      const position = scrollPosition();
      const loading = loadingVisible();
      const signature = `${Math.round(position.height)}:${secondRows.map((row) => row.handle).join(",")}`;
      if (position.atBottom && !loading && rows.size > 0) {
        if (signature === lastBottomSignature) {
          stableBottomSince ||= Date.now();
          stableBottomPasses++;
        } else {
          stableBottomSince = Date.now();
          stableBottomPasses = 1;
          lastBottomSignature = signature;
        }
        if (stableBottomPasses >= 5 && Date.now() - stableBottomSince >= timing.endStable) {
          if (expected !== null && rows.size < expected) {
            task.state.scanEndReason = "stalled-before-known-total";
            throw new Halt(`X 停止加载：只读到 ${rows.size} / ${expected} 个账号。本次未执行清理。`, "scan-incomplete");
          }
          task.state.scanEndReason = "stable-visible-list-end";
          task.state.scanCoverage = "当前列表页面稳定到达底部；X 未提供可核对的精确总数。";
          return [...rows.values()];
        }
      } else {
        stableBottomSince = 0;
        stableBottomPasses = 0;
        lastBottomSignature = "";
      }
      if (Date.now() - lastProgressAt >= timing.stalled) {
        task.state.scanEndReason = loading ? "loading-stalled" : "scroll-no-progress";
        throw new Halt(loading ? "X 持续加载但没有返回新账号，本次未执行清理。" : "列表滚动没有产生新账号，无法确认完整范围，本次未执行清理。", "scan-incomplete");
      }
      scrollTo(position.top + Math.max(400, Math.round(position.viewport * 0.72)));
      await wait(timing.scroll);
    }
    task.state.scanEndReason = "scan-limit";
    throw new Halt("扫描次数达到上限，本次未执行清理。", "scan-incomplete");
  }

  async function verifyCandidate(candidate) {
    await checkpoint();
    const first = rowFor(candidate.handle);
    if (!first || first.userId !== candidate.userId) return { result: "unknown" };
    await wait(timing.settle);
    const second = rowFor(candidate.handle);
    const verified = stableRelationship(first, second);
    if (!verified || verified.userId !== candidate.userId) return { result: "unknown" };
    if (task.protectedHandles.has(candidate.handle) || verified.followsYou === true) return { result: "protected", row: verified };
    if (verified.following === false) return { result: "not-following", row: verified };
    return core.classifyRow(verified) === "eligible" ? { result: "eligible", row: verified } : { result: "unknown", row: verified };
  }

  function confirmationFor(candidate) {
    const confirms = [...document.querySelectorAll('[data-testid="confirmationSheetConfirm"]')].filter(isVisible);
    if (confirms.length !== 1) return null;
    const button = confirms[0];
    const dialog = button.closest('[role="dialog"], [data-testid="confirmationSheetDialog"]');
    if (!dialog || !isVisible(dialog)) return null;
    const handles = [...textOf(dialog).matchAll(/@([A-Za-z0-9_]{1,15})\b/g)].map((match) => match[1].toLowerCase());
    if (!handles.includes(candidate.handle) || handles.some((handle) => handle !== candidate.handle)) return null;
    if (!/Unfollow|取消关注|取消關注|取消跟随|取消跟隨/i.test(textOf(dialog))) return null;
    return { button, dialog };
  }

  function cancelConfirmation() {
    if (!task.confirmationHandle) return;
    const owned = confirmationFor({ handle: task.confirmationHandle });
    const cancel = owned?.dialog.querySelector('[data-testid="confirmationSheetCancel"]');
    if (cancel && isVisible(cancel)) cancel.click();
    task.confirmationHandle = null;
  }

  async function unfollowCandidate(candidate) {
    const verification = await verifyCandidate(candidate);
    if (verification.result !== "eligible") return verification.result;
    await checkpoint(true);
    if (navigator.onLine === false) return "network-offline";
    const beforeActionError = readListError();
    if (beforeActionError) return alertKind(beforeActionError) || "list-error";
    if ([...document.querySelectorAll('[role="dialog"]')].some(isVisible)) return "dialog-present";
    const row = rowFor(candidate.handle);
    if (!row || row.userId !== candidate.userId || row.followsYou === true || actionState(row.button).state !== "following") return "unknown";
    const priorAlerts = new Set(visibleAlerts());
    task.confirmationHandle = candidate.handle;
    task.inFlight = { handle: candidate.handle, confirmationSent: false };
    row.button.click();
    let confirmation = null;
    let spent = 0;
    while (spent < timing.confirmation) {
      await wait(timing.tick);
      spent += timing.tick;
      confirmation = confirmationFor(candidate);
      if (confirmation) break;
      if (document.querySelector('[data-testid="confirmationSheetConfirm"]')) break;
    }
    if (!confirmation) {
      cancelConfirmation();
      return "confirmation-mismatch";
    }
    await checkpoint(true);
    if (navigator.onLine === false || readListError()) {
      cancelConfirmation();
      return navigator.onLine === false ? "network-offline" : "list-error";
    }
    const latest = rowFor(candidate.handle);
    const target = confirmationFor(candidate);
    if (!latest || latest.userId !== candidate.userId || latest.followsYou === true || !target || !latest.complete || !latest.supported) {
      cancelConfirmation();
      return latest?.followsYou === true ? "protected" : "unknown";
    }
    if (actionState(latest.button).state !== "following") {
      cancelConfirmation();
      return "unknown";
    }
    task.inFlight.confirmationSent = true;
    target.button.click();
    task.confirmationHandle = null;
    task.state.inFlight = { handle: candidate.handle, confirmationSent: true };
    task.state.message = `已向 X 发送 @${candidate.handle} 的取消关注请求，正在核对结果。`;
    await persist();
    let stableSince = 0;
    spent = 0;
    while (spent < timing.result) {
      await wait(timing.tick);
      spent += timing.tick;
      const alert = visibleAlerts().find((text) => !priorAlerts.has(text) && alertKind(text));
      if (alert) return alertKind(alert);
      const current = rowFor(candidate.handle);
      if (!current || current.userId !== candidate.userId) {
        stableSince = 0;
        continue;
      }
      if (current.following === false && actionState(current.button).state === "follow") {
        stableSince ||= Date.now();
        if (Date.now() - stableSince >= timing.resultStable) return "confirmed";
      } else stableSince = 0;
    }
    return "unconfirmed";
  }

  async function cleanPlan(plan) {
    await checkpoint();
    task.state.phase = "cleaning";
    task.state.message = `已确认 ${plan.candidates.length} 个待清理账号，开始逐个检查并处理。`;
    await persist();
    await checkpoint();
    scrollTo(0);
    await wait(timing.scroll);
    const pending = new Map(plan.candidates.map((row) => [row.handle, row]));
    let lastFoundAt = Date.now();
    let acted = false;
    while (pending.size) {
      await checkpoint();
      const error = readListError();
      if (error) {
        await pauseForReview(`X 出现提示，已暂停：${error}`, alertKind(error) || "list-error");
        continue;
      }
      const visible = visibleRows();
      const candidate = visible.map((row) => pending.get(row.handle)).find(Boolean);
      if (!candidate) {
        if (Date.now() - lastFoundAt > timing.stalled) {
          task.state.remaining = [...pending.keys()];
          throw new Halt("剩余账号未能重新加载，已停止；未处理的账号保留在记录中。", "cleaning-stalled");
        }
        const position = scrollPosition();
        scrollTo(position.top + Math.max(400, Math.round(position.viewport * 0.72)));
        await wait(timing.scroll);
        continue;
      }
      lastFoundAt = Date.now();
      if (acted) {
        task.state.message = `等待下一次处理：@${candidate.handle}`;
        task.state.nextActionAt = Date.now() + timing.action;
        await persist();
        await wait(timing.action);
      }
      delete task.state.nextActionAt;
      await checkpoint(true);
      const lateError = readListError();
      if (navigator.onLine === false || lateError) {
        await pauseForReview(navigator.onLine === false ? "网络已离线，已暂停。恢复网络后再继续。" : `X 出现提示，已暂停：${lateError}`, navigator.onLine === false ? "network-offline" : alertKind(lateError) || "list-error");
        continue;
      }
      task.state.message = `正在复核 @${candidate.handle}`;
      await persist();
      const result = await unfollowCandidate(candidate);
      task.inFlight = null;
      delete task.state.inFlight;
      pending.delete(candidate.handle);
      task.state.remaining = [...pending.keys()];
      if (result === "confirmed") {
        acted = true;
        task.state.counters.removed++;
        log(candidate.handle, "removed", "同一账号的按钮已明确变为“关注”。");
      } else if (result === "protected" || result === "not-following") {
        task.state.counters.kept++;
        log(candidate.handle, "kept", result === "protected" ? "复核时确认对方关注了你，已保留。" : "复核时已不在关注状态，未执行操作。");
      } else {
        // A failed confirmation is never counted as a successful unfollow.
        acted = true;
        task.state.counters.unconfirmed++;
        log(candidate.handle, "unconfirmed", `未确认取关成功：${result}。`);
        await persist();
        await pauseForReview(`@${candidate.handle} 的处理结果未能确认，已暂停。可查看 X 页面后继续；该账号不会自动重试。`, result);
      }
      await persist();
    }
  }

  async function pipeline(token, initialWrite) {
    try {
      if (initialWrite) await initialWrite;
      const rows = await scanScope();
      await checkpoint();
      const plan = core.buildPlan(rows, task.state.options);
      task.state.counters.eligible = plan.candidates.length;
      task.state.counters.kept = plan.protected.length + plan.unknown.length;
      task.state.scopeCount = plan.scopeCount;
      task.state.candidates = plan.candidates.map(({ handle, userId }) => ({ handle, userId }));
      task.state.remaining = plan.candidates.map(({ handle }) => handle);
      for (const row of plan.unknown) log(row.handle, "kept", "关系状态无法确认，保留。");
      log("", "scan-complete", `范围内 ${plan.scopeCount} 个账号；可清理 ${plan.candidates.length} 个；保留 ${task.state.counters.kept} 个。`);
      await persist();
      if (!task.state.options.dryRun && plan.candidates.length) await cleanPlan(plan);
      await checkpoint();
      task.state.phase = "completed";
      task.state.message = task.state.options.dryRun
        ? `检查完成：可清理 ${plan.candidates.length} 个账号，未执行取消关注。`
        : `本次处理结束：确认清理 ${task.state.counters.removed} 个，未确认 ${task.state.counters.unconfirmed} 个。`;
      log("", "completed", task.state.message);
    } catch (error) {
      cancelConfirmation();
      if (task.inFlight?.confirmationSent) {
        task.state.counters.unconfirmed++;
        log(task.inFlight.handle, "unconfirmed", "取消关注请求已发送，但任务停止前未完成结果核对；不计入清理成功。");
        task.state.lastUnconfirmed = task.inFlight.handle;
      }
      task.inFlight = null;
      delete task.state.inFlight;
      task.state.phase = error instanceof Halt ? "stopped" : "error";
      task.state.message = error.message || "发生错误，已停止。";
      if (task.state.lastUnconfirmed) task.state.message += ` @${task.state.lastUnconfirmed} 的请求已发送，结果待核对。`;
      task.state.stopReason = error.code || "error";
      log("", task.state.phase, task.state.message);
    } finally {
      if (token === task.token) {
        task.paused = false;
        delete task.state.nextActionAt;
        try {
          await persist();
        } catch (error) {
          // Losing ownership is a local stop: never overwrite the new run.
          task.stopped = true;
          task.state.phase = error instanceof Halt ? "stopped" : "error";
          task.state.stopReason = error.code || "storage-error";
          task.state.message = error.message || "记录保存失败，任务已停止。";
        } finally {
          task.active = false;
        }
      }
    }
  }

  async function start(message) {
    if (!core) throw new Error("清理核心未加载，请重新加载扩展。");
    if (task.active || task.starting) throw new Error("当前页面已有任务，请先停止并等待收尾。");
    const owner = core.normalizeHandle(message.owner);
    const options = core.validateOptions(message.options);
    const account = accountFromPage();
    if (!owner || !account || owner !== account.handle || !isFollowingPage(owner)) throw new Error("请打开当前登录账号自己的关注列表。");
    if (typeof message.runId !== "string" || !message.runId || message.runId.length > 128) throw new Error("任务标识无效。");
    if (!Number.isSafeInteger(message.tabId) || message.tabId < 0) throw new Error("工作页面标识无效。");
    if (!primaryColumn()) throw new Error("X 页面仍在加载或结构已变化，请等待后重试。");
    task.starting = true;
    task.startCancelled = false;
    task.startingRunId = message.runId;
    let finishStart;
    task.startDone = new Promise((resolve) => { finishStart = resolve; });
    try {
      if (hasChrome) {
        const reservation = (await chrome.storage.local.get("runState")).runState;
        if (!sameRun({ runId: message.runId, owner, tabId: message.tabId }, reservation) || reservation.phase !== "scanning" || reservation.preparing !== true) {
          throw new Error("任务预约已失效，请从清理窗口重新开始。");
        }
      }
      if (task.startCancelled) throw new Error("任务在启动前已取消。");
      const latestAccount = accountFromPage();
      if (!latestAccount || latestAccount.handle !== owner || !isFollowingPage(owner)) throw new Error("登录账号或工作页面已变化，未启动清理。");
      task.active = true;
      task.paused = false;
      task.stopped = false;
      task.protectedHandles = new Set();
      task.confirmationHandle = null;
      task.inFlight = null;
      task.ownershipCheckedAt = 0;
      task.token++;
      task.state = {
        runId: message.runId, owner, tabId: message.tabId, options,
        phase: "scanning", preparing: false, counters: { scanned: 0, eligible: 0, kept: 0, removed: 0, unconfirmed: 0 },
        message: "正在读取本人关注列表。扫描结束前不会取消关注任何人。",
        updatedAt: Date.now(), logs: [], candidates: [], scanEndReason: null,
      };
      log("", "started", options.dryRun ? "开始只读检查。" : "开始扫描并按范围清理。");
      const initialWrite = persist();
      // Install completion before yielding so STOP can always await the worker.
      task.completion = pipeline(task.token, initialWrite);
      await initialWrite;
      return { ok: true, state: task.state };
    } finally {
      task.starting = false;
      task.startingRunId = null;
      finishStart();
    }
  }

  async function handleMessage(message) {
    if (!core) return { ok: false, error: "清理核心未加载。" };
    if (message.type === "XC/PROBE") {
      const account = accountFromPage();
      return account ? { ok: true, account, followingPage: isFollowingPage(account.handle) } : { ok: false, error: "未识别到 X 登录账号，请先在浏览器登录。" };
    }
    if (message.type === "XC/START") return start(message);
    if (message.type === "XC/STATUS") {
      const stored = task.state || (hasChrome ? (await chrome.storage.local.get("runState")).runState : null) || null;
      return { ok: true, state: stored, live: task.active || task.starting, interrupted: !task.active && !task.starting && !!stored && ["scanning", "cleaning", "paused"].includes(stored.phase) };
    }
    if (message.type === "XC/STOP" && task.starting) {
      if (message.runId && message.runId !== task.startingRunId) return { ok: false, error: "任务标识不匹配。" };
      task.startCancelled = true;
      task.stopped = true;
      task.paused = false;
      await task.startDone;
      if (task.active && task.completion) await task.completion;
      return { ok: true, state: task.state };
    }
    if (!task.active || !task.state) return { ok: false, error: "当前页面没有正在执行的任务。" };
    if (message.runId && message.runId !== task.state.runId) return { ok: false, error: "任务标识不匹配。" };
    if (terminalPhase(task.state.phase)) {
      if (task.completion) await task.completion;
      return { ok: true, state: task.state };
    }
    if (message.type === "XC/PAUSE") {
      if (!task.paused) {
        task.paused = true;
        task.state.previousPhase = task.state.phase;
        task.state.phase = "paused";
        task.state.message = task.inFlight?.confirmationSent
          ? `已暂停；@${task.inFlight.handle} 的取消关注请求已发送，恢复后核对结果。`
          : "已暂停；不会继续点击或取消关注。";
        log("", "paused", task.state.message);
        await persist();
      }
      return { ok: true, state: task.state };
    }
    if (message.type === "XC/RESUME") {
      await assertOwnership(true);
      assertContext();
      if (!task.paused) return { ok: true, state: task.state };
      task.state.phase = task.state.previousPhase || "scanning";
      delete task.state.previousPhase;
      delete task.state.pauseReason;
      task.state.message = "已继续，正在重新核对页面。";
      task.paused = false;
      log("", "resumed", task.state.message);
      await persist();
      return { ok: true, state: task.state };
    }
    if (message.type === "XC/STOP") {
      task.stopped = true;
      task.paused = false;
      task.state.phase = "stopped";
      task.state.message = "任务已停止。";
      cancelConfirmation();
      log("", "stopped", task.state.message);
      // The pipeline owns the terminal write, including any in-flight outcome.
      // Do not acknowledge STOP while an old final write could still be pending.
      if (task.completion) await task.completion;
      return { ok: true, state: task.state };
    }
    return { ok: false, error: "不支持的操作。" };
  }

  if (!hasChrome) {
    globalThis.XCleanerRunnerTest = Object.freeze({
      actionState, stableRelationship, alertKind, handleFromHref, languageSupported, timing,
      ...(globalThis.XC_TESTING ? {
        handleMessage,
        getState: () => task.state ? JSON.parse(JSON.stringify(task.state)) : null,
        whenIdle: () => task.completion || Promise.resolve(),
      } : {}),
    });
    return;
  }

  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (!message || !/^XC\/(PROBE|START|PAUSE|RESUME|STOP|STATUS)$/.test(message.type || "")) return false;
    if (sender.id !== chrome.runtime.id || (sender.url && !sender.url.startsWith(`chrome-extension://${chrome.runtime.id}/`))) {
      respond({ ok: false, error: "消息来源无效。" });
      return false;
    }
    handleMessage(message).then(respond).catch((error) => respond({ ok: false, error: error.message || "操作失败。" }));
    return true;
  });
})();
