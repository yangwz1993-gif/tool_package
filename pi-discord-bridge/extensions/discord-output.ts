// @ts-nocheck
// discord-output.ts — Discord 子区干净输出（herdr-discord 场景专用）
//
// 作用：当本 pi 面板被 herdr-discord 桥映射到某个 Discord 子区时，
// 把「每回合的最终回答」以干净 markdown 发到子区（⏳ 占位 → 原地编辑成答案），
// 替代桥原来粗糙的终端屏幕转发（需配合桥侧 DISCORD_RAW_RELAY=0 静音开关）。
//
// 启用检测（约束：非 Discord 的 pi 不受影响）：
//   每次 input/agent_start 时读桥的账本 state.json，发现自己 pane_id 在
//   映射里才激活；否则什么都不做（每个 prompt 仅一次 ~1ms 的文件读，无可观测行为）。
//   一旦激活则锁定，不再重复检测。
//
// 隔离性（约束：不与其他插件/skill/正常多轮冲突）：
//   只监听 session_start / input / agent_start / agent_end 四个事件 + 发 HTTP；
//   不注册工具、不修改消息、不碰系统提示、不拦截任何工具调用；
//   所有异常就地吞掉并写 /tmp 文件日志，绝不抛进 pi 主流程。
//
// 长度控制（在 Discord 子区里发，扩展在 input 层直接处理，不进模型）：
//   #len          查看当前设置
//   #len 1500     超过 1500 字截断并附提示
//   #len full     恢复全量
//   注：用 # 不用 !，因为 ! 开头的消息会被 herdr-discord 桥全部拦截，到不了 pi。
//
// 手机可读性（2026-10-01 用户实测反馈，T21）：
//   手机端 Discord「标题不渲染、表格不渲染」——## 是字面文本，表格本来就不支持。
//   所以 markdown 结构排版在手机上等于噪音，唯一出路是「短 + 纯文字要点」。三层手段：
//   1) 源头管住：input 事件用 {action:"transform"} 给每条用户消息追加一句手机端输出纪律，
//      让 pi 自己先写短（治本，不依赖自觉）。
//   2) 出口净化：agent_end 发出去前把 ## 标题降级成加粗、表格拆成「• **左** — 右」要点行、
//      去掉 --- 分隔线、压掉多余空行（代码围栏内一律不动）。
//   3) 兜底限长：默认 1000 字上限（原为全量），超出截断并提示。
//
// 小结卡片（2026-10-01 用户要求，方案 B）：
//   每条回答末尾附一张卡片，只放两件事——「结论」与「需要你」（需要用户做什么）。
//   卡片用 Components V2 渲染（flags=32768）：`### ✅ 结论` 是真标题、自带卡片色边框与分隔线。
//   扩展不懂语义，所以由 pi 自己产出结构化尾巴，扩展只负责渲染：
//
//     ```card
//     结论：一句话
//     待你：需要用户做的动作
//     ```
//
//   扩展把这段从正文里摘掉（不计数、不受 #len 截断影响），独立发成一条 V2 卡片消息。
//   注意：V2 消息里 content/embeds 字段失效，所以卡片不能挂在正文消息上。
//
// 状态行（2026-10-01 用户拍板，挂卡片最底部）：
//   `📊 模型 @ 供应商 · 🧠上下文% · ↑输入 ↓输出 ⚡缓存 · $花费 · N轮 · 💰剩余/总额`
//   口径 = 本次单次（本轮内所有请求合计）；数据取自本轮 assistant 消息自带的 usage
//   （input/output/cacheRead/cost.total）+ ctx.getContextUsage()/getModel()。
//   额度那段来自 RAI 内部接口（5 分钟缓存、非阻塞刷新，拿不到就省略）。
//   全部由扩展自己算，模型不知情、不消耗 token、不受 #len 影响。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PANE_ID = process.env.HERDR_PANE_ID || "";
const STATE_PATH =
  process.env.DISCORD_BRIDGE_STATE ||
  path.join(os.homedir(), ".local/state/herdr/plugins/herdr.discord/state.json");
