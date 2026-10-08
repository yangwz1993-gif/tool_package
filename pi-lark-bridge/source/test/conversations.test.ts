import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BotController, MAX_CONVERSATIONS } from "../src/controller.ts";
import type { BotTransport, IncomingMessage, WorkerFactory } from "../src/types.ts";

const config = { version: 1 as const, brand: "feishu" as const, appId: "cli_test", appSecret: "secret" };
const message = (id: string, text: string, userId = "ou_alice"): IncomingMessage =>
  ({ id, text, userId, chatId: `chat_${userId}` });

class Transport implements BotTransport {
  sent: string[] = [];
  async start() {}
  async stop() {}
  async send(_chat: string, text: string) { this.sent.push(text); return `m_${this.sent.length}`; }
  async update() {}
}

/**
 * Records which conversation key each message was handed to, and which panes were closed.
 * Nothing here reaches herdr: the factory is the seam the controller sees.
 */
class Recorder implements WorkerFactory {
  readonly keys: string[] = [];
  readonly closedKeys: string[] = [];
  readonly resetKeys: string[] = [];
  async open(key: string) {
    this.keys.push(key);
    return { async run() {}, async close() {} };
  }
  async closeConversation(key: string) { this.closedKeys.push(key); }
  async reset(key: string) { this.resetKeys.push(key); }
  async close() {}
}

async function withBot<T>(run: (bot: BotController, transport: Transport, workers: Recorder, stateDir: string) => Promise<T>): Promise<T> {
  const stateDir = await mkdtemp(join(tmpdir(), "lark-conversations-"));
  const transport = new Transport(), workers = new Recorder();
  const bot = new BotController({ config, stateDir, transport, workers });
  await bot.start();
  try { return await run(bot, transport, workers, stateDir); }
  finally { await bot.stop(); await rm(stateDir, { recursive: true, force: true }); }
}

test("a chat with no commands stays a single conversation and writes no state file", async () => {
  await withBot(async (bot, transport, workers, stateDir) => {
    await bot.receive(message("one", "hello"));
    await bot.drain();
    assert.deepEqual(workers.keys, ["ou_alice"], "the chat's first conversation keeps the bare chat key");
    await assert.rejects(readFile(join(stateDir, "conversations.json"), "utf8"), /ENOENT/);
    assert.equal(transport.sent.length, 0, "no command, no command reply");
  });
});

test("/new opens a separate conversation, remembers it, and /switch goes back", async () => {
  await withBot(async (bot, transport, workers, stateDir) => {
    await bot.receive(message("first", "work in #1"));
    await bot.receive(message("new", "/new 字幕任务"));
    await bot.receive(message("second", "work in #2"));
    await bot.drain();
    assert.deepEqual(workers.keys, ["ou_alice", "ou_alice#2"], "the second conversation gets its own key, so its own pane and pi session");
    assert(transport.sent.some((text) => text.includes("已新建会话 #2「字幕任务」")));

    // The listing names both conversations and marks the active one.
    await bot.receive(message("list", "/list"));
    await bot.drain();
    const list = transport.sent.at(-1)!;
    assert(list.includes("#1") && /#2[^\n]*← 当前/.test(list), list);
    assert(list.includes("「字幕任务」"), list);

    // Switching back sends the next message to #1 without closing or resetting anything.
    await bot.receive(message("back", "/switch 1"));
    await bot.receive(message("third", "work in #1 again"));
    await bot.drain();
    assert.deepEqual(workers.keys.at(-1), "ou_alice");
    assert.deepEqual(workers.closedKeys, []);
    assert.deepEqual(workers.resetKeys, []);
    assert(transport.sent.some((text) => text.includes("已切换到会话 #1")), transport.sent.join("\n---\n"));

    // The book survives a restart with #1 active again.
    const stored = JSON.parse(await readFile(join(stateDir, "conversations.json"), "utf8"));
    assert.equal(stored.appId, config.appId);
    assert.equal(stored.chats.ou_alice.active, 1);
    assert.deepEqual(stored.chats.ou_alice.slots.map((slot: { id: number; title?: string }) => [slot.id, slot.title]), [[1, undefined], [2, "字幕任务"]]);
  });
});

test("/close closes only that conversation's pane and never leaves the chat without one", async () => {
  await withBot(async (bot, transport, workers) => {
    await bot.receive(message("new1", "/new"));
    await bot.receive(message("new2", "/new"));
    await bot.drain();
    assert(workers.keys.length === 0, "opening a conversation does not open a pane until a message needs one");

    // Closing a conversation the chat is not in leaves the active one alone.
    await bot.receive(message("close", "/close 2"));
    await bot.drain();
    assert.deepEqual(workers.closedKeys, ["ou_alice#2"], "closing uses the conversation's own pane key");
    assert(transport.sent.at(-1)!.includes("已关闭会话 #2"), transport.sent.join("\n---\n"));
    await bot.receive(message("after", "still works"));
    await bot.drain();
    assert.deepEqual(workers.keys, ["ou_alice#3"], "#3 was active, so the message stays in it");

    // Closing the active conversation falls back to the lowest one left.
    await bot.receive(message("close-active", "/close 3"));
    await bot.receive(message("back", "next message"));
    await bot.drain();
    assert.deepEqual(workers.keys.at(-1), "ou_alice", "#1 is what remains");
    assert(transport.sent.some((text) => text.includes("下一条消息进会话 #1")), transport.sent.join("\n---\n"));

    // The last conversation cannot be closed: /reset is the destructive command.
    await bot.receive(message("close-last", "/close 1"));
    await bot.drain();
    assert(transport.sent.at(-1)!.includes("唯一的会话"), transport.sent.join("\n---\n"));
    assert.deepEqual(workers.closedKeys, ["ou_alice#2", "ou_alice#3"], "nothing else was closed");
  });
});

test("/switch and /close reject unknown numbers, and /new refuses to exceed the cap", async () => {
  await withBot(async (bot, transport) => {
    await bot.receive(message("bad", "/switch 7"));
    await bot.drain();
    assert(transport.sent.at(-1)!.includes("没有会话 #7"), transport.sent.join("\n---\n"));

    for (let index = 2; index <= MAX_CONVERSATIONS; index++) {
      await bot.receive(message(`new${index}`, "/new"));
      await bot.drain();
    }
    assert(transport.sent.at(-1)!.includes(`已新建会话 #${MAX_CONVERSATIONS}`), transport.sent.at(-1)!);
    await bot.receive(message("overflow", "/new"));
    await bot.drain();
    assert(transport.sent.at(-1)!.includes("达到上限"), transport.sent.at(-1)!);
    await bot.receive(message("list", "/list"));
    await bot.drain();
    assert(transport.sent.at(-1)!.includes(`#${MAX_CONVERSATIONS}`));
    assert(!transport.sent.at(-1)!.includes(`#${MAX_CONVERSATIONS + 1}`));
  });
});

test("a group chat keeps its own conversation numbering", async () => {
  await withBot(async (bot, _transport, workers) => {
    const group = (id: string, text: string): IncomingMessage =>
      ({ id, text, userId: "ou_bob", chatId: "oc_team", chatType: "group", mentionedBot: true });
    await bot.receive(group("g-new", "/new"));
    await bot.receive(group("g-msg", "group work"));
    await bot.drain();
    assert.deepEqual(workers.keys, ["group:oc_team#2"], "groups and DMs never share a conversation key");
  });
});
