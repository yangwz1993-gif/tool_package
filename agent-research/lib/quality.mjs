// lib/quality.mjs — 题目质量校验与修复
// 目标：保证每道题完整、可执行，避免截断/过度简化/方式状语前缀
import { ds } from "./llm.mjs";

/**
 * 完整性检查：返回问题列表（空数组 = 完整）
 */
export function checkCompleteness(q) {
  const problems = [];
  const task = (q.task || "").trim();
  const acc = (q.acceptance || "").trim();

  if (!task) problems.push("缺 task");
  else {
    if (task.length < 30) problems.push(`task过短(${task.length}字)`);
    if (/[、，：:，、]$/.test(task)) problems.push("task以标点结尾(可能截断)");
    if (/(具体交付|要求[：:]|如下[：:]|包括[：:]|功能[：:]|步骤[：:]|1[）)]?[：:]?)$/.test(task)) {
      problems.push("task以列举引导词结尾(可能截断)");
    }
  }
  if (!acc) problems.push("缺验收标准");
  else if (acc.length < 15) problems.push(`验收过短(${acc.length}字)`);
  if (!q.difficulty || !/简单|中等|困难/.test(q.difficulty)) problems.push("缺难度");
  if (!q.source) problems.push("缺来源");

  return problems;
}

/**
 * 规则优先：移除 task 开头的方式状语（"用 AI / 用 vibecoding / 借助 XX"）
 * 只删前置方式状语，正文原样保留 → 无信息损失
 *
 * 处理模式（大小写不敏感）：
 *   "用 AI 做一个X"           → "做一个X"
 *   "用 vibecoding 做一个X"    → "做一个X"
 *   "使用 Vibe Coding（…）做一个X" → "做一个X"
 *   "借助 XX 工具搭建X"        → "搭建X"
 *   "用 AI 编程从0开发X"       → "开发X"
 */
export function stripToolPrefix(task) {
  const t = (task || "").trim();
  if (!t) return { task: "", changed: false };

  // 方式词（要删的），含空格变体
  const WAYS = [
    "vibecoding", "vibe coding", "vibecoding方式", "vibe coding方式",
    "coding agent", "AI对话式编程", "自然语言编程", "AI辅助设计",
    "AI写代码", "AI coding", "AI编程", "编程工具", "AI工具", "AI辅助", "AI生成",
    "AI",
  ].join("|");

  // 方式状语短语：开头用/使用/借助/通过 + 方式词（AI 后可接 编程/工具/coding 等）+
  // 可选括号说明 + 可选“的方式/方式/来/去/从零/从0” + 可选逗号/顿号
  const re = new RegExp(
    `^[用使用借助通过]{1,4}\\s*(?:${WAYS})\\s*` +
    `(?:[（(][^）)]*[）)])?\\s*` +
    `(?:的方式|方式|来|去|从零|从0)?\\s*[，,、]?\\s*`,
    "i"
  );

  const m = t.match(re);
  if (m && m[0].length >= 3) {
    let rest = t.slice(m[0].length);
    // 清理残留：括号说明、残留的方式词后缀（编程/辅助/工具等）
    rest = rest.replace(/^[（(][^）)]*[）)]\s*/, "");
    rest = rest.replace(/^(?:编程|工具|coding|辅助|辅助设计|写代码|对话式编程)\s*/, "");
    rest = rest.replace(/^[，,、]\s*/, "");
    // 防误删：剩余部分不能太短（必须还有实质内容）
    if (rest.length >= 10) return { task: rest, changed: true };
  }
  return { task: t, changed: false };
}

/**
 * LLM 改写 + 校验：改写后若不完整则回退原文（用于规则无法处理的复杂情况）
 */
export async function rewriteTaskSafely(task) {
  const SYS = `你是测试题编辑。改写下面的题目：去掉开头的「用 AI / 用 AI 工具 / 用 Coding Agent / 使用 AI 工具 / 用 vibecoding / 借助 XX / 通过 XX」这类方式状语，直接以动词开头（开发/实现/构建/做一个/搭建…）描述要交付的东西。内容本身需要 AI 的（如"AI 识别照片"）保留。必须保留原文所有功能要求和细节，不得删减。只输出改写后的文本，不要解释。`;
  const r = await ds(SYS, `TASK: ${task}`, { maxTokens: 1200 });
  const clean = (r || "").replace(/^["'`TASK:\s*]|["'`]$/g, "").trim();
  // 校验：改写后不能比原文短太多（防过度简化）、不能截断
  if (!clean || clean.length < task.length * 0.6 || /[、，：:]$/.test(clean)) {
    return { task, changed: false, reason: "改写结果不可靠，回退原文" };
  }
  return { task: clean, changed: true };
}

/**
 * 综合修复一条题目：规则 → LLM → 校验，确保完整
 */
export async function fixQuestion(q) {
  const result = { ...q };
  const fixes = [];

  // 1. 方式状语前缀（规则优先，无信息损失）
  if (result.task) {
    const strip = stripToolPrefix(result.task);
    if (strip.changed) { result.task = strip.task; fixes.push("规则去前缀"); }
  }

  // 2. 完整性校验
  let probs = checkCompleteness(result);

  // 3. 校验仍失败 → LLM 安全改写（补全/修复）
  if (probs.length > 0 && result.task) {
    const rw = await rewriteTaskSafely(result.task);
    if (rw.changed) { result.task = rw.task; fixes.push("LLM改写"); }
    probs = checkCompleteness(result);
  }

  if (probs.length > 0) fixes.push(`仍存在问题: ${probs.join(";")}`);
  return { q: result, fixed: fixes };
}
