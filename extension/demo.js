// Local preview adapter. It never opens X or sends network requests.
export function createDemoBackend(onChange) {
  const people = Array.from({ length: 12 }, (_, i) => ({ handle: `demo_${String(i + 1).padStart(2, "0")}`, mutual: i % 3 !== 1 }));
  let connection = { handle: "demo_user", name: "预览账号", tabId: -1 };
  let state = null;
  let timer = null;
  let scanIndex = 0;
  let cleanIndex = 0;
  let selected = people;
  let candidates = [];
  let settings = { mode: "all", boundary: "" };
  const now = () => new Date().toISOString();
  const clone = value => value == null ? null : JSON.parse(JSON.stringify(value));
  const emit = () => { if (state) state.updatedAt = now(); onChange(); };
  const addLog = (handle, action, message) => state.logs.push({ at: now(), handle, action, message });
  const schedule = () => { clearTimeout(timer); timer = setTimeout(tick, 850); };

  function tick() {
    if (!state || !["scanning", "cleaning"].includes(state.phase)) return;
    if (state.phase === "scanning") {
      const person = selected[scanIndex++];
      if (person) {
        state.counters.scanned += 1;
        if (person.mutual) { state.counters.kept += 1; addLog(person.handle, "kept", "互相关注，已保留"); }
        else { state.counters.eligible += 1; candidates.push(person); addLog(person.handle, "eligible", "未回关，符合清理条件"); }
        state.message = `正在检查 @${person.handle}`;
      } else if (state.options.dryRun || !candidates.length) {
        state.phase = "completed";
        state.message = state.options.dryRun ? `检查完成，发现 ${candidates.length} 个未回关账号；没有取消任何关注。` : "检查完成，没有需要清理的账号。";
      } else { state.phase = "cleaning"; state.message = "检查完成，开始清理未回关账号。"; }
    } else {
      const person = candidates[cleanIndex++];
      if (person) { state.counters.removed += 1; addLog(person.handle, "removed", "演示：已取消关注"); state.message = `正在整理 @${person.handle}`; }
      else { state.phase = "completed"; state.message = `本次已清理 ${state.counters.removed} 个未回关账号，互关账号已保留。`; }
    }
    emit();
    if (["scanning", "cleaning"].includes(state.phase)) schedule();
  }

  function start(options) {
    clearTimeout(timer); scanIndex = 0; cleanIndex = 0; candidates = [];
    const boundaryIndex = people.findIndex(p => p.handle.toLowerCase() === options.boundary.toLowerCase());
    if (options.mode !== "all" && boundaryIndex < 0) return { ok: false, error: "演示中没有找到该起点。可输入 demo_04 体验指定范围。" };
    selected = options.mode === "newer" ? people.slice(0, boundaryIndex + 1) : options.mode === "older" ? people.slice(boundaryIndex) : people;
    settings = { mode: options.mode, boundary: options.boundary };
    state = { runId: `preview-${Date.now()}`, owner: "demo_user", tabId: -1, options, phase: "scanning", counters: { scanned: 0, eligible: 0, kept: 0, removed: 0, unconfirmed: 0 }, message: "正在读取关注列表…", updatedAt: now(), logs: [] };
    emit(); schedule();
    return { ok: true };
  }

  const previewState = new URLSearchParams(location.search).get("state");
  if (previewState === "custom") settings = { mode: "older", boundary: "demo_04" };
  if (previewState === "disconnected") connection = null;
  if (["running", "paused", "completed", "error"].includes(previewState)) {
    state = { runId: "preview-snapshot", owner: "demo_user", tabId: -1, options: { mode: "all", boundary: "", dryRun: false }, phase: previewState === "running" ? "cleaning" : previewState, previousPhase: "cleaning", counters: { scanned: 12, eligible: 4, kept: 8, removed: previewState === "completed" ? 4 : 2, unconfirmed: 0 }, message: previewState === "error" ? "连接已中断，重新连接后再试。" : previewState === "completed" ? "本次已清理 4 个未回关账号，互关账号已保留。" : previewState === "paused" ? "已暂停，点击继续处理剩余账号。" : "正在清理 @demo_08", updatedAt: now(), logs: [{ at: now(), handle: "demo_02", action: "removed", message: "演示：已取消关注" }, { at: now(), handle: "demo_03", action: "kept", message: "互相关注，已保留" }] };
    candidates = people.filter(p => !p.mutual); scanIndex = people.length; cleanIndex = 2;
    if (previewState === "running") schedule();
  }

  return {
    async send(message) {
      await new Promise(resolve => setTimeout(resolve, 120));
      if (message.type === "APP/STATE") return { ok: true, state: clone(state), connection: clone(connection), settings: clone(settings) };
      if (message.type === "APP/CONNECT") { connection = { handle: "demo_user", name: "预览账号", tabId: -1 }; emit(); return { ok: true, connection: clone(connection), message: "预览账号已连接，所有操作仅在演示中进行。" }; }
      if (message.type === "APP/FOCUS_X") return { ok: true, message: "演示模式不会打开或操作 X。" };
      if (message.type === "APP/START") {
        if (!connection) return { ok: false, error: "请先连接 X 账号。" };
        if (state && ["scanning", "cleaning", "paused"].includes(state.phase)) return { ok: false, error: "已有任务正在进行。" };
        return start(message.options);
      }
      if (message.type === "APP/CONTROL") {
        if (!state) return { ok: false, error: "没有正在进行的任务。" };
        if (message.command === "pause" && ["scanning", "cleaning"].includes(state.phase)) { clearTimeout(timer); state.previousPhase = state.phase; state.phase = "paused"; state.message = "已暂停，点击继续处理剩余账号。"; }
        if (message.command === "resume" && state.phase === "paused") { state.phase = state.previousPhase || "scanning"; state.message = "继续处理…"; schedule(); }
        if (message.command === "stop") { clearTimeout(timer); state.phase = "stopped"; state.message = "本次任务已停止，已完成的结果保留。"; }
        emit(); return { ok: true };
      }
      return { ok: false, error: "未知的演示操作。" };
    },
    dispose() { clearTimeout(timer); }
  };
}
