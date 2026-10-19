(() => {
  "use strict";

  const MODES = new Set(["all", "newer", "older"]);

  function normalizeHandle(input) {
    if (typeof input !== "string") return null;
    let value = input.trim();
    if (/^https?:\/\//i.test(value)) {
      try {
        const url = new URL(value);
        if (!["x.com", "www.x.com", "twitter.com", "www.twitter.com"].includes(url.hostname.toLowerCase())) return null;
        if (url.username || url.password || url.port || url.search || url.hash) return null;
        const match = url.pathname.match(/^\/([A-Za-z0-9_]{1,15})\/?$/);
        if (!match) return null;
        value = match[1];
      } catch {
        return null;
      }
    }
    value = value.replace(/^@/, "");
    return /^[A-Za-z0-9_]{1,15}$/.test(value) ? value.toLowerCase() : null;
  }

  function validateOptions(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("清理选项无效。");
    if (!MODES.has(input.mode)) throw new Error("请选择全部、指定账号及之前，或指定账号及之后。");
    if (input.dryRun !== undefined && typeof input.dryRun !== "boolean") throw new Error("只检查选项必须为布尔值。");
    const boundary = input.mode === "all" ? "" : normalizeHandle(input.boundary);
    if (input.mode !== "all" && !boundary) throw new Error("请输入有效的账号 ID，例如 @example。");
    return { mode: input.mode, boundary, dryRun: input.dryRun === true };
  }

  function uniqueRows(rows) {
    if (!Array.isArray(rows)) throw new Error("关注列表无效。");
    const result = [];
    const indexes = new Map();
    for (const row of rows) {
      const handle = normalizeHandle(row?.handle);
      if (!handle) throw new Error("列表中出现无法识别的账号，已停止。");
      const current = { ...row, handle };
      if (!indexes.has(handle)) {
        indexes.set(handle, result.length);
        result.push(current);
        continue;
      }
      const previous = result[indexes.get(handle)];
      const mismatch = previous.userId && current.userId && previous.userId !== current.userId;
      // A positive relationship marker always wins, even over a newer absence.
      if (previous.followsYou === true || current.followsYou === true) {
        result[indexes.get(handle)] = { ...previous, followsYou: true, relationshipVerified: true };
      } else if (mismatch || previous.following !== current.following || previous.followsYou !== current.followsYou) {
        result[indexes.get(handle)] = { ...previous, followsYou: null, relationshipVerified: false, inconsistent: true };
      } else {
        result[indexes.get(handle)] = {
          ...previous,
          relationshipVerified: previous.relationshipVerified === true && current.relationshipVerified === true,
        };
      }
    }
    return result;
  }

  function selectScope(rows, input) {
    const options = validateOptions(input);
    const ordered = uniqueRows(rows);
    if (options.mode === "all") return ordered;
    const boundaryIndex = ordered.findIndex((row) => row.handle === options.boundary);
    if (boundaryIndex < 0) throw new Error(`没有找到 @${options.boundary}。本次不会取消关注任何人。`);
    return options.mode === "newer" ? ordered.slice(0, boundaryIndex + 1) : ordered.slice(boundaryIndex);
  }

  function classifyRow(row) {
    if (row.followsYou === true) return "protected";
    if (row.following === false) return "protected";
    if (row.following === true && row.followsYou === false && row.relationshipVerified === true && !row.inconsistent) return "eligible";
    return "unknown";
  }

  function buildPlan(rows, input) {
    const options = validateOptions(input);
    const selected = selectScope(rows, options);
    const plan = { options, selected, candidates: [], protected: [], unknown: [], scopeCount: selected.length };
    for (const row of selected) {
      const classification = classifyRow(row);
      if (classification === "eligible") plan.candidates.push(row);
      else if (classification === "protected") plan.protected.push(row);
      else plan.unknown.push(row);
    }
    return plan;
  }

  globalThis.XCleanerCore = Object.freeze({ normalizeHandle, validateOptions, uniqueRows, selectScope, classifyRow, buildPlan });
})();
