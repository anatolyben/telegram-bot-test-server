/**
 * The viewer's data: the chat list and one chat's page, as JSON, read from
 * the server's model (index.js uiModel). Read-only: members are read without
 * the side effects of an expiry, and nothing here changes what it is given.
 */
import { inTopic, pageWindow, revokedBy, visibleTo } from "./views.js";

// A message's content, as the chat list names it: the first field it has.
// An animation also carries document, a live photo photo and a venue
// location, so they come first.
const MEDIA_FIELDS = [
  "live_photo",
  "animation",
  "audio",
  "document",
  "photo",
  "sticker",
  "video",
  "video_note",
  "voice",
  "contact",
  "dice",
  "venue",
  "location",
  "poll",
];
// The fields of a service message, one of which each carries.
const SERVICE_FIELDS = [
  "new_chat_members",
  "left_chat_member",
  "new_chat_title",
  "new_chat_photo",
  "delete_chat_photo",
  "group_chat_created",
  "supergroup_chat_created",
  "channel_chat_created",
  "migrate_to_chat_id",
  "migrate_from_chat_id",
  "pinned_message",
  "forum_topic_created",
  "forum_topic_edited",
];
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

  function botList() {
    const first = model.firstBotId();
    return model.bots().map((record, index) => ({
      id: record.id,
      username: record.username,
      first_name: record.first_name,
      first: record.id === first,
      index,
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

  /** A stored message as a page item. */
  function messageItem(chat, entry) {
    const { message } = entry;
    const deletedIn = (quoted) =>
      quoted != null &&
      quoted.chat?.id === chat.id &&
      chat.messages.get(quoted.message_id)?.deleted === true;
    return {
      kind: "message",
      ...model.messageLogEntry(entry),
      reply_deleted: deletedIn(message.reply_to_message),
      pinned_deleted: deletedIn(message.pinned_message),
    };
  }

  /** Every item of a chat or private pair, oldest first. */
  function itemsOf(target) {
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
    if (target.kind === "calls") {
      return {
        key: "calls",
        id: null,
        type: "calls",
        title: "Bot calls",
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

  /** The chat list's short form of a chat's latest item. */
  function preview(item) {
    if (!item) return null;
    if (item.kind === "event") {
      return {
        kind: "event",
        seq: item.seq,
        at: item.at,
        author: item.user_id ?? item.bot_id ?? null,
        preview: null,
        media: item.type,
        deleted: false,
        ephemeral: false,
      };
    }
    const { message } = item;
    const text = message.text ?? message.caption;
    return {
      kind: "message",
      seq: item.seq,
      at: item.at,
      author: item.author,
      preview: text == null ? null : Array.from(text).slice(0, 100).join(""),
      media:
        MEDIA_FIELDS.find((field) => message[field] !== undefined) ??
        SERVICE_FIELDS.find((field) => message[field] !== undefined) ??
        null,
      deleted: item.deleted,
      ephemeral: item.ephemeral,
    };
  }

  /** One row of the chat list. */
  function row(target, items, as) {
    const chat = chatJson(target);
    const shown = as === null ? items : seenBy(target, items, as).items;
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
      last: preview(shown[shown.length - 1]),
      message_count: messages.length,
      deleted_count: messages.filter((item) => item.deleted).length,
      member_count: group
        ? [...group.members.keys()].filter((id) => model.inChat(group, id))
            .length
        : 0,
      pending_join_requests: group && as === null ? group.joinRequests.size : 0,
      photo_file_id: chat.photo_file_id,
    };
  }

  /**
   * GET /_fake/ui/api/state: every group, supergroup, channel and forum, and
   * every private chat with something in it, most recent first; with `as`,
   * only the chats that person can open.
   */
  function state(query = {}) {
    const as = integer(query, "as", null, 1);
    const rows = [];
    for (const chat of model.chats()) {
      if (as !== null && !chat.members.has(as)) continue;
      const target = { key: String(chat.id), kind: "group", chat };
      rows.push(row(target, itemsOf(target), as));
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
        if (target) rows.push(row(target, itemsOf(target), as));
      }
    }
    // Most recent first; chats with nothing in them last, in creation order.
    rows.sort(
      (left, right) => (right.last?.seq ?? -1) - (left.last?.seq ?? -1),
    );
    return {
      instance: model.instance(),
      epoch: model.epoch(),
      version: model.version(),
      cursor: model.cursor(),
      clock: model.clock(),
      bots: botList(),
      chats: rows,
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
    let items = itemsOf(target);
    let as = null;
    if (read.as !== null) {
      ({ items, as } = seenBy(target, items, read.as));
    }
    if (read.topic !== null) {
      items = items.filter((item) => inTopic(item, read.topic));
    }
    const window =
      read.callsBefore !== null
        ? { items: [], has_older: false, oldest_seq: null, latest_seq: null }
        : pageWindow(items, read);
    const group = target.kind === "group" && as === null ? target.chat : null;
    const named = new Set();
    const ids = new Set(target.kind === "private" ? [target.userId] : []);
    for (const item of window.items) {
      if (item.kind === "message") {
        ids.add(item.author);
        ids.add(item.message.receiver_user?.id);
      } else {
        for (const id of [item.user_id, item.actor_id, item.bot_id]) {
          ids.add(id);
        }
        if (item.user_id != null) named.add(item.user_id);
      }
    }
    const members = group ? membersOf(group, read.membersLimit, named) : [];
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
      as,
      members,
      members_total: group ? group.members.size : 0,
      join_requests: joinRequests,
      bots: botList(),
      users: usersOf(ids),
      files: filesTable([
        ...window.items.flatMap((item) =>
          item.kind === "message" ? imageIds(item.message) : [],
        ),
        chat.photo_file_id,
      ]),
      calls: [],
      calls_truncated: false,
      calls_oldest_request: null,
    };
  }

  /** A stored image's bytes and type, for /_fake/ui/files; null otherwise. */
  function file(fileId) {
    const info = imageOf(String(fileId));
    return info
      ? { bytes: model.fileBytes(String(fileId)), mime_type: info.mime_type }
      : null;
  }

  return { state, page, resolve, file };
}
