// lib/search_xhs.mjs — 小红书 build 内容检索（子 agent 用）
// 用法: node search_xhs.mjs "<关键词>" [--limit N] [--cookie-file 路径]
// 输出: JSON [{id, title, author, likes, url}]
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(here);
const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const kw = process.argv[2];
const limit = parseInt(arg("--limit", "8"), 10);
const cookieFile = arg("--cookie-file", path.join(ROOT, "xhs.cookie"));
if (!kw) { console.error("用法: node search_xhs.mjs <关键词>"); process.exit(1); }

const cookieStr = readFileSync(cookieFile, "utf8").trim();
const browser = await chromium.launch({ headless: true, args: ["--disable-blink-features=AutomationControlled"] });
const ctx = await browser.newContext({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36", locale: "zh-CN" });
const cookies = cookieStr.split(";").map((s) => { const [k, ...v] = s.trim().split("="); return { name: k, value: v.join("="), domain: ".xiaohongshu.com", path: "/" }; }).filter((c) => c.name);
await ctx.addCookies(cookies);
const page = await ctx.newPage();
await page.goto(`https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(kw)}&source=web_search_result_notes`, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
await page.waitForTimeout(4000);
const items = await page.evaluate((lim) => {
  const out = [];
  for (const el of document.querySelectorAll(".note-item")) {
    const a = el.querySelector("a[href*='/explore/'], a[href*='/discovery/item/']");
    if (!a) continue;
    const href = a.getAttribute("href") || "";
    const m = href.match(/\/(explore|discovery\/item)\/([0-9a-fA-F]+)/);
    const id = m ? m[2] : "";
    const title = (el.querySelector("[class*=title]")?.textContent || "").trim();
    const author = (el.querySelector("[class*=author], [class*=name]")?.textContent || "").trim();
    const likes = (el.querySelector("[class*=like], [class*=count]")?.textContent || "").trim();
    if (id) out.push({ id, title, author, likes, url: `https://www.xiaohongshu.com/explore/${id}` });
    if (out.length >= lim) break;
  }
  return out;
}, limit);
await browser.close();
console.log(JSON.stringify(items, null, 2));
