/**
 * A local, in-memory stand-in for the Telegram Bot API, for tests.
 *
 * Bot side: point a bot's Bot API base URL at this server and every call and
 * file download lands here. It answers like Telegram and keeps the state a
 * group bot works with: members and their status, profiles and photos,
 * messages (and which were deleted), invite links and pending join requests.
 *
 * Telegram side: tests drive it through /_fake/* (a user joins, asks to join,
 * leaves, posts text or a photo, presses a button, messages the bot). It sends
 * the webhook update Telegram would, with the registered secret token, and —
 * like Telegram — reports the bot's own restrictions back as chat_member
 * updates.
 *
 * Nothing here talks to Telegram.
 */
import http from "node:http";
import { randomBytes } from "node:crypto";

// Every field of ChatPermissions, as of Bot API 10.3.
const PERMISSION_KEYS = Object.freeze([
  "can_send_messages",
  "can_send_audios",
  "can_send_documents",
  "can_send_photos",
  "can_send_videos",
  "can_send_video_notes",
  "can_send_voice_notes",
  "can_send_polls",
  "can_send_other_messages",
  "can_add_web_page_previews",
  "can_react_to_messages",
  "can_change_info",
  "can_invite_users",
  "can_pin_messages",
  "can_manage_topics",
  "can_edit_tag",
]);
const MEDIA_PERMISSIONS = Object.freeze([
  "can_send_messages",
  "can_send_audios",
  "can_send_documents",
  "can_send_photos",
  "can_send_videos",
  "can_send_video_notes",
  "can_send_voice_notes",
]);
const ALL_PERMISSIONS = Object.freeze(
  Object.fromEntries(PERMISSION_KEYS.map((key) => [key, true])),
);
const NO_GIFTS = Object.freeze({
  unlimited_gifts: false,
  limited_gifts: false,
  unique_gifts: false,
  premium_subscription: false,
  gifts_from_channels: false,
});

/**
 * A ChatPermissions object as Telegram applies it: unspecified fields are
 * false, and unless use_independent_chat_permissions is set, the broader
 * permissions imply the narrower ones.
 */
function normalizePermissions(input = {}, independent = false) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new TelegramError(
      400,
      "Bad Request: can't parse permissions JSON object",
    );
  }
  const given = (key) => input[key] === true || input[key] === "true";
  const result = Object.fromEntries(
    PERMISSION_KEYS.map((key) => [key, given(key)]),
  );
  if (!(independent === true || independent === "true")) {
    if (result.can_send_other_messages || result.can_add_web_page_previews) {
      for (const key of MEDIA_PERMISSIONS) result[key] = true;
    }
    if (result.can_send_polls) result.can_send_messages = true;
  }
  if (!("can_react_to_messages" in input)) {
    result.can_react_to_messages = result.can_send_messages;
  }
  if (!("can_edit_tag" in input)) result.can_edit_tag = result.can_pin_messages;
  return result;
}
// How long a webhook may take to answer before the update is given up on.
const WEBHOOK_TIMEOUT_MS = 10_000;
const OBJECT_PARAMS = new Set([
  "allowed_updates",
  "permissions",
  "reply_markup",
  "message_ids",
  "link_preview_options",
  "reply_parameters",
  "commands",
  "media",
  "scope",
  "ephemeral_message_parameters",
]);

class TelegramError extends Error {
  constructor(code, description) {
    super(description);
    this.code = code;
  }
}

/** A request number, or the fallback when it is missing or not a number. */
function numberParam(value, fallback) {
  const number = Number(value);
  return value != null && value !== "" && Number.isFinite(number)
    ? number
    : fallback;
}

function now() {
  return Math.floor(Date.now() / 1000);
}

function fileUniqueId() {
  return `AgAD${randomBytes(6).toString("base64url")}`;
}

function userObject(user) {
  return {
    id: user.id,
    is_bot: user.is_bot === true,
    first_name: user.first_name,
    ...(user.last_name ? { last_name: user.last_name } : {}),
    ...(user.username ? { username: user.username } : {}),
    ...(user.language_code ? { language_code: user.language_code } : {}),
  };
}

/**
 * The entities Telegram attaches to a member's text: bot commands, @mentions
 * and links, with UTF-16 offsets as Telegram reports them.
 */
function messageEntities(text) {
  const entities = [];
  const add = (type, offset, length) => entities.push({ type, offset, length });
  const overlaps = (offset, length) =>
    entities.some(
      (entity) =>
        offset < entity.offset + entity.length &&
        entity.offset < offset + length,
    );
  for (const match of text.matchAll(
    /(?<![\w@])\/[A-Za-z0-9_]+(?:@[A-Za-z0-9_]+)?/g,
  )) {
    if (match.index === 0) add("bot_command", match.index, match[0].length);
  }
  for (const match of text.matchAll(
    /(?<![\w.+-])[A-Za-z0-9._%+-]+@(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}\b/g,
  )) {
    add("email", match.index, match[0].length);
  }
  for (const match of text.matchAll(
    /(?<![\w@/])@[A-Za-z][A-Za-z0-9_]{3,31}\b/g,
  )) {
    if (!overlaps(match.index, match[0].length)) {
      add("mention", match.index, match[0].length);
    }
  }
  for (const match of text.matchAll(
    /\b(?:https?:\/\/[^\s]+|(?:t\.me|telegram\.me)\/[^\s]+|(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s]*)?)/gi,
  )) {
    // Sentence punctuation after a link is not part of it.
    const url = match[0].replace(/[.,!?;:)\]}'"]+$/, "");
    if (url && !overlaps(match.index, url.length)) {
      add("url", match.index, url.length);
    }
  }
  return entities.sort((left, right) => left.offset - right.offset);
}

function coerceParams(entries) {
  const params = {};
  for (const [key, value] of entries) {
    if (typeof value === "string" && OBJECT_PARAMS.has(key)) {
      try {
        params[key] = JSON.parse(value);
        continue;
      } catch {
        // keep the string
      }
    }
    params[key] = value;
  }
  return params;
}

/** Parse a JSON body that must be an object, or fail with a 400. */
function parseJsonObject(body) {
  let value;
  try {
    value = JSON.parse(body.toString("utf8"));
  } catch {
    throw new TelegramError(400, "Bad Request: request body is not valid JSON");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TelegramError(
      400,
      "Bad Request: request body must be a JSON object",
    );
  }
  return value;
}

