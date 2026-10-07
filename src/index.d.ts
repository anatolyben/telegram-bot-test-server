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
  /**
   * A manual clock starting at this Unix time in milliseconds, moved only by
   * advanceTime. Omit for real time.
   */
  clock?: { now: number };
  /** Default "127.0.0.1". */
  host?: string;
  /** Default "example_bot". */
  botUsername?: string;
  /** Default "Example Bot". */
  botName?: string;
  /**
   * The bot is a guard bot: in a chat where it has can_invite_users, join
   * requests reach it as queries it answers with answerChatJoinRequestQuery.
   * Default false.
   */
  supportsJoinRequestQueries?: boolean;
  /**
   * The first bot's Telegram Login client secret (its client id is the bot
   * id). Default: a random secret, readable from GET /_fake/bot.
   */
  loginClientSecret?: string;
  /** Supergroups the bot administers. */
  chats?: TestChat[];
  /** Channels, groups and bots that getChat("@username") resolves. */
  publicChats?: PublicChat[];
  /**
   * What an unimplemented Bot API method returns: Telegram's 404 "Not Found:
   * method not found" ("error", default), or `true` when Telegram documents
   * the method as returning True ("ok"; any other method still gets the 404).
   */
  unimplemented?: "error" | "ok";
  /**
   * Apply the limits Telegram publishes to a bot's sends: one message a
   * second in a chat, 20 a minute in a group, 30 a second across all chats
   * (an album counts each message). As Telegram's Bot API server does, a send
   * that has to wait 8 seconds or less is held and then sent; one that has to
   * wait longer gets 429 "Too Many Requests: retry after N". Also answer a
   * setWebhook with a URL within a second of the previous one with "retry
   * after 1", as Telegram's Bot API server does. Default false.
   */
  floodControl?: boolean;
  /** Serve the live chat viewer at `${origin}/_fake/ui`, to this computer only. Default false. */
  ui?: boolean;
  /** POST { now, mode } here whenever the manual clock is set or advanced. Default none. */
  clockWebhook?: string;
  /**
   * Write each stopped recording here, as `<name>.html` and `<name>.json`
   * (the directory is made when missing). Default none: stopRecording only
   * returns them.
   */
  recordDir?: string;
  log?: (line: string) => void;
}

/** A message as the server stores it, in the Bot API's Message shape. */
export type Message = { message_id: number; [field: string]: unknown };

/** A MessageEntity in the Bot API's shape, such as { type: "bold", offset: 0, length: 4 }. */
export type MessageEntity = {
  type: string;
  offset: number;
  length: number;
  [field: string]: unknown;
};

/** A Bot API Poll: id, question, options with voter_count, total_voter_count, ... */
export type Poll = { id: string; [field: string]: unknown };

/** A chat member in the Bot API's ChatMember shape. */
export type ChatMember = {
  status:
    | "creator"
    | "administrator"
    | "member"
    | "restricted"
    | "left"
    | "kicked";
  user: { id: number; [field: string]: unknown };
  [field: string]: unknown;
};

export interface ButtonAnswer {
  /**
   * Whether the bot called answerCallbackQuery within 10 seconds. An answer
   * Telegram refuses (text over 200 characters) does not count.
   */
  answered: boolean;
  text?: string;
  show_alert?: boolean;
}

export interface PressOptions {
  /**
   * Deliver the press twice: once, then the same update again to the bot's
   * webhook, with the same update_id and callback query id, as Telegram
   * sends an update again when a webhook does not confirm it. Needs a
   * webhook. Default false.
   */
  deliverTwice?: boolean;
}

export interface OpenUrlOptions {
  /**
   * The group (startgroup link) or channel (startchannel link) the person
   * picks to add the bot to. Required for those links; ignored otherwise.
   */
  addToChatId?: number;
}

/**
 * What opening a URL button did. Only url for any other URL. A start link
 * also gives the /start message's id in the person's private chat
 * (chat_id); a startgroup or startchannel link gives the chat the bot was
 * added to.
 */
export interface OpenedUrl {
  url: string;
  link?: "start" | "startgroup" | "startchannel";
  bot_id?: number;
  chat_id?: number;
  message_id?: number;
}

export interface UserFields {
  first_name?: string;
  last_name?: string;
  username?: string;
  language_code?: string;
  bio?: string;
  /** Shown as User.is_bot. Default false. */
  is_bot?: boolean;
  /** Shown as User.is_premium. Default false. */
  is_premium?: boolean;
}

/** A Bot API BusinessConnection. */
export interface BusinessConnection {
  id: string;
  user: { id: number; [field: string]: unknown };
  user_chat_id: number;
  date: number;
  rights: { can_reply?: boolean; [right: string]: boolean | undefined };
  is_enabled: boolean;
}

/** One message in a business chat, as the control API lists it. */
export interface BusinessChatEntry {
  /** From the person, the owner by hand, or the bot for the owner. */
  direction: "inbound" | "owner" | "bot";
  deleted: boolean;
  message: Message;
}

