// lib/llm.mjs — LLM 封装（文本 + 视觉，统一用 DS v4）
// 文本: deepseek-v4-flash；图片: deepseek-v4-flash-vision-exp（每张图 ≤384 tokens，detail 可调）
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const EXP = path.join(here, "..", "..", "exp-speed");

function loadDS() {
  try {
    const txt = readFileSync(path.join(EXP, ".env"), "utf8");
    const m = txt.match(/^DEEPSEEK_API_KEY=(.+)$/m);
    if (m) return m[1].trim();
  } catch {}
  return process.env.DEEPSEEK_API_KEY || "";
}

export const DS_KEY = loadDS();
export const DS_MODEL = process.env.DEEPSEEK_MODEL || "deepseek-v4-flash";
export const DS_VISION_MODEL = "deepseek-v4-flash-vision-exp";

const BASE = "https://api.deepseek.com/v1";

/** DS 文本分析 */
export async function ds(system, user, { maxTokens = 1200 } = {}) {
  const r = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${DS_KEY}` },
    body: JSON.stringify({ model: DS_MODEL, messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ], temperature: 0.2, max_tokens: maxTokens }),
    signal: AbortSignal.timeout(180000),
  }).then((x) => x.json());
  return r?.choices?.[0]?.message?.content?.trim() || "";
}

/** DS 视觉模型识别图片（文本+图片统一 DS）*/
export async function dsVision(imageB64, prompt = "请完整识别这张图片中的文字内容，包括标题、正文、代码。如果是测试题/任务描述，请原样转写。", detail = "low") {
  if (!DS_KEY) throw new Error("无 DS key");
  const r = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${DS_KEY}` },
    body: JSON.stringify({
      model: DS_VISION_MODEL,
      messages: [{ role: "user", content: [
        { type: "text", text: prompt },
        { type: "image_url", image_url: { url: `data:image/jpeg;base64,${imageB64}`, detail } },
      ]}],
      temperature: 0.1,
      max_tokens: 2000,
    }),
    signal: AbortSignal.timeout(180000),
  }).then((x) => x.json());
  return r?.choices?.[0]?.message?.content?.trim() || "";
}

/** 从 URL 下载图片转 base64（抓取失败返回 null） */
export async function imageToB64(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
    const buf = Buffer.from(await r.arrayBuffer());
    return buf.toString("base64");
  } catch { return null; }
}

/** 判断文本是否属于 build 类内容 */
export async function isBuildContent(title, content) {
  const r = await ds(
    "判断内容是否属于「build 类」：测试某 AI/工具的性能、实现某个功能或东西、DIY 造物、写代码/做网站/做应用/做小工具/做游戏、让人照着做一个东西。返回 JSON：{\"is_build\":true/false, \"build_type\":\"ai_test|diy_build|code_build|prompt_skill|other\", \"summary\":\"中文一句话总结\"}",
    `标题：${title}\n内容：\n${String(content || "").slice(0, 3000)}`
  );
  try { return JSON.parse(r.replace(/```json|```/g, "").trim()); }
  catch { return { is_build: false, build_type: "other", summary: "" }; }
}
