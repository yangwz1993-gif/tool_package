import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BotController } from "../src/controller.ts";
import type { BotTransport, IncomingMessage, WorkerFactory } from "../src/types.ts";

class Transport implements BotTransport {
  sent: string[] = [];
  async start() {}
  async stop() {}
  async send(_chat: string, text: string) { this.sent.push(text); return `m_${this.sent.length}`; }
  async update() {}
}

function message(id: string, text: string, userId = "ou_user", chatId = `chat_${userId}`): IncomingMessage {
  return { id, text, userId, chatId };
}

test("/new, /reset and /model are scoped to the sender's DM or the current group", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "lark-commands-"));
  const resets: string[] = [], closed: string[] = [], models: Array<{ key: string; model: string }> = [];
  const workers: WorkerFactory = {
    async open() { throw new Error("commands must not create a normal prompt worker"); },
    async reset(key) { resets.push(key); },
    async closeConversation(key) { closed.push(key); },
    async setModel(key, model) { models.push({ key, model: `${model.provider}/${model.id}` }); },
    async close() {},
  };
  const transport = new Transport();
  const bot = new BotController({
    config: { version: 1, brand: "feishu", appId: "cli_test", appSecret: "secret" }, stateDir, transport, workers,
    defaultModel: { provider: "openai", id: "default" },
    availableModels: [{ provider: "openai", id: "default" }, { provider: "openai", id: "fast" }],
  });
  try {
    await bot.start();
    // /new opens a second conversation inside the chat that sent it, and switches to it.
    await bot.receive(message("dm-new", "/new", "ou_alice"));
    await bot.receive({ ...message("group-new", "/new", "ou_bob", "oc_team"), chatType: "group", mentionedBot: true });
    // /model then applies to the conversation each chat is now in, not to the one it left.
    await bot.receive(message("model", "/model openai/fast", "ou_alice"));
    await bot.receive(message("models", "/model", "ou_alice"));
    // /reset is the old destructive /new: it clears only the current conversation.
    await bot.receive(message("reset", "/reset", "ou_alice"));
    await bot.drain();
    assert.deepEqual(closed, [], "closing is not part of switching");
    assert.deepEqual(resets, ["ou_alice#2"], "reset only touches the sender's current conversation");
    assert.deepEqual(models, [{ key: "ou_alice#2", model: "openai/fast" }]);
    assert(transport.sent.includes("已新建会话 #2，并切换过去。\n\n下一条消息进这个新会话：独立的 pi 会话与分屏，和 #1 的历史互不影响。\n#1 不会关闭，发一句 /switch 1 就回到它。\n\n/list 看全部 · /new 再开一个"));
    assert(transport.sent.some((text) => text.includes("当前模型：openai/fast") && text.includes("openai/default")));
    await bot.stop();

    // Numbering survives a restart: ou_alice is still on #2, and its list still shows it.
    const second = new Transport();
    const restarted = new BotController({
      config: { version: 1, brand: "feishu", appId: "cli_test", appSecret: "secret" }, stateDir, transport: second, workers,
    });
    await restarted.start();
    await restarted.receive(message("dm-list", "/list", "ou_alice"));
    await restarted.drain();
    const list = second.sent.at(-1)!;
    assert(list.includes("#2 ← 当前"), `expected #2 to still be active after a restart, got: ${list}`);
    assert(!list.includes("#3"), "list shows what exists, not what might come next");
    assert.equal(restarted.status.users, 0, "listing a chat creates no handoff queue");
    await restarted.stop();
  } finally { await bot.stop(); await rm(stateDir, { recursive: true, force: true }); }
});