const ENV_PATH =
  process.env.DISCORD_BRIDGE_ENV ||
  path.join(os.homedir(), ".config/herdr/plugins/config/herdr.discord/.env");
const LOG_PATH = "/tmp/discord-output-pi.log";
const CHUNK_LIMIT = 1900; // Discord 单条 2000 字上限，留余量
const DEFAULT_MAX_LEN = null; // 默认不截断：可读性靠分层（卡片/骨架/折叠），不靠砍字。要临时设限发 `#len 800`
const CARD_LABEL_CONCLUSION = "✅ 结论";
const CARD_LABEL_ACTION = "👉 需要你";
const CARD_COLOR = 0x5865f2;
const V2_FLAG = 1 << 15; // IS_COMPONENTS_V2
const TEXT_DISPLAY_LIMIT = 4000; // Text Display 的 content 上限

// 追加到每条用户消息末尾的输出纪律。手机端只读短消息，所以从这里就压住长度和花哨排版。
// 顺序要求（2026-10-01 用户拍板）：**不先抛结论**，按逻辑一步步讲清楚，结论最后落到卡片里。
// 这既合用户的阅读习惯，也避开了「结论先写→后面被自己锚定」的自回归风险。
// 卡片那段是硬要求：pi 每回合都要产出，扩展才好渲染成卡片。
const MOBILE_HINT = [
  "",
  "",
  "[Discord手机端] 回答要清晰、直白、易懂，按逻辑一步步展开，**不要先抛结论**。",
  "不设字数上限：讲清楚优先，能短则短，但绝不许为省字数牺牲前提、因果和关键数字。",
  "手机可读性靠结构，不靠砍字：开头一句说清这条在讲什么；用 ## 小标题分节，一节只讲一件事，别把每件事硬拆成点。",
  "细节靠分层：Discord 没有折叠功能（||剧透标记|| 实测手机端完全不可用），次要细节放 > 引用块或 -# 小字，让它一眼可跳过。",
  "**代码块只留给真正的代码、命令、原始日志**，别拿来装排版或隔断内容——手机上又挤又乱。",
  "**不要用 1、2、3、4 这种编号列表**，太死板：用 - 短行或自然衔接的句子，语气像在说话就行。",
  "不要用表格和 --- 分隔线（手机端不渲染）。",
  "结论放在最后：原样输出下面这个围栏（系统会渲染成卡片，不会显示成代码）：",
  "```card",
  "结论：一句话结论",
  "待你：需要用户做的事（没有就写「无需操作」）",
  "```",
].join("\n");
const MOBILE_HINT_MARK = "[Discord手机端]";

let active = false; // 是否为 Discord 映射面板（一旦激活则锁定）
let threadId = null;
let token = null;
let maxLen = DEFAULT_MAX_LEN; // 字数上限；null = 全量
let placeholderId = null; // ⏳ 消息 id，等待被原地编辑成答案
let loggedDormant = false;

function log(...args) {
  try {
    fs.appendFileSync(
      LOG_PATH,
      `[${new Date().toISOString()}] [${PANE_ID || "?"}] ` + args.map(String).join(" ") + "\n",
    );
  } catch {}
}

// 惰性检测：发现自己 pane 在桥账本里 → 激活并锁定；否则返回 false 下次再试。
// 不做「永久未映射」的负面缓存：新子区的 pi 启动时桥可能还没落账，负面缓存会永久误杀。
function ensureActive() {
  if (active) return true;
  if (!PANE_ID) return false;
  let st;
  try {
    st = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  } catch {
    return false; // 账本暂时读不到，下次事件再试
  }
  for (const [tid, m] of Object.entries(st.threads || {})) {
    if (m && m.pane_id === PANE_ID) {
      try {
        const line = fs
          .readFileSync(ENV_PATH, "utf8")
          .split("\n")
          .find((l) => l.startsWith("DISCORD_BOT_TOKEN="));
        token = line ? line.slice("DISCORD_BOT_TOKEN=".length).trim() : null;
      } catch {}
      if (!token) {
        log("found mapping but token unreadable");
        return false;
      }
      threadId = tid;
      active = true;
      log("active, thread", tid);
      return true;
    }
  }
  if (!loggedDormant) {
    loggedDormant = true;
    log("not in bridge state (dormant; will re-check on each input)");
  }
  return false;
}

