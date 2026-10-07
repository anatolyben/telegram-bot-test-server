/**
 * The viewer's data: the chat list and one chat's page, as JSON, read from
 * the server's model (index.js uiModel). Read-only: members are read without
 * the side effects of an expiry, and nothing here changes what it is given.
 */
import {
  callsInTopic,
  callWindow,
  inTopic,
  listPreview,
  pageWindow,
  revokedBy,
  visibleTo,
} from "./views.js";

// The parameters a call shows: what it asked for, never a secret, a raw
// body or an upload. Every can_* right is kept too.
const CALL_PARAMS = new Set([
  "chat_id",
  "user_id",
  "receiver_user_id",
  "ephemeral_message_parameters",
  "message_id",
  "message_ids",
  "ephemeral_message_id",
  "until_date",
  "permissions",
  "use_independent_chat_permissions",
  "revoke_messages",
  "only_if_banned",
  "text",
  "caption",
  "parse_mode",
  "callback_query_id",
  "show_alert",
  "url",
  "invite_link",
  "name",
  "creates_join_request",
  "member_limit",
  "expire_date",
  "custom_title",
  "title",
  "description",
  "from_chat_id",
  "question",
  "result",
  "emoji",
  "message_thread_id",
  "allowed_updates",
  "offset",
  "timeout",
]);
// Methods whose message ids are in the chat they copy from (from_chat_id).
const SOURCE_CHAT_METHODS = new Set([
  "forwardmessage",
  "forwardmessages",
  "copymessage",
  "copymessages",
]);
// Members in the order a test looks for them.
const MEMBER_ORDER = [
  "creator",
  "administrator",
  "restricted",
  "kicked",
  "member",
  "left",
];

/** A request the viewer refuses, with its HTTP status. */
function refuse(status, message) {
  return Object.assign(new Error(message), { status });
}

/**
 * A query parameter that must be a whole number from `min` to `max`, or
 * `fallback` when it is absent.
 */
function integer(
  query,
  name,
  fallback,
  min = 0,
  max = Number.MAX_SAFE_INTEGER,
) {
  const value = query[name];
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!/^\d+$/.test(String(value)) || number < min || number > max) {
    throw refuse(
      400,
      max === Number.MAX_SAFE_INTEGER
        ? min > 0
          ? `${name} must be a positive integer`
          : `${name} must be a non-negative integer`
        : `${name} must be an integer from ${min} to ${max}`,
    );
  }
  return number;
}

/** The image type and size of stored bytes, or null for anything else. */
function imageInfo(bytes) {
  const latin = (from, to) => bytes.toString("latin1", from, to);
  if (bytes.length >= 24 && latin(0, 8) === "\x89PNG\r\n\x1a\n") {
    return {
      mime_type: "image/png",
      width: bytes.readUInt32BE(16),
      height: bytes.readUInt32BE(20),
    };
  }
  if (bytes.length >= 10 && latin(0, 4) === "GIF8") {
    return {
      mime_type: "image/gif",
      width: bytes.readUInt16LE(6),
      height: bytes.readUInt16LE(8),
    };
  }
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    // A JPEG's frame header (SOF0 to SOF15, but not DHT, JPG or DAC) holds it.
    for (let at = 2; at + 9 <= bytes.length && bytes[at] === 0xff; ) {
      const marker = bytes[at + 1];
      if (
        marker >= 0xc0 &&
        marker <= 0xcf &&
        ![0xc4, 0xc8, 0xcc].includes(marker)
      ) {
        return {
          mime_type: "image/jpeg",
          width: bytes.readUInt16BE(at + 7),
          height: bytes.readUInt16BE(at + 5),
        };
      }
      at += 2 + bytes.readUInt16BE(at + 2);
    }
    return { mime_type: "image/jpeg", width: null, height: null };
  }
  if (bytes.length >= 30 && latin(0, 4) === "RIFF" && latin(8, 12) === "WEBP") {
    const chunk = latin(12, 16);
    let size = [null, null];
    if (chunk === "VP8X") {
      size = [1 + bytes.readUIntLE(24, 3), 1 + bytes.readUIntLE(27, 3)];
    } else if (chunk === "VP8 ") {
      size = [bytes.readUInt16LE(26) & 0x3fff, bytes.readUInt16LE(28) & 0x3fff];
    } else if (chunk === "VP8L") {
      size = [
        1 + (bytes[21] | ((bytes[22] & 0x3f) << 8)),
        1 + ((bytes[22] >> 6) | (bytes[23] << 2) | ((bytes[24] & 0x0f) << 10)),
      ];
    }
    return { mime_type: "image/webp", width: size[0], height: size[1] };
  }
  return null;
}