async function readRequestParams(request, body) {
  const url = new URL(request.url, "http://localhost");
  const params = coerceParams(url.searchParams.entries());
  if (!body.length) return params;
  const type = String(request.headers["content-type"] ?? "");
  if (type.includes("application/json")) {
    return { ...params, ...parseJsonObject(body) };
  }
  if (
    !type.includes("multipart/form-data") &&
    !type.includes("application/x-www-form-urlencoded")
  ) {
    throw new TelegramError(
      400,
      "Bad Request: send parameters as a query string, JSON, or form data",
    );
  }
  let form;
  try {
    form = await new Request("http://localhost/", {
      method: "POST",
      headers: { "content-type": type },
      body,
    }).formData();
  } catch {
    throw new TelegramError(
      400,
      "Bad Request: request body is not valid form data",
    );
  }
  const entries = [];
  for (const [key, value] of form.entries()) {
    entries.push([
      key,
      typeof value === "string"
        ? value
        : Buffer.from(await value.arrayBuffer()),
    ]);
  }
  return { ...params, ...coerceParams(entries) };
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

/**
 * @param {{
 *   port?: number,
 *   host?: string,
 *   botToken: string,
 *   botUsername?: string,
 *   botName?: string,
 *   chats?: Array<{ id: number, title: string, ownerId: number, ownerName?: string }>,
 *   publicChats?: Array<{ username: string, type: "channel"|"supergroup"|"bot", title?: string }>,
 *   unimplemented?: "error" | "ok",
 *   log?: (line: string) => void,
 * }} options
 */
export async function startTestServer({
  port = 0,
  host = "127.0.0.1",
  botToken,
  botUsername = "fake_test_bot",
  botName = "Fake Test Bot",
  chats: chatConfigs = [],
  publicChats = [],
  unimplemented: unimplementedMode = "error",
  log = () => {},
}) {
  if (unimplementedMode !== "error" && unimplementedMode !== "ok") {
    throw new TypeError('unimplemented must be "error" or "ok"');
  }
  const botId = Number(String(botToken).split(":")[0]);
  if (!Number.isSafeInteger(botId)) {
    throw new TypeError(
      "Fake Telegram needs a bot token of the form <id>:<secret>",
    );
  }
  const bot = {
    id: botId,
    is_bot: true,
    first_name: botName,
    username: botUsername,
    photos: [],
  };
  const users = new Map([[bot.id, bot]]);
  const files = new Map();
  const chats = new Map();
  // Public channels, groups and bots other accounts link to, by lower-case
  // username. A personal profile is never public: getChat on it fails.
  const publicByUsername = new Map();
  let nextPublicId = 1_000_000;
  for (const entry of publicChats) {
    const username = String(entry.username).replace(/^@/, "");
    nextPublicId += 1;
    publicByUsername.set(username.toLowerCase(), {
      id:
        entry.type === "bot"
          ? 6_000_000_000 + nextPublicId
          : -1_002_000_000_000 - nextPublicId,
      type: entry.type,
      username,
      title: entry.title ?? username,
    });
  }
  // A member's private chat with the bot, keyed by the member's id.
  const privateChats = new Map();
  const callbackAnswers = new Map();
  // Callback queries awaiting an answer; any other id is refused.
  const openQueries = new Set();
  let commands = [];
  const calls = [];
  const unimplemented = new Set();
  let webhook = null;
  // The update types the bot subscribed to, set by setWebhook or getUpdates.
  let subscription = null;
  // Updates waiting for getUpdates while no webhook is set, as on Telegram.
  const queue = [];
  const pollWaiters = new Set();
  // Webhook requests in progress, aborted on stop().
  const inFlight = new Set();
  // Telegram never reuses an update, member or message id, and bots commonly
  // treat a repeated one as already handled; counters start from the clock so
  // a restarted fake does not repeat the previous run's ids.
  const startSeconds = Math.floor(Date.now() / 1000);
  let updateId = startSeconds;
  let nextUserId = 7_000_000_000 + startSeconds;
  let delivery = Promise.resolve();

  for (const config of chatConfigs) {
    const owner = {
      id: config.ownerId,
      is_bot: false,
      first_name: config.ownerName ?? "Group Owner",
      bio: "",
      photos: [],
    };
    users.set(owner.id, owner);
    chats.set(config.id, {
      id: config.id,
      title: config.title,
      type: "supergroup",
      members: new Map([
        [owner.id, { status: "creator" }],
        [bot.id, { status: "administrator" }],
      ]),
      messages: new Map(),
      nextMessageId: startSeconds - 1_700_000_000,
      inviteLinks: new Map(),
      joinRequests: new Map(),
      permissions: { ...ALL_PERMISSIONS },
    });
  }

  function requireChat(chatId) {
    const chat = chats.get(Number(chatId));
    if (!chat) throw new TelegramError(400, "Bad Request: chat not found");
    return chat;
  }

  /** The group, or a member's private chat with the bot, holding a message. */
  function messageChat(chatId) {
    const id = Number(chatId);
    if (chats.has(id)) return chats.get(id);
    const user = users.get(id);
    if (!user || user.is_bot) {
      throw new TelegramError(400, "Bad Request: chat not found");
    }
    if (!privateChats.has(id)) {
      privateChats.set(id, {
        id,
        type: "private",
        user,
        messages: new Map(),
        nextMessageId: 1,
      });
    }
    return privateChats.get(id);
  }

  /**
   * The chat a Bot API call addresses. A bot cannot open a private chat: it
   * can only write to users who have messaged it first, as on Telegram.
   */
  function botChat(chatId) {
    const id = Number(chatId);
    if (chats.has(id)) return chats.get(id);
    if (privateChats.has(id)) return privateChats.get(id);
    const user = users.get(id);
    if (user && !user.is_bot) {
      throw new TelegramError(
        403,
        "Forbidden: bot can't initiate conversation with a user",
      );
    }
    throw new TelegramError(400, "Bad Request: chat not found");
  }

  function requireUser(userId) {
    const user = users.get(Number(userId));
    if (!user) throw new TelegramError(400, "Bad Request: user not found");
    return user;
  }

  function chatObject(chat) {
    if (chat.type === "private") {
      return {
        id: chat.id,
        type: "private",
        first_name: chat.user.first_name,
        ...(chat.user.last_name ? { last_name: chat.user.last_name } : {}),
        ...(chat.user.username ? { username: chat.user.username } : {}),
      };
    }
    return { id: chat.id, title: chat.title, type: chat.type };
  }

  function memberStatus(chat, userId) {
    return chat.members.get(Number(userId)) ?? { status: "left" };
  }

  function chatMemberObject(chat, userId) {
    const user = requireUser(userId);
    const member = memberStatus(chat, userId);
    const base = { user: userObject(user), status: member.status };
    if (member.status === "administrator") {
      return {
        ...base,
        can_be_edited: false,
        is_anonymous: false,
        can_manage_chat: true,
        can_delete_messages: true,
        can_restrict_members: true,
        can_promote_members: false,
        can_change_info: true,
        can_invite_users: true,
        can_pin_messages: true,
        can_post_stories: false,
        can_edit_stories: false,
        can_delete_stories: false,
        can_manage_video_chats: false,
        can_manage_topics: false,
        can_send_welcome_messages: false,
      };
    }
    if (member.status === "creator") return { ...base, is_anonymous: false };
    if (member.status === "restricted") {
      return {
        ...base,
        is_member: member.is_member !== false,
        until_date: member.until_date ?? 0,
        ...member.permissions,
      };
    }
    if (member.status === "kicked") {
      return { ...base, until_date: member.until_date ?? 0 };
    }
    return base;
  }

  function isInChat(chat, userId) {
    const member = memberStatus(chat, userId);
    return (
      ["member", "administrator", "creator"].includes(member.status) ||
      (member.status === "restricted" && member.is_member !== false)
    );
  }

  /** Whether the user may post, given their own and the chat's permissions. */
  function canPost(chat, userId, permission = "can_send_messages") {
    const member = memberStatus(chat, userId);
    if (!isInChat(chat, userId)) return false;
    if (["creator", "administrator"].includes(member.status)) return true;
    if (
      member.status === "restricted" &&
      member.permissions[permission] !== true
    ) {
      return false;
    }
    return chat.permissions[permission] === true;
  }

  /**
   * Telegram refuses to restrict or remove the chat owner, an administrator
   * or the bot itself.
   */
  function assertCanModerate(chat, userId, { self } = {}) {
    if (Number(userId) === bot.id && self) {
      throw new TelegramError(400, `Bad Request: ${self}`);
    }
    const status = memberStatus(chat, userId).status;
    if (status === "creator") {
      throw new TelegramError(400, "Bad Request: can't remove chat owner");
    }
    if (status === "administrator") {
      throw new TelegramError(
        400,
        "Bad Request: user is an administrator of the chat",
      );
    }
  }

  /**
   * Make the user a member again. A restriction outlives leaving and
   * rejoining on Telegram, so a restricted user comes back restricted.
   */
  function admit(chat, userId) {
    const current = memberStatus(chat, userId);
    chat.members.set(
      Number(userId),
      current.status === "restricted"
        ? { ...current, is_member: true }
        : { status: "member" },
    );
  }

  /** Send a chat_member update only when the member actually changed. */
  function memberChanged(chat, userId, before, actor, extra) {
    const after = chatMemberObject(chat, userId);
    if (JSON.stringify(before) === JSON.stringify(after))
      return Promise.resolve();
    return emitMemberChange(chat, userId, before, actor, extra);
  }

  function nextUpdateId() {
    updateId += 1;
    return updateId;
  }

  function allowed(type) {
    const list = subscription;
    if (!Array.isArray(list) || list.length === 0) {
      return ![
        "chat_member",
        "message_reaction",
        "message_reaction_count",
      ].includes(type);
    }
    return list.includes(type);
  }

  /**
   * Deliver one update: to the webhook in order when one is set, otherwise to
   * the queue getUpdates reads.
   */
  function emit(type, payload) {
    if (!allowed(type)) return Promise.resolve();
    const update = { update_id: nextUpdateId(), [type]: payload };
    if (!webhook?.url) {
      queue.push(structuredClone(update));
      wakePollers();
      return Promise.resolve();
    }
    return deliver(update);
  }

  function wakePollers() {
    for (const waiter of pollWaiters) waiter.wake();
  }

  function deliver(update) {
    const type = Object.keys(update).find((key) => key !== "update_id");
    // Serialised now, so later state changes cannot rewrite a sent update.
    const body = JSON.stringify(update);
    delivery = delivery.then(async () => {
      // The webhook may have been removed while this update waited its turn;
      // it then belongs to getUpdates, as on Telegram.
      const target = webhook;
      if (!target?.url) {
        queue.push(JSON.parse(body));
        wakePollers();
        return;
      }
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), WEBHOOK_TIMEOUT_MS);
      inFlight.add(abort);
      try {
        const response = await fetch(target.url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(target.secret_token
              ? { "X-Telegram-Bot-Api-Secret-Token": target.secret_token }
              : {}),
          },
          body,
          signal: abort.signal,
        });
        await response.body?.cancel();
        if (!response.ok) {
          log(`webhook answered ${response.status} for ${type}`);
        }
      } catch (error) {
        log(`webhook delivery failed for ${type}: ${error.message}`);
      } finally {
        clearTimeout(timer);
        inFlight.delete(abort);
      }
    });
    return delivery;
  }

  function emitMemberChange(chat, userId, before, actor, extra = {}) {
    return emit("chat_member", {
      chat: chatObject(chat),
      from: userObject(actor),
      date: now(),
      old_chat_member: before,
      new_chat_member: chatMemberObject(chat, userId),
      ...extra,
    });
  }

  function addMessage(chat, from, fields) {
    const message = {
      message_id: chat.nextMessageId++,
      from: userObject(from),
      chat: chatObject(chat),
      date: now(),
      ...fields,
    };
    chat.messages.set(message.message_id, { message, deleted: false });
    return message;
  }

  // Image bytes only. Accepting a file path here would let anyone who can reach
  // the control API read any file on the host through the file download URL.
  function registerFile(bytes, folder, extension) {
    const data = bytes;
    const fileId = `AgACAgQAAx0Cfake${randomBytes(9).toString("base64url")}`;
    const uniqueId = fileUniqueId();
    files.set(fileId, {
      data,
      file_unique_id: uniqueId,
      file_path: `${folder}/${fileId}.${extension}`,
    });
    return { file_id: fileId, file_unique_id: uniqueId, size: data.length };
  }

  function registerPhoto(bytes) {
    return registerFile(bytes, "photos", "jpg");
  }

  /**
   * The file a send* call refers to: an uploaded file, or the file_id of one
   * this server already holds. Anything else becomes a one-byte placeholder.
   */
  function sentFile(value, folder, extension) {
    if (typeof value === "string" && files.has(value)) {
      const file = files.get(value);
      return {
        file_id: value,
        file_unique_id: file.file_unique_id,
        size: file.data.length,
      };
    }
    return registerFile(
      Buffer.isBuffer(value) ? value : Buffer.alloc(1),
      folder,
      extension,
    );
  }

  function photoSizes(photo) {
    return [
      {
        file_id: photo.file_id,
        file_unique_id: photo.file_unique_id,
        width: 800,
        height: 800,
        file_size: photo.size,
      },
    ];
  }

  // ── Bot API ────────────────────────────────────────────────────────────
  const methods = {
    getMe: () => ({
      ...userObject(bot),
      can_join_groups: true,
      can_read_all_group_messages: true,
      supports_inline_queries: false,
    }),
    setWebhook: (p) => {
      if (!p.url) {
        webhook = null;
        return true;
      }
      webhook = { url: String(p.url), secret_token: p.secret_token ?? null };
      if (Array.isArray(p.allowed_updates)) subscription = p.allowed_updates;
      // Updates that queued while nobody was listening go to the new webhook.
      const pending = isTrue(p.drop_pending_updates) ? [] : queue.splice(0);
      queue.length = 0;
      for (const update of pending) deliver(update);
      return true;
    },
    deleteWebhook: (p) => {
      webhook = null;
      if (isTrue(p.drop_pending_updates)) queue.length = 0;
      return true;
    },
    getWebhookInfo: () => ({
      url: webhook?.url ?? "",
      has_custom_certificate: false,
      pending_update_count: webhook?.url ? 0 : queue.length,
      ...(subscription ? { allowed_updates: subscription } : {}),
    }),
    getUpdates: async (p) => {
      if (webhook?.url) {
        throw new TelegramError(
          409,
          "Conflict: can't use getUpdates method while webhook is active; use deleteWebhook to delete the webhook first",
        );
      }
      if (Array.isArray(p.allowed_updates)) subscription = p.allowed_updates;
      const offset = numberParam(p.offset, 0);
      // An offset confirms every update before it: they are gone for good.
      if (offset > 0) {
        while (queue.length && queue[0].update_id < offset) queue.shift();
      } else if (offset < 0) {
        queue.splice(0, Math.max(0, queue.length + offset));
      }
      const limit = Math.min(100, Math.max(1, numberParam(p.limit, 100)));
      const timeoutMs = Math.max(0, numberParam(p.timeout, 0)) * 1000;
      if (queue.length === 0 && timeoutMs > 0) {
        await new Promise((resolve) => {
          const waiter = {
            wake: () => {
              clearTimeout(waiter.timer);
              pollWaiters.delete(waiter);
              resolve();
            },
          };
          waiter.timer = setTimeout(waiter.wake, timeoutMs);
          pollWaiters.add(waiter);
        });
      }
      return queue.slice(0, limit);
    },
    setMyCommands: (p) => {
      commands = Array.isArray(p.commands) ? p.commands : [];
      return true;
    },
    deleteMyCommands: () => {
      commands = [];
      return true;
    },
    getMyCommands: () => commands,
    setMyDescription: () => true,
    setMyShortDescription: () => true,
    setChatMenuButton: () => true,
    setMyDefaultAdministratorRights: () => true,
    answerCallbackQuery: (p) => {
      if (!openQueries.delete(String(p.callback_query_id))) {
        throw new TelegramError(
          400,
          "Bad Request: query is too old and response timeout expired or query ID is invalid",
        );
      }
      callbackAnswers.set(String(p.callback_query_id), {
        text: p.text ?? "",
        show_alert: String(p.show_alert) === "true",
      });
      return true;
    },
    getChat: (p) => {
      if (String(p.chat_id).startsWith("@")) {
        const entry = publicByUsername.get(
          String(p.chat_id).slice(1).toLowerCase(),
        );
        if (!entry) throw new TelegramError(400, "Bad Request: chat not found");
        const common = {
          accent_color_id: 0,
          max_reaction_count: 11,
          accepted_gift_types: { ...NO_GIFTS },
        };
        return entry.type === "bot"
          ? {
              id: entry.id,
              type: "private",
              first_name: entry.title,
              username: entry.username,
              ...common,
            }
          : {
              id: entry.id,
              type: entry.type,
              title: entry.title,
              username: entry.username,
              ...common,
            };
      }
      const id = Number(p.chat_id);
      if (chats.has(id)) {
        const chat = chats.get(id);
        return {
          ...chatObject(chat),
          permissions: { ...chat.permissions },
          accent_color_id: 0,
          max_reaction_count: 11,
          accepted_gift_types: { ...NO_GIFTS },
        };
      }
      // A user the bot shares a group with; the bio shows as under
      // Telegram's default privacy (everybody).
      const user = users.get(id);
      if (!user) throw new TelegramError(400, "Bad Request: chat not found");
      const photo = user.photos?.[0];
      return {
        id: user.id,
        type: "private",
        first_name: user.first_name,
        ...(user.last_name ? { last_name: user.last_name } : {}),
        ...(user.username ? { username: user.username } : {}),
        ...(user.bio ? { bio: user.bio } : {}),
        ...(photo
          ? {
              photo: {
                small_file_id: photo.file_id,
                small_file_unique_id: photo.file_unique_id,
                big_file_id: photo.file_id,
                big_file_unique_id: photo.file_unique_id,
              },
            }
          : {}),
        accent_color_id: 0,
        max_reaction_count: 11,
        accepted_gift_types: { ...NO_GIFTS },
      };
    },
    getChatMember: (p) => chatMemberObject(requireChat(p.chat_id), p.user_id),
    getChatAdministrators: (p) => {
      const chat = requireChat(p.chat_id);
      return [...chat.members.entries()]
        .filter(([, m]) => ["creator", "administrator"].includes(m.status))
        .map(([id]) => chatMemberObject(chat, id));
    },
    getChatMemberCount: (p) => {
      const chat = requireChat(p.chat_id);
      return [...chat.members.keys()].filter((id) => isInChat(chat, id)).length;
    },
    getUserProfilePhotos: (p) => {
      const user = requireUser(p.user_id);
      const offset = Math.max(0, numberParam(p.offset, 0));
      const limit = Math.min(100, Math.max(1, numberParam(p.limit, 100)));
      const photos = (user.photos ?? []).slice(offset, offset + limit);
      return {
        total_count: user.photos?.length ?? 0,
        photos: photos.map(photoSizes),
      };
    },
    getFile: (p) => {
      const file = files.get(String(p.file_id));
      if (!file) throw new TelegramError(400, "Bad Request: invalid file_id");
      return {
        file_id: p.file_id,
        file_unique_id: file.file_unique_id,
        file_size: file.data.length,
        file_path: file.file_path,
      };
    },
    sendMessage: (p) => sendFrom(p, { text: String(p.text ?? "") }),
    sendPhoto: async (p) => {
      const photo =
        typeof p.photo === "string" && files.has(p.photo)
          ? {
              file_id: p.photo,
              ...files.get(p.photo),
              size: files.get(p.photo).data.length,
            }
          : sentFile(p.photo, "photos", "jpg");
      return sendFrom(p, {
        photo: photoSizes(photo),
        ...(p.caption ? { caption: String(p.caption) } : {}),
      });
    },
    sendDocument: (p) => {
      const file = sentFile(p.document, "documents", "bin");
      return sendFrom(p, {
        document: {
          file_id: file.file_id,
          file_unique_id: file.file_unique_id,
          file_size: file.size,
        },
        ...(p.caption ? { caption: String(p.caption) } : {}),
      });
    },
    sendVideo: (p) => {
      const file = sentFile(p.video, "videos", "mp4");
      return sendFrom(p, {
        video: {
          file_id: file.file_id,
          file_unique_id: file.file_unique_id,
          width: 640,
          height: 360,
          duration: 1,
          file_size: file.size,
        },
        ...(p.caption ? { caption: String(p.caption) } : {}),
      });
    },
    sendAnimation: (p) => {
      const file = sentFile(p.animation, "animations", "mp4");
      return sendFrom(p, {
        animation: {
          file_id: file.file_id,
          file_unique_id: file.file_unique_id,
          width: 320,
          height: 240,
          duration: 1,
          file_size: file.size,
        },
        ...(p.caption ? { caption: String(p.caption) } : {}),
      });
    },
    sendSticker: (p) => {
      const file = sentFile(p.sticker, "stickers", "webp");
      return sendFrom(p, {
        sticker: {
          file_id: file.file_id,
          file_unique_id: file.file_unique_id,
          type: "regular",
          width: 512,
          height: 512,
          is_animated: false,
          is_video: false,
          file_size: file.size,
        },
      });
    },
    editMessageText: (p) =>
      editMessage(p, (message) => {
        message.text = String(p.text ?? "");
      }),
    editMessageReplyMarkup: (p) => editMessage(p, () => {}),
    editMessageCaption: (p) =>
      editMessage(p, (message) => {
        message.caption = String(p.caption ?? "");
      }),
    pinChatMessage: () => true,
    unpinChatMessage: () => true,
    setChatPermissions: (p) => {
      const chat = requireChat(p.chat_id);
      chat.permissions = normalizePermissions(
        p.permissions,
        p.use_independent_chat_permissions,
      );
      return true;
    },
    leaveChat: () => true,
    deleteMessage: (p) => {
      const chat = botChat(p.chat_id);
      const entry = chat.messages.get(Number(p.message_id));
      if (!entry || entry.deleted) {
        throw new TelegramError(
          400,
          "Bad Request: message to delete not found",
        );
      }
      entry.deleted = true;
      return true;
    },
    deleteMessages: (p) => {
      const chat = botChat(p.chat_id);
      if (!Array.isArray(p.message_ids)) {
        throw new TelegramError(
          400,
          "Bad Request: message_ids must be a JSON array",
        );
      }
      for (const id of p.message_ids) {
        const entry = chat.messages.get(Number(id));
        if (entry) entry.deleted = true;
      }
      return true;
    },
    restrictChatMember: (p) => {
      const chat = requireChat(p.chat_id);
      const userId = Number(p.user_id);
      requireUser(userId);
      assertCanModerate(chat, userId, { self: "can't restrict self" });
      const before = chatMemberObject(chat, userId);
      const current = memberStatus(chat, userId);
      const permissions = normalizePermissions(
        p.permissions,
        p.use_independent_chat_permissions,
      );
      const inChat = isInChat(chat, userId);
      // Passing every permission as true lifts the restriction.
      if (PERMISSION_KEYS.every((key) => permissions[key])) {
        if (current.status === "restricted") {
          chat.members.set(userId, { status: inChat ? "member" : "left" });
        }
      } else {
        chat.members.set(userId, {
          status: "restricted",
          is_member: inChat,
          until_date: Number(p.until_date ?? 0),
          permissions,
        });
      }
      memberChanged(chat, userId, before, bot);
      return true;
    },
    banChatMember: (p) => {
      const chat = requireChat(p.chat_id);
      const userId = Number(p.user_id);
      requireUser(userId);
      assertCanModerate(chat, userId);
      const before = chatMemberObject(chat, userId);
      chat.members.set(userId, {
        status: "kicked",
        until_date: Number(p.until_date ?? 0),
      });
      memberChanged(chat, userId, before, bot);
      return true;
    },
    unbanChatMember: (p) => {
      const chat = requireChat(p.chat_id);
      const userId = Number(p.user_id);
      requireUser(userId);
      const current = memberStatus(chat, userId);
      const before = chatMemberObject(chat, userId);
      if (current.status === "kicked") {
        chat.members.set(userId, { status: "left" });
      } else if (isTrue(p.only_if_banned)) {
        return true;
      } else {
        // Without only_if_banned, Telegram guarantees the user is not a member
        // afterwards: a current member is removed, keeping any restriction.
        assertCanModerate(chat, userId);
        if (current.status === "restricted") {
          chat.members.set(userId, { ...current, is_member: false });
        } else if (current.status === "member") {
          chat.members.set(userId, { status: "left" });
        }
      }
      memberChanged(chat, userId, before, bot);
      return true;
    },
    approveChatJoinRequest: (p) => {
      const chat = requireChat(p.chat_id);
      const userId = Number(p.user_id);
      if (!chat.joinRequests.has(userId)) {
        throw new TelegramError(400, "Bad Request: HIDE_REQUESTER_MISSING");
      }
      const request = chat.joinRequests.get(userId);
      chat.joinRequests.delete(userId);
      const before = chatMemberObject(chat, userId);
      admit(chat, userId);
      // via_join_request is only for requests made without an invite link;
      // every request here came through one, so the link is reported instead.
      emitMemberChange(chat, userId, before, bot, {
        ...(request.invite_link
          ? { invite_link: request.invite_link }
          : { via_join_request: true }),
      });
      const user = requireUser(userId);
      emit(
        "message",
        addMessage(chat, user, { new_chat_members: [userObject(user)] }),
      );
      return true;
    },
    declineChatJoinRequest: (p) => {
      const chat = requireChat(p.chat_id);
      const userId = Number(p.user_id);
      if (!chat.joinRequests.delete(userId)) {
        throw new TelegramError(400, "Bad Request: HIDE_REQUESTER_MISSING");
      }
      return true;
    },
    createChatInviteLink: (p) => {
      const chat = requireChat(p.chat_id);
      const link = `https://t.me/+fake${randomBytes(9).toString("base64url")}`;
      const invite = {
        invite_link: link,
        creator: userObject(bot),
        creates_join_request: String(p.creates_join_request) === "true",
        is_primary: false,
        is_revoked: false,
        ...(p.name ? { name: String(p.name) } : {}),
      };
      chat.inviteLinks.set(link, invite);
      return invite;
    },
    exportChatInviteLink: (p) => {
      const chat = requireChat(p.chat_id);
      // A new primary link revokes the previous one.
      for (const invite of chat.inviteLinks.values()) {
        if (invite.is_primary) invite.is_revoked = true;
      }
      const invite = methods.createChatInviteLink({ chat_id: p.chat_id });
      invite.is_primary = true;
      return invite.invite_link;
    },
    revokeChatInviteLink: (p) => {
      const chat = requireChat(p.chat_id);
      const invite = chat.inviteLinks.get(String(p.invite_link));
      if (invite) invite.is_revoked = true;
      return {
        ...(invite ?? { invite_link: p.invite_link }),
        is_revoked: true,
      };
    },
  };

  const methodsByLowerName = new Map(
    Object.entries(methods).map(([name, handler]) => [
      name.toLowerCase(),
      handler,
    ]),
  );

  function isTrue(value) {
    return value === true || value === "true";
  }

  /** An inline keyboard with at least one row, or undefined. */
  function inlineMarkup(markup) {
    return Array.isArray(markup?.inline_keyboard) &&
      markup.inline_keyboard.length > 0
      ? markup
      : undefined;
  }

  function sendFrom(p, fields) {
    // Message.reply_markup only ever carries an inline keyboard; reply
    // keyboards and ForceReply are shown to the user, not echoed back.
    const markup = inlineMarkup(p.reply_markup);
    // An ephemeral message (Bot API 10.2) is shown to one member only. Telegram
    // gives it message_id 0; here it keeps the chat's message id, so tests can
    // find and press it like any message, and reuses it as ephemeral_message_id.
    const receiverId = p.ephemeral_message_parameters?.receiver_user_id;
    const chat = botChat(p.chat_id);
    const message = addMessage(chat, bot, {
      ...fields,
      ...(markup ? { reply_markup: markup } : {}),
      ...(receiverId != null
        ? { receiver_user: userObject(requireUser(receiverId)) }
        : {}),
    });
    if (receiverId != null) message.ephemeral_message_id = message.message_id;
    return message;
  }

  /** Apply a bot edit to a stored message, as Telegram does. */
  /**
   * Apply a bot edit to a stored message, as Telegram does: only the bot's own
   * messages can be edited, an edit without reply_markup removes the inline
   * keyboard, and an edit that changes nothing is refused.
   */
  function editMessage(p, apply) {
    const chat = botChat(p.chat_id);
    const entry = chat.messages.get(Number(p.message_id));
    if (!entry || entry.deleted) {
      throw new TelegramError(400, "Bad Request: message to edit not found");
    }
    if (entry.message.from.id !== bot.id) {
      throw new TelegramError(400, "Bad Request: message can't be edited");
    }
    const previous = structuredClone(entry.message);
    const edited = structuredClone(entry.message);
    apply(edited);
    const markup = inlineMarkup(p.reply_markup);
    if (markup) edited.reply_markup = markup;
    else delete edited.reply_markup;
    const same = (message) =>
      JSON.stringify([message.text, message.caption, message.reply_markup]);
    if (same(edited) === same(previous)) {
      throw new TelegramError(
        400,
        "Bad Request: message is not modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message",
      );
    }
    edited.edit_date = now();
    entry.message = edited;
    return edited;
  }

  // ── Test controls (/_fake/*) ───────────────────────────────────────────
  async function control(method, parts, body) {
    const [resource, id, sub, subId] = parts;
    if (resource === "users" && method === "POST" && !id) {
      const user = {
        id: nextUserId++,
        is_bot: false,
        first_name: body.first_name ?? "Test Member",
        last_name: body.last_name ?? "",
        username: body.username ?? null,
        language_code: body.language_code ?? "en",
        bio: body.bio ?? "",
        photos: [],
      };
      users.set(user.id, user);
      return { id: user.id };
    }
    if (resource === "users" && id) {
      const user = requireUser(id);
      if (!sub && method === "GET") {
        return { ...userObject(user), bio: user.bio, photos: user.photos };
      }
      if (sub === "profile" && method === "POST") {
        for (const key of ["first_name", "last_name", "bio", "username"]) {
          if (key in body) user[key] = body[key];
        }
        return { ok: true };
      }
      if (sub === "photos" && method === "POST") {
        if (typeof body.base64 !== "string" || body.base64 === "") {
          throw new TelegramError(400, "photo needs base64 image bytes");
        }
        const photo = registerPhoto(Buffer.from(body.base64, "base64"));
        user.photos.unshift(photo);
        return photo;
      }
      if (sub === "photos" && method === "DELETE") {
        user.photos = user.photos.filter((p) => p.file_id !== subId);
        return { ok: true };
      }
    }
    if (resource === "chats" && id) {
      const chat = requireChat(id);
      if (sub === "join" && method === "POST") return join(chat, body);
      if (sub === "leave" && method === "POST") return leave(chat, body);
      if (sub === "messages" && method === "POST" && !subId)
        return post(chat, body);
      if (sub === "messages" && method === "GET" && !subId) {
        return [...chat.messages.values()]
          .filter((entry) => !entry.deleted)
          .map((entry) => entry.message)
          .sort((left, right) => right.message_id - left.message_id);
      }
      if (sub === "messages" && method === "GET" && subId) {
        const entry = chat.messages.get(Number(subId));
        return entry
          ? { exists: true, deleted: entry.deleted, message: entry.message }
          : { exists: false, deleted: false };
      }
      if (sub === "members" && method === "GET" && subId) {
        return chatMemberObject(chat, subId);
      }
      if (sub === "join-requests" && method === "GET") {
        return [...chat.joinRequests.keys()];
      }
    }
    if (resource === "invites" && id) {
      let hash;
      try {
        hash = decodeURIComponent(id);
      } catch {
        throw new TelegramError(400, "INVITE_HASH_INVALID");
      }
      const link = `https://t.me/+${hash}`;
      const chat = [...chats.values()].find((c) => c.inviteLinks.has(link));
      if (!chat) throw new TelegramError(400, "INVITE_HASH_INVALID");
      if (sub === "join" && method === "POST") {
        return {
          chat_id: chat.id,
          ...(await join(chat, { ...body, invite_link: link })),
        };
      }
      if (sub === "check" && method === "POST") {
        return {
          chat_id: chat.id,
          title: chat.title,
          member: isInChat(chat, body.user_id),
        };
      }
    }
    if (resource === "bot" && method === "GET") return userObject(bot);
    if (resource === "users" && id && sub === "dm") {
      // Only the user writing to the bot opens their private chat; reading it
      // must not, or the bot could then message a user who never wrote.
      const existing = privateChats.get(Number(id));
      if (method === "GET" && !subId) {
        requireUser(id);
        return existing
          ? [...existing.messages.values()]
              .filter((entry) => !entry.deleted)
              .map((entry) => entry.message)
              .sort((left, right) => right.message_id - left.message_id)
          : [];
      }
      if (method === "POST" && subId && parts[4] === "callback") {
        if (!existing) throw new TelegramError(400, "MESSAGE_ID_INVALID");
        return pressButton(existing, requireUser(id), Number(subId), body.data);
      }
      const chat = messageChat(id);
      if (method === "POST" && !subId) {
        const text = String(body.text ?? "");
        const entities = messageEntities(text);
        const message = addMessage(chat, requireUser(id), {
          text,
          ...(entities.length > 0 ? { entities } : {}),
        });
        await emit("message", message);
        return { message_id: message.message_id };
      }
    }
    if (
      resource === "chats" &&
      id &&
      sub === "messages" &&
      subId &&
      parts[4] === "callback"
    ) {
      const user = requireUser(body.user_id);
      return pressButton(requireChat(id), user, Number(subId), body.data);
    }
    if (
      resource === "chats" &&
      id &&
      sub === "guest-bot-reply" &&
      method === "POST"
    ) {
      // Guest mode (Bot API 10.0): a user calls a bot that is not a member of
      // the chat, and its answer is posted in the chat as that bot, with
      // guest_bot_caller_user naming the user who called it.
      const chat = requireChat(id);
      const caller = requireUser(body.caller_user_id);
      const username = String(body.bot_username ?? "").replace(/^@/, "");
      if (!/^[A-Za-z][A-Za-z0-9_]{3,31}$/.test(username)) {
        throw new TelegramError(400, "guest bot needs a valid bot_username");
      }
      let guestBot = [...users.values()].find(
        (user) => user.is_bot && user.username === username,
      );
      if (!guestBot) {
        guestBot = {
          id: nextUserId++,
          is_bot: true,
          first_name: username,
          username,
          photos: [],
        };
        users.set(guestBot.id, guestBot);
      }
      const text = String(body.text ?? "");
      const entities = messageEntities(text);
      const message = addMessage(chat, guestBot, {
        text,
        ...(entities.length > 0 ? { entities } : {}),
        guest_bot_caller_user: userObject(caller),
      });
      await emit("message", message);
      return { message_id: message.message_id };
    }
    if (resource === "calls" && method === "GET") {
      return { calls, unimplemented: [...unimplemented] };
    }
    if (resource === "webhook" && method === "GET") return webhook;
    throw new TelegramError(
      404,
      `Unknown fake control ${method} /${parts.join("/")}`,
    );
  }

  /**
   * A member presses an inline button: Telegram sends the bot a callback_query
   * and waits for its answer, which it hands back to the member.
   */
  async function pressButton(chat, user, messageId, data) {
    const entry = chat.messages.get(messageId);
    if (!entry || entry.deleted) {
      throw new TelegramError(400, "MESSAGE_ID_INVALID");
    }
    const buttons = entry.message.reply_markup?.inline_keyboard?.flat() ?? [];
    if (
      !buttons.some((button) => button.callback_data === String(data ?? ""))
    ) {
      throw new TelegramError(
        400,
        "The message has no button with that callback data",
      );
    }
    const queryId = randomBytes(8).readBigUInt64BE().toString();
    openQueries.add(queryId);
    await emit("callback_query", {
      id: queryId,
      from: userObject(user),
      message: entry.message,
      chat_instance: String(chat.id),
      data: String(data ?? ""),
    });
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (callbackAnswers.has(queryId)) {
        const answer = callbackAnswers.get(queryId);
        callbackAnswers.delete(queryId);
        return { answered: true, ...answer };
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    openQueries.delete(queryId);
    return { answered: false };
  }

  async function join(chat, { user_id: userId, invite_link: link }) {
    const user = requireUser(userId);
    const current = memberStatus(chat, userId);
    if (current.status === "kicked") {
      throw new TelegramError(400, "USER_BANNED_IN_CHANNEL");
    }
    if (isInChat(chat, userId)) {
      throw new TelegramError(400, "USER_ALREADY_PARTICIPANT");
    }
    const invite = link ? chat.inviteLinks.get(link) : null;
    if (link && (!invite || invite.is_revoked)) {
      throw new TelegramError(400, "INVITE_HASH_EXPIRED");
    }
    if (invite?.creates_join_request) {
      chat.joinRequests.set(user.id, {
        invite_link: { ...invite },
        date: now(),
      });
      await emit("chat_join_request", {
        chat: chatObject(chat),
        from: userObject(user),
        user_chat_id: user.id,
        date: now(),
        ...(user.bio ? { bio: user.bio } : {}),
        invite_link: { ...invite },
      });
      return { status: "requested" };
    }
    const before = chatMemberObject(chat, user.id);
    admit(chat, user.id);
    await emitMemberChange(chat, user.id, before, user, {
      ...(invite ? { invite_link: { ...invite } } : {}),
    });
    const service = addMessage(chat, user, {
      new_chat_members: [userObject(user)],
    });
    await emit("message", service);
    return { status: "member" };
  }

  async function leave(chat, { user_id: userId }) {
    const user = requireUser(userId);
    if (!isInChat(chat, userId))
      return { status: memberStatus(chat, userId).status };
    const before = chatMemberObject(chat, userId);
    const current = memberStatus(chat, userId);
    chat.members.set(
      user.id,
      current.status === "restricted"
        ? { ...current, is_member: false }
        : { status: "left" },
    );
    await emitMemberChange(chat, user.id, before, user);
    const service = addMessage(chat, user, {
      left_chat_member: userObject(user),
    });
    await emit("message", service);
    return { status: "left" };
  }

  async function post(
    chat,
    {
      user_id: userId,
      text,
      photo_base64: photoBase64,
      caption,
      reply_to: replyTo,
    },
  ) {
    const user = requireUser(userId);
    const permission = photoBase64 ? "can_send_photos" : "can_send_messages";
    if (!canPost(chat, userId, permission)) {
      throw new TelegramError(403, "CHAT_WRITE_FORBIDDEN");
    }
    const fields = {};
    if (photoBase64) {
      const photo = registerPhoto(Buffer.from(photoBase64, "base64"));
      fields.photo = photoSizes(photo);
      if (caption) {
        fields.caption = String(caption);
        const captionEntities = messageEntities(fields.caption);
        if (captionEntities.length > 0)
          fields.caption_entities = captionEntities;
      }
    } else {
      fields.text = String(text ?? "");
    }
    const replied = replyTo != null ? chat.messages.get(Number(replyTo)) : null;
    if (replied) {
      const { reply_to_message: _nested, ...original } = replied.message;
      fields.reply_to_message = original;
    }
    if (fields.text) {
      const entities = messageEntities(fields.text);
      if (entities.length > 0) fields.entities = entities;
    }
    const message = addMessage(chat, user, fields);
    await emit("message", message);
    return { message_id: message.message_id };
  }

  // ── HTTP ───────────────────────────────────────────────────────────────
  function send(response, status, payload) {
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(JSON.stringify(payload));
  }

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://localhost");
      const body = await readBody(request);
      if (url.pathname.startsWith("/_fake/")) {
        const parts = url.pathname
          .slice("/_fake/".length)
          .split("/")
          .filter(Boolean);
        try {
          const payload = body.length ? parseJsonObject(body) : {};
          send(response, 200, await control(request.method, parts, payload));
        } catch (error) {
          if (!(error instanceof TelegramError)) throw error;
          send(response, error.code, { error: error.message });
        }
        return;
      }
      const file = url.pathname.match(/^\/file\/bot([^/]+)\/(.+)$/);
      if (file) {
        const entry = [...files.values()].find((f) => f.file_path === file[2]);
        if (!entry || file[1] !== botToken) {
          response.writeHead(404).end();
          return;
        }
        response.writeHead(200, {
          "Content-Type": entry.file_path.startsWith("photos/")
            ? "image/jpeg"
            : "application/octet-stream",
        });
        response.end(entry.data);
        return;
      }
      const call = url.pathname.match(/^\/bot([^/]+)\/([A-Za-z]+)$/);
      if (!call) {
        send(response, 404, {
          ok: false,
          error_code: 404,
          description: "Not Found",
        });
        return;
      }
      if (call[1] !== botToken) {
        send(response, 401, {
          ok: false,
          error_code: 401,
          description: "Unauthorized",
        });
        return;
      }
      const method = call[2];
      let params;
      try {
        params = await readRequestParams(request, body);
      } catch (error) {
        if (!(error instanceof TelegramError)) throw error;
        send(response, error.code, {
          ok: false,
          error_code: error.code,
          description: error.message,
        });
        return;
      }
      calls.push({ method, params: summarize(params), at: Date.now() });
      // Bot API method names are case-insensitive.
      const handler = methodsByLowerName.get(method.toLowerCase());
      if (!handler) {
        if (!unimplemented.has(method)) {
          unimplemented.add(method);
          log(`unimplemented Bot API method ${method}`);
        }
        if (unimplementedMode === "ok") {
          send(response, 200, { ok: true, result: true });
        } else {
          // Real Telegram's answer to a method it does not know, with a
          // description that says this fake is the one missing it.
          send(response, 404, {
            ok: false,
            error_code: 404,
            description: `Not Found: method ${method} is not implemented by telegram-bot-test-server`,
          });
        }
        return;
      }
      try {
        send(response, 200, { ok: true, result: await handler(params) });
      } catch (error) {
        if (!(error instanceof TelegramError)) throw error;
        send(response, error.code, {
          ok: false,
          error_code: error.code,
          description: error.message,
        });
      }
    } catch (error) {
      log(`internal error: ${error.stack ?? error.message}`);
      send(response, 500, {
        ok: false,
        error_code: 500,
        description: error.message,
      });
    }
  });

  function summarize(params) {
    const out = {};
    for (const [key, value] of Object.entries(params)) {
      out[key] = Buffer.isBuffer(value) ? `<${value.length} bytes>` : value;
    }
    return out;
  }

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  const address = server.address();
  const origin = `http://${host.includes(":") ? `[${host}]` : host}:${address.port}`;
  /** Run a control action in-process, with the same checks as /_fake/*. */
  async function act(method, path, body = {}) {
    try {
      return await control(method, path.split("/"), body);
    } catch (error) {
      if (error instanceof TelegramError) throw new Error(error.message);
      throw error;
    }
  }
  const inviteHash = (link) =>
    encodeURIComponent(link.replace(/^https:\/\/t\.me\/\+/, ""));

  return {
    origin,
    createUser: async (fields = {}) => (await act("POST", "users", fields)).id,
    updateProfile: (userId, fields) =>
      act("POST", `users/${userId}/profile`, fields),
    addProfilePhoto: (userId, bytes) =>
      act("POST", `users/${userId}/photos`, {
        base64: Buffer.from(bytes).toString("base64"),
      }),
    join: (chatId, userId) =>
      act("POST", `chats/${chatId}/join`, { user_id: userId }),
    joinByLink: (inviteLink, userId) =>
      act("POST", `invites/${inviteHash(inviteLink)}/join`, {
        user_id: userId,
      }),
    leave: (chatId, userId) =>
      act("POST", `chats/${chatId}/leave`, { user_id: userId }),
    post: async (chatId, userId, message) => {
      const fields =
        typeof message === "string"
          ? { text: message }
          : {
              ...(message.text !== undefined ? { text: message.text } : {}),
              ...(message.photo
                ? {
                    photo_base64: Buffer.from(message.photo).toString("base64"),
                  }
                : {}),
              ...(message.caption ? { caption: message.caption } : {}),
              ...(message.replyTo != null ? { reply_to: message.replyTo } : {}),
            };
      return (
        await act("POST", `chats/${chatId}/messages`, {
          user_id: userId,
          ...fields,
        })
      ).message_id;
    },
    pressButton: (chatId, messageId, userId, data) =>
      act("POST", `chats/${chatId}/messages/${messageId}/callback`, {
        user_id: userId,
        data,
      }),
    sendDirectMessage: async (userId, text) =>
      (await act("POST", `users/${userId}/dm`, { text })).message_id,
    postGuestBotReply: async (chatId, callerUserId, botUsername, text) =>
      (
        await act("POST", `chats/${chatId}/guest-bot-reply`, {
          caller_user_id: callerUserId,
          bot_username: botUsername,
          text,
        })
      ).message_id,
    pressDirectButton: (userId, messageId, data) =>
      act("POST", `users/${userId}/dm/${messageId}/callback`, { data }),
    getMessages: (chatId) => act("GET", `chats/${chatId}/messages`),
    getMessage: (chatId, messageId) =>
      act("GET", `chats/${chatId}/messages/${messageId}`),
    getDirectMessages: (userId) => act("GET", `users/${userId}/dm`),
    getMember: (chatId, userId) =>
      act("GET", `chats/${chatId}/members/${userId}`),
    getJoinRequests: (chatId) => act("GET", `chats/${chatId}/join-requests`),
    getCalls: () => act("GET", "calls"),
    stop: () =>
      new Promise((resolve) => {
        wakePollers();
        for (const abort of inFlight) abort.abort();
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
