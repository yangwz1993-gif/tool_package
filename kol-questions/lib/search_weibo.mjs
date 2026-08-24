// lib/search_weibo.mjs — 微博 build 内容检索（子 agent 用）
// 用法: node search_weibo.mjs "<关键词>" [--limit N]
// 输出: JSON [{user, time, text, link}]
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(here);
const COOKIE = path.join(ROOT, "weibo.cookie");
const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const kw = process.argv[2];
const limit = parseInt(arg("--limit", "8"), 10);
if (!kw) { console.error("用法: node search_weibo.mjs <关键词>"); process.exit(1); }

const BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36";
const browser = await chromium.launch({ headless: true, args: ["--disable-blink-features=AutomationControlled"] });
const ctx = await browser.newContext({ userAgent: BROWSER_UA, locale: "zh-CN" });
const cookieStr = readFileSync(COOKIE, "utf8").trim();
const cookies = cookieStr.split(";").map((s) => { const [k, ...v] = s.trim().split("="); return { name: k, value: v.join("="), domain: ".weibo.com", path: "/" }; }).filter((c) => c.name);
await ctx.addCookies(cookies);
const page = await ctx.newPage();
await page.goto(`https://s.weibo.com/weibo?q=${encodeURIComponent(kw)}`, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
await page.waitForTimeout(3000);
const items = await page.evaluate((lim) => {
  const out = [];
  for (const card of document.querySelectorAll(".card-wrap")) {
    const user = (card.querySelector(".name, [nick-name], [class*=name]")?.textContent || "").trim();
    const time = (card.querySelector(".from, [class*=time]")?.textContent || "").trim();
    const text = (card.querySelector(".txt, [class*=text]")?.textContent || "").trim();
    const mid = card.getAttribute("mid") || "";
    if (text) out.push({ user: user.slice(0, 20), time: time.slice(0, 25), text: text.slice(0, 800), mid, link: mid ? `https://weibo.com/${mid}` : "" });
    if (out.length >= lim) break;
  }
  return out;
}, limit);
await browser.close();
console.log(JSON.stringify(items, null, 2));
