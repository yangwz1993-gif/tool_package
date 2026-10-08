import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BotController } from "../src/controller.ts";
import type { BotTransport, IncomingMessage, WorkerFactory } from "../src/types.ts";

const config = { version: 1 as const, brand: "feishu" as const, appId: "cli_test", appSecret: "secret" };

class Transport implements BotTransport {
  readonly reactions: Array<{ id: string; emoji: string }> = [];
  readonly sent: string[] = [];
  readonly updates: string[] = [];
  fail?: Error;
  async start() {}
  async stop() {}
  async send(_chat: string, text: string) { this.sent.push(text); return `m_${this.sent.length}`; }
  async update(_id: string, text: string) { this.updates.push(text); }
  async react(messageId: string, emoji: string) {
    this.reactions.push({ id: messageId, emoji });
    if (this.fail) throw this.fail;
  }
}

function run(transport: BotTransport, text = "hello") {
  const stateDir = mkdtemp(join(tmpdir(), "lark-ack-"));
  return stateDir.then(async (dir) => {
    const workers: WorkerFactory = {
      async open() { return { async run(_text, emit) { emit({ type: "done", text: "answer" }); }, async close() {} }; },
      async close() {},
    };
    const bot = new BotController({ config, stateDir: dir, transport, workers });
    const message: IncomingMessage = { id: "om_1", text, userId: "ou_alice", chatId: "chat" };
    await bot.start();
    try { await bot.receive(message); await bot.drain(); }
    finally { await bot.stop(); await rm(dir, { recursive: true, force: true }); }
  });
}

/**
 * The acknowledgement reaction is the sender's only sign that a message was received. It is
 * fire-and-forget by contract, so it must also never be able to break the reply itself:
 * that regression (a missing ACK_EMOJI constant) silently dropped every reply.
 */
test("an allowed message is acknowledged with ✅ and still gets its reply", async () => {
  const transport = new Transport();
  await run(transport);
  assert.deepEqual(transport.reactions, [{ id: "om_1", emoji: "OK" }], "Feishu renders emoji_type OK as ✅");
  assert(transport.updates.some((text) => text.includes("answer")), transport.updates.join("\n---\n"));
});

test("a failing reaction never delays or drops the reply", async () => {
  const transport = new Transport();
  transport.fail = new Error("reaction API refused");
  await run(transport);
  assert.equal(transport.reactions.length, 1, "the reaction was attempted");
  assert(transport.updates.some((text) => text.includes("answer")), `the reply still arrived: ${transport.updates.join("\n---\n")}`);
});

test("bot commands are acknowledged without being sent to Pi", async () => {
  const transport = new Transport();
  await run(transport, "/list");
  assert.deepEqual(transport.reactions, [{ id: "om_1", emoji: "OK" }]);
  assert(!transport.updates.some((text) => text.includes("answer")), "a command never reaches the model");
});