/** The file_ids of the images a message shows: the largest size of each. */
function imageIds(message) {
  const largest = (sizes) =>
    Array.isArray(sizes) ? sizes[sizes.length - 1]?.file_id : undefined;
  return [
    largest(message.photo),
    largest(message.new_chat_photo),
    message.sticker?.file_id,
    largest(message.poll?.media?.photo),
    largest(message.live_photo?.photo),
    largest(message.reply_to_message?.photo),
    largest(message.external_reply?.photo),
  ].filter(Boolean);
}

/** A whole number given as a number or as its digits, else null. */
function idOf(value) {
  const text = String(value ?? "").trim();
  return /^-?\d+$/.test(text) && Number.isSafeInteger(Number(text))
    ? Number(text)
    : null;
}

/** A call parameter's text or caption, cut to 200 characters. */
function shortText(value) {
  if (typeof value !== "string") return value;
  const chars = Array.from(value);
  return chars.length > 200 ? `${chars.slice(0, 200).join("")}…` : value;
}

/**
 * A message's reactions (its stored map of user id to reactions, index.js
 * storedReaction) as td_api's messageReaction has them: each reaction's type
 * and total_count, and here also who chose it (`user_ids`). The most chosen
 * come first, as TDLib sorts them (MessageReactions::sort_reactions).
 * UNVERIFIED: the order of reactions chosen as often. TDLib orders them by
 * Telegram's list of active reactions, which this server does not have; here
 * they keep the order of the members who chose them, by when each first
 * reacted to the message.
 */
function reactionsOf(stored) {
  const found = new Map();
  for (const [userId, chosen] of stored ?? []) {
    for (const value of chosen) {
      if (!found.has(value)) {
        const custom = /^#(-?\d+)$/.exec(value);
        found.set(value, {
          ...(custom
            ? { type: "custom_emoji", custom_emoji_id: custom[1] }
            : { type: "emoji", emoji: value }),
          total_count: 0,
          user_ids: [],
        });
      }
      const reaction = found.get(value);
      reaction.total_count += 1;
      reaction.user_ids.push(userId);
    }
  }
  return [...found.values()].sort(
    (left, right) => right.total_count - left.total_count,
  );
}

/** A person's or bot's name as the chat list shows it. */
function fullName(user) {
  return [user.first_name, user.last_name].filter(Boolean).join(" ");
}

