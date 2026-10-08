export interface BotConfig {
  version: 1;
  brand: "feishu" | "lark";
  appId: string;
  appSecret: string;
}

export type IncomingAttachment =
  | { status: "ready"; type: "file" | "image" | "audio" | "video"; path: string; name: string; size: number; sourceMessageId: string }
  | { status: "failed"; type: "file" | "image" | "audio" | "video"; name: string; sourceMessageId: string; error: "download_failed" };

export interface IncomingMessage {
  id: string;
  userId: string;
  chatId: string;
  text: string;
  chatType?: "p2p" | "group";
  mentionedBot?: boolean;
  /** The directly quoted/replied-to message, if any. */
  parentMessageId?: string;
  /** Text of the directly quoted/replied-to message, resolved after authorization. */
  quotedText?: string;
  attachments?: IncomingAttachment[];
  preparationWarning?: "referenced_message_unavailable";
  /**
   * Set when a message was addressed to the bot but carries nothing it can run.
   * It still travels the normal path so the allowlist decides who gets an answer:
   * an addressed message must never vanish without one.
   */
  unsupported?: "message_type" | "content" | "empty_text";
}

/** Keep existing private-session keys; group IDs occupy a distinct namespace. */
export function conversationKey(message: IncomingMessage): string {
  return message.chatType === "group" ? `group:${message.chatId}` : message.userId;
}

/** Global, single, optional push destination. Absent means pushing is disabled. */
export interface PushTarget {
  version: 1;
  appId: string;
  chatId: string;
  chatType: "p2p" | "group";
  /** Conversation key that set it, for local diagnostics only. */
  setBy: string;
  setAt: string;
}

/** Worker-initiated request over the controller IPC socket. */
export type WorkerRequest =
  | { action: "push"; text: string }
  | { action: "set-target" }
  | { action: "clear-target" }
  | { action: "target-status" };
export interface WorkerResponse { ok: boolean; text: string }

/** Chat output only. `done` ends a reply bubble, not an input delivery or background task. */
export type WorkerEvent =
  | { type: "progress"; text: string }
  | { type: "text"; text: string }
  | { type: "done"; text: string; error?: boolean };

export interface ConversationWorker {
  /** Resolves on Pi handoff, not completion. The sink receives chat-wide output until replaced/closed. */
  run(text: string, onEvent: (event: WorkerEvent) => void, signal?: AbortSignal): Promise<void>;
  /** Abort the current Pi operation without opening a new pane. */
  interrupt?(): Promise<void>;
  close(): Promise<void>;
}

export interface ModelSpec { provider: string; id: string }

/**
 * One live conversation worker, as reported to the controller's `/list` and local status view.
 * A chat's first conversation keeps the bare chat key; later ones are `<chat key>#N`.
 */
export interface WorkerSnapshot {
  /** Conversation key: the chat key, plus `#N` for every conversation after the first. */
  key: string;
  /** Chat key: the p2p sender's open_id, or `group:<chat_id>`. Stable across conversations. */
  userId: string;
  /** 1-based conversation number inside that chat. */
  slot: number;
  paneId?: string;
  sessionFile: string;
  connected: boolean;
}

export interface WorkerFactory {
  list?(): WorkerSnapshot[];
  open(userId: string): Promise<ConversationWorker>;
  /** Delete only this conversation's saved Pi history and close its pane. */
  reset?(userId: string): Promise<void>;
  /** Select the model used when this conversation's pane is next opened. */
  setModel?(userId: string, model: ModelSpec): Promise<void>;
  /** Close this conversation's pane but keep its saved Pi history, so it can be resumed later. */
  closeConversation?(userId: string): Promise<void>;
  close(): Promise<void>;
}

export interface BotTransport {
  readonly state?: string;
  start(onMessage: (message: IncomingMessage) => Promise<void>): Promise<void>;
  stop(): Promise<void>;
  send(chatId: string, text: string, replyTo?: string): Promise<string>;
  update(messageId: string, text: string): Promise<void>;
  /**
   * Immediate receipt signal, added before the agent starts working.
   * Cosmetic and best-effort: the implementation must never throw, and a missing
   * reaction must never delay, drop or fail the message it acknowledges.
   */
  react?(messageId: string, emoji: string): Promise<void>;
  /** Resolve quoted resources only after sender authorization succeeds. */
  prepareMessage?(message: IncomingMessage): Promise<IncomingMessage>;
  sendCard?(chatId: string, card: object, replyTo?: string): Promise<string>;
  updateCard?(messageId: string, card: object): Promise<void>;
}
