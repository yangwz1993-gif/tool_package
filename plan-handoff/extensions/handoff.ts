/**
 * /handoff — 方案文件读写入口（浮窗交互版）
 *
 * 用户输入 /handoff 回车后，全程浮窗交互：
 *   1) 选「读 / 写」
 *   2) 自动扫描当前仓库 handoff/ 下的方案 JSON，确认或手填路径（写模式没有就问是否新建）
 *   3) 只把最终指令作为用户消息发给 agent（pi.sendUserMessage），交互过程不进上下文
 *
 * 兼容老用法：/handoff <需求文字> → 跳过读/写选择，直接走写流程（路径仍走浮窗确认）。
 *
 * 工具目录（含 hdo.py 与 skill.md 的那个文件夹）的定位顺序，见 resolveToolDir()：
 *   环境变量 HANDOFF_TOOL_DIR → 配置文件 → 扩展自己所在目录及其上一级 → 首次运行引导
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

// 用户可以自己指定 python 解释器（Windows 上常是 python 而不是 python3）
const PYTHON = process.env.HANDOFF_PYTHON?.trim() || "python3";
const CONFIG_FILE = path.join(os.homedir(), ".pi", "agent", "handoff-tool.json");

type ToolPaths = { hdo: string; skill: string };

/** 目录里必须同时有 hdo.py 和 skill.md，才算有效的工具目录 */
function usable(dir: string | undefined): ToolPaths | undefined {
  if (!dir) return undefined;
  const hdo = path.join(dir, "hdo.py");
  const skill = path.join(dir, "skill.md");
  return fs.existsSync(hdo) && fs.existsSync(skill) ? { hdo, skill } : undefined;
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

function resolveToolDir(): ToolPaths | undefined {
  const candidates = [
    process.env.HANDOFF_TOOL_DIR,
    readConfig(),
    ...selfDirs(),
  ];
  for (const c of candidates) {
    const hit = usable(c);
    if (hit) return hit;
  }
  return undefined;
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("handoff", {
    description: "方案文件读写入口（读=理解+汇报，写=新建/更新；留空则浮窗引导）",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("/handoff 需要交互界面（当前模式无 UI）", "error");
        return;
      }
      const cwd = ctx.cwd;
      const handoffDir = path.join(cwd, "handoff");

      // ---------- 第 0 步：定位工具目录（hdo.py / skill.md） ----------
      let tool = resolveToolDir();
      if (!tool) {
        ctx.ui.notify(
          "没找到 plan-handoff 工具目录（里面有 hdo.py 和 skill.md）。\n" +
            "可以设环境变量 HANDOFF_TOOL_DIR=<目录>，或在下面填一次，之后会记住。",
          "info",
        );
        const dir = await ctx.ui.input(
          "plan-handoff 工具目录",
          "/path/to/plan-handoff（含 hdo.py 与 skill.md）",
        );
        if (!dir || !dir.trim()) {
          ctx.ui.notify("已取消", "info");
          return;
        }
        tool = usable(dir.trim());
        if (!tool) {
          ctx.ui.notify(`该目录里没有同时找到 hdo.py 和 skill.md：${dir.trim()}`, "error");
          return;
        }
        saveConfig(dir.trim());
        ctx.ui.notify(`已记住工具目录：${dir.trim()}`, "info");
      }

      // ---------- 第 1 步：读 or 写（带参数则直接写） ----------
      let mode: "read" | "write";
      if (args.trim()) {
        mode = "write";
      } else {
        const pick = await ctx.ui.select("/handoff", [
          "读：理解现有方案 + 调查仓库，汇报背景/目标/TODO",
          "写：新建或更新方案文件",
        ]);
        if (pick === undefined) return; // Esc 取消
        mode = pick.startsWith("写") ? "write" : "read";
      }

      // ---------- 第 2 步：定位方案文件 ----------
      const listPlans = (): string[] => {
        try {
          return fs
            .readdirSync(handoffDir)
            .filter((f) => f.endsWith(".json"))
            .map((f) => path.join(handoffDir, f))
            .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
        } catch {
          return [];
        }
      };
      const askPath = async (title: string) => {
        const p = await ctx.ui.input(title, "/绝对路径/xxx_方案.json");
        return p && p.trim() ? p.trim() : undefined;
      };

      let target: string | undefined;
      const files = listPlans();

      if (files.length === 1) {
        const ok = await ctx.ui.confirm(
          "找到方案文件",
          `${path.relative(cwd, files[0])}\n\n「确定」用它，「取消」自己填路径`,
        );
        target = ok ? files[0] : await askPath("方案文件路径");
      } else if (files.length > 1) {
        const CUSTOM = "✏️ 自己填路径…";
        const items = files.map((f) => {
          const mt = new Date(fs.statSync(f).mtimeMs);
          return `${path.basename(f)}（${mt.toLocaleString("zh-CN", { hour12: false })}）`;
        });
        const pick = await ctx.ui.select("找到多个方案文件", [...items, CUSTOM]);
        if (pick === undefined) return;
        target = pick === CUSTOM ? await askPath("方案文件路径") : files[items.indexOf(pick)];
      } else if (mode === "write") {
        const ok = await ctx.ui.confirm(
          "没有找到方案文件",
          `在仓库根目录新建 handoff/ 吗？\n${handoffDir}\n\n「确定」新建，「取消」自己填路径`,
        );
        if (ok) {
          const defName = path.basename(cwd);
          const name = await ctx.ui.input("项目名（用于文件名）", defName);
          if (name === undefined) return;
          try {
            execFileSync(PYTHON, [tool.hdo, "init", cwd, name.trim() || defName], { stdio: "pipe" });
          } catch (e: any) {
            const msg = String(e?.stderr || e?.message || e);
            ctx.ui.notify(
              `hdo init 失败：${msg.trim()}\n（若是找不到解释器，可用环境变量 HANDOFF_PYTHON 指定 python）`,
              "error",
            );
            return;
          }
          target = listPlans()[0];
          if (target) ctx.ui.notify(`已创建 ${path.relative(cwd, target)}`, "info");
        } else {
          target = await askPath("方案文件路径");
        }
      } else {
        target = await askPath("没有找到方案文件，请粘贴路径");
      }

      if (!target) {
        ctx.ui.notify("已取消", "info");
        return;
      }

      // ---------- 第 3 步：只把最终指令发给 agent ----------
      if (mode === "write") {
        const req = args.trim();
        pi.sendUserMessage(
          `根据 handoff 的要求更新 ${target}${req ? `。本次需求：${req}` : ""}。` +
            `工具快速用法见 ${tool.skill} 的「hdo.py 命令参考」一节；新写或结构性改动见同文件的「字段规范」与「handoff 目录约定」两节。` +
            `先完整读 skill.md 再动手。`,
        );
      } else {
        pi.sendUserMessage(
          `理解下 ${target}。这是 handoff 方案文件：一份 JSON，记录该项目的整体目标（含衡量指标）、工程流程图（节点与连线）、当前 TODO、当前状态（阻塞/进行中/已完成）、经验沉淀、当前仓库结构；配套的可视化报告是同目录的 *_方案报告.html。字段含义与命名约定见 ${tool.skill}。` +
            `请同时调查它所在的仓库（README、目录结构、关键代码），然后简要汇报：1）项目背景 2）项目目标 3）当前 TODO。只汇报，不要改动任何文件。`,
        );
      }
    },
  });
}