export interface PostedMessage {
  text?: string;
  /** Image bytes, sent as a photo; a PNG, GIF or JPEG header gives its size. */
  photo?: Uint8Array;
  caption?: string;
  /** message_id this message replies to. */
  replyTo?: number;
  /** Forum topic to post in; the message then replies to the topic's creation. */
  threadId?: number;
  /** Anything besides a photo; a caption goes with every kind but stickers and video notes. */
  media?: {
    type:
      | "video"
      | "animation"
      | "sticker"
      | "voice"
      | "audio"
      | "video_note"
      | "document";
    bytes: Uint8Array;
    fileName?: string;
    mimeType?: string;
  };
  /**
   * Where a forwarded message came from: a user, a hidden user's name, a
   * channel post, or a supergroup's own post (its chatId, no messageId).
   * authorSignature goes with a channel or supergroup origin.
   */
  forwardFrom?: {
    userId?: number;
    senderName?: string;
    chatId?: number;
    messageId?: number;
    authorSignature?: string;
  };
  /**
   * Entities for the text, in the Bot API's shape, checked as Telegram checks
   * a user's. Types Telegram finds by itself are ignored, but phone_number
   * and bank_card_number.
   */
  entities?: MessageEntity[];
  /** Entities for the caption, read like entities. */
  captionEntities?: MessageEntity[];
  /**
   * In a supergroup, post on behalf of a chat: the group itself (an anonymous
   * administrator, who posts so anyway) or a channel the user created, which
   * needs Telegram Premium (PREMIUM_ACCOUNT_REQUIRED). A member who is not
   * anonymous may name themselves. Anything else fails with
   * SEND_AS_PEER_INVALID.
   */
  sendAs?: number;
  /** A contact, as a message of its own; needs can_send_messages. */
  contact?: {
    phoneNumber: string;
    firstName: string;
    lastName?: string;
    vcard?: string;
    /** The Telegram user the number belongs to. */
    userId?: number;
  };
  /**
   * A location, as a message of its own; needs can_send_messages. A
   * livePeriod other than 0 makes it a live location. horizontalAccuracy is
   * kept in whole meters, rounded up, at most 1500.
   */
  location?: {
    latitude: number;
    longitude: number;
    horizontalAccuracy?: number;
    livePeriod?: number;
    heading?: number;
    proximityAlertRadius?: number;
  };
  /**
   * Post an earlier file again, by a file_id read from a message: it keeps
   * its kind and file_unique_id. A caption may go with it.
   */
  fileId?: string;
  /**
   * A poll, as a message of its own (no text or media), with sendPoll's
   * fields and checks. Needs can_send_polls in a group.
   */
  poll?: {
    question: string;
    options: Array<string | { text: string }>;
    type?: "regular" | "quiz";
    is_anonymous?: boolean;
    allows_multiple_answers?: boolean;
    allows_revoting?: boolean;
    correct_option_ids?: number[];
    explanation?: string;
  };
}

export interface NewChat {
  title?: string;
  /** Default "supergroup". A "group" is a basic group, without the -100 id prefix. */
  type?: "supergroup" | "channel" | "group";
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
  /** Only this target user (user_id or ephemeral receiver). */
  userId?: number;
  /** Only this message_id. */
  messageId?: number;
  /** Start on this matching attempt after installing the rule; default 1. */
  attempt?: number;
  /** Delay the response by 0-30000 ms; without an error/drop, succeeds normally. */
  delayMs?: number;
  /** How many calls fail; default 1. */
  times?: number;
  /** Default 400. */
  errorCode?: number;
  /**
   * Default: Telegram's description for the code, such as "Forbidden", or
   * "Too Many Requests: retry after N" for 429.
   */
  description?: string;
  /**
   * A whole number of seconds, sent as parameters.retry_after, as with a 429,
   * which needs it and also carries it in the Retry-After header.
   */
  retryAfter?: number;
  /** The call takes effect, but the connection closes before it answers. */
  dropAfterApply?: boolean;
}

export interface RecordedCall {
  seq: number;
  method: string;
  /** The call took effect, or, for a read or a call that changes nothing, succeeded. */
  applied: boolean;
  outcome:
    | "pending"
    | "succeeded"
    | "delayed"
    | "response_lost"
    | "failed_after_apply"
    | "rejected"
    | "unimplemented_ok";
  status?: number;
  completed_at?: number;
  fault_id?: string;
  /** Also present on matching attempts before the fault starts injecting. */
  fault_injected?: boolean;
  attempt?: number;
  delay_ms?: number;
  /** The bot that made the call. */
  bot_id: number;
  /**
   * The parameters as Telegram's server reads them: text, with the
   * JSON-serialized ones (reply_markup, media, ...) parsed.
   */
  params: Record<string, unknown>;
  at: number;
  /** Rejected status, including actual permission/validation failures. */
  failed?: number;
  /**
   * The description the answer carried: Telegram's error text for a refusal,
   * or a success's text such as "Webhook was set".
   */
  description?: string;
  /** The call took effect and its answer was dropped. */
  dropped?: true;
  /** Target argument, ephemeral recipient, or deleteMessage author captured before execution. */
  target_user_id?: number;
  request_id: string;
  timeline: Array<{
    stage:
      | "received"
      | "validated"
      | "state_applied"
      | "handler_completed"
      | "response_sent"
      | "response_lost";
    at: number;
  }>;
}

