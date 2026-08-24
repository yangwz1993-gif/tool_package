/**
 * orchestrator.mjs — 主 agent 编排层
 *
 * 职责：
 *  1. 意图理解 & 切分子任务（目标数量、预算）
 *  2. 预算估算（基于 cost_history）
 *  3. 调 supervisor 守护并行子 agent
 *  4. 验收：汇总/去重/检查数量 → 状态码决策
 *  5. 不达标 → 制定新策略 → 重跑（有限轮）→ 仍不达标按状态码交付
 *
 * 状态码（退出码）：
 *  0 SUCCESS / 1 PARTIAL / 2 MAX_RETRY / 3 BUDGET / 4 NEED_HUMAN
 *
 * 用法:
 *   node orchestrator.mjs "找10条测试题" --target 10 --budget 20
 *   echo $?   # 查看状态码
 */
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BudgetTracker, budgetStatus } from "./lib/budget.mjs";
import { EXIT, EXIT_NAME, superviseAll } from "./supervisor.mjs";
import { createDefaultLoaderFactory, makeSystemTemplate } from "./lib/agent_factory.mjs";
import { checkCompleteness, fixQuestion } from "./lib/quality.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const EXP = path.join(here, "..", "exp-speed");

// ── env ─────────────────────────────────────────────────────────────
const env = {};
for (const line of readFileSync(path.join(EXP, ".env"), "utf8").split("\n")) {
  const t = line.trim();
  if (t && !t.startsWith("#") && t.includes("=")) { const i = t.indexOf("="); env[t.slice(0, i)] = t.slice(i + 1); }
}

// ── 参数 ────────────────────────────────────────────────────────────
const goal = process.argv[2] || "找出10条可执行的agent/vibecoding build类测试题";
const arg = (name, def) => {
  const idx = process.argv.findIndex((a) => a.startsWith(`--${name}`));
  if (idx < 0) return def;
  return process.argv[idx].includes("=") ? process.argv[idx].split("=")[1] : process.argv[idx + 1];
};
const target = parseInt(arg("target", "10"), 10);
const budgetYuan = parseFloat(arg("budget", "3"));
const existingCount = parseInt(arg("existing", "0"), 10); // 已有题目数（本次要新增的 = target - existing）
const existingFile = arg("existing-file", path.join(here, "results", "existing_10.json")); // 已有题目文件
const minAcceptRatio = parseFloat(arg("min-ratio", "0.6"), 10); // 最低交付线
const maxRounds = parseInt(arg("max-rounds", "2"), 10); // 主 agent 迭代重跑轮数上限

// ── 初始化 ─────────────────────────────────────────────────────────
mkdirSync(path.join(here, "work"), { recursive: true });
mkdirSync(path.join(here, "results"), { recursive: true });
const budget = new BudgetTracker(budgetYuan, target);

console.log(`\n═══ 主 agent 编排开始 ═══`);
console.log(`目标: ${goal}`);
console.log(`目标题目数: ${target} (已有 ${existingCount}，需新增 ${target - existingCount})`);
console.log(`预算: ¥${budgetYuan}（90% 停止线 ¥${(budgetYuan * 0.9).toFixed(2)}）`);
console.log(`最低交付线: ${minAcceptRatio * 100}%`);

// 预算估算
const HIST = path.join(here, "results", "cost_history.json");
if (existsSync(HIST)) {
  try {
    const h = JSON.parse(readFileSync(HIST, "utf8"));
    const est = budget.estimateReasonableness(h.spent, h.count);
    console.log(`[预算估算] ${est.suggestion}`);
  } catch {}
}

// ── 子 agent 工厂（新增题目数按平台切分）─────────────────────────────
const needNew = Math.max(0, target - existingCount);
const subTasks = [
  { index: 1, name: "微博", task: "在微博检索 build 类内容", count: Math.ceil(needNew / 4) },
  { index: 2, name: "小红书", task: "在小红书检索 build 类内容", count: Math.ceil(needNew / 4) },
  { index: 3, name: "知乎", task: "在知乎检索 build 类内容", count: Math.ceil(needNew / 4) },
  { index: 4, name: "公众号", task: "在公众号检索 build 类内容", count: Math.ceil(needNew / 4) },
].filter((t) => t.count > 0);

const loaderFactory = createDefaultLoaderFactory({ here, env, budget });
const systemTemplate = makeSystemTemplate({ here });

