// lib/search_wx.mjs — 公众号 build 内容检索（子 agent 用）
// 用 weixin_search_mcp 修复版（requests，带时间戳）
// 用法: node search_wx.mjs "<关键词>" [--limit N]
// 输出: JSON [{title, ts, publish_time, real_url, content, link}]
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(here);
const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const kw = process.argv[2];
const limit = parseInt(arg("--limit", "6"), 10);
if (!kw) { console.error("用法: node search_wx.mjs <关键词>"); process.exit(1); }

const VENV_PY = path.join(ROOT, "vendor", "weixin_search_mcp", ".venv", "bin", "python");
const PY_HELPER = `
import sys, json, time
sys.path.insert(0, '${path.join(ROOT, "vendor", "weixin_search_mcp")}')
from weixin_search_mcp.tools.weixin_search import sogou_weixin_search, get_real_url_from_sogou, get_article_content
kw = sys.argv[1]
items = []
r = sogou_weixin_search(kw, strict=False)
for x in (r or [])[:${limit}]:
    ts_raw = x.get('publish_time', '')
    ts = 0
    if "'" in ts_raw:
        try: ts = int(ts_raw.split("'")[1])
        except: pass
    item = {'title': x.get('title',''), 'ts': ts, 'link': x.get('link','')}
    try:
        real = get_real_url_from_sogou(item['link'])
        item['real_url'] = real
        if real:
            item['content'] = (get_article_content(real, referer=item['link']) or '')[:4000]
    except Exception:
        item['real_url'] = ''; item['content'] = ''
    items.append(item)
    time.sleep(0.4)
print(json.dumps(items, ensure_ascii=False))
`;

const { stdout } = await exec(VENV_PY, ["-c", PY_HELPER, kw], { timeout: 90000, maxBuffer: 10 * 1024 * 1024 });
console.log(stdout);
