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
      params: Record<string, unknown>;
      at: number;
    }>;
    unimplemented: string[];
  }>;
  stop(): Promise<void>;
}

export declare function startTestServer(
  options: TelegramBotTestServerOptions,
): Promise<TelegramBotTestServer>;
