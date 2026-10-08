/**
 * plan-handoff 的 pi 命令入口 —— 两条命令，各管一件事
 *
 *   /handoff-read  [方案.json] [关注点]  读：理解当前项目（只读，不改任何文件）
 *   /handoff-write [方案.json] [本次需求] 写：新建或更新 handoff 方案文件
 *
 * 设计原则：**能不问就不问**。
 *   - 不再弹「读 / 写」选择框（命令名已经说清楚了）
 *   - 当前仓库 handoff/ 下只有一个方案 JSON → 直接采用，不弹确认框
 *   - 有多个 → 才弹列表（带修改时间），读/写共享；写模式多一个「🆕 新建」
 *   - 一个都没有 + 写模式 → 直接 `hdo init` 建一个（不再弹「是否新建」确认框）
 *   - 参数里可以带方案路径（以 .json 结尾的 token），带上就跳过所有推导
 *   - 需要弹窗但当前模式没 UI（print / json）→ 报错并告诉你怎么用参数指定
 *
 * 浮窗交互过程不进上下文，只有最后拼好的那条指令会作为用户消息发给 agent。
 * Esc 随时取消。
 *
 * 工具目录（含 hdo.py 的那个文件夹）定位顺序，见 resolveToolDir()：
 *   环境变量 HANDOFF_TOOL_DIR → 配置文件 ~/.pi/agent/handoff-tool.json
 *   → 扩展自己所在目录及其上一级 → 实在没有才问一次并记住
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

// 用户可以自己指定 python 解释器（Windows 上常是 python 而不是 python3）
const PYTHON = process.env.HANDOFF_PYTHON?.trim() || "python3";
const CONFIG_FILE = path.join(os.homedir(), ".pi", "agent", "handoff-tool.json");
/** 方案 JSON 的相对位置约定：<仓库根>/handoff/*.json */
const PLAN_DIR = "handoff";

const NEW_PLAN = "🆕 新建一个方案…";
const CUSTOM_PATH = "✏️ 自己填路径…";

type ToolPaths = { dir: string; hdo: string; skill?: string };
type PlanFile = { file: string; mtimeMs: number };
type Mode = "read" | "write";

/* ------------------------------------------------------------------ *
 * 工具目录：找到 hdo.py 所在文件夹
 * ------------------------------------------------------------------ */

/** 目录里有 hdo.py 就算有效；skill.md 是文档，缺了也能跑，只是少一段引导 */
function usable(dir?: string | null): ToolPaths | undefined {
  if (!dir) return undefined;
  const hdo = path.join(dir, "hdo.py");
  if (!fs.existsSync(hdo)) return undefined;
  const skill = path.join(dir, "skill.md");
  return { dir, hdo, skill: fs.existsSync(skill) ? skill : undefined };
}

function readConfig(): string | undefined {
  try {
    const j = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
    return typeof j.toolDir === "string" ? j.toolDir : undefined;
  } catch {
    return undefined; // 没配过 / 文件坏了都当没配，走后面的引导
  }
}

function saveConfig(dir: string): void {
  try {
    fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify({ toolDir: dir }, null, 2) + "\n", "utf8");
  } catch {
    // 存不下就算了，下次再问一遍而已，不该因此中断
  }
}

/** 扩展自己所在目录 + 上一级：支持「整个文件夹复制到 extensions/」的零配置用法 */
function selfDirs(): string[] {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    return [here, path.dirname(here)];
  } catch {
    return [];
  }
}

let cachedTool: ToolPaths | undefined;

/** 命中就缓存；没命中不缓存（用户可能刚在浮窗里填了路径） */
function resolveToolDir(): ToolPaths | undefined {
  if (cachedTool) return cachedTool;
  for (const c of [process.env.HANDOFF_TOOL_DIR, readConfig(), ...selfDirs()]) {
    const hit = usable(c);
    if (hit) {
      cachedTool = hit;
      return hit;
    }
  }
  return undefined;
}