/** A pattern: a RegExp, or its source and flags (over HTTP). */
export type PatternSource = RegExp | { source: string; flags?: string };

export type FakeWaitCondition =
  | {
      kind: "message";
      chatId: number;
      messageId?: number;
      userId?: number;
      botId?: number;
      text?: string;
      caption?: string;
      deleted?: boolean;
      /** Only messages stored after this cursor (MessageLog.cursor). */
      since?: number;
      /** The text or caption includes this. */
      contains?: string;
      /** The text or caption matches this; the g and y flags are dropped. */
      matches?: PatternSource;
      /** An inline button with exactly this text. */
      buttonText?: string;
      /** An inline button with exactly this callback_data (the same button as buttonText). */
      buttonData?: string;
    }
  | {
      kind: "member";
      chatId: number;
      userId: number;
      status: ChatMember["status"];
      permissions?: Record<string, boolean>;
    }
  | {
      kind: "joinRequest";
      chatId: number;
      userId: number;
      botId?: number;
      state: "pending" | "approved" | "declined";
    }
  | {
      kind: "call";
      botId: number;
      method: string;
      chatId?: number;
      userId?: number;
      messageId?: number;
      params?: Record<string, unknown>;
      includeRejectedRequests?: boolean;
      afterSeq?: number;
      requestId?: string;
      outcome?: RecordedCall["outcome"];
      stage?: RecordedCall["timeline"][number]["stage"];
    };
/**
 * Nothing left to do: no update a bot has not confirmed, no Bot API call
 * (getUpdates aside) or webhook attempt in progress, no test action, owner
 * call or clock advance under way, and no call for `ms` milliseconds. `ms`
 * is 1-30000 and below the wait's timeoutMs.
 */
export interface FakeQuietCondition {
  kind: "quiet";
  ms: number;
  /** The bots to consider; default every bot. */
  botIds?: number[];
}
/** An update a bot was sent, after `afterUpdateId`. */
export interface FakeUpdateCondition {
  kind: "update";
  botId: number;
  type?: string | string[];
  chatId?: number;
  afterUpdateId?: number;
  state?: DeliveredUpdate["state"];
}
export type FakeAnyWaitCondition =
  | FakeWaitCondition
  | FakeQuietCondition
  | FakeUpdateCondition;
export interface FakeQuietObservation {
  quiet: true;
  /** Milliseconds since the last call. */
  idleMs: number;
}
/** One update a bot was sent. */
export interface DeliveredUpdate {
  update_id: number;
  type: string;
  /** null for updates about no chat, such as poll and poll_answer. */
  chat_id: number | null;
  /** When it was sent, server clock milliseconds. */
  at: number;
  /**
   * pending: not confirmed yet; delivered: confirmed by a getUpdates offset or
   * a 2XX webhook answer; dropped: given up, or discarded without being
   * received.
   */
  state: "pending" | "delivered" | "dropped";
  /** Returned by getUpdates or posted to the webhook at least once. */
  received: boolean;
  /** Exactly what the bot was sent, its own file_ids included. */
  update: Record<string, unknown>;
}
/** A stored message in the message log. */
export interface MessageLogEntry {
  /** Its place among everything stored in any chat. */
  seq: number;
  /** When it was stored, server clock milliseconds. */
  at: number;
  /** How many Bot API requests had been received when it was stored. */
  after_request: number;
  /** The call that stored it; null for a test action. */
  request_id: string | null;
  /** Who posted it (in a channel, the person or bot behind the channel). */
  author: number;
  deleted: boolean;
  deleted_by: {
    seq: number;
    bot_id: number;
    method: "deleteMessage" | "deleteMessages" | "deleteEphemeralMessage";
    request_id: string | null;
    at: number;
  } | null;
  ephemeral: boolean;
  message: Message;
  /** A poll's votes by user id, when anyone voted. */
  votes?: Record<string, number[]>;
}
export interface MessageLog {
  chat_id: number;
  /** The number of restores so far; a mark from another epoch is refused. */
  epoch: number;
  /** The latest seq: pass it as `since` to read what comes after. */
  cursor: number;
  messages: MessageLogEntry[];
}

export interface FakeWaitOptions {
  /** Wall-clock deadline, 1-30000ms; default 1000. */ timeoutMs?: number;
}
export interface FakeMessageObservation {
  exists: true;
  deleted: boolean;
  message: Message;
}
export interface FakeJoinObservation {
  state: "pending" | "approved" | "declined";
  member: ChatMember;
  botId?: number;
}
export interface FakeClockState {
  mode: "real" | "manual";
  now: number;
  scheduled: number;
}
/** A chat as the viewer and recordings name it: a group's id, "<user id>:<bot id>", a user id (their chat with the first bot) or "calls". */
export type ChatRef = number | string;

export interface RecordingStarted {
  name: string;
  /** Server clock milliseconds. */
  started_at: number;
  epoch: number;
  /** The message log cursor at the start: the recording holds what comes after it. */
  start_seq: number;
  /** How many Bot API requests had been received: it holds the calls after them. */
  start_request: number;
}

