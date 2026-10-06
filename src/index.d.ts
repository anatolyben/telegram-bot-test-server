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
  /** Instance-owned manual time, in Unix milliseconds. Omit for real time. */
  clock?: { now: number };
  /** Default "127.0.0.1". */
  host?: string;
  /** Default "fake_test_bot". */
  botUsername?: string;
  /** Default "Fake Test Bot". */
  botName?: string;
  /**
   * The bot is a guard bot: join requests reach it as queries it answers with
   * answerChatJoinRequestQuery. Default false.
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
   * What an unimplemented Bot API method returns: an error naming the method
   * ("error", default), or `true` ("ok").
   */
  unimplemented?: "error" | "ok";
  /**
   * Answer a bot's sends with Telegram's 429 "Too Many Requests: retry after N"
   * once they exceed the limits Telegram publishes: one message a second in a
   * chat, 20 a minute in a group, 30 a second across all chats. Default false.
   */
  floodControl?: boolean;
  log?: (line: string) => void;
}

/** A message as the server stores it, in the Bot API's Message shape. */
export type Message = { message_id: number; [field: string]: unknown };

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
  /** Image bytes, sent as a photo. */
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
  /** Where a forwarded message came from: a user, a hidden user's name, or a channel post. */
  forwardFrom?: {
    userId?: number;
    senderName?: string;
    chatId?: number;
    messageId?: number;
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
  /** Default "Bad Request". */
  description?: string;
  /** Sent as parameters.retry_after, as with a 429. */
  retryAfter?: number;
  /** The call takes effect, but the connection closes before it answers. */
  dropAfterApply?: boolean;
}

export interface RecordedCall {
  seq: number;
  method: string;
  /** A physical checkpoint or successful handler completion; reads/no-ops need not mutate. */
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
  params: Record<string, unknown>;
  at: number;
  /** Rejected status, including actual permission/validation failures. */
  failed?: number;
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
 * been handed to the bot's webhook, or queued for getUpdates. The same actions
 * are available over HTTP under `${origin}/_fake/` for tests in other languages.
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
    condition: FakeWaitCondition,
    options?: FakeWaitOptions,
  ): Promise<
    FakeMessageObservation | ChatMember | FakeJoinObservation | RecordedCall
  >;
  /** Opaque, instance-owned handle; requires quiescence. Release when no longer used. */
  snapshot(): Promise<string>;
  restore(snapshot: string): Promise<{ restored: true; epoch: number }>;
  releaseSnapshot(snapshot: string): Promise<{ ok: true }>;
  getClock(): Promise<FakeClockState>;
  advanceTime(ms: number): Promise<FakeClockState>;
  /** Wait for queued/in-flight webhook attempts, not downstream enforcement or queued getUpdates consumption. */
  drainDeliveries(
    options?: FakeWaitOptions & { botId?: number },
  ): Promise<{ drained: true }>;
  getDeliveries(): Promise<FakeDelivery[]>;
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
    /** A guard bot that gets join requests as queries. */
    supportsJoinRequestQueries?: boolean;
    /** Its Telegram Login client secret; default random. */
    loginClientSecret?: string;
  }): Promise<{ id: number; is_bot: true; username: string }>;
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
  /** Deliver an update again, byte for byte, to the webhook it went to. */
  redeliverUpdate(updateId: number): Promise<{ update_id: number }>;
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
   * text is empty once trimmed.
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
   * The author edits their message's text or caption; bots get edited_message
   * (edited_channel_post in a channel).
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
  /** The user presses an inline button under a message in a chat. */
  pressButton(
    chatId: number,
    messageId: number,
    userId: number,
    data: string,
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
   * The user sends the bot a direct message; returns the message_id. Empty
   * text, once trimmed, fails with MESSAGE_EMPTY.
   */
  sendDirectMessage(userId: number, text: string): Promise<number>;
  /** The user presses an inline button in their private chat with the bot. */
  pressDirectButton(
    userId: number,
    messageId: number,
    data: string,
  ): Promise<ButtonAnswer>;
  /**
   * Messages not deleted, newest first, with ephemeral messages (message_id 0,
   * receiver_user set) in the order they were sent.
   */
  getMessages(chatId: number): Promise<Message[]>;
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
    /** Attempts rejected before parameter validation; kept separate for 0.9.x compatibility. */
    rejected_requests: RecordedCall[];
    unimplemented: string[];
  }>;
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
