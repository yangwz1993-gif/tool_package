// lib/search_zhihu.mjs — 知乎 build 内容检索（子 agent 用）
// 用法: node search_zhihu.mjs "<关键词>" [--limit N]
// 输出: JSON [{title, href}]
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(here);
const COOKIE = path.join(ROOT, "zhihu.cookie");
const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const kw = process.argv[2];
const limit = parseInt(arg("--limit", "8"), 10);
if (!kw) { console.error("用法: node search_zhihu.mjs <关键词>"); process.exit(1); }

const BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36";
const browser = await chromium.launch({ headless: true, args: ["--disable-blink-features=AutomationControlled"] });
const ctx = await browser.newContext({ userAgent: BROWSER_UA, locale: "zh-CN" });
const cookieStr = readFileSync(COOKIE, "utf8").trim();
const cookies = cookieStr.split(";").map((s) => { const [k, ...v] = s.trim().split("="); return { name: k, value: v.join("="), domain: ".zhihu.com", path: "/" }; }).filter((c) => c.name);
await ctx.addCookies(cookies);
const page = await ctx.newPage();
await page.goto(`https://www.zhihu.com/search?type=content&q=${encodeURIComponent(kw)}`, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
await page.waitForTimeout(3000);
const items = await page.evaluate((lim) => {
  const out = [];
  for (const c of document.querySelectorAll("[class*=SearchResult], .List-item")) {
    const t = (c.querySelector("[class*=title], h2")?.textContent || "").trim();
    const a = c.querySelector("a[href*=answer], a[href*=question]")?.getAttribute("href") || "";
    if (t && a) out.push({ title: t.slice(0, 80), href: a });
    if (out.length >= lim) break;
  }
  return out;
}, limit);
await browser.close();
console.log(JSON.stringify(items, null, 2));
