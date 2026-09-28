export interface TestChat {
  /** Chat id, e.g. -1001234567890 for a supergroup. */
  id: number;
  title: string;
  /** User id of the chat's creator. The bot is always an administrator. */
  ownerId: number;
  ownerName?: string;
}

export interface PublicChat {
  /** Username without or with the leading "@". */
  username: string;
  type: "channel" | "supergroup" | "bot";
  title?: string;
}

export interface TelegramBotTestServerOptions {
  /** The bot's token, "<numeric id>:<secret>". Calls with any other token get 401. */
  botToken: string;
  /** Default 0 (any free port). */
  port?: number;
  /** Default "127.0.0.1". */
  host?: string;
  /** Default "fake_test_bot". */
  botUsername?: string;
  /** Default "Fake Test Bot". */
  botName?: string;
  /** Supergroups the bot administers. */
  chats?: TestChat[];
  /** Channels, groups and bots that getChat("@username") resolves. */
  publicChats?: PublicChat[];
  /**
   * What an unimplemented Bot API method returns: an error naming the method
   * ("error", default), or `true` ("ok").
   */
  unimplemented?: "error" | "ok";
  log?: (line: string) => void;
}

/** A message as the server stores it, in the Bot API's Message shape. */
export type Message = { message_id: number; [field: string]: unknown };

/** A chat member in the Bot API's ChatMember shape. */
export type ChatMember = {
  status:
    "creator" | "administrator" | "member" | "restricted" | "left" | "kicked";
  user: { id: number; [field: string]: unknown };
  [field: string]: unknown;
};

export interface ButtonAnswer {
  /** Whether the bot called answerCallbackQuery within 10 seconds. */
  answered: boolean;
  text?: string;
  show_alert?: boolean;
}

export interface UserFields {
  first_name?: string;
  last_name?: string;
  username?: string;
  language_code?: string;
  bio?: string;
}

export interface PostedMessage {
  text?: string;
  /** Image bytes, sent as a photo. */
  photo?: Uint8Array;
  caption?: string;
  /** message_id this message replies to. */
  replyTo?: number;
  /** Forum topic to post in; the message then replies to the topic's creation. */
  threadId?: number;
}

export interface NewChat {
  title?: string;
  /** Default "supergroup". */
  type?: "supergroup" | "channel";
  /** The chat's creator. */
  ownerId: number;
  ownerName?: string;
  /** A supergroup with forum topics. */
  isForum?: boolean;
}

export interface BotMembership {
  /** Default "administrator". "left" removes the bot. */
  status?: "administrator" | "member" | "left" | "kicked";
  /** Administrator rights to grant or withhold, e.g. { can_post_messages: false }. */
  rights?: Record<string, boolean>;
  /** Who made the change; default the chat's creator. */
  by?: number;
}

/** Make the next matching Bot API calls fail. */
export interface FailureRule {
  /** Bot API method name, e.g. "sendMessage". */
  method: string;
  /** Only calls to this chat. */
  chatId?: number;
  /** Only calls from this bot. */
  botId?: number;
  /** How many calls fail; default 1. */
  times?: number;
  /** Default 400. */
  errorCode?: number;
  /** Default "Bad Request". */
  description?: string;
  /** Sent as parameters.retry_after, as with a 429. */
  retryAfter?: number;
  /** The call takes effect, but the connection closes before it answers. */
  dropAfterApply?: boolean;
}

/**
 * The running server. Besides the Bot API at `origin`, it exposes the actions
 * a test takes on Telegram's side. Each resolves after the resulting update has
 * been handed to the bot's webhook, or queued for getUpdates. The same actions
 * are available over HTTP under `${origin}/_fake/` for tests in other languages.
 */
