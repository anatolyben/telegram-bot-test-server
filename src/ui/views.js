/**
 * Windows and filters over one chat's items (its messages and events, oldest
 * first by seq), shared by the server's viewer data and by recordings, so a
 * live page and a recorded one page and filter the same way.
 *
 * Pure: no DOM, no Node APIs, no imports, nothing run at load. Recordings
 * inline this file, so every export starts a line as `export function`.
 */

/**
 * The page of `items` a viewer asks for: the newest `limit` items, the
 * `limit` items before the seq `before`, or the items from seq `from` to seq
 * `to` (both included; at most 1000, the newest when more). `has_older`,
 * `oldest_seq` and `latest_seq` describe the page within `items`.
 */
export function pageWindow(
  items,
  { limit = 200, before = null, from = null, to = null } = {},
) {
  let start;
  let end;
  if (from != null) {
    start = viewFirstFrom(items, from);
    end = to == null ? items.length : viewFirstFrom(items, to + 1);
    start = Math.min(end, Math.max(start, end - 1000));
  } else {
    end = before == null ? items.length : viewFirstFrom(items, before);
    start = Math.max(0, end - limit);
  }
  const page = items.slice(start, end);
  return {
    items: page,
    has_older: start > 0,
    oldest_seq: page.length ? page[0].seq : null,
    latest_seq: page.length ? page[page.length - 1].seq : null,
  };
}

/** The index of the first item whose seq is `seq` or more. */
function viewFirstFrom(items, seq) {
  let low = 0;
  let high = items.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (items[middle].seq < seq) low = middle + 1;
    else high = middle;
  }
  return low;
}

/**
 * What one member sees of a chat, and why. `member` is
 * `{ user_id, status, is_member, revoked_by }`: their state in the chat now
 * (status null for a private chat) and the request ids of the calls that
 * banned them with revoke_messages (revokedBy). `chat` is the page's chat:
 * `{ type, is_forum, user_id }`.
 *
 * Every chat here is private (chats have no usernames): a channel, a forum
 * or a supergroup shows a member everything and anyone else nothing, though a
 * non-forum supergroup may hide older history from new members, which is not
 * modeled (history_may_be_hidden); a basic group shows only what was posted
 * while the member was in it, from each join to the next leave or removal,
 * and nothing that a removal with revoke_messages took away; a private chat
 * shows only its own user everything. Members configured with the chat have
 * no join event and count as present from the start.
 *
 * Deleted messages, other members' ephemeral messages and events are never
 * shown. Returns `{ items, as }`, `as` being the page's description of the
 * member.
 */
export function visibleTo(items, member, chat) {
  let inChat = viewInChat(member);
  let access;
  let hidden = false;
  let windows = null;
  if (chat.type === "private") {
    inChat = chat.user_id === member.user_id;
    access = inChat ? "all" : "none";
  } else if (chat.type === "group") {
    windows = viewWindows(items, member, inChat);
    access = windows.length ? "while_member" : "none";
  } else if (inChat) {
    access = "all";
    hidden = chat.type === "supergroup" && !chat.is_forum;
  } else {
    access = "none";
  }
  const shown =
    access === "none"
      ? []
      : items.filter(
          (item) =>
            item.kind === "message" &&
            !item.deleted &&
            (!item.ephemeral ||
              item.message.receiver_user?.id === member.user_id) &&
            (windows === null ||
              windows.some(
                ([open, close]) => item.seq > open && item.seq < close,
              )),
        );
  return {
    items: shown,
    as: {
      user_id: member.user_id,
      status: member.status,
      in_chat: inChat,
      access,
      history_may_be_hidden: hidden,
    },
  };
}

/** Whether a member state (a ChatMember without user) is in the chat. */
function viewInChat(member) {
  return (
    ["member", "administrator", "creator"].includes(member?.status) ||
    (member?.status === "restricted" && member.is_member !== false)
  );
}

/**
 * The seq ranges, both ends excluded, in which a member was in a basic group,
 * from their member events. A removal by a call that revoked their messages
 * takes everything before it away.
 */
function viewWindows(items, member, inChat) {
  const changes = items.filter(
    (item) =>
      item.kind === "event" &&
      item.type === "member" &&
      item.user_id === member.user_id,
  );
  let inside = changes.length ? viewInChat(changes[0].old) : inChat;
  let open = -Infinity;
  const windows = [];
  for (const change of changes) {
    const now = viewInChat(change.new);
    if (!inside && now) open = change.seq;
    if (inside && !now) {
      windows.push([open, change.seq]);
      if ((member.revoked_by ?? []).includes(change.request_id)) {
        windows.length = 0;
      }
    }
    inside = now;
  }
  if (inside) windows.push([open, Infinity]);
  return windows;
}

/**
 * The request ids of the banChatMember calls with revoke_messages that
 * removed the user from the chat, from call receipts or recorded calls
 * (`{ method, params, request_id }`).
 */
export function revokedBy(calls, chatId, userId) {
  return calls
    .filter(
      (call) =>
        String(call.method).toLowerCase() === "banchatmember" &&
        String(call.params?.chat_id) === String(chatId) &&
        String(call.params?.user_id) === String(userId) &&
        ["true", "yes", "1"].includes(
          String(call.params?.revoke_messages).trim().toLowerCase(),
        ),
    )
    .map((call) => call.request_id);
}

/**
 * Whether an item belongs to a forum topic: its message_thread_id, or
 * "general" for messages in no topic and for events. No topic: every item.
 */
export function inTopic(item, topic) {
  if (topic == null) return true;
  const thread =
    item.kind === "message" && item.message.is_topic_message
      ? item.message.message_thread_id
      : null;
  return topic === "general" ? thread == null : thread === Number(topic);
}

/**
 * The calls a chat's page shows, from the chat's calls (each with its
 * request_number): those that fall among the page's items in a merged stream
 * (render.js mergeStream) — numbered above the after_request of the item just
 * older than the page (from the first call when there is none), and up to the
 * page's newest item's after_request, or every newer call when the page holds
 * the chat's newest item. An empty chat shows every call. With `callsBefore`,
 * the calls numbered below it instead, whatever the page.
 *
 * `items` is the list `page` (a pageWindow) was cut from. At most `limit`
 * calls, the newest: `calls_truncated` then says older ones were left out,
 * and `calls_oldest_request` is the oldest number sent, for the next
 * `callsBefore`.
 */
export function callWindow(
  items,
  calls,
  page,
  { callsBefore = null, limit = 1000 } = {},
) {
  let after = -Infinity;
  let upTo = Infinity;
  if (callsBefore != null) {
    upTo = callsBefore - 1;
  } else if (page.items.length) {
    const first = viewFirstFrom(items, page.items[0].seq);
    const last = page.items[page.items.length - 1];
    if (first > 0) after = items[first - 1].after_request;
    if (viewFirstFrom(items, last.seq) < items.length - 1) {
      upTo = last.after_request;
    }
  } else if (items.length) {
    return { calls: [], calls_truncated: false, calls_oldest_request: null };
  }
  const inside = calls
    .filter(
      (call) => call.request_number > after && call.request_number <= upTo,
    )
    .sort((left, right) => left.request_number - right.request_number);
  const kept = inside.slice(Math.max(0, inside.length - limit));
  const truncated = kept.length < inside.length;
  return {
    calls: kept,
    calls_truncated: truncated,
    calls_oldest_request: truncated ? kept[0].request_number : null,
  };
}
