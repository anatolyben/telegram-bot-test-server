// Windows and filters over a chat's items, the same for the server, the page
// and recordings. No DOM and no Node APIs.

/**
 * A page of items (oldest first, by seq): the newest `limit`, the newest
 * `limit` older than `before`, or exactly `from`…`to` (at most 1000, the
 * newest when more).
 */
export function pageWindow(
  items,
  { limit = 200, before = null, from = null, to = null } = {},
) {
  const sorted = [...items].sort((a, b) => a.seq - b.seq);
  let candidates = sorted;
  let count = limit;
  if (from != null) {
    candidates = sorted.filter(
      (item) => item.seq >= from && (to == null || item.seq <= to),
    );
    count = 1000;
  } else if (before != null) {
    candidates = sorted.filter((item) => item.seq < before);
  }
  const window = candidates.slice(-count);
  const first = window[0]?.seq ?? null;
  return {
    items: window,
    has_older: first != null && sorted[0].seq < first,
    oldest_seq: first,
    latest_seq: sorted.at(-1)?.seq ?? null,
  };
}

/** Whether an item belongs to a forum topic (a message_thread_id) or the General topic. */
export function inTopic(item, topic) {
  if (topic == null) return true;
  if (item.kind !== "message") return true;
  const thread = item.message?.is_topic_message
    ? item.message.message_thread_id
    : null;
  return topic === "general"
    ? thread == null
    : Number(thread) === Number(topic);
}

/**
 * What a member sees: no deleted messages, no other member's
 * ephemeral messages, no events or calls.
 */
export function visibleTo(items, member, chat) {
  const userId = Number(member?.user_id);
  return items.filter(
    (item) =>
      item.kind === "message" &&
      !item.deleted &&
      (!item.ephemeral || Number(item.message?.receiver_user?.id) === userId),
  );
}

/** The calls of a page's window (calls are not drawn yet). */
export function callWindow(calls) {
  return [];
}
