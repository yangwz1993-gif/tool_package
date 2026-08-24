// lib/agent_factory.mjs — 子 agent 工厂与系统模板
// 被 orchestrator 调用：创建独立 pi session 的子 agent
import { createAgentSession, DefaultResourceLoader, ModelRegistry, AuthStorage, SessionManager, SettingsManager } from "@mariozechner/pi-coding-agent";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(here);

/**
 * 子 agent 系统模板：ReAct 检索 + 出题 + issues 记录 + 上下文压缩
 */
export function makeSystemTemplate({ here }) {
  return `你是一个调研子代理，负责在指定的数据源中检索「build 类内容」（测试某 AI/工具性能、实现某个功能或东西、DIY 造物、用 AI 写代码/做网站/做应用等），并把每条提炼成**可执行的测试题**（task + 难度 + 验收标准）。

你的检索工具（通过 bash 调用）：
- 微博: node ${path.join(here, "lib", "search_weibo.mjs")} "<关键词>"
- 小红书: node ${path.join(here, "lib", "search_xhs.mjs")} "<关键词>"
- 知乎: node ${path.join(here, "lib", "search_zhihu.mjs")} "<关键词>"
- 公众号: node ${path.join(here, "lib", "search_wx.mjs")} "<关键词>"

工作方式（多步 ReAct）：
1. 用不同关键词组合检索（如 "vibecoding"、"agent 测试"、"我做了个"、"AI 造了个"、"coding agent"、"我做了个AI"）
2. 对每条结果判断是否 build 类；是则生成一道测试题
3. 重复检索/换关键词，直到凑够你负责的题目数量
4. 上下文接近上限时，用 /compact 压缩后再继续

题目质量标准（重要）：
- **task 直接以动词开头**描述要构建的东西（开发/实现/构建/做一个/搭建/编写…），不要写「用 vibecoding」「用 AI 编程」「使用 Coding Agent」「借助 XX 工具」这类方式状语前缀
- task 要完整可执行：包含明确功能要求、目标、关键细节，不要一句话带过
- 验收标准（acceptance）要具体可验证：怎么做、交付什么、怎么算做成了
- 内容本身需要 AI 的（如"AI 识别照片""AI 陪伴"）保留 AI 作为功能，不视为方式状语
- 每条必须含：task / difficulty（简单|中等|困难）/ acceptance / blogger / source / link / date

异常处理（重要）：
- 单条检索失败/抓取失败/结果为空：**跳过并记录**到 /tmp/subagent_<你的编号>.issues.json（JSON 数组，每条 {"type":"fetch_fail","detail":"..."}），继续下一条，不要中断
- 检索工具报错（cookie 失效等）：换关键词或换平台继续，仍失败则记入 issues 后跳过

输出：最终把你负责的题目以 JSON 数组写入文件 /tmp/subagent_<你的编号>.json
每条：{"task":"可执行的测试题","difficulty":"简单|中等|困难","acceptance":"验收标准","blogger":"博主","source":"平台","link":"链接","date":"时间"}`;
}

/**
 * 创建子 agent 的 loaderFactory（每个子 agent 独立 pi session）
 */
export function createDefaultLoaderFactory({ here, env, budget }) {
  const authStorage = AuthStorage.create(path.join(here, ".auth.json"));
  authStorage.setRuntimeApiKey("deepseek", env.DEEPSEEK_API_KEY);
  const modelRegistry = ModelRegistry.create(authStorage);

  return async function loaderFactory(index) {
    const loader = new DefaultResourceLoader({
      cwd: path.join(here, "work"),
      agentDir: path.join(here, `agent-${index}`),
      systemPromptOverride: () => makeSystemTemplate({ here }),
      skillsOverride: () => ({ skills: [], diagnostics: [] }),
      extensionFactories: [
        (pi) => {
          pi.registerProvider("deepseek", {
            baseUrl: env.DEEPSEEK_BASE_URL, apiKey: env.DEEPSEEK_API_KEY, api: "openai-completions",
            models: [{
              id: env.DEEPSEEK_MODEL || "deepseek-v4-flash", name: "v4f", reasoning: true, input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 128000, maxTokens: 8192, compat: { thinkingFormat: "deepseek" },
            }],
          });
        },
      ],
    });
    await loader.reload();
    const model = modelRegistry.find("deepseek", env.DEEPSEEK_MODEL || "deepseek-v4-flash");
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: true, threshold: 80000 }, retry: { enabled: true, maxRetries: 2 } });
    const { session } = await createAgentSession({
      cwd: path.join(here, "work"), agentDir: path.join(here, `agent-${index}`),
      model, authStorage, modelRegistry, resourceLoader: loader,
      sessionManager: SessionManager.inMemory(), settingsManager,
      thinkingLevel: "off",
    });
    return session;
  };
}
