/**
 * supervisor.mjs — 守护层：监控子 agent 存活/产出/超时/预算，限次重启，状态码决策
 *
 * 职责：
 *  - spawn 子 agent（独立 pi session），并行执行
 *  - 监控：产出数量 / 超时 / 异常终止 / 预算 90%
 *  - 异常 → 限次重启（≤3 次）→ 仍失败标记 FAILED 并记录 issues
 *  - 汇总产出 + issues → 返回给 orchestrator（主 agent）
 *
 * 状态码协议（orchestrator 据此决策）：
 *   EXIT_SUCCESS    = 0  目标全部达成
 *   EXIT_PARTIAL    = 1  达到最低线(≥60%)，交付部分
 *   EXIT_MAX_RETRY  = 2  重试超限
 *   EXIT_BUDGET     = 3  预算 90% 停止线触发
 *   EXIT_NEED_HUMAN = 4  必须人判断（条件极苛刻：全平台不可用+无降级路径）
 */
import { createAgentSession, DefaultResourceLoader, ModelRegistry, AuthStorage, SessionManager, SettingsManager } from "@mariozechner/pi-coding-agent";
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export const EXIT = { SUCCESS: 0, PARTIAL: 1, MAX_RETRY: 2, BUDGET: 3, NEED_HUMAN: 4 };
export const EXIT_NAME = { 0: "SUCCESS", 1: "PARTIAL", 2: "MAX_RETRY", 3: "BUDGET", 4: "NEED_HUMAN" };

const MAX_RETRIES = 3;
const SUB_TIMEOUT_MS = 5 * 60 * 1000; // 子 agent 单次尝试超时 5 分钟

/**
 * 运行一个受守护的子 agent。
 * @param {object} opts { index, name, task, count, systemTemplate, loaderFactory, budget, workDir }
 * @returns {Promise<{status:string, results:Array, issues:Array, attempts:number, error?:string}>}
 */
export async function runGuardedSubAgent(opts) {
  const { index, name, task, count, systemTemplate, loaderFactory, budget, workDir } = opts;
  const issues = [];
  let attempts = 0;
  let lastError = "";

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    attempts = attempt;
    // 预算检查：达到 90% 停止线则不再尝试（启动前硬检查）
    if (budget.shouldStop) {
      return { status: "BUDGET", results: [], issues, attempts, error: "预算90%停止线" };
    }
    console.log(`  [supervisor] 子agent ${index}(${name}) 第${attempt}/${MAX_RETRIES}次尝试…`);
    try {
      const session = await loaderFactory(index);
      let usageTotal = { input: 0, output: 0, cached: 0 };
      session.subscribe((ev) => {
        if (ev.type === "message_end" && ev.message?.role === "assistant" && ev.message.usage) {
          const u = ev.message.usage;
          usageTotal.input += u.input || 0;
          usageTotal.output += u.output || 0;
          usageTotal.cached += u.cacheRead || 0;
          budget.spend({ inputTokens: u.input || 0, outputTokens: u.output || 0, cachedTokens: u.cacheRead || 0, note: `子agent${index}` });
        }
      });

      // 超时保护
      const promptPromise = session.prompt(`你的编号是 ${index}。请检索并产出 ${count} 道测试题，最终写入 /tmp/subagent_${index}.json。子任务范围：${task}`);
      const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error("子agent超时")), SUB_TIMEOUT_MS));
      await Promise.race([promptPromise, timeout]);

      console.log(`  [supervisor] 子agent ${index} 完成，tokens in=${usageTotal.input} out=${usageTotal.output} cached=${usageTotal.cached} | 预算 ${(budget.ratio * 100).toFixed(1)}%`);
      session.dispose();

      // 读取产出
      let results = [];
      try { results = JSON.parse(readFileSync(`/tmp/subagent_${index}.json`, "utf8")); } catch {}
      // 读取 issues（子 agent 写的小问题记录）
      try { issues.push(...JSON.parse(readFileSync(`/tmp/subagent_${index}.issues.json`, "utf8"))); } catch {}

      if (Array.isArray(results) && results.length > 0) {
        return { status: "OK", results, issues, attempts };
      }
      // 产出 0：可能是子 agent 没完成任务，重试
      lastError = "产出为空";
      if (attempt < MAX_RETRIES) {
        console.log(`  [supervisor] 子agent ${index} 产出为空，重试…`);
      }
    } catch (e) {
      lastError = e.message.slice(0, 120);
      console.log(`  [supervisor] 子agent ${index} 异常: ${lastError}`);
      if (attempt < MAX_RETRIES) {
        console.log(`  [supervisor] 重试…`);
      }
      try { writeFileSync(`/tmp/subagent_${index}.issues.json`, JSON.stringify([...issues, { type: "subagent_error", msg: lastError, attempt }])); } catch {}
    }
  }
  return { status: "FAILED", results: [], issues, attempts, error: lastError };
}

/**
 * 守护所有子 agent，返回汇总状态码和结果。
 */
export async function superviseAll(subTasks, { loaderFactory, systemTemplate, budget, workDir }) {
  mkdirSync(workDir, { recursive: true });
  const guarded = subTasks.map((st) => runGuardedSubAgent({ ...st, systemTemplate, loaderFactory, budget, workDir }));
  const outcomes = await Promise.all(guarded);

  const results = [];
  const issues = [];
  const failed = [];
  for (let i = 0; i < outcomes.length; i++) {
    const o = outcomes[i];
    results.push(...(Array.isArray(o.results) ? o.results : []));
    issues.push(...(o.issues || []));
    if (o.status === "FAILED" || o.status === "BUDGET") failed.push({ index: i + 1, name: subTasks[i].name, status: o.status, error: o.error, attempts: o.attempts });
  }

  // 预算状态
  const budgetTriggered = budget.shouldStop;

  return { results, issues, failed, budgetTriggered, budget };
}
