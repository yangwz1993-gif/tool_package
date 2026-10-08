/**
 * pretty-footer —— 状态栏升级扩展
 *
 * 只替换底部状态栏（footer）的渲染，对话区零改动：
 * 活动时间线、聊天气泡、代码块、输入框等仍由 pi / pi-pretty-tui 原样渲染。
 *
 * 布局（2 行 + 可选扩展状态行）：
 *   ⌂ ~/Desktop/111Workspace   ⎇ main   · 会话名
 *   ↑12.3k ↓4.5k  │  R89k W2k  │  命中 94%  │  $0.183  │  ▰▰▰▱▱▱▱▱ 23.4%   mimo-v2.6-pro · high
 *
 * 交互（fullscreen 模式下）：
 *   - 点击路径 → 复制 cwd；点击分支 → 复制分支名
 *   - 点击右侧模型区 → 选择 thinking level
 *
 * 窄终端降级顺序：缓存组 → 命中率组 → 进度条 8→5 格 → 截断右侧模型名。
 *
 * 命令：/pretty-footer [enable|disable|status]
 * 配置：~/.pi/agent/pretty-footer.json（或 PI_CODING_AGENT_DIR 对应目录）
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { copyToClipboard } from "@earendil-works/pi-coding-agent";
import {
	truncateToWidth,
	visibleWidth,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { homedir } from "node:os";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// ---------- 小工具 ----------

type Level = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

const LEVELS: Level[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** thinking level → 主题色 token（与 pi 主题的 thinkingXxx 色一一对应） */
const LEVEL_COLOR: Record<Level, string> = {
	off: "thinkingOff",
	minimal: "thinkingMinimal",
	low: "thinkingLow",
	medium: "thinkingMedium",
	high: "thinkingHigh",
	xhigh: "thinkingXhigh",
	max: "thinkingMax",
};

type ThemeLike = {
	fg(color: string, text: string): string;
	bold(text: string): string;
};

type FooterDataLike = {
	getGitBranch(): string | null;
	getExtensionStatuses(): ReadonlyMap<string, string>;
	getAvailableProviderCount(): number;
	onBranchChange(callback: () => void): () => void;
};

type Totals = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	/** 本轮（自上条用户消息起）的实际花费 */
	turnCost: number;
};

type Region = {
	line: number;
	x: number;
	w: number;
	action: "copy-cwd" | "copy-branch" | "thinking";
};

const SEPARATOR = " │ ";

/** 与 pi 原生 footer 一致的紧凑 token 格式 */
const formatTokens = (count: number): string => {
	if (count < 1000) return String(count);
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
};

/** home 目录缩成 ~，过长时只保留最后两段路径 */
const shortenCwd = (cwd: string, home: string): string => {
	let s = cwd;
	if (home && (s === home || s.startsWith(home + "/"))) s = "~" + s.slice(home.length);
	const MAX = 48;
	if (s.length <= MAX) return s;
	const parts = s.split("/");
	return "…/" + parts.slice(-2).join("/");
};

const configPath = (): string =>
	join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "pretty-footer.json");

const loadEnabled = (): boolean => {
	try {
		return JSON.parse(readFileSync(configPath(), "utf8")).enabled !== false;
	} catch {
		return true;
	}
};

const saveEnabled = (enabled: boolean): void => {
	try {
		const p = configPath();
		mkdirSync(dirname(p), { recursive: true });
		writeFileSync(p, `${JSON.stringify({ enabled }, null, 2)}\n`);
	} catch {
		// 配置写失败不影响本次会话显示
	}
};

// ---------- 扩展入口 ----------