/** The viewer's read-only views of the server's model. */
export function createUiState(model) {
  // Image types and sizes by file_id: a file's bytes never change.
  const images = new Map();

  function imageOf(fileId) {
    if (!fileId) return null;
    if (!images.has(fileId)) {
      const bytes = model.fileBytes(fileId);
      images.set(fileId, bytes ? imageInfo(bytes) : null);
    }
    return images.get(fileId);
  }

  /** The `files` table: every image among `ids`, by file_id. */
  function filesTable(ids) {
    const table = {};
    for (const id of ids) {
      const info = imageOf(id);
      if (!info || table[id]) continue;
      table[id] = {
        url: `/_fake/ui/files/${encodeURIComponent(id)}`,
        mime_type: info.mime_type,
        width: info.width,
        height: info.height,
        size: model.fileBytes(id).length,
      };
    }
    return table;
  }

  /** Every bot the server has had; a deleted one says so. */
  function botList() {
    const first = model.firstBotId();
    return model.bots().map((record, index) => ({
      id: record.id,
      username: record.username,
      first_name: record.first_name,
      first: record.id === first,
      index,
      ...(record.deleted ? { deleted: true } : {}),
    }));
  }

  /** A user as the viewer shows them: never more than their public names. */
  function userJson(user) {
    return {
      id: user.id,
      is_bot: user.is_bot === true,
      first_name: user.first_name,
      ...(user.last_name ? { last_name: user.last_name } : {}),
      ...(user.username ? { username: user.username } : {}),
    };
  }

  /**
   * A chat reference: a group, supergroup or channel id; a private chat as
   * "<user id>:<bot id>", or a user id alone for their chat with the first
   * bot; or "calls", the bot calls that belong to no chat. Null when it names
   * nothing.
   */
  function resolve(ref) {
    const text = String(ref);
    if (text === "calls") return { key: "calls", kind: "calls", chat: null };
    if (text === "all") return { key: "all", kind: "all", chat: null };
    const pair = /^(\d+):(\d+)$/.exec(text);
    if (pair) return privatePair(Number(pair[1]), Number(pair[2]));
    if (/^\d+$/.test(text)) {
      return privatePair(Number(text), model.firstBotId());
    }
    if (/^-\d+$/.test(text)) {
      const chat = model.chat(text);
      return chat ? { key: String(chat.id), kind: "group", chat } : null;
    }
    return null;
  }

  /**
   * A user's private chat with one bot. Users write only to the first bot,
   * and any bot's messages to them are kept in the same stored chat, so each
   * bot's chat is a part of it (model.privatePairOf). It exists, empty, for
   * any person and bot: nothing is stored to open it.
   */
  function privatePair(userId, botId) {
    const user = model.user(userId);
    if (!user || user.is_bot) return null;
    if (!model.bots().some((record) => record.id === botId)) return null;
    return {
      key: `${userId}:${botId}`,
      kind: "private",
      chat: model.privateChat(userId) ?? null,
      user,
      userId,
      botId,
    };
  }

  /**
   * A stored message as a page item. `edit_hidden`: its last edit was a
   * bot's change of only its keyboard, which Telegram's apps do not mark as
   * edited (the message's edit_hide), though the bot gets its edit_date.
   * `reactions`: its reactions now (reactionsOf), when it has any.
   */
  function messageItem(chat, entry) {
    const { message } = entry;
    const deletedIn = (quoted) =>
      quoted != null &&
      quoted.chat?.id === chat.id &&
      chat.messages.get(quoted.message_id)?.deleted === true;
    const reactions = reactionsOf(entry.reactions);
    return {
      kind: "message",
      ...model.messageLogEntry(entry),
      reply_deleted: deletedIn(message.reply_to_message),
      pinned_deleted: deletedIn(message.pinned_message),
      ...(entry.editHidden ? { edit_hidden: true } : {}),
      ...(reactions.length ? { reactions } : {}),
    };
  }

  /**
   * Every chat and private pair with something in it (with `as`, only those
   * that person can open), as targets: groups first, then private pairs.
   */
  function everyTarget(as = null) {
    const targets = [];
    for (const chat of model.chats()) {
      if (as !== null && !chat.members.has(as)) continue;
      targets.push({ key: String(chat.id), kind: "group", chat });
    }
    for (const chat of model.privateChats()) {
      if (as !== null && chat.id !== as) continue;
      const pairs = new Set();
      for (const stored of [
        ...chat.messages.values(),
        ...(chat.events ?? []),
      ]) {
        pairs.add(model.privatePairOf(chat, stored));
      }
      for (const botId of pairs) {
        const target = privatePair(chat.id, botId);
        if (target) targets.push(target);
      }
    }
    return targets;
  }

  /** A chat's name in the "all" feed: its title, or "<person> ↔ @<bot>". */
  function labelOf(target) {
    if (target.kind === "group") return target.chat.title ?? String(target.key);
    if (target.kind === "private") {
      const bot = model.bots().find((record) => record.id === target.botId);
      return `${fullName(target.user)} ↔ @${bot?.username ?? target.botId}`;
    }
    return "Bot calls without a chat";
  }

  /** Every item of a chat or private pair (or of all of them, "all"), oldest first. */
  function itemsOf(target) {
    if (target.kind === "all") {
      const items = [];
      for (const each of everyTarget()) {
        const label = labelOf(each);
        for (const item of itemsOf(each)) {
          items.push({ ...item, chat_ref: each.key, chat_label: label });
        }
      }
      return items.sort((left, right) => left.seq - right.seq);
    }
    const { chat } = target;
    if (!chat) return [];
    const keep =
      target.kind === "private"
        ? (stored) => model.privatePairOf(chat, stored) === target.botId
        : () => true;
    const items = [];
    for (const entry of chat.messages.values()) {
      if (keep(entry)) items.push(messageItem(chat, entry));
    }
    for (const entry of chat.ephemeral?.values() ?? []) {
      if (keep(entry)) items.push(messageItem(chat, entry));
    }
    for (const event of chat.events ?? []) {
      if (keep(event)) items.push({ kind: "event", ...model.eventJson(event) });
    }
    return items.sort((left, right) => left.seq - right.seq);
  }

  /** The page's description of the chat. */
  function chatJson(target) {
    if (target.kind === "all") {
      return {
        key: "all",
        id: null,
        type: "all",
        title: "Activity",
        is_forum: false,
        topics: [],
        migrated_to: null,
        migrated_from: null,
        permissions: null,
        description: null,
        photo_file_id: null,
        user_id: null,
        bot_id: null,
      };
    }
    if (target.kind === "calls") {
      return {
        key: "calls",
        id: null,
        type: "calls",
        title: "Bot calls without a chat",
        is_forum: false,
        topics: [],
        migrated_to: null,
        migrated_from: null,
        permissions: null,
        description: null,
        photo_file_id: null,
        user_id: null,
        bot_id: null,
      };
    }
    if (target.kind === "private") {
      return {
        key: target.key,
        id: target.userId,
        type: "private",
        title: fullName(target.user),
        is_forum: false,
        topics: [],
        migrated_to: null,
        migrated_from: null,
        permissions: null,
        description: null,
        photo_file_id: null,
        user_id: target.userId,
        bot_id: target.botId,
      };
    }
    const { chat } = target;
    return {
      key: target.key,
      id: chat.id,
      type: chat.type,
      title: chat.title,
      is_forum: chat.topics != null,
      topics: chat.topics
        ? [...chat.topics].map(([id, topic]) => ({
            message_thread_id: id,
            name: topic.name,
          }))
        : [],
      migrated_to: chat.migratedTo ?? null,
      migrated_from: chat.migratedFrom ?? null,
      permissions: chat.type === "channel" ? null : { ...chat.permissions },
      description: chat.description ?? null,
      photo_file_id: imageOf(chat.photo?.file_id) ? chat.photo.file_id : null,
      user_id: null,
      bot_id: null,
    };
  }

  /** Who the viewer is looking as, for visibleTo. */
  function viewerMember(target, userId) {
    if (target.kind !== "group") {
      return { user_id: userId, status: null, revoked_by: [] };
    }
    const { chat } = target;
    const member = model.member(chat, userId);
    return {
      user_id: userId,
      status: member.status,
      ...(member.status === "restricted"
        ? { is_member: member.is_member !== false }
        : {}),
      revoked_by:
        chat.type === "group" ? revokedBy(model.calls(), chat.id, userId) : [],
    };
  }

  /** What a member sees of a chat: visibleTo over its items. */
  function seenBy(target, items, userId) {
    if (target.kind === "calls") {
      return {
        items: [],
        as: {
          user_id: userId,
          status: null,
          in_chat: false,
          access: "none",
          history_may_be_hidden: false,
        },
      };
    }
    return visibleTo(items, viewerMember(target, userId), chatJson(target));
  }

  /**
   * The chat's members, creator first, then administrators, restricted,
   * banned, members and those who left, each by user id: at most `limit`,
   * plus any member the page's items name.
   */
  function membersOf(chat, limit, named) {
    if (limit === 0) return [];
    const rank = (id) => MEMBER_ORDER.indexOf(model.member(chat, id).status);
    const ids = [...chat.members.keys()].sort(
      (left, right) => rank(left) - rank(right) || left - right,
    );
    const kept = ids.slice(0, limit);
    const shown = new Set(kept);
    for (const id of ids.slice(limit)) {
      if (named.has(id) && !shown.has(id)) kept.push(id);
    }
    return kept.map((id) => ({
      user_id: id,
      member: model.memberJson(chat, id),
    }));
  }

  /** The users a page names, and every bot. */
  function usersOf(ids) {
    const users = {};
    for (const id of ids) {
      const user = id == null ? null : model.user(id);
      if (user) users[user.id] = userJson(user);
    }
    for (const record of model.bots()) users[record.id] = userJson(record);
    return users;
  }

  /**
   * The chat a call belongs to, `{ key, id }`: the chat its chat_id names (a
   * private chat as the user's chat with the calling bot), or the chat of the
   * button press or join request query it answers. Null for business calls
   * and calls naming no chat this server has: they belong to "calls".
   */
  function callChat(call, botIds) {
    const params = call.params ?? {};
    if (params.business_connection_id != null) return null;
    const method = String(call.method).toLowerCase();
    const id = idOf(
      method === "answercallbackquery"
        ? model.chatOfQuery(params.callback_query_id)
        : method === "answerchatjoinrequestquery"
          ? model.chatOfQuery(params.chat_join_request_query_id)
          : params.chat_id,
    );
    if (id === null) return null;
    if (id < 0) {
      const chat = model.chat(id);
      return chat ? { key: String(chat.id), id: chat.id } : null;
    }
    const user = model.user(id);
    return user && !user.is_bot && botIds.has(call.bot_id)
      ? { key: `${id}:${call.bot_id}`, id }
      : null;
  }

  /**
   * The calls numbered above `after` (of the chat `only`, else of every
   * chat), by the key of the chat each belongs to (callChat), oldest first.
   * Refused requests (an unknown token, a body that could not be read)
   * belong to "calls".
   */
  function callsByChat({ after = 0, only = null } = {}) {
    const botIds = new Set(model.bots().map((record) => record.id));
    const byKey = new Map();
    const keep = (key, call, journal, chat) => {
      const number = requestNumber(call.request_id);
      if (number <= after) return;
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push({ call, journal, chat, request_number: number });
    };
    for (const call of model.calls()) {
      const chat = callChat(call, botIds);
      const key = chat?.key ?? "calls";
      if (only === null || key === only) keep(key, call, "calls", chat);
    }
    if (only === null || only === "calls") {
      for (const call of model.rejectedRequests()) {
        keep("calls", call, "rejected_requests", null);
      }
    }
    for (const found of byKey.values()) {
      found.sort((left, right) => left.request_number - right.request_number);
    }
    return byKey;
  }

  /** The calls of a chat, or of "calls" (those no chat holds), oldest first. */
  function callsOf(key) {
    if (key === "all") {
      return [...callsByChat().values()]
        .flat()
        .sort((left, right) => left.request_number - right.request_number);
    }
    return callsByChat({ only: key }).get(key) ?? [];
  }

  function requestNumber(requestId) {
    return Number(String(requestId).split(":").pop());
  }

  /**
   * A call as the timeline shows it: what it asked (CALL_PARAMS), how it
   * ended, Telegram's description, and what it touched — the messages it
   * names (in the chat it copies from, for forwards and copies), its user,
   * and the messages it stored (`created`, by request id). A call with
   * `permissions` also has them as Telegram reads them
   * (`resolved_permissions`: every field, those left out off), or null when
   * Telegram could not read them.
   */
  function callItem({ call, journal, chat, request_number }, created) {
    const raw = call.params ?? {};
    const params = {};
    for (const [name, value] of Object.entries(raw)) {
      if (CALL_PARAMS.has(name) || name.startsWith("can_")) {
        params[name] =
          name === "text" || name === "caption" ? shortText(value) : value;
      }
    }
    const method = String(call.method);
    const targetChat = idOf(
      SOURCE_CHAT_METHODS.has(method.toLowerCase())
        ? raw.from_chat_id
        : raw.chat_id,
    );
    const ids = [
      raw.message_id,
      ...(Array.isArray(raw.message_ids) ? raw.message_ids : []),
    ]
      .map(idOf)
      .filter((id) => id !== null);
    const stored = created.get(call.request_id) ?? [];
    return {
      kind: "call",
      journal,
      call_seq: call.seq,
      request_id: call.request_id,
      request_number,
      bot_id: call.bot_id ?? null,
      method,
      at: call.at,
      completed_at: call.completed_at ?? null,
      outcome: call.outcome,
      status: call.status ?? null,
      applied: call.applied === true,
      description: call.description ?? null,
      unimplemented:
        !model.knownMethod(method) || call.outcome === "unimplemented_ok",
      fault_injected: call.fault_injected === true,
      chat_id: chat?.id ?? idOf(raw.chat_id),
      params,
      ...(raw.permissions != null
        ? {
            resolved_permissions: model.permissions(
              raw.permissions,
              raw.use_independent_chat_permissions,
            ),
          }
        : {}),
      targets: {
        messages:
          targetChat === null
            ? []
            : ids.map((id) => ({ chat_id: targetChat, message_id: id })),
        user_id: call.target_user_id ?? null,
        ephemeral_message_id: idOf(raw.ephemeral_message_id),
        created_message_ids: stored
          .filter((item) => !item.ephemeral)
          .map((item) => item.message.message_id),
        created_ephemeral_ids: stored
          .filter((item) => item.ephemeral)
          .map((item) => item.message.ephemeral_message_id),
      },
    };
  }

  /** The messages each call stored, by request id. */
  function storedBy(items) {
    const created = new Map();
    for (const item of items) {
      if (item.kind !== "message" || item.request_id == null) continue;
      if (!created.has(item.request_id)) created.set(item.request_id, []);
      created.get(item.request_id).push(item);
    }
    return created;
  }

  /**
   * The chat list's row of the calls no chat holds (`found`, by default all
   * of them); null when there are none.
   */
  function callsRow(found = callsOf("calls")) {
    if (!found.length) return null;
    return {
      key: "calls",
      id: null,
      type: "calls",
      title: "Bot calls without a chat",
      is_forum: false,
      migrated_to: null,
      migrated_from: null,
      user_id: null,
      bot_id: null,
      last: null,
      message_count: 0,
      deleted_count: 0,
      member_count: 0,
      pending_join_requests: 0,
      photo_file_id: null,
      call_count: found.length,
      last_call: callItem(found[found.length - 1], new Map()),
    };
  }

  /**
   * One row of the chat list; seen as the member `as`, also what they may
   * see of it (`access`, as visibleTo says).
   */
  function row(target, items, as) {
    const chat = chatJson(target);
    const seen = as === null ? null : seenBy(target, items, as);
    const shown = seen === null ? items : seen.items;
    const messages = shown.filter((item) => item.kind === "message");
    const group = target.kind === "group" ? target.chat : null;
    return {
      key: chat.key,
      id: chat.id,
      type: chat.type,
      title: chat.title,
      is_forum: chat.is_forum,
      migrated_to: chat.migrated_to,
      migrated_from: chat.migrated_from,
      user_id: chat.user_id,
      bot_id: chat.bot_id,
      last: listPreview(shown[shown.length - 1]),
      message_count: messages.length,
      deleted_count: messages.filter((item) => item.deleted).length,
      member_count: group
        ? [...group.members.keys()].filter((id) => model.inChat(group, id))
            .length
        : 0,
      pending_join_requests: group && as === null ? group.joinRequests.size : 0,
      photo_file_id: chat.photo_file_id,
      ...(seen === null ? {} : { access: seen.as.access }),
    };
  }

  /**
   * The users the chat list's rows name in their latest item (its author,
   * the people a service message or an event names), and every bot, so a
   * row reads the same whichever chats a page has open.
   */
  function rowUsers(rows) {
    const ids = [];
    for (const { last } of rows) {
      if (!last) continue;
      ids.push(
        last.author,
        last.event?.user_id,
        last.event?.actor_id,
        last.event?.bot_id,
        last.message?.from?.id,
        last.message?.left_chat_member?.id,
        ...(last.message?.new_chat_members ?? []).map((user) => user.id),
      );
    }
    return usersOf(ids);
  }

  /**
   * GET /_fake/ui/api/state: every group, supergroup, channel and forum, and
   * every private chat with something in it, most recent first; with `as`,
   * only the chats that person can open.
   */
  function state(query = {}) {
    const as = integer(query, "as", null, 1);
    const rows = [];
    for (const target of everyTarget(as)) {
      rows.push(row(target, itemsOf(target), as));
    }
    // Most recent first; chats with nothing in them last, in creation order.
    rows.sort(
      (left, right) => (right.last?.seq ?? -1) - (left.last?.seq ?? -1),
    );
    // The calls no chat holds come first; a member sees no calls.
    const calls = as === null ? callsRow() : null;
    if (calls) rows.unshift(calls);
    // "Activity" (every chat in one feed) comes first in the test view.
    if (as === null) {
      const all = { key: "all", kind: "all", chat: null };
      rows.unshift(row(all, itemsOf(all), null));
    }
    return {
      instance: model.instance(),
      epoch: model.epoch(),
      version: model.version(),
      cursor: model.cursor(),
      clock: model.clock(),
      bots: botList(),
      chats: rows,
      users: rowUsers(rows),
      files: filesTable(rows.map((each) => each.photo_file_id)),
    };
  }

  /** A chat page's query, checked. */
  function pageQuery(query) {
    const read = {
      limit: integer(query, "limit", 200, 1, 1000),
      before: integer(query, "before", null),
      from: integer(query, "from", null),
      to: integer(query, "to", null),
      as: integer(query, "as", null, 1),
      membersLimit: integer(query, "members_limit", 200, 0, 5000),
      callsBefore: integer(query, "calls_before", null),
      topic: null,
    };
    if (read.before !== null && (read.from !== null || read.to !== null)) {
      throw refuse(400, "before cannot be combined with from or to");
    }
    if (read.to !== null && read.from === null) {
      throw refuse(400, "to needs from");
    }
    if (query.topic !== undefined) {
      if (
        query.topic !== "general" &&
        !/^[1-9]\d*$/.test(String(query.topic))
      ) {
        throw refuse(400, "topic must be a message_thread_id or general");
      }
      read.topic = query.topic === "general" ? "general" : Number(query.topic);
    }
    return read;
  }

  /** GET /_fake/ui/api/chats/<ref>: one window of a chat's items. */
  function page(ref, query = {}) {
    const target = resolve(ref);
    if (!target) throw refuse(404, "chat not found");
    const read = pageQuery(query);
    const all = itemsOf(target);
    let items = all;
    let as = null;
    if (read.as !== null && target.kind === "all") {
      // Seen as a member: each chat they can open, as they see it.
      items = [];
      for (const each of everyTarget(read.as)) {
        const label = labelOf(each);
        for (const item of seenBy(each, itemsOf(each), read.as).items) {
          items.push({ ...item, chat_ref: each.key, chat_label: label });
        }
      }
      items.sort((left, right) => left.seq - right.seq);
      as = {
        user_id: read.as,
        status: null,
        in_chat: true,
        access: "member",
        history_may_be_hidden: false,
      };
    } else if (read.as !== null) {
      ({ items, as } = seenBy(target, items, read.as));
    }
    if (read.topic !== null) {
      items = items.filter((item) => inTopic(item, read.topic));
    }
    const window =
      read.callsBefore !== null
        ? {
            items: [],
            has_older: false,
            oldest_seq: null,
            latest_seq: null,
            chat_latest_seq: null,
          }
        : pageWindow(items, read);
    // A member sees no calls; a topic shows only its own. Only the calls the
    // page shows are drawn up.
    const calls =
      as === null
        ? callWindow(
            items,
            callsInTopic(
              callsOf(target.key),
              all,
              read.topic,
              (entry) => entry.call,
            ),
            window,
            { callsBefore: read.callsBefore },
          )
        : { calls: [], calls_truncated: false, calls_oldest_request: null };
    if (calls.calls.length) {
      const created = storedBy(all);
      const labels =
        target.kind === "all"
          ? new Map(everyTarget().map((each) => [each.key, labelOf(each)]))
          : null;
      calls.calls = calls.calls.map((found) => {
        const item = callItem(found, created);
        if (!labels) return item;
        const key = found.chat?.key ?? "calls";
        return {
          ...item,
          chat_ref: key,
          chat_label: labels.get(key) ?? "Bot calls without a chat",
        };
      });
    }
    return pageJson(target, window, as, calls, read.membersLimit);
  }

  /**
   * A chat's page: `window` (its items and where they sit in the chat), the
   * member it is seen as (`as`), its drawn-up `calls`, and the members (at
   * most `membersLimit`, plus any its items or calls name; `members_total`
   * counts every member record, `members_in_chat` those in the chat now),
   * join requests, users (the member it is seen as among them) and images
   * it names.
   */
  function pageJson(target, window, as, calls, membersLimit) {
    const group = target.kind === "group" && as === null ? target.chat : null;
    const named = new Set();
    const ids = new Set(target.kind === "private" ? [target.userId] : []);
    if (as !== null) ids.add(as.user_id);
    for (const item of window.items) {
      if (item.kind === "message") {
        ids.add(item.author);
        ids.add(item.message.receiver_user?.id);
        for (const reaction of item.reactions ?? []) {
          for (const id of reaction.user_ids) ids.add(id);
        }
      } else {
        for (const id of [item.user_id, item.actor_id, item.bot_id]) {
          ids.add(id);
        }
        if (item.user_id != null) named.add(item.user_id);
      }
    }
    for (const call of calls.calls) {
      ids.add(call.targets.user_id);
      if (call.targets.user_id != null) named.add(call.targets.user_id);
    }
    const members = group ? membersOf(group, membersLimit, named) : [];
    const joinRequests = group
      ? [...group.joinRequests].map(([userId, request]) => ({
          user_id: userId,
          date: request.date,
          invite_link: request.invite_link?.invite_link ?? null,
          invite_link_name: request.invite_link?.name ?? null,
        }))
      : [];
    for (const entry of members) ids.add(entry.user_id);
    for (const request of joinRequests) ids.add(request.user_id);
    const chat = chatJson(target);
    return {
      instance: model.instance(),
      epoch: model.epoch(),
      version: model.version(),
      cursor: model.cursor(),
      chat,
      items: window.items,
      has_older: window.has_older,
      oldest_seq: window.oldest_seq,
      latest_seq: window.latest_seq,
      chat_latest_seq: window.chat_latest_seq,
      as,
      members,
      members_total: group ? group.members.size : 0,
      members_in_chat: group
        ? [...group.members.keys()].filter((id) => model.inChat(group, id))
            .length
        : 0,
      join_requests: joinRequests,
      bots: botList(),
      users: usersOf(ids),
      files: filesTable([
        ...window.items.flatMap((item) =>
          item.kind === "message" ? imageIds(item.message) : [],
        ),
        chat.photo_file_id,
      ]),
      calls: calls.calls,
      calls_truncated: calls.calls_truncated,
      calls_oldest_request: calls.calls_oldest_request,
    };
  }

  /** A chat's stored messages, ephemeral messages and events. */
  function* storedIn(chat) {
    yield* chat.messages.values();
    yield* chat.ephemeral?.values() ?? [];
    yield* chat.events ?? [];
  }

  /**
   * What a recording keeps (index.js record/start and record/stop): for each
   * chat, its items stored after the seq `startSeq` and its calls numbered
   * after `startRequest`, as one page with every member and call. Older
   * messages that a recorded call names (for a forward, in the chat it came
   * from) or that a recorded message replies to come first, as context
   * (`before_window`). `refs` names the chats; null records every chat with
   * an item or a call in the window, and a ref that names no chat is listed
   * in `missing`. The images the pages show are in one `files` table, and
   * the state and pages keep none of their own.
   */
  function recorded({ refs = null, startSeq, startRequest }) {
    const found = callsByChat({ after: startRequest });
    const targets = new Map();
    const missing = [];
    const add = (target) => {
      if (target && !targets.has(target.key)) targets.set(target.key, target);
    };
    if (refs !== null) {
      for (const ref of refs) {
        const target = resolve(ref);
        if (target) add(target);
        else missing.push(String(ref));
      }
    } else {
      for (const chat of model.chats()) {
        for (const stored of storedIn(chat)) {
          if (stored.seq <= startSeq) continue;
          add({ key: String(chat.id), kind: "group", chat });
          break;
        }
      }
      for (const chat of model.privateChats()) {
        for (const stored of storedIn(chat)) {
          if (stored.seq > startSeq) {
            add(privatePair(chat.id, model.privatePairOf(chat, stored)));
          }
        }
      }
      for (const key of found.keys()) add(resolve(key));
    }
    // The calls first: a chat's context includes the messages any recorded
    // call names in it.
    const all = new Map();
    const calls = new Map();
    const named = new Map();
    const namedIn = (chatId) => {
      if (!named.has(chatId)) {
        named.set(chatId, { messages: new Set(), ephemeral: new Set() });
      }
      return named.get(chatId);
    };
    for (const target of targets.values()) {
      const items = itemsOf(target);
      const created = storedBy(items);
      const drawn = (found.get(target.key) ?? []).map((each) =>
        callItem(each, created),
      );
      all.set(target.key, items);
      calls.set(target.key, drawn);
      for (const call of drawn) {
        for (const { chat_id, message_id } of call.targets.messages) {
          namedIn(chat_id).messages.add(message_id);
        }
        if (call.targets.ephemeral_message_id !== null) {
          namedIn(call.chat_id).ephemeral.add(
            call.targets.ephemeral_message_id,
          );
        }
      }
    }
    const pages = {};
    const files = {};
    const rows = [];
    for (const target of targets.values()) {
      const items = all.get(target.key);
      let start = items.findIndex((item) => item.seq > startSeq);
      if (start < 0) start = items.length;
      const chatId =
        target.kind === "private" ? target.userId : (target.chat?.id ?? null);
      const messages = new Set(named.get(chatId)?.messages);
      const ephemeral = named.get(chatId)?.ephemeral ?? new Set();
      const window = items.slice(start);
      for (const item of window) {
        const reply =
          item.kind === "message" ? item.message.reply_to_message : null;
        if (reply && reply.chat?.id === chatId) messages.add(reply.message_id);
      }
      const context = items
        .slice(0, start)
        .filter(
          (item) =>
            item.kind === "message" &&
            (item.ephemeral
              ? ephemeral.has(item.message.ephemeral_message_id)
              : messages.has(item.message.message_id)),
        )
        .map((item) => ({ ...item, before_window: true }));
      const kept = [...context, ...window];
      const page = pageJson(
        target,
        {
          items: kept,
          has_older: false,
          oldest_seq: kept.length ? kept[0].seq : null,
          latest_seq: kept.length ? kept[kept.length - 1].seq : null,
          chat_latest_seq: kept.length ? kept[kept.length - 1].seq : null,
        },
        null,
        {
          calls: calls.get(target.key),
          calls_truncated: false,
          calls_oldest_request: null,
        },
        Infinity,
      );
      Object.assign(files, page.files);
      page.files = {};
      pages[target.key] = page;
      if (target.kind !== "calls") rows.push(row(target, kept, null));
    }
    rows.sort(
      (left, right) => (right.last?.seq ?? -1) - (left.last?.seq ?? -1),
    );
    const callsList = targets.has("calls")
      ? callsRow(found.get("calls") ?? [])
      : null;
    if (callsList) rows.unshift(callsList);
    return {
      state: {
        instance: model.instance(),
        epoch: model.epoch(),
        version: model.version(),
        cursor: model.cursor(),
        clock: model.clock(),
        bots: botList(),
        chats: rows,
        users: rowUsers(rows),
        files: {},
      },
      pages,
      files,
      missing,
    };
  }

  /** A stored image's bytes and type, for /_fake/ui/files; null otherwise. */
  function file(fileId) {
    const info = imageOf(String(fileId));
    return info
      ? { bytes: model.fileBytes(String(fileId)), mime_type: info.mime_type }
      : null;
  }

  return { state, page, resolve, file, recorded };
}