/**
 * A recording's data, in the viewer's own shapes: the chat list (`state`) and
 * one page per recorded chat, keyed by its ChatRef, with every item and call
 * of the window, every member, and older messages the window's calls or
 * replies name (`before_window: true`).
 */
export interface RecordingJson {
  format: "telegram-bot-test-server-recording";
  format_version: 1;
  name: string;
  /** The chats asked for, as text; null for every chat. */
  chats_filter: string[] | null;
  window: {
    epoch: number;
    start_seq: number;
    stop_seq: number;
    start_request: number;
    stop_request: number;
    started_at: number;
    stopped_at: number;
  };
  state: Record<string, unknown>;
  pages: Record<string, Record<string, unknown>>;
  /** Every image the pages show, once, as a data: URI. */
  files: Record<
    string,
    {
      url: string;
      mime_type: string;
      width: number | null;
      height: number | null;
      size: number;
    }
  >;
  /** Chats asked for that did not exist when the recording stopped. */
  missing_chats: string[];
}

export interface Recording {
  name: string;
  /** One standalone page that shows the recording offline. */
  html: string;
  json: RecordingJson;
  /** Where they were written, with the recordDir option. */
  files?: { html: string; json: string };
}

export interface FakeDelivery {
  update_id: number;
  bot_id: number;
  attempt: number;
  epoch: number;
  received_at: number;
  started_at?: number;
  completed_at?: number;
  status?: number;
  outcome:
    | "queued"
    | "poll_queue"
    | "delivered"
    | "rejected"
    | "failed"
    | "cancelled";
}

/**
 * The running server. Besides the Bot API at `origin`, it exposes the actions
 * a test takes on Telegram's side. Each resolves after the resulting update has
 * been handed to the bot: its first webhook attempt finished (with any call the
 * webhook answered with), it waits behind an update the webhook refused, or it
 * is queued for getUpdates. The same actions are available over HTTP under
 * `${origin}/_fake/` for tests in other languages.
 */