export default function (pi: ExtensionAPI) {
	let enabled = loadEnabled();
	let ctxRef: any;

	// ---- 用量统计（按 session 条目数缓存，与 pi 原生 footer 同策略）----
	const collectStats = (ctx: any): { totals: Totals; hitRate: number | null } => {
		const totals: Totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turnCost: 0 };
		let hitRate: number | null = null;
		const add = (u: any) => {
			if (!u) return;
			totals.input += u.input || 0;
			totals.output += u.output || 0;
			totals.cacheRead += u.cacheRead || 0;
			totals.cacheWrite += u.cacheWrite || 0;
			const c = u.cost?.total ?? u.cost ?? 0;
			totals.cost += c;
			totals.turnCost += c;
		};
		for (const entry of ctx.sessionManager.getEntries() as any[]) {
			if (entry.type === "message" && entry.message?.role === "user") {
				// 新一轮回复开始：重置本轮花费
				totals.turnCost = 0;
			} else if (entry.type === "usage") {
				add(entry.usage);
			} else if (entry.type === "message" && entry.message?.role === "assistant") {
				add(entry.message.usage);
				const u = entry.message.usage;
				const prompt = (u?.input || 0) + (u?.cacheRead || 0) + (u?.cacheWrite || 0);
				if (prompt > 0) hitRate = ((u.cacheRead || 0) / prompt) * 100;
			} else if (entry.type === "message" && entry.message?.role === "toolResult") {
				add(entry.message.usage);
			} else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
				add(entry.usage);
			}
		}
		return { totals, hitRate };
	};

	const install = (ctx: any) => {
		ctx.ui.setFooter((tui: any, theme: ThemeLike, footerData: FooterDataLike) => {
			let flash: { text: string; kind: "success" | "error" } | undefined;
			let flashTimer: ReturnType<typeof setTimeout> | undefined;
			let regions: Region[] = [];
			let cacheKey = "";
			let cached: { totals: Totals; hitRate: number | null } | undefined;

			const unsubBranch = footerData.onBranchChange(() => tui.requestRender());

			const setFlash = (text: string, kind: "success" | "error") => {
				flash = { text, kind };
				if (flashTimer) clearTimeout(flashTimer);
				flashTimer = setTimeout(() => {
					flash = undefined;
					tui.requestRender();
				}, 1200);
				tui.requestRender();
			};

			const copyText = (text: string) => {
				void Promise.resolve(copyToClipboard(text))
					.then(() => setFlash("Copied!", "success"))
					.catch(() => setFlash("Copy failed", "error"));
			};

			const currentLevel = (): Level => {
				try {
					const lv = pi.getThinkingLevel() as Level;
					return LEVELS.includes(lv) ? lv : "off";
				} catch {
					return (ctx.thinkingLevel as Level) || "off";
				}
			};

			const pickThinkingLevel = async () => {
				const current = currentLevel();
				const options = LEVELS.map((l) => (l === current ? `${l} · current` : l));
				const chosen = await ctx.ui.select("Thinking level", options);
				if (!chosen) return;
				const level = chosen.split(" ")[0] as Level;
				if (!LEVELS.includes(level)) return;
				try {
					pi.setThinkingLevel(level);
					setFlash(`thinking ${level}`, "success");
				} catch {
					setFlash("set failed", "error");
				}
			};

			return {
				invalidate() {},
				render(width: number): string[] {
					regions = [];
					const lines: string[] = [];
					const home = process.env.HOME || process.env.USERPROFILE || "";

					// ---- 行 1：位置信息 ----
					const cwdText = shortenCwd(String(ctx.sessionManager.getCwd()), home);
					const cwdStyled = theme.fg("muted", cwdText);
					const cwdSeg = `${theme.fg("dim", "⌂ ")}${cwdStyled}`;
					regions.push({ line: 0, x: 0, w: visibleWidth(cwdSeg), action: "copy-cwd" });
					const parts0: string[] = [cwdSeg];

					const branch = footerData.getGitBranch();
					if (branch) {
						parts0.push("  ");
						const branchStyled = theme.fg("mdLink", `⎇ ${branch}`);
						regions.push({
							line: 0,
							x: visibleWidth(parts0.join("")),
							w: visibleWidth(branchStyled),
							action: "copy-branch",
						});
						parts0.push(branchStyled);
					}

					const sessionName = ctx.sessionManager.getSessionName?.();
					if (sessionName) parts0.push(theme.fg("dim", `  · ${sessionName}`));

					let line0 = parts0.join("");
					if (flash) {
						const flashStyled = theme.fg(flash.kind === "success" ? "success" : "error", flash.text);
						const pad = width - visibleWidth(line0) - visibleWidth(flashStyled) - 2;
						if (pad > 0) line0 += " ".repeat(pad) + flashStyled;
					}
					lines.push(truncateToWidth(line0, width, theme.fg("dim", "…")));

					// ---- 行 2：指标 + 模型 ----
					const stats = (() => {
						const sm = ctx.sessionManager;
						const key = `${sm.getSessionId?.()}|${sm.getLeafId?.()}|${sm.getEntries().length}|${ctx.model?.id ?? ""}`;
						if (!cached || cacheKey !== key) {
							cached = collectStats(ctx);
							cacheKey = key;
						}
						return cached!;
					})();
					const { totals, hitRate } = stats;

					const ctxUsage = ctx.getContextUsage?.();
					const percent = ctxUsage?.percent ?? null;
					const pctColor =
						percent === null ? "dim" : percent > 90 ? "error" : percent > 70 ? "warning" : "success";

					const hasCache = totals.cacheRead > 0 || totals.cacheWrite > 0;
					const hasHit = hitRate !== null && hitRate !== undefined;

					const buildGroups = (useCache: boolean, useHit: boolean, barCells: number, costFull: boolean): string[] => {
						const groups: string[] = [];
						// 流量
						groups.push(
							`${theme.fg("dim", "↑")}${theme.fg("text", formatTokens(totals.input))} ` +
								`${theme.fg("dim", "↓")}${theme.fg("text", formatTokens(totals.output))}`,
						);
						// 缓存
						if (useCache && hasCache) {
							groups.push(
								`${theme.fg("dim", "R")}${theme.fg("muted", formatTokens(totals.cacheRead))} ` +
									`${theme.fg("dim", "W")}${theme.fg("muted", formatTokens(totals.cacheWrite))}`,
							);
						}
						// 命中率
						if (useHit && hasHit) {
							const rate = Math.round(hitRate!);
							groups.push(
								`${theme.fg("muted", "命中 ")}${theme.fg(rate >= 70 ? "success" : "warning", `${rate}%`)}`,
							);
						}
						// 成本：本轮回复花费 + 会话累计花费（窄屏只留本轮）
						if (totals.cost > 0) {
							groups.push(
								costFull
									? `${theme.fg("muted", "本轮 ")}${theme.fg("warning", `$${totals.turnCost.toFixed(4)}`)}` +
										` ${theme.fg("dim", "·")} ${theme.fg("muted", "累计 ")}${theme.fg("dim", `$${totals.cost.toFixed(3)}`)}`
									: `${theme.fg("dim", "$")}${theme.fg("warning", totals.turnCost.toFixed(4))}`,
							);
						}
						// 上下文占用
						const filled =
							percent === null ? 0 : Math.min(barCells, Math.round((percent / 100) * barCells));
						const bar = "▰".repeat(filled) + "▱".repeat(barCells - filled);
						const pctText = percent === null ? "?" : `${percent.toFixed(1)}%`;
						groups.push(
							`${theme.fg(pctColor, bar)} ${theme.bold(theme.fg(pctColor, pctText))}`,
						);
						return groups;
					};

					// 右侧：模型 + thinking level
					const model = ctx.model;
					const level = currentLevel();
					const providerPrefix =
						footerData.getAvailableProviderCount() > 1 && model ? `(${model.provider}) ` : "";
					const levelPart = model?.reasoning
						? theme.fg("dim", " · ") + theme.fg(LEVEL_COLOR[level] ?? "dim", level)
						: "";
					const right =
						theme.fg("muted", providerPrefix) +
						theme.bold(theme.fg("text", model?.id ?? "no-model")) +
						levelPart;
					const rightW = visibleWidth(right);

					let groups = buildGroups(true, true, 8, true);
					const fit = (gs: string[]) => visibleWidth(gs.join(SEPARATOR)) + 3 + rightW <= width;
					if (!fit(groups)) groups = buildGroups(false, true, 8, true);
					if (!fit(groups)) groups = buildGroups(false, false, 8, true);
					if (!fit(groups)) groups = buildGroups(false, false, 8, false);
					if (!fit(groups)) groups = buildGroups(false, false, 5, false);

					const left = groups.join(SEPARATOR);
					let line1: string;
					const pad = width - visibleWidth(left) - rightW;
					if (pad >= 3) {
						regions.push({ line: 1, x: visibleWidth(left) + pad, w: rightW, action: "thinking" });
						line1 = left + " ".repeat(pad) + right;
					} else {
						const avail = Math.max(8, width - rightW - 2);
						const truncLeft = truncateToWidth(left, avail, theme.fg("dim", "…"));
						regions.push({ line: 1, x: visibleWidth(truncLeft) + 2, w: rightW, action: "thinking" });
						line1 = `${truncLeft}  ${right}`;
					}
					lines.push(truncateToWidth(line1, width, theme.fg("dim", "…")));

					// ---- 行 3：第三方扩展状态（原样保留）----
					const statuses = footerData.getExtensionStatuses();
					if (statuses.size > 0) {
						const statusLine = Array.from(statuses.values())
							.map((t) => String(t).replace(/[\r\n]+/g, " "))
							.join(" ");
						lines.push(truncateToWidth(statusLine, width, theme.fg("dim", "…")));
					}

					return lines;
				},
				handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
					if (tui?.mode !== "fullscreen") return undefined;
					if (event.type !== "click" || event.button !== "left") return undefined;
					const hit = regions.find(
						(r) => r.line === event.y && event.x >= r.x && event.x < r.x + r.w,
					);
					if (!hit) return undefined;
					if (hit.action === "copy-cwd") copyText(String(ctx.sessionManager.getCwd()));
					else if (hit.action === "copy-branch") {
						const b = footerData.getGitBranch();
						if (b) copyText(b);
					} else if (hit.action === "thinking") void pickThinkingLevel();
					return { handled: true, render: false };
				},
				dispose() {
					unsubBranch();
					if (flashTimer) clearTimeout(flashTimer);
				},
			};
		});
	};

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		ctxRef = ctx;
		if (enabled) install(ctx);
	});

	pi.registerCommand("pretty-footer", {
		description: "状态栏升级开关：/pretty-footer [enable|disable|status]",
		handler: async (args, ctx) => {
			const arg = (args || "").trim().split(/\s+/)[0];
			if (arg === "status") {
				ctx.ui.notify(`pretty-footer 当前${enabled ? "已启用" : "已禁用"}`, "info");
				return;
			}
			if (arg === "enable" || arg === "disable") {
				enabled = arg === "enable";
				saveEnabled(enabled);
				if (enabled) install(ctx);
				else ctx.ui.setFooter(undefined);
				ctx.ui.notify(`pretty-footer ${enabled ? "已启用" : "已禁用，恢复原生状态栏"}`, "info");
				return;
			}
			ctx.ui.notify("用法：/pretty-footer [enable|disable|status]", "info");
		},
	});
}