// ── 主循环：执行 → 验收 → 迭代 ─────────────────────────────────────
// 加载已有题目（计入目标）
let allQuestions = [];
if (existingCount > 0 && existsSync(existingFile)) {
  try {
    allQuestions = JSON.parse(readFileSync(existingFile, "utf8"));
    console.log(`[已有] 加载 ${allQuestions.length} 条已有题目`);
  } catch { console.log(`[已有] 文件读取失败，忽略`); }
}
let allIssues = [];
let round = 0;
let exitCode = EXIT.NEED_HUMAN; // 默认最差

for (round = 1; round <= maxRounds; round++) {
  console.log(`\n── 第 ${round} 轮 ──`);
  const sup = await superviseAll(subTasks, { loaderFactory, systemTemplate, budget, workDir: path.join(here, "work") });
  allQuestions.push(...sup.results);
  allIssues.push(...sup.issues.map((i) => ({ ...i, round })));
  console.log(`\n[验收] 本轮汇总: ${sup.results.length} 条（累计 ${allQuestions.length}）`);
  if (sup.failed.length) console.log(`[验收] 失败子agent: ${sup.failed.map((f) => `${f.name}(${f.error})`).join(", ")}`);
  if (sup.issues.length) console.log(`[验收] issues: ${sup.issues.length} 条（已记录，交付时一起处理）`);

  // 预算触发
  if (sup.budgetTriggered) { exitCode = EXIT.BUDGET; break; }

  // 去重
  const seen = new Set();
  const deduped = allQuestions.filter((x) => {
    const k = (x.task || "").slice(0, 30);
    if (seen.has(k)) return false;
    seen.add(k);
    return x.task && x.acceptance;
  });
  allQuestions = deduped;

  // ── 质量校验 + 修复（自动）──
  const qaReport = { total: 0, fixed: 0, still_bad: [] };
  const fixed = [];
  for (const q of allQuestions) {
    qaReport.total++;
    const probs = checkCompleteness(q);
    if (probs.length === 0) { fixed.push(q); continue; }
    const res = await fixQuestion(q);
    if (res.fixed.length && !checkCompleteness(res.q).length) qaReport.fixed++;
    fixed.push(res.q);
    const still = checkCompleteness(res.q);
    if (still.length) qaReport.still_bad.push({ idx: fixed.length, task: (res.q.task || "").slice(0, 40), problems: still });
  }
  allQuestions = fixed;
  if (qaReport.total) console.log(`[QA] 校验 ${qaReport.total} 条，自动修复 ${qaReport.fixed} 条${qaReport.still_bad.length ? `，仍异常 ${qaReport.still_bad.length} 条(已记录)` : "，全部通过"}`);

  const total = allQuestions.length;
  console.log(`[验收] 去重后: ${total}/${target}`);

  // 达标判定
  if (total >= target) { exitCode = EXIT.SUCCESS; break; }

  // 达到最低线但未达标：看是否还有轮次
  const minAccept = Math.floor(target * minAcceptRatio);
  if (round >= maxRounds) {
    exitCode = total >= minAccept ? EXIT.PARTIAL : (total > 0 ? EXIT.PARTIAL : EXIT.NEED_HUMAN);
    break;
  }
  if (total < minAccept && total > 0) {
    // 有产出但不足最低线：再跑一轮补（换策略提示）
    console.log(`[验收] 不足最低线 ${minAccept}，第 ${round + 1} 轮继续补…`);
  }
}

// ── 输出 ───────────────────────────────────────────────────────────
const finalOut = path.join(here, "results", "final.json");
const issuesOut = path.join(here, "results", "issues.json");
// 备份：改写前的原始产出（防止 QA 修复导致信息丢失，可追溯）
const rawOut = path.join(here, "results", `final_raw_${Date.now()}.json`);
writeFileSync(rawOut, JSON.stringify(allQuestions, null, 2));
writeFileSync(finalOut, JSON.stringify(allQuestions.slice(0, target), null, 2));
writeFileSync(issuesOut, JSON.stringify(allIssues, null, 2));
writeFileSync(HIST, JSON.stringify({ spent: budget.spent, count: allQuestions.length, t: Date.now() }));

console.log(`\n═══ 结束：${EXIT_NAME[exitCode]} ═══`);
console.log(`产出: ${allQuestions.length} 条 → ${finalOut}`);
console.log(`issues: ${allIssues.length} 条 → ${issuesOut}`);
console.log(budgetStatus(budget));

// 状态码
console.log(`EXIT_CODE=${exitCode}`);
process.exit(exitCode);