export interface TelegramBotTestServer {
  waitFor(
    condition: Extract<FakeWaitCondition, { kind: "message" }>,
    options?: FakeWaitOptions,
  ): Promise<FakeMessageObservation>;
  waitFor(
    condition: Extract<FakeWaitCondition, { kind: "member" }>,
    options?: FakeWaitOptions,
  ): Promise<ChatMember>;
  waitFor(
    condition: Extract<FakeWaitCondition, { kind: "joinRequest" }>,
    options?: FakeWaitOptions,
  ): Promise<FakeJoinObservation>;
  waitFor(
    condition: Extract<FakeWaitCondition, { kind: "call" }>,
    options?: FakeWaitOptions,
  ): Promise<RecordedCall>;
  waitFor(
    condition: FakeQuietCondition,
    options?: FakeWaitOptions,
  ): Promise<FakeQuietObservation>;
  waitFor(
    condition: FakeUpdateCondition,
    options?: FakeWaitOptions,
  ): Promise<DeliveredUpdate>;
  waitFor(
    condition: FakeWaitCondition,
    options?: FakeWaitOptions,
  ): Promise<
    FakeMessageObservation | ChatMember | FakeJoinObservation | RecordedCall
  >;
  waitFor(
    condition: FakeAnyWaitCondition,
    options?: FakeWaitOptions,
  ): Promise<
    | FakeMessageObservation
    | ChatMember
    | FakeJoinObservation
    | RecordedCall
    | FakeQuietObservation
    | DeliveredUpdate
  >;
  /**
   * An opaque handle only this server accepts; the server must be idle.
   * Release it when no longer used.
   */
  snapshot(): Promise<string>;
  restore(snapshot: string): Promise<{ restored: true; epoch: number }>;
  releaseSnapshot(snapshot: string): Promise<{ ok: true }>;
  /**
   * Record what happens from now on, in the chats named (by default every
   * chat something happens in), until stopRecording. Any number of names can
   * record at once.
   */
  startRecording(
    name: string,
    options?: { chats?: ChatRef[] },
  ): Promise<RecordingStarted>;
  /**
   * The recording as one HTML page and its JSON twin. A recording that
   * started before a restore is dropped with an error.
   */
  stopRecording(name: string): Promise<Recording>;
  getClock(): Promise<FakeClockState>;
  advanceTime(ms: number): Promise<FakeClockState>;
  /**
   * Wait for queued/in-flight webhook attempts, including retries Telegram
   * would still make and calls a webhook answered with, not downstream
   * enforcement or queued getUpdates consumption.
   */
  drainDeliveries(
    options?: FakeWaitOptions & { botId?: number },
  ): Promise<{ drained: true }>;
  getDeliveries(): Promise<FakeDelivery[]>;
  /** Base URL to use as the bot's Bot API root, e.g. "http://127.0.0.1:53211". */
  origin: string;
  /** The live chat viewer's address with `ui: true`, else null. */
  viewerUrl: string | null;
  /**
   * Another bot this server answers for, with its own webhook or update queue.
   * It is in no chat until added with setBotMembership.
   */
  addBot(bot: {
    token: string;
    username: string;
    firstName?: string;
    /**
     * A guard bot: in a chat where it has can_invite_users, it gets join
     * requests as queries.
     */
    supportsJoinRequestQueries?: boolean;
    /** Its Telegram Login client secret; default random. */
    loginClientSecret?: string;
  }): Promise<{ id: number; is_bot: true; username: string }>;
  /**
   * Delete a bot added with addBot: it leaves every chat it is in, and its
   * token gets 401 Unauthorized from then on. The first bot can't be deleted.
   */
  deleteBot(botId: number): Promise<{ deleted: true }>;
  /** A group, forum or channel owned by `ownerId`, with no bot in it; returns its id. */
  createChat(chat: NewChat): Promise<number>;
  /**
   * A person adds the bot through its t.me/<bot>?startgroup=<parameter> link:
   * the bot joins (as an administrator when rights are given, combined with
   * any it has), then the person's "/start@<bot> <parameter>" is posted. In a
   * channel it is the t.me/<bot>?startchannel&admin=<rights> link: rights are
   * required, there is no startParameter, and nothing is posted.
   * Returns the bot's membership.
   */
  addBotViaLink(
    chatId: number,
    botId: number,
    link?: {
      by?: number;
      startParameter?: string;
      rights?: Record<string, boolean>;
    },
  ): Promise<ChatMember>;
  /** The creator or an administrator upgrades a basic group; returns the new supergroup's id. */
  migrateToSupergroup(
    chatId: number,
    options?: { by?: number },
  ): Promise<number>;
  /** A person with can_change_info renames the chat. */
  renameChat(
    chatId: number,
    change: { by?: number; title: string },
  ): Promise<{ message_id: number }>;
  /** A person with can_change_info sets the chat photo. */
  changeChatPhoto(
    chatId: number,
    change: { by?: number; bytes: Uint8Array },
  ): Promise<{ message_id: number }>;
  /** The chat, its pinned message ids (newest first by sending date) and members. */
  getChat(chatId: number): Promise<{
    id: number;
    type: string;
    title: string;
    pinned: number[];
    members: Array<{ user_id: number; status: string }>;
  }>;
  /**
   * Add, promote, demote or remove a bot, as the chat's owner would. The bot
   * gets my_chat_member, the chat's administrator bots chat_member, and a
   * group a service message when the bot joins or leaves.
   */
  setBotMembership(
    chatId: number,
    botId: number,
    membership?: BotMembership,
  ): Promise<ChatMember>;
  /**
   * A person (`by`, default the creator) makes a member an administrator with
   * the rights given, e.g. { can_delete_messages: true }. Rights left out are
   * not granted, and no right at all makes them a member; an edit keeps the
   * custom title and who promoted them, so a bot that did still edits them.
   * The chat's administrator bots get chat_member. Fails as
   * Telegram refuses the person; in a basic group only the creator promotes,
   * with the group's fixed rights.
   */
  promoteMember(
    chatId: number,
    userId: number,
    promotion: { by?: number; rights: Record<string, boolean> },
  ): Promise<ChatMember>;
  /** A person (`by`, default the creator) makes an administrator a member again. */
  demoteMember(
    chatId: number,
    userId: number,
    options?: { by?: number },
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
  /** An owner account a test can connect an owner client to. */
  createOwner(owner?: {
    userId?: number;
    firstName?: string;
    lastName?: string;
    username?: string;
  }): Promise<{ id: number }>;
  /** Revoke (false) or restore the owner's authorization. */
  updateOwner(
    ownerId: number,
    change: { authorized?: boolean },
  ): Promise<unknown>;
  /** The owner's dialogs and filter order; never another owner's. */
  getOwner(ownerId: number): Promise<unknown>;
  /** Someone who can send messages in the owner's groups. */
  addOwnerUser(
    ownerId: number,
    user: {
      id?: number;
      firstName?: string;
      lastName?: string;
      username?: string;
      bot?: boolean;
    },
  ): Promise<{ id: number }>;
  /** A conversation on the owner's account; returns its peer id. */
  addOwnerDialog(
    ownerId: number,
    dialog: OwnerDialogFields,
  ): Promise<{ id: number }>;
  /** Move between folders, pin, mute or set the unread count. */
  updateOwnerDialog(
    ownerId: number,
    peerId: number,
    change: Pick<
      OwnerDialogFields,
      "folder" | "pinned" | "muted" | "muteUntil" | "unreadCount"
    >,
  ): Promise<unknown>;
  addOwnerMessages(
    ownerId: number,
    peerId: number,
    messages: OwnerMessageFields[],
  ): Promise<{ ids: number[] }>;
  editOwnerMessage(
    ownerId: number,
    peerId: number,
    messageId: number,
    edit: { text: string; editDate?: number },
  ): Promise<unknown>;
  deleteOwnerMessage(
    ownerId: number,
    peerId: number,
    messageId: number,
  ): Promise<unknown>;
  /** Create or change a custom dialog filter. */
  setOwnerFilter(ownerId: number, filter: OwnerFilterFields): Promise<unknown>;
  /** Every filter id once, with 0 for the default ("All chats"). */
  orderOwnerFilters(ownerId: number, ids: number[]): Promise<unknown>;
  deleteOwnerFilter(ownerId: number, filterId: number): Promise<unknown>;
  failOwnerCall(ownerId: number, fault: OwnerFault): Promise<unknown>;
  clearOwnerFaults(ownerId: number): Promise<unknown>;
  getOwnerCalls(ownerId: number): Promise<OwnerCall[]>;
  /** Remove every owner and its state. */
  resetOwners(): Promise<unknown>;
  /**
   * The user logs in on the Telegram Login page for this authorization URL
   * (the /auth URL an app sends the browser to). Returns the redirect_uri URL
   * with the one-time code and state.
   */
  approveLogin(authUrl: string, userId: number): Promise<string>;
  /** The user cancels: returns the redirect_uri URL with error=access_denied and state. */
  cancelLogin(authUrl: string): Promise<string>;
  /**
   * The owner connects a bot (default the first) to their business account, or,
   * given the id of an existing connection, changes its rights or enabled
   * state. The bot gets business_connection; update_id is null when its
   * allowed_updates leave that out.
   */
  connectBusiness(connection: {
    ownerId: number;
    rights?: BusinessConnection["rights"];
    id?: string;
    isEnabled?: boolean;
    botId?: number;
  }): Promise<{ connection: BusinessConnection; update_id: number | null }>;
  getBusinessConnection(connectionId: string): Promise<BusinessConnection>;
  /**
   * The person writes in the owner's business chat, or the owner answers by
   * hand. The bot gets business_message unless the connection is disabled.
   */
  sayInBusinessChat(
    connectionId: string,
    userId: number,
    sender: "person" | "owner",
    text: string,
  ): Promise<{ message_id: number; date: number; update_id: number | null }>;
  /** The business chat with a person, newest first. */
  getBusinessChat(
    connectionId: string,
    userId: number,
  ): Promise<BusinessChatEntry[]>;
  /**
   * Deliver an update again, byte for byte, to the webhook it went to. Each bot
   * numbers its own updates, so name the bot when two bots got the same id.
   */
  redeliverUpdate(
    updateId: number,
    options?: { botId?: number },
  ): Promise<{ update_id: number }>;
  updateProfile(userId: number, fields: UserFields): Promise<unknown>;
  addProfilePhoto(userId: number, bytes: Uint8Array): Promise<unknown>;
  /** The user joins a chat directly. */
  join(chatId: number, userId: number): Promise<{ status: "member" }>;
  /**
   * The user opens an invite link: joins, or files a join request if the link requires one.
   * Rejects with INVITE_HASH_EXPIRED when the link is revoked, past its expire_date, or full.
   */
  joinByLink(
    inviteLink: string,
    userId: number,
  ): Promise<{ chat_id: number; status: "member" | "requested" }>;
  leave(chatId: number, userId: number): Promise<{ status: string }>;
  /**
   * The user posts in a chat; returns the message_id. Text and captions are
   * trimmed as Telegram's apps send them. Fails if they may not post: in a
   * channel, only the creator and administrators with can_post_messages may,
   * and bots get the post as channel_post. Fails with MESSAGE_EMPTY when the
   * text shows nothing once trimmed (only spaces or blank characters such as
   * zero-width spaces); such a caption is dropped. In a supergroup, an
   * anonymous administrator's post comes from the group (sender_chat).
   */
  post(
    chatId: number,
    userId: number,
    message: string | PostedMessage,
  ): Promise<number>;
  /** The user posts 2 to 10 photos or videos as one album. */
  postAlbum(
    chatId: number,
    userId: number,
    items: Array<{
      type: "photo" | "video";
      bytes: Uint8Array;
      caption?: string;
    }>,
    options?: { threadId?: number },
  ): Promise<{ media_group_id: string; message_ids: number[] }>;
  /**
   * The author edits their message's text or caption, trimmed as when posted;
   * bots get edited_message (edited_channel_post in a channel). Text that shows
   * nothing fails with MESSAGE_EMPTY, and such a caption removes the caption.
   */
  editMessage(
    chatId: number,
    messageId: number,
    userId: number,
    edit: { text?: string; caption?: string },
  ): Promise<{ message_id: number; edit_date: number }>;
  /**
   * The user sets their reaction on a message, or takes it back with null.
   * Administrator bots that asked for message_reaction are told.
   */
  react(
    chatId: number,
    messageId: number,
    userId: number,
    emoji: string | null,
  ): Promise<{ reactions: Record<string, string[]> }>;
  /**
   * The user pins a message, with can_pin_messages (in a channel,
   * can_edit_messages). Every bot in the chat gets the pinned_message service
   * message; returns its message_id.
   */
  pinMessage(
    chatId: number,
    messageId: number,
    userId: number,
  ): Promise<{ message_id: number }>;
  /**
   * The user presses an inline button under a message in a chat. The bot that
   * put the keyboard on the message, by sending it or by the last edit that
   * set the keyboard, gets the callback_query.
   */
  pressButton(
    chatId: number,
    messageId: number,
    userId: number,
    data: string,
    options?: PressOptions,
  ): Promise<ButtonAnswer>;
  /**
   * The receiver of an ephemeral message presses one of its inline buttons;
   * the message is named by its ephemeral_message_id (its message_id is 0).
   */
  pressEphemeralButton(
    chatId: number,
    ephemeralMessageId: number,
    userId: number,
    data: string,
    options?: PressOptions,
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
  /**
   * The user sends the bot a direct message: text, or anything post() takes
   * but threadId and sendAs (a photo, media, a caption, a reply, a forward, a
   * poll, a contact, a location or an earlier file); returns the message_id.
   * Text that shows nothing once trimmed fails with MESSAGE_EMPTY.
   */
  sendDirectMessage(
    userId: number,
    message: string | Omit<PostedMessage, "threadId" | "sendAs">,
  ): Promise<number>;
  /**
   * The user votes in a poll: option indexes, or an empty list to retract.
   * Refused as Telegram's app refuses it ("Can't answer closed poll", "Can't
   * revote in a quiz", ...). The bot that sent the poll gets a poll update,
   * and a poll_answer when the poll is not anonymous. Resolves with the poll.
   */
  vote(
    chatId: number,
    messageId: number,
    userId: number,
    optionIds: number[],
  ): Promise<Poll>;
  /** The user votes in a poll the bot sent to their private chat. */
  voteDirect(
    userId: number,
    messageId: number,
    optionIds: number[],
  ): Promise<Poll>;
  /** The user presses an inline button in their private chat with the bot. */
  pressDirectButton(
    userId: number,
    messageId: number,
    data: string,
    options?: PressOptions,
  ): Promise<ButtonAnswer>;
  /**
   * The user opens a URL button, named by its text or its index (row by row,
   * from 0). A t.me/<bot>?start=<parameter> link to the first bot sends
   * "/start <parameter>" in the user's private chat; a startgroup or
   * startchannel link to one of the server's bots adds it to addToChatId as
   * addBotViaLink does. Any other URL changes nothing. Refused for a button
   * that is not a URL button, or a user not in the chat.
   */
  openUrlButton(
    chatId: number,
    messageId: number,
    userId: number,
    button: string | number,
    options?: OpenUrlOptions,
  ): Promise<OpenedUrl>;
  /** The receiver of an ephemeral message opens one of its URL buttons. */
  openEphemeralUrlButton(
    chatId: number,
    ephemeralMessageId: number,
    userId: number,
    button: string | number,
    options?: OpenUrlOptions,
  ): Promise<OpenedUrl>;
  /** The user opens a URL button in their private chat with the bot. */
  openDirectUrlButton(
    userId: number,
    messageId: number,
    button: string | number,
    options?: OpenUrlOptions,
  ): Promise<OpenedUrl>;
  /**
   * Messages not deleted, newest first, with ephemeral messages (message_id 0,
   * receiver_user set) in the order they were sent. Their file_ids are the
   * first bot's; every other bot gets its own for the same file.
   */
  getMessages(chatId: number): Promise<Message[]>;
  /**
   * A regular message by its message_id; an ephemeral one (message_id 0) is
   * found with getEphemeralMessage.
   */
  getMessage(
    chatId: number,
    messageId: number,
  ): Promise<{ exists: boolean; deleted: boolean; message?: Message }>;
  /** An ephemeral message by its ephemeral_message_id. */
  getEphemeralMessage(
    chatId: number,
    ephemeralMessageId: number,
  ): Promise<{ exists: boolean; deleted: boolean; message?: Message }>;
  /** The private chat's messages, newest first. */
  getDirectMessages(userId: number): Promise<Message[]>;
  /** The member as getChatMember would return them to the first bot. */
  getMember(chatId: number, userId: number): Promise<ChatMember>;
  /** User ids with a pending join request. */
  getJoinRequests(chatId: number): Promise<number[]>;
  /** Every Bot API call received, and any unsupported methods called. */
  getCalls(): Promise<{
    calls: RecordedCall[];
    /**
     * Calls refused before their parameters were read: an unknown token or
     * unreadable form data.
     */
    rejected_requests: RecordedCall[];
    unimplemented: string[];
  }>;
  /**
   * The chat's messages stored after a mark (`since`, a cursor), oldest first;
   * with includeDeleted also those deleted, and those deleted after the mark.
   * A positive chat id reads the user's private chat, all bots' messages in
   * it or one bot's (botId, a deleted bot's too). Read the cursor once as the
   * mark; pass its epoch to refuse a mark from before a restore.
   */
  getMessageLog(
    chatId: number,
    options?: {
      since?: number;
      includeDeleted?: boolean;
      botId?: number;
      epoch?: number;
    },
  ): Promise<MessageLog>;
  /** The updates a bot was sent, in update_id order, after `since`. */
  getBotUpdates(
    botId: number,
    options?: {
      type?: string | string[];
      chatId?: number;
      since?: number;
      epoch?: number;
    },
  ): Promise<{ bot_id: number; epoch: number; updates: DeliveredUpdate[] }>;
  stop(): Promise<void>;
}

// ── Owner accounts ─────────────────────────────────────────────────────────
// A user's own account as a GramJS TelegramClient reads it (see the README,
// "Owner accounts"). Ids are plain numbers; GramJS uses big-integer objects,
// which give the same String() and Number().

export type OwnerDialogKind =
  | "private"
  | "bot"
  | "group"
  | "supergroup"
  | "channel";

export interface OwnerDialogFields {
  kind: OwnerDialogKind;
  /** The raw id; the dialog's peer id is derived from it (-id for a group, -100<id> for a supergroup or channel). */
  id?: number;
  /** Groups, supergroups and channels. */
  title?: string;
  /** Private chats and bots. */
  firstName?: string;
  lastName?: string;
  username?: string;
  participantsCount?: number;
  /** 0 main (default), 1 archive. */
  folder?: 0 | 1;
  pinned?: boolean;
  /** Muted forever, or not muted. */
  muted?: boolean;
  /** Unix time the mute lasts until; 0 is not muted. */
  muteUntil?: number;
  unreadCount?: number;
  /** The dialog's date while it has no messages. */
  date?: number;
}

export interface OwnerMessageFields {
  id: number;
  /** Unix seconds. */
  date: number;
  /** The owner's id or a user added with addOwnerUser; omit in a private chat or for a channel post. */
  fromId?: number;
  out?: boolean;
  text?: string;
  /** Makes it a MessageService, e.g. { className: "MessageActionChatAddUser", users: [id] }. */
  action?: { className: string; [field: string]: unknown };
  /** The id of the message it answers. */
  replyTo?: number;
  media?:
    | {
        type: "photo";
        id: number;
        width?: number;
        height?: number;
        size?: number;
      }
    | {
        type: "document";
        id: number;
        fileName?: string;
        mimeType?: string;
        size?: number;
      };
  editDate?: number;
}

export interface OwnerFilterFields {
  /** 2 or more; Telegram's custom filter ids start at 2. */
  id: number;
  title?: string;
  emoticon?: string;
  color?: number;
  /** Dialog peer ids. */
  includePeers?: number[];
  excludePeers?: number[];
  pinnedPeers?: number[];
  contacts?: boolean;
  nonContacts?: boolean;
  groups?: boolean;
  broadcasts?: boolean;
  bots?: boolean;
  excludeMuted?: boolean;
  excludeRead?: boolean;
  excludeArchived?: boolean;
}

export type OwnerMethod =
  | "connect"
  | "disconnect"
  | "isUserAuthorized"
  | "getMe"
  | "getEntity"
  | "getInputEntity"
  | "getDialogs"
  | "getMessages"
  | "invoke";

export interface OwnerFault {
  method: OwnerMethod;
  /** Only calls about this dialog. */
  peerId?: number;
  /** How many calls it applies to; default 1. */
  times?: number;
  /** Answer after this long (at most 30 000 ms). */
  delayMs?: number;
  preset?:
    | "flood_wait"
    | "permission_denied"
    | "reconnect_required"
    | "stale_entity"
    | "malformed_page"
    | "dropped";
  /** For flood_wait; default 30. */
  seconds?: number;
  /** A custom RPC error instead of a preset, e.g. "CHANNEL_PRIVATE". */
  errorMessage?: string;
  code?: number;
}

export interface OwnerCall {
  owner_id: number;
  method: string;
  /** The call's arguments, with session, token and hash fields redacted. */
  args: Record<string, unknown>;
  at: string;
  outcome: "pending" | "ok" | "error" | "dropped" | "malformed" | "cancelled";
  error_message?: string;
  duration_ms?: number;
}

/** The GramJS TelegramClient subset the owner client answers. */
export interface OwnerClient {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  destroy(): Promise<void>;
  isUserAuthorized(): Promise<boolean>;
  getMe(): Promise<Record<string, unknown>>;
  getEntity(peer: unknown): Promise<Record<string, unknown>>;
  getInputEntity(peer: unknown): Promise<Record<string, unknown>>;
  getDialogs(options?: {
    folder?: 0 | 1;
    archived?: boolean;
    limit?: number;
    ignorePinned?: boolean;
    ignoreMigrated?: boolean;
    offsetDate?: number;
    offsetId?: number;
    offsetPeer?: unknown;
  }): Promise<Array<Record<string, any>> & { total: number }>;
  getMessages(
    entity: unknown,
    options?: { limit?: number; offsetId?: number; ids?: number | number[] },
  ): Promise<Array<Record<string, any> | undefined> & { total: number }>;
  /** Only ownerApi.messages.GetDialogFilters (or GramJS's own request of that name). */
  invoke(request: { className: string }): Promise<Record<string, any>>;
  /** Reserved: rejects with code "OWNER_CLIENT_NOT_MODELLED". */
  markAsRead(...args: unknown[]): Promise<never>;
  /** Reserved: rejects with code "OWNER_CLIENT_NOT_MODELLED". */
  sendMessage(...args: unknown[]): Promise<never>;
}

/**
 * A client for one owner of a running server. `session` stands in for a
 * StringSession and is only ever recorded redacted.
 */
export declare function createOwnerClient(options: {
  origin: string;
  userId: number;
  session?: string;
}): OwnerClient;

/** Request classes for OwnerClient.invoke(). */
export declare const ownerApi: {
  messages: {
    GetDialogFilters: new (args?: Record<string, unknown>) => {
      className: "messages.GetDialogFilters";
    };
  };
};

export declare function startTestServer(
  options: TelegramBotTestServerOptions,
): Promise<TelegramBotTestServer>;
