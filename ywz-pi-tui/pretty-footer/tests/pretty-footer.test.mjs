/**
 * pretty-footer 渲染快照测试（不启动 pi，mock API）
 * 运行：node ~/.pi/agent/extensions/tests/pretty-footer.test.mjs
 */
import { createJiti } from "file:///Users/yangwenzhu1/.nvm/versions/node/v22.22.2/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.mjs";
import { homedir } from "node:os";
import { join } from "node:path";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const extPath = join(homedir(), ".pi/agent/extensions/pretty-footer.ts");
const mod = await jiti.import(extPath);
const register = mod.default ?? mod;

// ---- mock ----
let footerFactory;
let thinkingLevel = "high";
const piMock = {
	getThinkingLevel: () => thinkingLevel,
	setThinkingLevel: (lv) => { thinkingLevel = lv; console.log("  [setThinkingLevel]", lv); },
	registerCommand: () => {},
	on: () => {},
};

const usage = (input, output, cr, cw, cost) => ({ input, output, cacheRead: cr, cacheWrite: cw, cost: { total: cost } });
const entries = [
	// 上一轮：用户提问 → 两次助手回复（含工具循环）
	{ type: "message", message: { role: "user", content: "上一轮问题" } },
	{ type: "message", message: { role: "assistant", usage: usage(12000, 2400, 88000, 2000, 0.12) } },
	{ type: "message", message: { role: "assistant", usage: usage(12300, 4500, 89000, 2100, 0.063) } },
	{ type: "usage", usage: usage(0, 0, 5000, 0, 0.005) },
	// 当前轮：新的用户提问 → 一次助手回复
	{ type: "message", message: { role: "user", content: "本轮问题" } },
	{ type: "message", message: { role: "assistant", usage: usage(8000, 1200, 40000, 500, 0.037) } },
];

const ctxMock = {
	mode: "tui",
	thinkingLevel: "high",
	model: { id: "mimo-v2.6-pro", provider: "xiaomi", reasoning: true },
	sessionManager: {
		getCwd: () => join(homedir(), "Desktop/111Workspace"),
		getSessionId: () => "sid-1",
		getLeafId: () => "leaf-1",
		getSessionName: () => "状态栏升级",
		getEntries: () => entries,
	},
	getContextUsage: () => ({ contextWindow: 1_000_000, percent: 23.4 }),
	ui: {
		setFooter: (f) => { footerFactory = f; },
		notify: (m) => console.log("  [notify]", m),
		select: async () => undefined,
	},
};

const themeMock = {
	fg: (c, t) => `\x1b[38;5;${({ dim: 240, muted: 245, text: 252, warning: 214, success: 78, error: 203, mdLink: 75, accent: 111 }[c] ?? 255)}m${t}\x1b[0m`,
	bold: (t) => `\x1b[1m${t}\x1b[0m`,
};

const footerDataMock = {
	getGitBranch: () => "main",
	getExtensionStatuses: () => new Map([["brief", "💬 BRIEF"]]),
	getAvailableProviderCount: () => 1,
	onBranchChange: () => () => {},
};

// ---- 装载 ----
register(piMock);
let ctx;
for (const h of []) h;
// 触发 session_start
// （pi.on mock 忽略了 handler，这里直接手动拿 factory）
// 重新模拟：registerCommand/on 都是 no-op，所以我们改走 install 路径 —— 重新注册一次并捕获 handler
let sessionStartHandler;
piMock.on = (event, handler) => { if (event === "session_start") sessionStartHandler = handler; };
register(piMock);
await sessionStartHandler({}, ctxMock);

const footer = footerFactory({ mode: "fullscreen", requestRender: () => {} }, themeMock, footerDataMock);

// ---- 快照 ----
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
const show = (width) => {
	const lines = footer.render(width).map(strip);
	console.log(`\n── width=${width} ──`);
	lines.forEach((l) => console.log(`│${l}${" ".repeat(Math.max(0, width - [...l].reduce((w, ch) => w + (ch.codePointAt(0) > 0x2e00 ? 2 : 1), 0)))}│`));
	return lines;
};

[120, 80, 60, 40, 24].forEach(show);

// ---- 本轮/累计花费验证 ----
console.log("\n── turn cost test ──");
const costLine = footer.render(120).map(strip)[1];
// 累计 = 0.12+0.063+0.005+0.037 = 0.225；本轮 = 0.037（上一条用户消息之后）
const turnOk = costLine.includes("$0.0370");
const totalOk = costLine.includes("$0.225");
console.log(`  本轮 $0.0370 → ${turnOk ? "✓" : "✗ " + costLine}`);
console.log(`  累计 $0.225 → ${totalOk ? "✓" : "✗ " + costLine}`);

// ---- 鼠标命中测试 ----
console.log("\n── mouse hit test (width=120) ──");
footer.render(120);
const cases = [
	{ x: 3, y: 0, expect: "copy-cwd" },
	{ x: 27, y: 0, expect: "copy-branch" },
	{ x: 110, y: 1, expect: "thinking" },
	{ x: 45, y: 1, expect: "none" },
];
for (const c of cases) {
	const r = footer.handleMouse({ type: "click", button: "left", x: c.x, y: c.y });
	const ok = c.expect === "none" ? !r : !!r?.handled;
	console.log(`  click(${c.x},${c.y}) expect=${c.expect} → ${ok ? "✓" : "✗ handled=" + !!r?.handled}`);
}

// 低上下文占用 / 高占用变色
console.log("\n── context percent coloring ──");
ctxMock.getContextUsage = () => ({ contextWindow: 200000, percent: 85.2 });
const l2 = footer.render(120).map(strip)[1];
console.log("  85%:", l2.includes("85.2%") ? "✓ shows 85.2%" : "✗ " + l2);
ctxMock.getContextUsage = () => ({ contextWindow: 200000, percent: 93.1 });
const l3 = footer.render(120).map(strip)[1];
console.log("  93%:", l3.includes("93.1%") ? "✓ shows 93.1%" : "✗ " + l3);