async function api(method, p, body) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch("https://discord.com/api/v10" + p, {
        method,
        headers: { Authorization: "Bot " + token, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (res.status === 429) {
        let waitMs = 1000;
        try {
          waitMs = Math.min(5000, ((await res.json())?.retry_after ?? 1) * 1000);
        } catch {}
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }
      if (!res.ok) {
        log("api", method, p, "->", res.status);
        return null;
      }
      return await res.json().catch(() => ({}));
    } catch (e) {
      log("api error", method, p, e?.message || e);
      return null;
    }
  }
  return null;
}

// 手机端净化：把「只有电脑上才好看」的 markdown 结构拆成纯文字要点。
// 代码围栏内的内容一律原样保留（里面的 # 注释、| 管道符不能被误伤）。
// ⚠️ 剧透标记 ||...|| 首尾也是 |，会被下面的表格正则误判成表格行而遭拆解 → 必须先排除
const SPOILER_RE = /^\s*\|\|[\s\S]*\|\|\s*$/;
const isTableRow = (l) => !SPOILER_RE.test(l) && /^\s*\|.*\|\s*$/.test(l);
const isSeparatorRow = (cells) =>
  cells.length > 0 && cells.every((c) => /^:?-{2,}:?$/.test(c) || c === "");

function sanitize(text) {
  const lines = text.split("\n");
  const out = [];
  let inFence = false;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      out.push(line);
      i++;
      continue;
    }
    if (inFence) {
      out.push(line);
      i++;
      continue;
    }

    // 表格 → 每行一条要点（Discord 不渲染表格，代码块方案在手机上更难看）
    if (isTableRow(line)) {
      const block = [];
      while (i < lines.length && isTableRow(lines[i])) block.push(lines[i++]);
      const rows = block.map((l) =>
        l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim()),
      );
      // 标准 markdown 表格第 2 行是 |---| 分隔行；有分隔行时把首行当表头丢掉（手机上表头只是噪音）
      const sepAt = rows.findIndex((cells) => isSeparatorRow(cells));
      const body = rows.filter((cells) => !isSeparatorRow(cells) && cells.some(Boolean));
      if (sepAt === 1) body.shift();
      if (!body.length) continue;
      if (out.length && out[out.length - 1].trim()) out.push("");
      for (const cells of body) {
        const [head, ...rest] = cells;
        const tail = rest.filter(Boolean);
        out.push(tail.length ? `• **${head}** — ${tail.join(" · ")}` : `• **${head}**`);
      }
      continue;
    }

    // --- 分隔线：手机上是没意义的细线
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      i++;
      continue;
    }

    // ## 标题：客户端已确认能正常渲染，保持原样（早期旧客户端不渲染时曾降级为加粗）

    out.push(line.replace(/[ \t]+$/, ""));
    i++;
  }

  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