async function ensureToolDir(ctx: ExtensionCommandContext): Promise<ToolPaths | undefined> {
  const hit = resolveToolDir();
  if (hit) return hit;

  if (!ctx.hasUI) {
    ctx.ui.notify(
      "没找到 plan-handoff 工具目录（里面有 hdo.py）。设环境变量 HANDOFF_TOOL_DIR=<目录> 后重试。",
      "error",
    );
    return undefined;
  }

  ctx.ui.notify(
    "没找到 plan-handoff 工具目录（里面有 hdo.py 即可；skill.md 是可选的说明文档）。\n" +
      "可以设环境变量 HANDOFF_TOOL_DIR=<目录>，或在下面填一次，之后会记住。",
    "info",
  );
  const dir = await ctx.ui.input("plan-handoff 工具目录", "/path/to/plan-handoff（含 hdo.py）");
  if (dir === undefined || !dir.trim()) {
    ctx.ui.notify("已取消", "info");
    return undefined;
  }
  const verified = usable(dir.trim());
  if (!verified) {
    ctx.ui.notify(`该目录里没有找到 hdo.py：${dir.trim()}`, "error");
    return undefined;
  }
  saveConfig(dir.trim());
  cachedTool = verified;
  ctx.ui.notify(`已记住工具目录：${dir.trim()}`, "info");
  return verified;
}

/* ------------------------------------------------------------------ *
 * 方案文件：定位 / 新建
 * ------------------------------------------------------------------ */

function listPlans(cwd: string): PlanFile[] {
  const dir = path.join(cwd, PLAN_DIR);
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => path.join(dir, f))
      .map((file) => ({ file, mtimeMs: fs.statSync(file).mtimeMs }))
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
  } catch {
    return []; // handoff/ 不存在＝没有方案文件
  }
}

const rel = (cwd: string, file: string): string => path.relative(cwd, file) || file;

const absPlan = (cwd: string, p: string): string => (path.isAbsolute(p) ? p : path.resolve(cwd, p));