export interface TelegramBotTestServer {
  /** Base URL to use as the bot's Bot API root, e.g. "http://127.0.0.1:53211". */
  origin: string;
  /**
   * Another bot this server answers for, with its own webhook or update queue.
   * It is in no chat until added with setBotMembership.
   */
  addBot(bot: {
    token: string;
    username: string;
    firstName?: string;
  }): Promise<{ id: number; is_bot: true; username: string }>;
  /** A group, forum or channel owned by `ownerId`, with no bot in it; returns its id. */
  createChat(chat: NewChat): Promise<number>;
  /** The chat, its pinned message ids (newest first) and members. */
  getChat(chatId: number): Promise<{
    id: number;
    type: string;
    title: string;
    pinned: number[];
    members: Array<{ user_id: number; status: string }>;
  }>;
  /**
   * Add, promote, demote or remove a bot, as the chat's owner would. The bot
   * gets my_chat_member, the chat's other bots chat_member, and a group a
   * service message when the bot joins or leaves.
   */
  setBotMembership(
    chatId: number,
    botId: number,
    membership?: BotMembership,
  ): Promise<ChatMember>;
  /** Create a forum topic, with its service message; returns its message_thread_id. */
  createTopic(
    chatId: number,
    name: string,
    options?: { by?: number },
  ): Promise<number>;
  renameTopic(
    chatId: number,
    threadId: number,
    name: string,
    options?: { by?: number },
  ): Promise<{ message_thread_id: number; name: string }>;
  failNext(rule: FailureRule): Promise<unknown>;
  clearFailures(): Promise<{ ok: true }>;
  /** Create a user; returns their id. */
  createUser(fields?: UserFields): Promise<number>;
  updateProfile(userId: number, fields: UserFields): Promise<unknown>;
  addProfilePhoto(userId: number, bytes: Uint8Array): Promise<unknown>;
  /** The user joins a chat directly. */
  join(chatId: number, userId: number): Promise<{ status: "member" }>;
  /** The user opens an invite link: joins, or files a join request if the link requires one. */
  joinByLink(
    inviteLink: string,
    userId: number,
  ): Promise<{ chat_id: number; status: "member" | "requested" }>;
  leave(chatId: number, userId: number): Promise<{ status: string }>;
  /** The user posts in a chat; returns the message_id. Fails if they may not post. */
  post(
    chatId: number,
    userId: number,
    message: string | PostedMessage,
  ): Promise<number>;
  /** The user presses an inline button under a message in a chat. */
  pressButton(
    chatId: number,
    messageId: number,
    userId: number,
    data: string,
  ): Promise<ButtonAnswer>;
  /**
   * A user calls a guest bot (Bot API 10.0 guest mode) that is not a member of
   * the chat; its answer appears in the chat from that bot, with
   * guest_bot_caller_user naming the caller. Returns the message_id.
   */
  postGuestBotReply(
    chatId: number,
    callerUserId: number,
    botUsername: string,
    text: string,
  ): Promise<number>;
  /** The user sends the bot a direct message; returns the message_id. */
  sendDirectMessage(userId: number, text: string): Promise<number>;
  /** The user presses an inline button in their private chat with the bot. */
  pressDirectButton(
    userId: number,
    messageId: number,
    data: string,
  ): Promise<ButtonAnswer>;
  /** Messages not deleted, newest first. */
  getMessages(chatId: number): Promise<Message[]>;
  getMessage(
    chatId: number,
    messageId: number,
  ): Promise<{ exists: boolean; deleted: boolean; message?: Message }>;
  /** The private chat's messages, newest first. */
  getDirectMessages(userId: number): Promise<Message[]>;
  /** The member as getChatMember would return them. */
  getMember(chatId: number, userId: number): Promise<ChatMember>;
  /** User ids with a pending join request. */
  getJoinRequests(chatId: number): Promise<number[]>;
  /** Every Bot API call received, and any unsupported methods called. */
  getCalls(): Promise<{
    calls: Array<{
      method: string;
      /** The bot that made the call. */
      bot_id: number;
      params: Record<string, unknown>;
      at: number;
      /** The error a failure rule answered with. */
      failed?: number;
      /** The call took effect and its answer was dropped. */
      dropped?: true;
    }>;
    unimplemented: string[];
  }>;
  stop(): Promise<void>;
}

export declare function startTestServer(
  options: TelegramBotTestServerOptions,
): Promise<TelegramBotTestServer>;