// 分片：按行贪心装包；保持代码围栏成对（跨片时关旧开新）；超长行硬切
function chunkText(text, limit = CHUNK_LIMIT) {
  const chunks = [];
  let cur = "";
  let inFence = false;
  let fenceLang = "";

  const startChunk = () => {
    cur = inFence ? "```" + fenceLang + "\n" : "";
  };
  const endChunk = () => {
    if (inFence) cur += "\n```";
    if (cur.trim()) chunks.push(cur);
    startChunk();
  };
  const appendLine = (line) => {
    cur += (cur && !cur.endsWith("\n") ? "\n" : "") + line;
  };
  startChunk();

  for (const raw of text.split("\n")) {
    const fence = raw.match(/^```(\S*)/);
    const room = limit - cur.length - (cur ? 1 : 0) - (inFence ? 5 : 0);
    if (raw.length > room) {
      if (raw.length >= limit) {
        // 硬切超长行
        let rest = raw;
        while (rest.length) {
          const r = limit - cur.length - (cur ? 1 : 0) - (inFence ? 5 : 0);
          const part = rest.slice(0, Math.max(1, r));
          appendLine(part);
          rest = rest.slice(part.length);
          if (rest.length) endChunk();
        }
        if (fence) {
          if (!inFence) {
            inFence = true;
            fenceLang = fence[1] || "";
          } else inFence = false;
        }
        continue;
      }
      endChunk();
    }
    appendLine(raw);
    if (fence) {
      if (!inFence) {
        inFence = true;
        fenceLang = fence[1] || "";
      } else inFence = false;
    }
  }
  if (inFence) cur += "\n```";
  if (cur.trim()) chunks.push(cur);
  return chunks;
}

// 从回答里摘下 ```card 围栏，得到 { body, card }。
// card 为 null 表示 pi 没按约定产出（降级成普通文本，不影响正文发送）。
const CARD_FENCE_RE = /```(?:card|卡片|小结)\s*\n([\s\S]*?)```/i;
const clamp = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

function parseCard(text) {
  const m = text.match(CARD_FENCE_RE);
  if (!m) return { body: text, card: null };
  const body = (text.slice(0, m.index) + text.slice(m.index + m[0].length)).trim();

  let conclusion = null;
  let action = null;
  const extra = [];

  for (const raw of m[1].split("\n")) {
    const line = raw.trim().replace(/^[-*•]\s*/, "");
    if (!line) continue;
    const kv = line.match(/^([^：:]{1,12})[：:]\s*([\s\S]+)$/);
    if (!kv) {
      // 没有键名的行当作结论的续行
      if (conclusion) conclusion += " " + line;
      else conclusion = line;
      continue;
    }
    const key = kv[1].trim();
    const val = kv[2].trim();
    if (/^(结论|总结|一句话|结果|conclusion)$/i.test(key)) conclusion = val;
    else if (/^(待你|需要你|需要你做|下一步|行动|action|next|todo|待办)$/i.test(key)) action = val;
    else extra.push({ name: clamp(key, 256), value: clamp(val, TEXT_DISPLAY_LIMIT) });
  }

  if (!conclusion && !action && !extra.length) return { body, card: null };
  return { body, card: { conclusion, action, extra } };
}

// ——— 状态行（本次单次口径） ———
// 数据全部来自本轮 assistant 消息自带的 usage + ctx，不经过模型、不消耗 token。
// 口径：只算「本次回答」这一轮内所有请求的合计（一轮内可能调用模型多次）。
const fmtTok = (n) => {
  if (!n) return "0";
  if (n < 1000) return String(n);
  if (n < 1e6) return (n / 1000).toFixed(n < 1e4 ? 1 : 0) + "k";
  return (n / 1e6).toFixed(2) + "M";
};
const fmtCost = (c) => {
  if (!c) return "$0";
  if (c < 0.0001) return "<$0.0001";
  if (c < 0.01) return "$" + c.toFixed(4);
  if (c < 1) return "$" + c.toFixed(3);
  return "$" + c.toFixed(2);
};

function turnStats(messages, ctx) {
  const u = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, requests: 0 };
  let provider = null;
  let model = null;
  for (const m of messages || []) {
    if (m?.role !== "assistant" || !m.usage) continue;
    const x = m.usage;
    u.input += x.input || 0;
    u.output += x.output || 0;
    u.cacheRead += x.cacheRead || 0;
    u.cacheWrite += x.cacheWrite || 0;
    u.cost += x.cost?.total || 0;
    u.requests++;
    provider = m.provider ?? provider;
    model = m.model ?? model;
  }
  try {
    const mo = ctx?.getModel?.();
    if (mo) {
      provider = provider ?? mo.provider;
      model = model ?? mo.id;
    }
  } catch {}
  let percent = null;
  try {
    percent = ctx?.getContextUsage?.()?.percent ?? null;
  } catch {}
  return { ...u, provider, model, percent };
}

// ——— RAI（Red Token Hub）额度 ———
// 额度查票链路（均为内部接口，扩展自己发 HTTP，不经过模型）：
//   1) GET  /api/v1/user/info                      （带 SSO cookie）→ user_id
//   2) POST /api/v1/user/forever/token              body {platform_user_name} → {QSUSER, QSTOKEN}
//   3) GET  /apis/platform/v1/maas/personal/me/budget  带 QSUSER/QSTOKEN 头 → total/used/remaining
// 拿不到就不显示：全程吞异常只写日志，绝不影响卡片与正文。
//
// 两个修正（2026-10-03 用户发现）：
//   a) 只有 RAI 覆盖的 provider（公司内部代理的 provider）才显示这个额度；
//      切到 openrouter 等外部 provider 时账单根本不在这个池子里，显示它会误导。
//      2026-10-03 补：openrouter 改为显示它自己的账户余额（💳$剩余），
//      其余 provider 才显示「💳外部计费」。
//   b) 缓存改写到 /tmp 共享文件：原来每个 pi 进程各存一份，同一个池子在多个子区
//      会各显各的（实测同刻出现 ¥84.5 / ¥163 / ¥204），改成全机器共享一份。
const RAI_HOST = process.env.RAI_HOST || ""; // 你的额度服务地址；留空则不显示额度段
const RAI_COOKIE_FILE = process.env.RAI_COOKIE_FILE || ""; // 取凭证的文件路径；留空则不显示额度段
const QUOTA_CACHE_FILE = process.env.DISCORD_QUOTA_CACHE || path.join(os.tmpdir(), "pi-quota-cache.json");
const QUOTA_TTL_MS = 60 * 1000; // 后端本身有几分钟快照延迟，压到 60 秒就够
const EXTERNAL_MARK = "💳外部计费";
const OPENROUTER_CREDITS_URL = "https://openrouter.ai/api/v1/credits";
const DEEPSEEK_BALANCE_URL = "https://api.deepseek.com/user/balance";

// 各 provider 的余额来源：
//   内部代理-*  → 公司 RAI 集合额度（Red Token Hub）
//   openrouter → 本人 OpenRouter 账户余额（total_credits − total_usage）
//   deepseek   → DeepSeek 官方账户余额（/user/balance，币种 CNY）
//   其它       → 一律「💳外部计费」，不瞎猜
const RAI_PROVIDER_RE = process.env.RAI_PROVIDER_RE ? new RegExp(process.env.RAI_PROVIDER_RE, "i") : /^$/i; // 命中「走公司额度池」的 provider 名前缀
const OPENROUTER_PROVIDER_RE = /^openrouter$/i;
const DEEPSEEK_PROVIDER_RE = /^deepseek$/i;

const quotaText = { rai: null, or: null, ds: null }; // 本进程最后一次成功拿到的文案
const quotaBusy = { rai: false, or: false, ds: false };

const fmtMoney = (n) => (n >= 100 ? String(Math.round(n)) : n.toFixed(1));

function readQuotaCache() {
  try {
    return JSON.parse(fs.readFileSync(QUOTA_CACHE_FILE, "utf8")) || {};
  } catch {
    return {};
  }
}

function writeQuotaSlot(slot, text) {
  try {
    const cache = readQuotaCache();
    cache[slot] = { at: Date.now(), text };
    const tmp = `${QUOTA_CACHE_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(cache));
    fs.renameSync(tmp, QUOTA_CACHE_FILE);
    quotaText[slot] = text;
  } catch (e) {
    log("quota cache write", e?.message);
  }
}

async function raiFetch(method, p, body, headers) {
  const res = await fetch(RAI_HOST + p, {
    method,
    headers: { "Content-Type": "application/json", ...(headers || {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`${method} ${p} -> ${res.status}`);
  return await res.json();
}

async function refreshRaiQuota() {
  if (quotaBusy.rai) return;
  quotaBusy.rai = true;
  try {
    const session = JSON.parse(fs.readFileSync(RAI_COOKIE_FILE, "utf8"));
    const inner = JSON.parse(Buffer.from(session.accessToken, "base64").toString("utf8"));
    const cookie = "common-internal-access-token-prod=" + inner.accessToken;

    const info = await raiFetch("GET", "/api/v1/user/info", undefined, { Cookie: cookie });
    const uid = (info.data || info).user_id;
    if (!uid) throw new Error("no user_id");

    const tk = await raiFetch(
      "POST",
      "/api/v1/user/forever/token",
      { platform_user_name: uid },
      { Cookie: cookie },
    );
    const t = tk.data || tk;
    if (!t.QSTOKEN) throw new Error("no QSTOKEN");

    const b = await raiFetch("GET", "/apis/platform/v1/maas/personal/me/budget", undefined, {
      Cookie: cookie,
      QSUSER: String(t.QSUSER ?? uid),
      QSTOKEN: String(t.QSTOKEN),
    });
    const d = b.data || b;
    const remain = Number(d.remaining_amount);
    const total = Number(d.total_budget);
    if (!Number.isFinite(remain) || !Number.isFinite(total)) throw new Error("bad budget payload");

    writeQuotaSlot("rai", `💰¥${fmtMoney(remain)}/${fmtMoney(total)}`);
  } catch (e) {
    log("rai quota", e?.message || e);
  } finally {
    quotaBusy.rai = false;
  }
}

// OpenRouter 余额：GET /api/v1/credits → {total_credits, total_usage}，余额 = 两者之差
async function refreshOpenRouterQuota() {
  if (quotaBusy.or) return;
  quotaBusy.or = true;
  try {
    const auth = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".pi/agent/auth.json"), "utf8"));
    const key = auth?.openrouter?.key;
    if (!key) throw new Error("no openrouter key in auth.json");
    const res = await fetch(OPENROUTER_CREDITS_URL, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`credits -> ${res.status}`);
    const d = (await res.json())?.data || {};
    const balance = Number(d.total_credits) - Number(d.total_usage);
    if (!Number.isFinite(balance)) throw new Error("bad credits payload");
    writeQuotaSlot("or", `💳$${fmtMoney(balance)}`);
  } catch (e) {
    log("openrouter credits", e?.message || e);
  } finally {
    quotaBusy.or = false;
  }
}

// DeepSeek 官方余额：GET /user/balance → {is_available, balance_infos:[{currency,total_balance,...}]}
// API key 在环境变量 DEEPSEEK_API_KEY（auth.json 里没有 deepseek 条目，pi 靠 env 认证）
async function refreshDeepSeekQuota() {
  if (quotaBusy.ds) return;
  quotaBusy.ds = true;
  try {
    const key = process.env.DEEPSEEK_API_KEY;
    if (!key) throw new Error("no DEEPSEEK_API_KEY");
    const res = await fetch(DEEPSEEK_BALANCE_URL, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`balance -> ${res.status}`);
    const body = await res.json();
    const info = (body?.balance_infos || []).find((b) => b?.currency === "CNY") || body?.balance_infos?.[0];
    const balance = Number(info?.total_balance);
    if (!Number.isFinite(balance)) throw new Error("bad balance payload");
    const mark = body?.is_available === false ? "💳¥" + fmtMoney(balance) + "(暂停)" : `💳¥${fmtMoney(balance)}`;
    writeQuotaSlot("ds", mark);
  } catch (e) {
    log("deepseek balance", e?.message || e);
  } finally {
    quotaBusy.ds = false;
  }
}

// 非阻塞刷新：本次卡片先用旧值（拿不到就不显），下一次就是新值。
// 优先读共享缓存文件，所以多个子区看到的是同一份数字。
function cachedSegment(slot, refresh) {
  const c = readQuotaCache()[slot];
  if (c && typeof c.text === "string") {
    if (Date.now() - (c.at || 0) > QUOTA_TTL_MS) refresh();
    return c.text;
  }
  refresh();
  return quotaText[slot];
}

function quotaSegment(provider) {
  const p = String(provider || "").toLowerCase();
  if (RAI_PROVIDER_RE.test(p)) return cachedSegment("rai", refreshRaiQuota);
  if (OPENROUTER_PROVIDER_RE.test(p)) return cachedSegment("or", refreshOpenRouterQuota);
  if (DEEPSEEK_PROVIDER_RE.test(p)) return cachedSegment("ds", refreshDeepSeekQuota);
  return EXTERNAL_MARK;
}

function buildStatusLine(s) {
  const parts = [];
  if (s.model) parts.push(s.provider ? `${s.model} @ ${s.provider}` : s.model);
  if (s.percent !== null && s.percent !== undefined) parts.push(`🧠${Math.round(s.percent)}%`);
  parts.push(`↑${fmtTok(s.input)} ↓${fmtTok(s.output)}`);
  if (s.cacheRead) parts.push(`⚡${fmtTok(s.cacheRead)}`);
  parts.push(fmtCost(s.cost));
  if (s.requests > 1) parts.push(`${s.requests}轮`);
  const q = quotaSegment(s.provider);
  if (q) parts.push(q);
  return "📊 " + parts.join(" · ");
}

// 小结卡片用 Components V2 渲染：`### ` 是真标题（会变大）、自带卡片色边框和分隔线。
// V2 硬约束：带 flags=32768 的消息里 content / embeds 失效，所以卡片必须独立成一条消息。
// 末尾额外挂一行状态（模型@供应商 · 上下文 · IO · 缓存 · 花费），由扩展自己算，模型不知情。
function buildCard(card, statusLine) {
  const sections = [];
  const add = (label, text) => {
    if (text) sections.push({ type: 10, content: `### ${label}\n${clamp(text, TEXT_DISPLAY_LIMIT)}` });
  };
  if (card) {
    add(CARD_LABEL_CONCLUSION, card.conclusion);
    add(CARD_LABEL_ACTION, card.action);
    for (const f of (card.extra || []).slice(0, 20)) add(f.name, f.value);
  }

  const components = [];
  sections.forEach((s) => {
    if (components.length) components.push({ type: 14, divider: true, spacing: 1 });
    components.push(s);
  });
  if (statusLine) {
    if (components.length) components.push({ type: 14, divider: true, spacing: 1 });
    components.push({ type: 10, content: statusLine });
  }
  if (!components.length) return null;
  return { flags: V2_FLAG, components: [{ type: 17, accent_color: CARD_COLOR, components }] };
}

function applyCap(text) {
  if (!maxLen || text.length <= maxLen) return text;
  let cut = text.slice(0, maxLen);
  const nl = cut.lastIndexOf("\n");
  if (nl > maxLen * 0.6) cut = cut.slice(0, nl);
  return cut + `\n\n…（已按 #len ${maxLen} 截断；完整版见电脑终端，或发 #len full 恢复全量）`;
}

async function ensurePlaceholder() {
  if (placeholderId) return;
  const msg = await api("POST", `/channels/${threadId}/messages`, { content: "⏳ 处理中…" });
  if (msg && msg.id) placeholderId = msg.id;
}

async function postAnswer(text, statusLine) {
  const parsed = parseCard(text.trim());
  const processed = applyCap(sanitize(parsed.body));
  const chunks = processed.trim() ? chunkText(processed) : [];
  const payload = buildCard(parsed.card, statusLine);

  if (!chunks.length && !payload) {
    if (placeholderId) {
      await api("DELETE", `/channels/${threadId}/messages/${placeholderId}`);
      placeholderId = null;
    }
    return;
  }

  if (chunks.length) {
    let first = null;
    if (placeholderId) {
      first = await api("PATCH", `/channels/${threadId}/messages/${placeholderId}`, {
        content: chunks[0],
      });
      placeholderId = null;
    }
    if (!first) await api("POST", `/channels/${threadId}/messages`, { content: chunks[0] });
    for (let i = 1; i < chunks.length; i++) {
      await new Promise((r) => setTimeout(r, 350)); //  gentle pacing，保持分片顺序
      await api("POST", `/channels/${threadId}/messages`, { content: chunks[i] });
    }
  }

  // 卡片单独一条 V2 消息（V2 消息不能带 content，所以不能挂在正文上）
  if (payload) {
    if (placeholderId) {
      await api("DELETE", `/channels/${threadId}/messages/${placeholderId}`);
      placeholderId = null;
    }
    if (chunks.length) await new Promise((r) => setTimeout(r, 350));
    await api("POST", `/channels/${threadId}/messages`, payload);
  }
}

async function handleLen(arg) {
  let reply;
  if (!arg) {
    reply = maxLen
      ? `当前长度上限：${maxLen} 字，超出截断。发 \`#len full\` 恢复全量。`
      : "当前为全量模式（默认，不截断），长回答会自动按 1900 字分条发。发 `#len 1000` 可临时设上限。";
  } else if (/^(full|all|0)$/i.test(arg)) {
    maxLen = null;
    reply = "✅ 已恢复全量模式（默认）：长回答完整分条发送，不截断。";
  } else if (/^\d+$/.test(arg)) {
    const n = parseInt(arg, 10);
    if (n < 100) {
      reply = "⚠️ 上限最小 100 字。";
    } else {
      maxLen = n;
      reply = `✅ 已设置：超过 ${n} 字的回答会被截断。发 \`#len full\` 恢复全量。`;
    }
  } else {
    reply = "用法：`#len` 查看 · `#len 1500` 设上限 · `#len full` 恢复全量";
  }
  await api("POST", `/channels/${threadId}/messages`, { content: reply });
}

export default function (pi) {
  pi.on("session_start", async (_event, _ctx) => {
    placeholderId = null; // 新会话，旧的占位消息 id 不再可靠
    try {
      if (ensureActive()) {
        // 预热：让第一条卡片的余额不空缺（不 await，不阻碍启动）
        refreshRaiQuota();
        refreshOpenRouterQuota();
        refreshDeepSeekQuota();
      }
    } catch (e) {
      log("session_start", e?.message);
    }
  });

  pi.on("input", async (event, ctx) => {
    try {
      if (!ensureActive()) return;
      const text = String(event?.text ?? "").trim();
      const m = text.match(/^[#＃]len\b\s*(\S*)/i);
      if (m) {
        await handleLen(m[1] || "");
        return { action: "handled" }; // 指令就地消化，不进模型、不算一轮对话
      }
      if (text.startsWith("/")) return; // 斜杠命令不占位
      await ensurePlaceholder();
      // 源头管住输出长度与排版：给用户消息追加一句手机端纪律（用户在本机/终端看不到，只影响模型）
      if (text && !text.includes(MOBILE_HINT_MARK)) {
        return { action: "transform", text: text + MOBILE_HINT };
      }
    } catch (e) {
      log("input", e?.message);
    }
  });

  pi.on("agent_start", async (_event, _ctx) => {
    try {
      if (!ensureActive()) return;
      await ensurePlaceholder(); // 兜底：有些注入路径可能不触发 input 事件
    } catch (e) {
      log("agent_start", e?.message);
    }
  });

  pi.on("agent_end", async (event, ctx) => {
    try {
      if (!ensureActive()) return;
      const msgs = event?.messages || [];
      let text = "";
      for (let i = msgs.length - 1; i >= 0; i--) {
        const msg = msgs[i];
        if (msg?.role !== "assistant") continue;
        const parts = Array.isArray(msg.content)
          ? msg.content
          : [{ type: "text", text: String(msg.content ?? "") }];
        const t = parts
          .filter((p) => p && p.type === "text" && typeof p.text === "string")
          .map((p) => p.text)
          .join("\n")
          .trim();
        if (t) {
          text = t;
          break;
        }
      }
      const statusLine = buildStatusLine(turnStats(msgs, ctx));
      if (text) {
        await postAnswer(text, statusLine);
      } else if (placeholderId) {
        await api("DELETE", `/channels/${threadId}/messages/${placeholderId}`);
        placeholderId = null;
      }
    } catch (e) {
      log("agent_end", e?.message);
    }
  });
}