function fmtTime(ms: number): string {
  try {
    return new Date(ms).toLocaleString("zh-CN", { hour12: false, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

const cmdName = (mode: Mode): string => (mode === "read" ? "handoff-read" : "handoff-write");

/**
 * 参数拆解：把「方案路径」和「需求/关注点」分开。
 * 只在下面两种情况认路径，避免把需求正文里的 config.json 误当方案路径：
 *   1) 首个 token 以 .json 结尾 —— 显式写在最前面，无条件当路径；
 *   2) 其它位置恰好一个 token 以 .json 结尾，且看起来像方案文件（handoff/ 下或 *_方案.json）
 *      而且文件确实存在 —— 兼容「需求写在前面、路径写在后面」的用法。
 * 其余文字原样返回（读模式＝关注点，写模式＝需求）。
 * 这样 /handoff-write 顺手加个缓存 和 /handoff-write handoff/xxx_方案.json 顺手加个缓存 都能用。
 */
function splitArgs(args: string, cwd: string): { explicit?: string; rest: string } {
  const tokens = args.split(/\s+/).filter(Boolean);
  const strip = (t: string): string => t.replace(/^["']|["']$/g, "");
  const isJson = (t: string): boolean => strip(t).endsWith(".json");
  const looksLikePlan = (t: string): boolean => /(^|[\\/])handoff[\\/]/.test(t) || /_方案\.json$/.test(t);

  let idx = -1;
  if (tokens.length && isJson(tokens[0])) {
    idx = 0; // 显式写在最前面，照用
  } else {
    const cands = tokens.map((t, i) => (isJson(t) ? i : -1)).filter((i) => i >= 0);
    if (
      cands.length === 1 &&
      looksLikePlan(strip(tokens[cands[0]])) &&
      fs.existsSync(absPlan(cwd, strip(tokens[cands[0]])))
    ) {
      idx = cands[0];
    }
  }
  if (idx < 0) return { rest: tokens.join(" ") };
  return { explicit: strip(tokens[idx]), rest: tokens.filter((_, i) => i !== idx).join(" ") };
}

async function askPath(ctx: ExtensionCommandContext, title: string): Promise<string | undefined> {
  if (!ctx.hasUI) return undefined;
  const p = await ctx.ui.input(title, "/绝对路径/YYMMDD_项目名_方案.json");
  if (p === undefined || !p.trim()) {
    ctx.ui.notify("已取消", "info");
    return undefined;
  }
  const file = absPlan(ctx.cwd, p.trim());
  if (!fs.existsSync(file)) {
    ctx.ui.notify(`文件不存在：${file}`, "error");
    return undefined;
  }
  return file;
}

/** 走一次 hdo init：在仓库根建 handoff/ 并生成 JSON 骨架（不生成 HTML，交给 agent 填完后 gen） */
async function createPlan(ctx: ExtensionCommandContext, tool: ToolPaths): Promise<string | undefined> {
  const cwd = ctx.cwd;
  if (cwd === os.homedir() || cwd === path.parse(cwd).root) {
    ctx.ui.notify(`当前目录不是项目目录（${cwd}），先 cd 到项目根目录再执行 /handoff-write。`, "error");
    return undefined;
  }

  const fallback = path.basename(cwd) || "project";
  let name = fallback;
  if (ctx.hasUI) {
    const typed = await ctx.ui.input(`项目名（生成 handoff/YYMMDD_<项目名>_方案.json）`, fallback);
    if (typed === undefined) {
      ctx.ui.notify("已取消", "info");
      return undefined;
    }
    name = typed.trim() || fallback;
  }

  try {
    const out = execFileSync(PYTHON, [tool.hdo, "init", cwd, name], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const matched = /已创建\s+(\S+)/.exec(out);
    const file = matched ? matched[1] : listPlans(cwd)[0]?.file;
    if (!file) {
      ctx.ui.notify(`hdo init 没有报错，但没找到新建的 JSON。输出：${out.trim()}`, "warning");
      return undefined;
    }
    ctx.ui.notify(`已创建 ${rel(cwd, file)}`, "info");
    return file;
  } catch (e: any) {
    const msg = String(e?.stderr || e?.message || e).trim();
    ctx.ui.notify(
      `hdo init 失败：${msg}\n（若是找不到解释器，可用环境变量 HANDOFF_PYTHON 指定 python）`,
      "error",
    );
    return undefined;
  }
}

/** 定位本次要操作的方案 JSON；只在与用户交互（选择/填写/取消）有关的地方返回 undefined */
async function resolvePlan(
  ctx: ExtensionCommandContext,
  tool: ToolPaths,
  mode: Mode,
  explicit: string | undefined,
): Promise<string | undefined> {
  const cwd = ctx.cwd;

  // 1. 参数里显式给了路径 → 照用，不推导
  if (explicit) {
    const file = absPlan(cwd, explicit);
    if (!fs.existsSync(file)) {
      ctx.ui.notify(
        `找不到方案文件：${explicit}\n（不想指定路径、想让 /${cmdName(mode)} 自己找或新建的话，把参数里的 .json 路径去掉）`,
        "error",
      );
      return undefined;
    }
    return file;
  }

  const plans = listPlans(cwd);

  // 2. 唯一一个 → 直接用，连确认框都不弹
  if (plans.length === 1) {
    if (mode === "write") ctx.ui.notify(`方案文件：${rel(cwd, plans[0].file)}`, "info");
    return plans[0].file;
  }

  // 3. 多个 → 这才需要问
  if (plans.length > 1) {
    const items = plans.map((p) => `${path.basename(p.file)}（${fmtTime(p.mtimeMs)}）`);
    items.push(CUSTOM_PATH);
    if (mode === "write") items.splice(plans.length, 0, NEW_PLAN); // 新建排在最后一个真实方案之后

    if (!ctx.hasUI) {
      ctx.ui.notify(
        `handoff/ 下有 ${plans.length} 个方案文件，当前模式无法弹窗选择。\n` +
          `请显式指定：/${cmdName(mode)} handoff/<文件名>.json`,
        "error",
      );
      return undefined;
    }

    const pick = await ctx.ui.select(`选择方案文件（${mode === "read" ? "读" : "写"}）`, items);
    if (pick === undefined) {
      ctx.ui.notify("已取消", "info");
      return undefined;
    }
    if (pick === NEW_PLAN) return createPlan(ctx, tool);
    if (pick === CUSTOM_PATH) return askPath(ctx, "方案文件路径");
    return plans[items.indexOf(pick)].file;
  }

  // 4. 一个都没有
  if (mode === "write") return createPlan(ctx, tool);

  ctx.ui.notify(`handoff/ 下还没有方案文件（${path.join(cwd, PLAN_DIR)}）`, "info");
  if (!ctx.hasUI) {
    ctx.ui.notify(`请显式指定：/${cmdName(mode)} <方案.json 路径>`, "error");
    return undefined;
  }
  return askPath(ctx, "方案文件路径");
}

/* ------------------------------------------------------------------ *
 * 发给 agent 的指令
 * ------------------------------------------------------------------ */

function readInstruction(file: string, tool: ToolPaths, focus: string): string {
  return [
    `理解下 ${file}。`,
    `这是 handoff 方案文件：一份 JSON，记录该项目的整体目标（含衡量指标）、工程流程图（节点与连线）、当前 TODO、当前状态（阻塞/进行中/已完成）、经验沉淀、当前仓库结构；配套的可视化报告是同目录下的 *_方案报告.html。` +
      (tool.skill ? `字段含义与命名约定见 ${tool.skill}，先读它再解释。` : ""),
    `请同时调查它所在的仓库（README、目录结构、关键代码），然后简要汇报：1）项目背景 2）项目目标 3）当前 TODO（按优先级） 4）当前状态与阻塞。`,
    focus ? `本次重点关注：${focus}` : "",
    `如果发现 JSON 与仓库实际状态对不上（TODO 已完成但没销账、文件已删流程图里还画着、repo_tree 过期等），明确指出来。`,
    `只汇报，不要改动任何文件。`,
  ]
    .filter(Boolean)
    .join("\n");
}

function writeInstruction(file: string, tool: ToolPaths, request: string): string {
  return [
    `根据 handoff 的要求更新 ${file}。`,
    request ? `本次需求：${request}` : `本次需求：按 JSON 里现有 TODO/状态继续推进，并把本次改动如实记进 JSON。`,
    tool.skill
      ? `先完整读 ${tool.skill}，重点看「字段规范」「handoff 目录约定」「hdo.py 命令参考」三节，不要凭记忆或惯例开工。`
      : `维护工具是 ${tool.hdo}。`,
    `维护一律走 hdo 命令（todo / status / exp / tree set，改完自动重新生成报告）；只有初版创建和流程图、目标等结构性改动才直接编辑 JSON，改完跑 python3 ${tool.hdo} ${file} gen。`,
    `禁止全量重写 JSON。完成后向人汇报 JSON 路径与最新 HTML 路径。`,
  ].join("\n");
}

/* ------------------------------------------------------------------ *
 * 命令注册
 * ------------------------------------------------------------------ */

export default function (pi: ExtensionAPI) {
  // 补全需要知道当前仓库在哪；命令里有 ctx.cwd，补全回调里没有，所以在 session_start 记一份
  let sessionCwd: string | undefined;
  pi.on("session_start", (_event, ctx) => {
    sessionCwd = ctx.cwd;
  });

  const planCompletions = (prefix: string): { value: string; label: string; description?: string }[] | null => {
    const cwd = sessionCwd ?? process.cwd();
    const p = prefix.trim();
    // 只有看起来在写路径时才补全：空参数是「关注点 / 需求」或「自动定位」，不能弹菜单抢回车
    if (!p || /\s/.test(p) || (!/^[.~/]|^h/i.test(p) && !p.endsWith(".json"))) return null;
    return listPlans(cwd)
      .map((x) => ({ value: rel(cwd, x.file), label: path.basename(x.file), description: `改动于 ${fmtTime(x.mtimeMs)}` }))
      .filter((i) => i.value.startsWith(p));
  };

  pi.registerCommand("handoff-read", {
    description: "读 handoff 方案：理解当前项目（只读，不改文件）",
    getArgumentCompletions: planCompletions,
    handler: async (args, ctx) => {
      const { explicit, rest } = splitArgs(args, ctx.cwd);
      const tool = await ensureToolDir(ctx);
      if (!tool) return;
      const file = await resolvePlan(ctx, tool, "read", explicit);
      if (!file) return;
      pi.sendUserMessage(readInstruction(file, tool, rest));
      ctx.ui.notify(`已发送：读 ${rel(ctx.cwd, file)}`, "info");
    },
  });

  pi.registerCommand("handoff-write", {
    description: "写 handoff 方案：新建或更新当前项目的方案文件",
    getArgumentCompletions: planCompletions,
    handler: async (args, ctx) => {
      const { explicit, rest } = splitArgs(args, ctx.cwd);
      const tool = await ensureToolDir(ctx);
      if (!tool) return;
      const file = await resolvePlan(ctx, tool, "write", explicit);
      if (!file) return;
      pi.sendUserMessage(writeInstruction(file, tool, rest));
      ctx.ui.notify(`已发送：写 ${rel(ctx.cwd, file)}`, "info");
    },
  });
}
