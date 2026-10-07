// The viewer's renderer: the viewer JSON (GET /_fake/ui/api/…, or a
// recording's twin) in, HTML strings out. Pure: no DOM and no Node APIs, so
// vitest imports it and a recording inlines it. Every user-controlled string
// goes through escapeHtml, in text and in attributes alike.

export const PANELS = Object.freeze([
  "list",
  "chat",
  "calls",
  "events",
  "members",
]);
export const LAYOUTS = Object.freeze(["combined", "split"]);
export const MAX_CHATS = 4;

const HTML_ESCAPES = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Text for an HTML text node or a quoted attribute value. */
export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]);
}

export const escapeAttr = escapeHtml;

// ── View state in the URL ──────────────────────────────────────────────

const PANEL_NAMES = new Set(PANELS);
const REF_PATTERN = /^(?:-?\d{1,20}|\d{1,20}:\d{1,20}|calls|all)$/;
const METHOD_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

function listParam(value) {
  return String(value ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function positiveInteger(value) {
  const text = String(value ?? "").trim();
  if (!/^\d{1,16}$/.test(text)) return null;
  const number = Number(text);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

/**
 * The view a /_fake/ui URL asks for. Unknown names and invalid values fall
 * back to the default; `chats` is empty when the URL names no chat (the page
 * then resolves the most recent one, once).
 */
export function parseView(search) {
  const params = new URLSearchParams(String(search ?? ""));
  const refs = (value) => [
    ...new Set(listParam(value).filter((ref) => REF_PATTERN.test(ref))),
  ];
  let chats = params.has("chats")
    ? refs(params.get("chats")).slice(0, MAX_CHATS)
    : [];
  if (!chats.length) chats = refs(params.get("chat")).slice(0, 1);
  const shown = new Set(
    listParam(params.get("show")).filter((panel) => PANEL_NAMES.has(panel)),
  );
  // Opened without a chat, or on "all", the page is the one feed of every
  // chat with its calls and events; the chat list and members stay off.
  const show = shown.size
    ? PANELS.filter((panel) => shown.has(panel))
    : !chats.length || chats[0] === "all"
      ? ["chat", "calls", "events"]
      : [...PANELS];
  const layout = LAYOUTS.includes(params.get("layout"))
    ? params.get("layout")
    : "combined";
  const bots = [
    ...new Set(
      listParam(params.get("bots")).map(positiveInteger).filter(Boolean),
    ),
  ];
  const methods = [
    ...new Set(
      listParam(params.get("methods")).filter((name) =>
        METHOD_PATTERN.test(name),
      ),
    ),
  ];
  const topicParam = params.get("topic");
  const topic =
    topicParam === "general" ? "general" : positiveInteger(topicParam);
  const theme = ["light", "dark"].includes(params.get("theme"))
    ? params.get("theme")
    : null;
  return {
    chats,
    show,
    layout,
    as: positiveInteger(params.get("as")),
    bots: bots.length ? bots : null,
    methods: methods.length ? methods : null,
    topic,
    theme,
  };
}

function searchValue(value) {
  return encodeURIComponent(String(value))
    .replace(/%2C/gi, ",")
    .replace(/%3A/gi, ":");
}

/** The query string for a view: the chat always, everything else only when it is not the default. */
export function viewToSearch(view) {
  const parts = [];
  const chats = view.chats ?? [];
  if (chats.length > 1) parts.push(`chats=${chats.map(searchValue).join(",")}`);
  else parts.push(`chat=${searchValue(chats[0] ?? "")}`);
  const show = PANELS.filter((panel) => (view.show ?? PANELS).includes(panel));
  if (show.length && show.length !== PANELS.length)
    parts.push(`show=${show.join(",")}`);
  if (view.layout === "split") parts.push("layout=split");
  if (view.as != null) parts.push(`as=${searchValue(view.as)}`);
  if (view.bots?.length)
    parts.push(`bots=${view.bots.map(searchValue).join(",")}`);
  if (view.methods?.length)
    parts.push(`methods=${view.methods.map(searchValue).join(",")}`);
  if (view.topic != null) parts.push(`topic=${searchValue(view.topic)}`);
  if (view.theme) parts.push(`theme=${searchValue(view.theme)}`);
  return `?${parts.join("&")}`;
}

/** The chat a URL without one opens: the most recently active, never the calls row. */
export function defaultChat(state) {
  const chats = state?.chats ?? [];
  if (chats.some((chat) => chat.type === "all")) return "all";
  return chats.find((chat) => chat.type !== "calls")?.key ?? null;
}

/**
 * The columns a view shows, in order: `list`, then for each chat its `chat`,
 * `calls` and `events` (their own columns in split, or when the chat panel is
 * hidden; inline otherwise) and `members`. View-as hides calls, events and
 * members. The calls row's only column is its call timeline.
 */
export function columnsFor(view) {
  const show = new Set(view.show ?? PANELS);
  const viewAs = view.as != null;
  const columns = [];
  if (show.has("list")) columns.push({ id: "list", panel: "list", ref: null });
  for (const ref of view.chats ?? []) {
    if (ref === "calls") {
      if (!viewAs && (show.has("calls") || show.has("chat")))
        columns.push({ id: "calls:calls", panel: "calls", ref });
      continue;
    }
    if (show.has("chat"))
      columns.push({ id: `chat:${ref}`, panel: "chat", ref });
    const ownColumns = view.layout === "split" || !show.has("chat");
    for (const panel of ["calls", "events"])
      if (!viewAs && ownColumns && show.has(panel))
        columns.push({ id: `${panel}:${ref}`, panel, ref });
    if (!viewAs && show.has("members") && ref !== "all")
      columns.push({ id: `members:${ref}`, panel: "members", ref });
  }
  return columns;
}

// ── Small helpers ──────────────────────────────────────────────────────

/** The identity colour slot (1-8) of an id, as classes tv-id-1 … tv-id-8. */
export function identitySlot(id) {
  let hash = 0;
  for (const char of String(id ?? ""))
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return (hash % 8) + 1;
}

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];
const pad2 = (number) => String(number).padStart(2, "0");

/** HH:MM in UTC, so a live view and a recording opened elsewhere read the same. */
export function clockTime(ms) {
  const date = new Date(Number(ms));
  if (Number.isNaN(date.getTime())) return "";
  return `${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())}`;
}

function isoTime(ms) {
  const date = new Date(Number(ms));
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function dayKey(ms) {
  return isoTime(ms).slice(0, 10);
}

function dayLabel(ms) {
  const date = new Date(Number(ms));
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

/** A date for "until …": day, month, year and UTC time. */
function untilText(seconds) {
  const ms = Number(seconds) * 1000;
  return `${dayLabel(ms)} ${clockTime(ms)} UTC`;
}

function timeTag(ms, extra = "") {
  return `<time class="tv-time" datetime="${escapeAttr(isoTime(ms))}" title="${escapeAttr(isoTime(ms))}">${extra}${escapeHtml(clockTime(ms))}</time>`;
}

function attrs(map) {
  let out = "";
  for (const [name, value] of Object.entries(map)) {
    if (value == null || value === false) continue;
    out += ` ${name}="${escapeAttr(value === true ? "true" : value)}"`;
  }
  return out;
}

/** An element: its name, escaped attributes (null and false left out) and inner HTML. */
function el(name, attributes, ...children) {
  return `<${name}${attrs(attributes ?? {})}>${children.join("")}</${name}>`;
}

function formatBytes(size) {
  const bytes = Number(size);
  if (!Number.isFinite(bytes) || bytes < 0) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  return hours
    ? `${hours}:${pad2(minutes)}:${pad2(total % 60)}`
    : `${minutes}:${pad2(total % 60)}`;
}

function oneLine(text, max = 80) {
  const flat = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  const chars = Array.from(flat);
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : flat;
}

function rightName(key) {
  return key.replace(/^can_/, "").replace(/_/g, " ");
}

// ── People ─────────────────────────────────────────────────────────────

/**
 * What a renderer needs besides the item: bots by id, users, image files,
 * the first bot, the chat, and the member the page is viewed as (or null).
 * `tags: false` leaves the bot tags out of names, for one-line previews.
 */
export function makeContext(page, options = {}) {
  const bots = new Map();
  for (const bot of page?.bots ?? []) bots.set(Number(bot.id), bot);
  const first = (page?.bots ?? []).find((bot) => bot.first);
  return {
    bots,
    users: page?.users ?? {},
    files: page?.files ?? {},
    firstBotId: first ? Number(first.id) : null,
    chat: page?.chat ?? null,
    key: String(options.key ?? page?.chat?.key ?? ""),
    as: options.as ?? page?.as?.user_id ?? null,
    asInfo: page?.as ?? null,
    links: options.links ?? new Map(),
    tags: options.tags !== false,
  };
}

function userOf(ctx, id) {
  if (id == null) return null;
  return ctx.users[String(id)] ?? ctx.bots.get(Number(id)) ?? null;
}

function nameOf(user) {
  if (!user) return "";
  const name = [user.first_name, user.last_name]
    .filter(Boolean)
    .join(" ")
    .trim();
  if (name) return name;
  if (user.title) return user.title;
  return user.username ? `@${user.username}` : `User ${user.id}`;
}

/** A person's display name: first and last name, else @username, else the id. */
export function personName(ctx, id) {
  if (id == null) return "someone";
  const user = userOf(ctx, id);
  return user ? nameOf(user) : `User ${id}`;
}

/** How a bot is labeled: the first bot, an added or deleted bot, or any other bot user. */
function botTag(ctx, user) {
  if (!user) return null;
  const bot = ctx.bots.get(Number(user.id));
  // With one bot there is nothing to tell apart.
  if (bot && bot.first && ctx.bots.size === 1) return null;
  if (bot)
    return bot.first ? "first bot" : bot.deleted ? "deleted bot" : "added bot";
  return user.is_bot ? "bot" : null;
}

/** A name, then `suffix` (such as "'s"), then the bot's tag, as HTML. */
function nameWithTag(ctx, id, suffix = "") {
  const name = `${escapeHtml(personName(ctx, id))}${suffix}`;
  const tag = ctx.tags ? botTag(ctx, userOf(ctx, id)) : null;
  return tag ? `${name} <span class="tv-tag">${escapeHtml(tag)}</span>` : name;
}

/** A user a message carries, named as the page knows them, else by the message's own copy. */
function messageUserName(ctx, user) {
  return userOf(ctx, user?.id)
    ? nameWithTag(ctx, user.id)
    : escapeHtml(nameOf(user) || "someone");
}

function avatar(id, name, ctx, { size = "", photoId = null } = {}) {
  const initial =
    Array.from(String(name ?? "").trim())[0]?.toUpperCase() || "?";
  const image = photoId ? imageTag(ctx, photoId, "tv-avatar-image") : "";
  return `<span class="tv-avatar${size} tv-id-${identitySlot(id)}" aria-hidden="true">${escapeHtml(initial)}${image}</span>`;
}

// ── Text and entities ──────────────────────────────────────────────────

const LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:", "tg:"]);

/** The URL as a safe href, or null: only http, https, mailto and tg links open. */
export function safeHref(url) {
  const text = String(url ?? "").trim();
  if (!text || /[\u0000-\u001f\u007f]/.test(text)) return null;
  try {
    return LINK_PROTOCOLS.has(new URL(text).protocol) ? text : null;
  } catch {
    return null;
  }
}

function linkOpen(url, className) {
  const href = safeHref(url);
  if (!href)
    return {
      open: `<span class="${className} tv-link-blocked" title="${escapeAttr(url)}">`,
      close: "</span>",
    };
  return {
    open: `<a class="${className}" href="${escapeAttr(href)}" target="_blank" rel="noopener noreferrer" title="${escapeAttr(url)}">`,
    close: "</a>",
  };
}

function entityTags(entity, covered) {
  switch (entity.type) {
    case "bold":
      return { open: "<strong>", close: "</strong>" };
    case "italic":
      return { open: "<em>", close: "</em>" };
    case "underline":
      return { open: "<u>", close: "</u>" };
    case "strikethrough":
      return { open: "<s>", close: "</s>" };
    case "spoiler":
      return {
        open: '<span class="tv-spoiler" title="spoiler">',
        close: "</span>",
      };
    case "code":
      return { open: '<code class="tv-code">', close: "</code>" };
    case "pre":
      return {
        open: `<pre class="tv-pre">${entity.language ? `<span class="tv-pre-language">${escapeHtml(entity.language)}</span>` : ""}<code>`,
        close: "</code></pre>",
      };
    case "blockquote":
      return {
        open: '<blockquote class="tv-blockquote">',
        close: "</blockquote>",
      };
    case "expandable_blockquote":
      return {
        open: '<blockquote class="tv-blockquote" data-expandable="true">',
        close: "</blockquote>",
      };
    case "text_link":
      return linkOpen(entity.url, "tv-link");
    case "url":
      return linkOpen(
        /^[a-z][a-z0-9+.-]*:/i.test(covered) ? covered : `http://${covered}`,
        "tv-link",
      );
    case "email":
      return linkOpen(`mailto:${covered}`, "tv-link");
    case "mention":
    case "hashtag":
    case "cashtag":
    case "bot_command":
    case "phone_number":
    case "bank_card_number":
      return {
        open: `<span class="tv-entity" data-entity="${escapeAttr(entity.type)}">`,
        close: "</span>",
      };
    case "text_mention":
      return {
        open: `<span class="tv-entity" data-entity="text_mention" title="${escapeAttr(`${nameOf(entity.user) || "someone"} · user ${entity.user?.id ?? ""}`)}">`,
        close: "</span>",
      };
    case "custom_emoji":
      return {
        open: `<span class="tv-custom-emoji" title="${escapeAttr(`custom emoji ${entity.custom_emoji_id ?? ""}`)}">`,
        close: "</span>",
      };
    case "date_time": {
      const when =
        entity.unix_time != null
          ? isoTime(Number(entity.unix_time) * 1000)
          : "";
      return {
        open: `<span class="tv-entity" data-entity="date_time" title="${escapeAttr(when)}">`,
        close: "</span>",
      };
    }
    default:
      return { open: "", close: "" };
  }
}

/**
 * Text with its entities, by UTF-16 offset (JavaScript string indices are
 * UTF-16, as Telegram's offsets are). Entities nest when one lies inside
 * another; a partial overlap is cut at the outer entity's end.
 */
export function renderText(text, entities = []) {
  const source = String(text ?? "");
  const list = (Array.isArray(entities) ? entities : [])
    .filter(
      (entity) =>
        Number.isInteger(entity?.offset) &&
        Number.isInteger(entity?.length) &&
        entity.length > 0,
    )
    .map((entity, index) => ({
      entity,
      index,
      start: Math.max(0, entity.offset),
      end: Math.min(source.length, entity.offset + entity.length),
    }))
    .filter((span) => span.end > span.start)
    .sort((a, b) => a.start - b.start || b.end - a.end || a.index - b.index);
  let out = "";
  let position = 0;
  const stack = [];
  const emit = (to) => {
    if (to > position) out += escapeHtml(source.slice(position, to));
    position = Math.max(position, to);
  };
  const closeTop = () => {
    const span = stack.pop();
    emit(span.end);
    out += span.close;
  };
  for (const span of list) {
    while (stack.length && stack.at(-1).end <= span.start) closeTop();
    if (span.start < position) continue;
    const end = stack.length ? Math.min(span.end, stack.at(-1).end) : span.end;
    if (end <= span.start) continue;
    const tags = entityTags(span.entity, source.slice(span.start, end));
    emit(span.start);
    out += tags.open;
    stack.push({ end, close: tags.close });
  }
  while (stack.length) closeTop();
  emit(source.length);
  return out;
}

// ── Media ──────────────────────────────────────────────────────────────

const IMAGE_URL =
  /^(?:\/_fake\/ui\/files\/[A-Za-z0-9_-]+|data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+)$/;

function imageTag(ctx, fileId, className, alt = "") {
  const file = fileId ? ctx.files[fileId] : null;
  if (!file || !IMAGE_URL.test(String(file.url))) return "";
  return `<img class="${className}" src="${escapeAttr(file.url)}" alt="${escapeAttr(alt)}"${attrs({ width: file.width, height: file.height })} loading="lazy" decoding="async">`;
}

function lastPhoto(sizes) {
  if (Array.isArray(sizes)) return sizes.at(-1) ?? null;
  return sizes?.file_id ? sizes : null;
}

const CONTENT_KINDS = [
  ["live_photo", "Live photo"],
  ["photo", "Photo"],
  ["animation", "GIF"],
  ["video", "Video"],
  ["video_note", "Video message"],
  ["audio", "Audio"],
  ["voice", "Voice message"],
  ["document", "File"],
  ["sticker", "Sticker"],
  ["story", "Story"],
  ["paid_media", "Paid media"],
  ["venue", "Venue"],
  ["location", "Location"],
  ["contact", "Contact"],
  ["dice", "Dice"],
  ["poll", "Poll"],
  ["checklist", "Checklist"],
  ["game", "Game"],
  ["invoice", "Invoice"],
];

/** The message's content key (photo, video, poll …), or null for text and service messages. */
export function contentKind(message) {
  return CONTENT_KINDS.find(([key]) => message?.[key] != null)?.[0] ?? null;
}

function contentLabel(message) {
  const kind = contentKind(message);
  return kind ? CONTENT_KINDS.find(([key]) => key === kind)[1] : null;
}

const FILE_GLYPHS = {
  photo: "▣",
  live_photo: "▣",
  animation: "▶",
  video: "▶",
  video_note: "◉",
  audio: "♪",
  voice: "♪",
  document: "▤",
  sticker: "☺",
  story: "◌",
  paid_media: "★",
};

function placeholder(kind, label, file = {}, extra = []) {
  const meta = [
    file.mime_type,
    file.width && file.height ? `${file.width}×${file.height}` : null,
    file.duration != null ? formatDuration(file.duration) : null,
    formatBytes(file.file_size),
    ...extra,
  ].filter(Boolean);
  return el(
    "div",
    { class: "tv-file", "data-media": kind },
    el(
      "span",
      { class: "tv-file-icon", "aria-hidden": "true" },
      FILE_GLYPHS[kind] ?? "▤",
    ),
    el(
      "span",
      { class: "tv-file-copy" },
      el("span", { class: "tv-file-kind" }, escapeHtml(label)),
      file.file_name
        ? el("span", { class: "tv-file-name" }, escapeHtml(file.file_name))
        : "",
      meta.length
        ? el("span", { class: "tv-file-meta" }, escapeHtml(meta.join(" · ")))
        : "",
    ),
  );
}

function box(kind, title, rows) {
  const lines = rows
    .filter(([, value]) => value != null && value !== "")
    .map(
      ([label, value]) =>
        `<span class="tv-box-label">${escapeHtml(label)}</span><span class="tv-box-value">${escapeHtml(value)}</span>`,
    )
    .join("");
  return `<div class="tv-box" data-media="${escapeAttr(kind)}"><span class="tv-box-title">${escapeHtml(title)}</span>${lines ? `<span class="tv-box-grid">${lines}</span>` : ""}</div>`;
}

/** A live location's period in words: "15 min", "1 h 30 min". */
function periodText(seconds) {
  const minutes = Math.round(Number(seconds) / 60);
  const hours = Math.floor(minutes / 60);
  return [hours ? `${hours} h` : "", minutes % 60 ? `${minutes % 60} min` : ""]
    .filter(Boolean)
    .join(" ");
}

/**
 * A location as a card: its point, the accuracy, and for a live one how
 * long it is shared (0x7FFFFFFF is until the sender stops it), when that
 * ends, its heading and the proximity alert radius. No map is drawn.
 */
function locationCard(location, date) {
  const live = Number(location.live_period) > 0;
  const forever = Number(location.live_period) === 0x7fffffff;
  const ends =
    live && !forever && date != null
      ? `, until ${clockTime((Number(date) + Number(location.live_period)) * 1000)}`
      : "";
  const meta = [
    location.horizontal_accuracy != null
      ? `± ${location.horizontal_accuracy} m`
      : null,
    live
      ? forever
        ? "live until stopped"
        : `live for ${periodText(location.live_period)}${ends}`
      : null,
    location.heading != null ? `heading ${location.heading}°` : null,
    location.proximity_alert_radius != null
      ? `alerts within ${location.proximity_alert_radius} m`
      : null,
  ].filter(Boolean);
  return el(
    "div",
    {
      class: "tv-file tv-location",
      "data-media": "location",
      "data-live": live,
    },
    el("span", { class: "tv-file-icon", "aria-hidden": "true" }, "⌖"),
    el(
      "span",
      { class: "tv-file-copy" },
      el(
        "span",
        { class: "tv-file-kind" },
        live ? "Live location" : "Location",
      ),
      el(
        "span",
        { class: "tv-location-point" },
        escapeHtml(`${location.latitude}, ${location.longitude}`),
      ),
      meta.length
        ? el(
            "span",
            { class: "tv-file-meta tv-location-meta" },
            meta.map((part) => el("span", {}, escapeHtml(part))).join(" · "),
          )
        : "",
    ),
  );
}

/** A contact as a card: the initial, the name, the phone and the account it names. */
function contactCard(contact, ctx) {
  const name = [contact.first_name, contact.last_name]
    .filter(Boolean)
    .join(" ");
  return el(
    "div",
    { class: "tv-file tv-contact", "data-media": "contact" },
    avatar(contact.user_id ?? contact.phone_number, name, ctx, {
      size: " tv-avatar--card",
    }),
    el(
      "span",
      { class: "tv-file-copy" },
      el("strong", { class: "tv-contact-name" }, escapeHtml(name)),
      el(
        "span",
        { class: "tv-contact-phone" },
        escapeHtml(contact.phone_number),
      ),
      contact.user_id != null
        ? el(
            "span",
            { class: "tv-file-meta" },
            escapeHtml(`user ${contact.user_id}`),
          )
        : "",
    ),
  );
}

function photoBlock(ctx, photo, label, kind) {
  const image = imageTag(ctx, photo?.file_id, "tv-photo", label);
  if (image)
    return `<div class="tv-media" data-media="${escapeAttr(kind)}">${image}</div>`;
  return placeholder(kind, label, photo ?? {});
}

function renderPoll(poll, item, ctx) {
  const viewer = ctx.as;
  const mine = viewer != null ? (item.votes?.[String(viewer)] ?? null) : null;
  const reveal = viewer == null || poll.is_closed === true || mine != null;
  const quiz = poll.type === "quiz";
  const correct = new Set(
    poll.correct_option_ids ??
      (poll.correct_option_id != null ? [poll.correct_option_id] : []),
  );
  const voters = new Map();
  if (viewer == null)
    for (const [userId, options] of Object.entries(item.votes ?? {}))
      for (const option of options ?? []) {
        if (!voters.has(option)) voters.set(option, []);
        voters.get(option).push(personName(ctx, userId));
      }
  const total = Number(poll.total_voter_count) || 0;
  const flags = [
    quiz ? "Quiz" : "Poll",
    poll.is_anonymous === false ? "public" : "anonymous",
    poll.allows_multiple_answers ? "multiple answers" : null,
    poll.is_closed ? "closed" : null,
  ].filter(Boolean);
  const image = poll.media
    ? imageTag(ctx, lastPhoto(poll.media.photo)?.file_id, "tv-photo")
    : "";
  const options = (poll.options ?? [])
    .map((option, index) => {
      const count = Number(option.voter_count) || 0;
      const isMine = mine?.includes(index) ?? false;
      const isCorrect = quiz && reveal && correct.has(index);
      const who = voters.get(index);
      const share = total ? ` · ${Math.round((count / total) * 100)}%` : "";
      return el(
        "li",
        {
          class: "tv-poll-option",
          "data-option": index,
          "data-mine": isMine,
          "data-correct": isCorrect,
        },
        el(
          "span",
          { class: "tv-poll-text" },
          escapeHtml(option.text),
          isCorrect ? ' <span class="tv-poll-mark">✓ correct</span>' : "",
          isMine ? ' <span class="tv-poll-mark">your vote</span>' : "",
        ),
        reveal
          ? el("span", { class: "tv-poll-count" }, `${count}${share}`)
          : "",
        who?.length
          ? el("span", { class: "tv-poll-voters" }, escapeHtml(who.join(", ")))
          : "",
      );
    })
    .join("");
  const footer = reveal
    ? `${total} ${total === 1 ? "vote" : "votes"}`
    : "Vote to see the results";
  const explanation =
    quiz && reveal && poll.explanation
      ? `<div class="tv-poll-explanation">${renderText(poll.explanation, poll.explanation_entities)}</div>`
      : "";
  return el(
    "div",
    { class: "tv-box tv-poll", "data-media": "poll" },
    image,
    el("span", { class: "tv-box-eyebrow" }, escapeHtml(flags.join(" · "))),
    el(
      "span",
      { class: "tv-poll-question" },
      renderText(poll.question, poll.question_entities),
    ),
    el("ol", { class: "tv-poll-options" }, options),
    explanation,
    el("span", { class: "tv-poll-footer" }, escapeHtml(footer)),
  );
}

function renderMedia(message, item, ctx) {
  const m = message;
  if (m.live_photo)
    return photoBlock(
      ctx,
      lastPhoto(m.live_photo.photo ?? m.photo),
      "Live photo",
      "live_photo",
    );
  if (m.photo) return photoBlock(ctx, lastPhoto(m.photo), "Photo", "photo");
  if (m.sticker) {
    const image = imageTag(
      ctx,
      m.sticker.file_id,
      "tv-sticker",
      m.sticker.emoji ?? "sticker",
    );
    if (image)
      return `<div class="tv-media" data-media="sticker">${image}</div>`;
    const kind = m.sticker.is_video
      ? "video sticker"
      : m.sticker.is_animated
        ? "animated sticker"
        : null;
    return placeholder(
      "sticker",
      `Sticker${m.sticker.emoji ? ` ${m.sticker.emoji}` : ""}`,
      m.sticker,
      [kind, m.sticker.set_name],
    );
  }
  for (const [key, label] of [
    ["animation", "GIF"],
    ["video", "Video"],
    ["video_note", "Video message"],
    ["audio", "Audio"],
    ["voice", "Voice message"],
    ["document", "File"],
  ])
    if (m[key]) {
      const file = m[key];
      const extra = key === "audio" ? [file.performer, file.title] : [];
      return placeholder(
        key,
        label,
        key === "video_note"
          ? { ...file, width: file.length, height: file.length }
          : file,
        extra,
      );
    }
  if (m.story)
    return placeholder("story", "Story", {}, [
      m.story.chat?.title,
      m.story.id != null ? `story ${m.story.id}` : null,
    ]);
  if (m.paid_media)
    return placeholder("paid_media", "Paid media", {}, [
      m.paid_media.star_count != null
        ? `${m.paid_media.star_count} stars`
        : null,
    ]);
  if (m.venue)
    return box("venue", "Venue", [
      ["Title", m.venue.title],
      ["Address", m.venue.address],
      [
        "Location",
        m.venue.location
          ? `${m.venue.location.latitude}, ${m.venue.location.longitude}`
          : null,
      ],
    ]);
  if (m.location) return locationCard(m.location, m.date);
  if (m.contact) return contactCard(m.contact, ctx);
  if (m.dice)
    return box("dice", `Dice ${m.dice.emoji ?? ""}`.trim(), [
      ["Value", m.dice.value],
    ]);
  if (m.poll) return renderPoll(m.poll, item, ctx);
  if (m.checklist)
    return box("checklist", "Checklist", [
      ["Title", m.checklist.title],
      ["Tasks", (m.checklist.tasks ?? []).map((task) => task.text).join(", ")],
    ]);
  if (m.game) return box("game", "Game", [["Title", m.game.title]]);
  if (m.invoice)
    return box("invoice", "Invoice", [
      ["Title", m.invoice.title],
      [
        "Amount",
        m.invoice.total_amount != null
          ? `${m.invoice.total_amount} ${m.invoice.currency ?? ""}`
          : null,
      ],
    ]);
  return "";
}

// ── Inline keyboards ───────────────────────────────────────────────────

const BUTTON_ACTIONS = [
  "url",
  "callback_data",
  "web_app",
  "login_url",
  "switch_inline_query",
  "switch_inline_query_current_chat",
  "switch_inline_query_chosen_chat",
  "copy_text",
  "callback_game",
  "pay",
];

function buttonTitle(button) {
  const action = BUTTON_ACTIONS.find((name) => button[name] !== undefined);
  if (!action) return "no action";
  const value = button[action];
  if (typeof value === "string") return `${action}: ${value}`;
  if (value && typeof value === "object") {
    const inner = value.url ?? value.text ?? value.query;
    return inner != null ? `${action}: ${inner}` : action;
  }
  return action;
}

function renderKeyboard(markup) {
  const rows = markup?.inline_keyboard;
  if (!Array.isArray(rows) || !rows.length) return "";
  const html = rows
    .map(
      (row, rowIndex) =>
        `<div class="tv-keyboard-row">${(row ?? [])
          .map(
            (button, colIndex) =>
              `<span class="tv-key" role="button" aria-disabled="true"${attrs({
                title: buttonTitle(button),
                "data-button-text": button.text ?? "",
                "data-button-data": button.callback_data,
                "data-button-url": button.url,
                "data-button-row": rowIndex,
                "data-button-col": colIndex,
              })}>${escapeHtml(button.text ?? "")}${button.url ? '<span class="tv-key-mark" aria-hidden="true">↗</span>' : ""}</span>`,
          )
          .join("")}</div>`,
    )
    .join("");
  return `<div class="tv-keyboard">${html}</div>`;
}

// ── Reactions ──────────────────────────────────────────────────────────

/**
 * A message's reactions, drawn under it: a chip per reaction, its emoji (a
 * custom emoji, whose image this server lacks, as a mark) and how many chose
 * it, in the order the server gives (state.js reactionsOf). In the test's
 * view a chip names who chose it on hover; seen as a member, it marks the
 * member's own (td_api messageReaction.is_chosen) and names nobody. `meta`
 * (the time) ends the row. A screen reader reads each chip as one image
 * named by the same: its emoji, how many, and who or "your reaction".
 */
function renderReactions(item, ctx, meta = "") {
  const reactions = Array.isArray(item.reactions) ? item.reactions : [];
  if (!reactions.length) return "";
  const chips = reactions
    .map((reaction) => {
      const ids = (reaction.user_ids ?? []).map(Number);
      const custom = reaction.type === "custom_emoji";
      const mine = ctx.as != null && ids.includes(Number(ctx.as));
      const count = String(Number(reaction.total_count) || 0);
      const what = custom
        ? `custom emoji ${reaction.custom_emoji_id ?? ""}`
        : String(reaction.emoji ?? "");
      const people =
        ctx.as == null ? ids.map((id) => personName(ctx, id)).join(", ") : "";
      const title = [
        custom ? what : null,
        people || (mine ? "your reaction" : null),
      ]
        .filter(Boolean)
        .join(" · ");
      const label = people
        ? `${what}, ${count}: ${people}`
        : `${what}, ${count}${mine ? ", your reaction" : ""}`;
      return el(
        "span",
        {
          class: "tv-reaction",
          "data-reaction-type": custom ? "custom_emoji" : "emoji",
          "data-reaction-emoji": custom ? null : String(reaction.emoji ?? ""),
          "data-custom-emoji-id": custom ? reaction.custom_emoji_id : null,
          "data-reaction-count": count,
          "data-reaction-user-ids": ctx.as == null ? ids.join(" ") : null,
          "data-reaction-mine": mine,
          title: title || null,
          role: "img",
          "aria-label": label,
        },
        custom
          ? '<span class="tv-reaction-emoji tv-reaction-custom" aria-hidden="true">☺</span>'
          : el(
              "span",
              { class: "tv-reaction-emoji" },
              escapeHtml(reaction.emoji),
            ),
        el("span", { class: "tv-reaction-count" }, count),
      );
    })
    .join("");
  return `<div class="tv-reactions">${chips}${meta}</div>`;
}

// ── Messages ───────────────────────────────────────────────────────────

const SERVICE_TYPES = [
  "new_chat_members",
  "left_chat_member",
  "pinned_message",
  "new_chat_title",
  "new_chat_photo",
  "delete_chat_photo",
  "migrate_to_chat_id",
  "migrate_from_chat_id",
  "forum_topic_created",
  "forum_topic_edited",
  "forum_topic_closed",
  "forum_topic_reopened",
  "group_chat_created",
  "supergroup_chat_created",
  "channel_chat_created",
];

/** The service type of a message (new_chat_members, pinned_message …), or null for a regular message. */
export function serviceType(message) {
  return (
    SERVICE_TYPES.find(
      (key) => message?.[key] != null && message[key] !== false,
    ) ?? null
  );
}

/** Who a message is from, for data-author-kind: user, first-bot, added-bot, guest-bot, bot or channel. */
export function authorKind(item, ctx) {
  const m = item.message ?? {};
  if (m.sender_chat || ctx.chat?.type === "channel") return "channel";
  if (m.guest_bot_caller_user) return "guest-bot";
  const bot = m.from ? ctx.bots.get(Number(m.from.id)) : null;
  if (bot) return bot.first ? "first-bot" : "added-bot";
  return m.from?.is_bot ? "bot" : "user";
}

function senderOf(message) {
  if (message?.sender_chat)
    return {
      id: message.sender_chat.id,
      name: message.sender_chat.title ?? "Chat",
    };
  if (message?.from) return { id: message.from.id, name: nameOf(message.from) };
  if (message?.chat?.type === "channel")
    return { id: message.chat.id, name: message.chat.title ?? "Channel" };
  return { id: null, name: "Unknown" };
}

function originName(origin) {
  if (!origin) return "";
  if (origin.type === "user") return nameOf(origin.sender_user);
  if (origin.type === "hidden_user")
    return origin.sender_user_name ?? "Hidden user";
  const chat = origin.type === "channel" ? origin.chat : origin.sender_chat;
  const title = chat?.title ?? (origin.type === "channel" ? "Channel" : "Chat");
  return origin.author_signature
    ? `${title} (${origin.author_signature})`
    : title;
}

function messageSummary(message) {
  const text = message?.text ?? message?.caption;
  if (text) return oneLine(text);
  return (
    contentLabel(message) ??
    (serviceType(message) ? "Service message" : "Message")
  );
}

function renderReply(item, ctx) {
  const m = item.message;
  const reply = m.reply_to_message;
  const external = m.external_reply;
  if (!reply && !external) return "";
  // A forum topic's messages reply to the topic's first message; Telegram draws no quote for it.
  if (
    reply &&
    m.is_topic_message &&
    Number(reply.message_id) === Number(m.message_thread_id) &&
    !m.quote
  )
    return "";
  const replyId = reply?.message_id ?? external?.message_id ?? null;
  if (item.reply_deleted && ctx.as != null)
    return `<blockquote class="tv-quote tv-quote--deleted"${attrs({ "data-reply-to": replyId })}><span class="tv-quote-author">Deleted message</span></blockquote>`;
  const author = reply
    ? senderOf(reply)
    : { id: null, name: originName(external.origin) };
  const quoted = m.quote?.text ?? null;
  const target = reply ?? external;
  const text = quoted ?? messageSummary(target);
  const thumb = imageTag(
    ctx,
    lastPhoto(target.photo)?.file_id,
    "tv-quote-thumb",
  );
  const flag = item.reply_deleted
    ? ' <span class="tv-quote-flag">deleted</span>'
    : "";
  const from =
    external && !reply
      ? '<span class="tv-quote-source">from another chat</span>'
      : "";
  return el(
    "blockquote",
    {
      class: `tv-quote tv-id-${identitySlot(author.id ?? author.name)}`,
      "data-reply-to": replyId,
    },
    thumb,
    el(
      "span",
      { class: "tv-quote-copy" },
      el("span", { class: "tv-quote-author" }, escapeHtml(author.name), flag),
      el("span", { class: "tv-quote-text" }, escapeHtml(oneLine(text, 120))),
      from,
    ),
  );
}

function messageAttrs(item, ctx, service) {
  const m = item.message ?? {};
  return attrs({
    "data-kind": "message",
    "data-chat-key": ctx.key,
    "data-chat-id": ctx.chat?.id ?? m.chat?.id,
    "data-seq": item.seq,
    "data-message-id": item.ephemeral ? null : m.message_id,
    "data-ephemeral-id": item.ephemeral ? m.ephemeral_message_id : null,
    "data-receiver-id": item.ephemeral ? m.receiver_user?.id : null,
    "data-author-id": item.author ?? m.from?.id ?? m.sender_chat?.id,
    "data-author-kind": authorKind(item, ctx),
    "data-deleted": item.deleted === true,
    "data-deleted-by": item.deleted ? item.deleted_by?.bot_id : null,
    "data-edited": m.edit_date != null,
    "data-edit-hidden": m.edit_date != null && item.edit_hidden === true,
    "data-service": service,
    "data-thread-id": m.message_thread_id,
    "data-reply-to":
      m.reply_to_message?.message_id ?? m.external_reply?.message_id,
    "data-reply-deleted": item.reply_deleted === true,
    "data-pinned-deleted": item.pinned_deleted === true,
    "data-request-id": item.request_id,
    "data-before-window": item.before_window === true,
  });
}

function actorName(message, ctx) {
  if (message.from)
    return (
      nameWithTag(ctx, message.from.id) || escapeHtml(nameOf(message.from))
    );
  if (message.sender_chat)
    return escapeHtml(message.sender_chat.title ?? "The channel");
  return "The chat";
}

function quoteText(text) {
  return `“${escapeHtml(oneLine(text, 60))}”`;
}

function linkDetails(event) {
  if (!event) return "";
  const parts = [];
  if (event.via_join_request) parts.push("by request");
  if (event.invite_link_name || event.invite_link)
    parts.push(
      `via ${event.invite_link_name ? quoteText(event.invite_link_name) : escapeHtml(event.invite_link)}`,
    );
  return parts.length
    ? ` <span class="tv-service-detail">· ${parts.join(" · ")}</span>`
    : "";
}

/**
 * A service message in words, as HTML. In a channel the message comes from
 * the channel itself (sender_chat), so the member it stores as its author is
 * who joined or left.
 */
function serviceText(item, ctx, type) {
  const m = item.message;
  const actor = actorName(m, ctx);
  const actorId =
    m.from?.id ?? (m.sender_chat && item.author != null ? item.author : null);
  const self = (user) =>
    user != null && actorId != null && Number(user.id) === Number(actorId);
  switch (type) {
    case "new_chat_members": {
      const members = m.new_chat_members ?? [];
      const linked = ctx.as == null ? linkDetails(ctx.links.get(item.seq)) : "";
      if (members.length === 1 && self(members[0]))
        return `${messageUserName(ctx, members[0])} joined${linked}`;
      return `${actor} added ${members.map((user) => messageUserName(ctx, user)).join(", ")}${linked}`;
    }
    case "left_chat_member": {
      const left = m.left_chat_member;
      if (self(left)) return `${messageUserName(ctx, left)} left`;
      return `${actor} removed ${messageUserName(ctx, left)}`;
    }
    case "pinned_message": {
      const pinned = m.pinned_message;
      if (item.pinned_deleted && ctx.as != null)
        return `${actor} pinned a deleted message`;
      const what =
        (pinned?.text ?? pinned?.caption)
          ? quoteText(pinned.text ?? pinned.caption)
          : escapeHtml((contentLabel(pinned) ?? "a message").toLowerCase());
      return `${actor} pinned ${what}${item.pinned_deleted ? ' <span class="tv-service-detail">· since deleted</span>' : ""}`;
    }
    case "new_chat_title":
      return `${actor} changed the title to ${quoteText(m.new_chat_title)}`;
    case "new_chat_photo":
      return `${actor} changed the photo`;
    case "delete_chat_photo":
      return `${actor} removed the photo`;
    case "migrate_to_chat_id":
      return `Moved to supergroup ${escapeHtml(m.migrate_to_chat_id)}`;
    case "migrate_from_chat_id":
      return `Upgraded from basic group ${escapeHtml(m.migrate_from_chat_id)}`;
    case "forum_topic_created":
      return `Topic ${quoteText(m.forum_topic_created.name)} created`;
    case "forum_topic_edited":
      return m.forum_topic_edited.name != null
        ? `Topic renamed to ${quoteText(m.forum_topic_edited.name)}`
        : "Topic icon changed";
    case "forum_topic_closed":
      return `${actor} closed the topic`;
    case "forum_topic_reopened":
      return `${actor} reopened the topic`;
    case "group_chat_created":
    case "supergroup_chat_created":
      return `${actor} created the group`;
    case "channel_chat_created":
      return "Channel created";
    default:
      return escapeHtml(type);
  }
}

function renderService(item, ctx, type) {
  const m = item.message;
  const photo =
    type === "new_chat_photo"
      ? imageTag(
          ctx,
          lastPhoto(m.new_chat_photo)?.file_id,
          "tv-service-photo",
          "new chat photo",
        )
      : "";
  const deleted = item.deleted && ctx.as == null ? deletedMark(item, ctx) : "";
  return `<div class="tv-service-row"${messageAttrs(item, ctx, type)}><span class="tv-service">${serviceText(item, ctx, type)}${photo}${deleted}<span class="tv-service-time">${timeTag(item.at ?? m.date * 1000)}</span></span>${renderReactions(item, ctx)}</div>`;
}

function deletedMark(item, ctx) {
  const by = item.deleted_by;
  const bot = by ? userOf(ctx, by.bot_id) : null;
  const name = bot?.username
    ? `@${bot.username}`
    : by
      ? personName(ctx, by.bot_id)
      : "a bot";
  const label =
    by && ctx.bots.get(Number(by.bot_id))?.deleted
      ? `${name} (deleted bot)`
      : name;
  const title = by ? `${by.method} at ${isoTime(by.at)}` : "deleted";
  return `<span class="tv-deleted" title="${escapeAttr(title)}">Deleted · ${escapeHtml(label)}</span>`;
}

function senderLine(item, ctx, kind) {
  const m = item.message;
  if (kind === "channel") {
    const chat =
      m.sender_chat ?? (ctx.chat?.type === "channel" ? ctx.chat : m.chat);
    const author =
      item.author != null &&
      Number(item.author) !== Number(chat?.id) &&
      ctx.as == null
        ? ` <span class="tv-sender-note">posted by ${escapeHtml(personName(ctx, item.author))}</span>`
        : "";
    // The signature sits at the line's end, where Telegram puts an admin's title.
    const rank = m.author_signature
      ? `<span class="tv-sender-rank">${escapeHtml(m.author_signature)}</span>`
      : "";
    return `<div class="tv-sender tv-id-${identitySlot(chat?.id)}">${rank}<span class="tv-sender-name">${escapeHtml(chat?.title ?? "Channel")}</span>${author}</div>`;
  }
  const from = m.from ?? {};
  const name = `<span class="tv-sender-name">${escapeHtml(nameOf(from))}</span>`;
  if (kind === "user")
    return `<div class="tv-sender tv-id-${identitySlot(from.id)}">${name}</div>`;
  const tag =
    kind === "guest-bot"
      ? "guest bot"
      : kind === "first-bot"
        ? botTag(ctx, from)
        : kind === "added-bot"
          ? (botTag(ctx, from) ?? "added bot")
          : "bot";
  const caller =
    kind === "guest-bot"
      ? ` <span class="tv-sender-note">for ${escapeHtml(nameOf(m.guest_bot_caller_user))}</span>`
      : "";
  return `<div class="tv-sender tv-id-${identitySlot(from.id)}">${name}${from.username ? ` <span class="tv-sender-note">@${escapeHtml(from.username)}</span>` : ""}${tag ? ` <span class="tv-tag">${tag}</span>` : ""}${caller}</div>`;
}

/**
 * One message: a service pill, or a bubble with its sender, forward, reply,
 * media, text, keyboard and markers. `position` says whether it continues a
 * group of the same author's messages (no repeated name or avatar).
 */
export function renderMessage(item, ctx, position = {}) {
  const m = item.message ?? {};
  if (item.deleted && ctx.as != null) return "";
  const service = serviceType(m);
  if (service) return renderService(item, ctx, service);
  const kind = authorKind(item, ctx);
  const sender =
    kind === "channel"
      ? senderOf(m.sender_chat ? m : { chat: ctx.chat ?? m.chat })
      : senderOf(m);
  const outgoing =
    ctx.as != null && Number(item.author) === Number(ctx.as) && kind === "user";
  const bot =
    kind === "first-bot" ||
    kind === "added-bot" ||
    kind === "guest-bot" ||
    kind === "bot";
  const classes = [
    "tv-msg",
    outgoing ? "tv-msg--out" : "",
    position.groupedWithPrevious ? "tv-msg--continued" : "",
    position.groupedWithNext ? "tv-msg--followed" : "",
  ].filter(Boolean);
  const avatarHtml = outgoing
    ? ""
    : position.groupedWithNext
      ? '<span class="tv-avatar-spacer" aria-hidden="true"></span>'
      : avatar(sender.id, sender.name, ctx);
  const receiver = m.receiver_user;
  // A recording keeps older messages its calls and replies name, as context.
  const context = item.before_window
    ? '<div class="tv-context-note">from before the recording</div>'
    : "";
  const ephemeral = item.ephemeral
    ? `<div class="tv-ephemeral" title="ephemeral message ${escapeAttr(m.ephemeral_message_id)}">◐ ${
        ctx.as != null && Number(receiver?.id) === Number(ctx.as)
          ? "only you see this"
          : `only <span class="tv-ephemeral-name">${escapeHtml(receiver ? nameOf(receiver) : "one member")}</span> sees this`
      }</div>`
    : "";
  const header =
    !position.groupedWithPrevious && !outgoing
      ? senderLine(item, ctx, kind)
      : "";
  const forward = m.forward_origin
    ? `<div class="tv-forward">Forwarded from <strong>${escapeHtml(originName(m.forward_origin))}</strong></div>`
    : "";
  const topic =
    ctx.chat?.is_forum && m.message_thread_id != null
      ? `<div class="tv-topic-label" data-topic-id="${escapeAttr(m.message_thread_id)}">${escapeHtml(topicName(ctx, m.message_thread_id))}</div>`
      : "";
  const media = renderMedia(m, item, ctx);
  const text = m.text ?? m.caption ?? null;
  const entities = m.text != null ? m.entities : m.caption_entities;
  // A bot's change of only the keyboard is not shown as an edit (edit_hidden).
  const meta = `<span class="tv-meta">${item.deleted ? deletedMark(item, ctx) : ""}${timeTag(item.at ?? m.date * 1000, m.edit_date != null && !item.edit_hidden ? '<span class="tv-edited">edited · </span>' : "")}</span>`;
  // Reactions sit under the text, with the time at the end of their row.
  const reactions = renderReactions(item, ctx, meta);
  const body = reactions
    ? `${text != null ? `<div class="tv-text">${renderText(text, entities)}</div>` : ""}${reactions}`
    : text != null
      ? `<div class="tv-text">${renderText(text, entities)}${meta}</div>`
      : `<div class="tv-meta-row">${meta}</div>`;
  const bubbleClass = [
    "tv-bubble",
    bot ? "tv-bubble--bot" : "",
    position.groupedWithNext ? "" : "tv-bubble--tail",
  ]
    .filter(Boolean)
    .join(" ");
  return `<div class="${classes.join(" ")}"${messageAttrs(item, ctx, null)}>${avatarHtml}<div class="tv-msg-body"><div class="${bubbleClass}">${context}${ephemeral}${header}${topic}${forward}${renderReply(item, ctx)}${media}${body}</div>${renderKeyboard(m.reply_markup)}</div></div>`;
}

function topicName(ctx, threadId) {
  const topic = (ctx.chat?.topics ?? []).find(
    (entry) => Number(entry.message_thread_id) === Number(threadId),
  );
  return topic ? topic.name : `topic ${threadId}`;
}

// ── Events ─────────────────────────────────────────────────────────────

const IN_CHAT = new Set(["creator", "administrator", "member"]);

/** The isInChat rule: in the chat, or restricted and still a member. */
export function memberInChat(member) {
  if (!member) return false;
  return (
    IN_CHAT.has(member.status) ||
    (member.status === "restricted" && member.is_member === true)
  );
}

function rightsList(member, value) {
  return Object.keys(member ?? {})
    .filter((key) => key.startsWith("can_") && member[key] === value)
    .map(rightName);
}

/** An administrator's rights in words, with "anonymous" when they post as the chat. */
function adminRights(member) {
  return [
    ...rightsList(member, true),
    ...(member?.is_anonymous === true ? ["anonymous"] : []),
  ];
}

function untilPhrase(member) {
  const until = Number(member?.until_date ?? 0);
  return until > 0 ? `until ${escapeHtml(untilText(until))}` : "forever";
}

function permissionsPhrase(member) {
  const off = rightsList(member, false);
  const on = rightsList(member, true);
  if (!off.length) return "";
  if (!on.length) return ": all permissions off";
  return `: can't ${escapeHtml(off.join(", "))}`;
}

function memberEventText(event, ctx) {
  const user = nameWithTag(ctx, event.user_id);
  const users = nameWithTag(ctx, event.user_id, "'s");
  const actor =
    event.actor_id != null ? nameWithTag(ctx, event.actor_id) : null;
  const before = event.old ?? { status: "left" };
  const after = event.new ?? { status: "left" };
  const self =
    event.actor_id != null && Number(event.actor_id) === Number(event.user_id);
  const by = actor && !self ? ` by ${actor}` : "";
  const subject = user;
  if (event.reason === "expired")
    return before.status === "kicked"
      ? `${users} ban ended`
      : `${users} restriction ended`;
  const wasIn = memberInChat(before);
  const isIn = memberInChat(after);
  const via = linkDetails(event);
  if (after.status === "kicked")
    return `${subject} banned ${untilPhrase(after)}${by}`;
  if (before.status === "kicked" && !isIn) return `${subject} unbanned${by}`;
  if (!wasIn && isIn) {
    const base =
      self || !actor ? `${subject} joined` : `${actor} added ${subject}`;
    const role =
      after.status === "administrator"
        ? " as administrator"
        : after.status === "restricted"
          ? " (restricted)"
          : "";
    return `${base}${role}${via}`;
  }
  if (wasIn && !isIn)
    return self || !actor ? `${subject} left` : `${actor} removed ${subject}`;
  if (after.status === "restricted" && before.status !== "restricted")
    return `${subject} restricted ${untilPhrase(after)}${permissionsPhrase(after)}${by}`;
  if (after.status === "restricted")
    return `${users} restrictions changed, ${untilPhrase(after)}${permissionsPhrase(after)}${by}`;
  if (before.status === "restricted" && after.status === "member")
    return `${subject} unrestricted${by}`;
  if (after.status === "administrator" && before.status !== "administrator") {
    const rights = adminRights(after);
    return `${subject} promoted${rights.length ? `: ${escapeHtml(rights.join(", "))}` : ""}${by}`;
  }
  if (before.status === "administrator" && after.status !== "administrator")
    return `${subject} demoted${by}`;
  if (after.status === "administrator") {
    if (before.custom_title !== after.custom_title)
      return `${users} title set to ${after.custom_title ? quoteText(after.custom_title) : "none"}${by}`;
    const gained = adminRights(after).filter(
      (right) => !adminRights(before).includes(right),
    );
    const lost = adminRights(before).filter(
      (right) => !adminRights(after).includes(right),
    );
    const change = [
      gained.length ? `+${gained.join(", +")}` : "",
      lost.length ? `−${lost.join(", −")}` : "",
    ]
      .filter(Boolean)
      .join("; ");
    return `${users} rights changed${change ? `: ${escapeHtml(change)}` : ""}${by}`;
  }
  return `${subject}: ${escapeHtml(before.status)} → ${escapeHtml(after.status)}${by}`;
}

function eventText(event, ctx) {
  if (event.type === "member") return memberEventText(event, ctx);
  if (event.type === "join_request") {
    const user = nameWithTag(ctx, event.user_id);
    if (event.state === "pending") {
      const link = event.invite_link_name
        ? quoteText(event.invite_link_name)
        : event.invite_link
          ? escapeHtml(event.invite_link)
          : "a link";
      return `${user} asked to join via ${link}`;
    }
    return `${nameWithTag(ctx, event.user_id, "'s")} join request ${event.state === "approved" ? "approved" : "declined"} by ${nameWithTag(ctx, event.bot_id)}`;
  }
  if (event.type === "unpin") {
    const bot = nameWithTag(ctx, event.bot_id);
    if (event.all || event.message_id == null)
      return `${bot} unpinned all messages`;
    return `${bot} unpinned <span class="tv-message-link" data-link-message-id="${escapeAttr(event.message_id)}">message ${escapeHtml(event.message_id)}</span>`;
  }
  return escapeHtml(event.type);
}

const EVENT_GLYPHS = { member: "◆", join_request: "✉", unpin: "⌖" };

/** A chat event that Telegram shows as no message: member changes, join requests, unpins. */
export function renderEvent(event, ctx) {
  return `<div class="tv-event"${attrs({
    "data-kind": "event",
    "data-chat-key": ctx.key,
    "data-chat-id": ctx.chat?.id,
    "data-event-id": event.seq,
    "data-seq": event.seq,
    "data-event-type": event.type,
    "data-user-id": event.user_id,
    "data-request-id": event.request_id,
    "data-before-window": event.before_window === true,
  })}><span class="tv-event-text">${eventText(event, ctx)}</span>${timeTag(event.at)}</div>`;
}

// ── Calls ──────────────────────────────────────────────────────────────

/**
 * A chat stream with its bot calls: each call just before the first item
 * stored after the call arrived (calls by request_number, items by
 * after_request, then seq), so a call comes right before what it produced.
 */
export function mergeStream(items, calls) {
  if (!calls?.length) return items;
  const sorted = [...calls].sort(
    (left, right) => left.request_number - right.request_number,
  );
  const out = [];
  let next = 0;
  for (const item of items) {
    while (
      next < sorted.length &&
      sorted[next].request_number <= item.after_request
    )
      out.push(sorted[next++]);
    out.push(item);
  }
  while (next < sorted.length) out.push(sorted[next++]);
  return out;
}

/** Whether the view's `bots` and `methods` filters let a call through. */
export function callShown(call, view) {
  const method = String(call.method).toLowerCase();
  return (
    (!view?.bots?.length ||
      view.bots.some((id) => Number(id) === Number(call.bot_id))) &&
    (!view?.methods?.length ||
      view.methods.some((name) => String(name).toLowerCase() === method))
  );
}

const CALL_OUTCOMES = {
  pending: "pending",
  succeeded: "succeeded",
  delayed: "delayed",
  response_lost: "response lost",
  failed_after_apply: "failed after apply",
  rejected: "rejected",
  unimplemented_ok: "unimplemented",
};
// Methods whose message ids are in the chat they copy from (from_chat_id).
const CALL_SOURCE_METHODS = new Set([
  "forwardmessage",
  "forwardmessages",
  "copymessage",
  "copymessages",
]);
// Parameters drawn in words by callParams; the rest are listed as they are.
const CALL_PARAMS_IN_WORDS = new Set([
  "chat_id",
  "user_id",
  "receiver_user_id",
  "ephemeral_message_parameters",
  "message_id",
  "message_ids",
  "from_chat_id",
  "ephemeral_message_id",
  "until_date",
  "permissions",
  "use_independent_chat_permissions",
  "revoke_messages",
  "only_if_banned",
  "show_alert",
  "creates_join_request",
  "text",
  "caption",
  "callback_query_id",
  "message_thread_id",
  "expire_date",
]);

/** A Bot API boolean as Telegram reads it. */
function callFlag(value) {
  return ["true", "yes", "1"].includes(
    String(value ?? "")
      .trim()
      .toLowerCase(),
  );
}

/**
 * until_date in words: a UTC date, or "forever" for 0 and for a date under
 * 30 seconds or over 366 days from the call, which Telegram takes as forever.
 */
function callUntil(value, at) {
  const until = Number.parseInt(String(value ?? "").trim(), 10) || 0;
  const away = until - Math.floor(Number(at) / 1000);
  const forever = until === 0 || away < 30 || away > 366 * 86400;
  return `<span title="until_date ${escapeAttr(value)}">${forever ? "forever" : `until ${escapeHtml(untilText(until))}`}</span>`;
}

/**
 * A call's permissions as Telegram reads them (resolved_permissions: a
 * permission left out is off), the parameter itself on hover; the parameter
 * alone when Telegram could not read it.
 */
function callPermissions(call, sent) {
  const resolved = call.resolved_permissions;
  if (!resolved || typeof resolved !== "object")
    return callRights(Object.entries(sent), "can't", "can");
  const off = Object.keys(resolved).filter((key) => resolved[key] === false);
  const on = Object.keys(resolved).filter((key) => resolved[key] === true);
  const names = (list) => escapeHtml(list.map(rightName).join(", "));
  const words = !off.length
    ? "all permissions on"
    : !on.length
      ? "all permissions off"
      : on.length < off.length
        ? `can only ${names(on)}`
        : `can't ${names(off)}`;
  return `<span title="${escapeAttr(`permissions sent: ${JSON.stringify(sent)}`)}">${words}</span>`;
}

/** The rights a parameter object or the can_* parameters turn off or on. */
function callRights(entries, offWord, onWord) {
  const off = entries.filter(([, value]) => !callFlag(value));
  const on = entries.filter(([, value]) => callFlag(value));
  const names = (list) =>
    escapeHtml(list.map(([key]) => rightName(key)).join(", "));
  if (offWord && off.length) return `${offWord} ${names(off)}`;
  if (on.length) return `${onWord} ${names(on)}`;
  return offWord ? "no permissions given" : "no rights";
}

function callValue(value) {
  return escapeHtml(
    oneLine(typeof value === "object" ? JSON.stringify(value) : value, 60),
  );
}

/** What a call asked for, in words: who, which messages, until when, which rights, and the rest. */
function callParams(call, ctx) {
  const p = call.params ?? {};
  const parts = [];
  const person = (id) => `<strong>${nameWithTag(ctx, id)}</strong>`;
  // In the "all" feed the chat's header above the call names its chat.
  const ownChat =
    call.chat_label != null ||
    (ctx.chat?.type !== "calls" && String(p.chat_id) === String(ctx.chat?.id));
  if (p.chat_id != null && !ownChat)
    parts.push(`chat ${escapeHtml(p.chat_id)}`);
  if (p.user_id != null) parts.push(`user ${person(p.user_id)}`);
  const receiver =
    p.receiver_user_id ?? p.ephemeral_message_parameters?.receiver_user_id;
  if (receiver != null) parts.push(`only ${person(receiver)} sees it`);
  const source = CALL_SOURCE_METHODS.has(String(call.method).toLowerCase())
    ? p.from_chat_id
    : null;
  const ids = [
    ...(p.message_id != null ? [p.message_id] : []),
    ...(Array.isArray(p.message_ids) ? p.message_ids : []),
  ];
  if (ids.length) {
    const shown = ids.slice(0, 10).map(escapeHtml).join(", ");
    parts.push(
      `${ids.length === 1 ? "message" : "messages"} ${shown}${ids.length > 10 ? ` and ${ids.length - 10} more` : ""}${source != null ? ` of chat ${escapeHtml(source)}` : ""}`,
    );
  } else if (p.from_chat_id != null) {
    parts.push(`from chat ${escapeHtml(p.from_chat_id)}`);
  }
  if (p.ephemeral_message_id != null)
    parts.push(`ephemeral message ${escapeHtml(p.ephemeral_message_id)}`);
  if (p.message_thread_id != null)
    parts.push(`topic ${escapeHtml(p.message_thread_id)}`);
  if (p.until_date != null) parts.push(callUntil(p.until_date, call.at));
  if (p.permissions && typeof p.permissions === "object")
    parts.push(callPermissions(call, p.permissions));
  const rights = Object.entries(p).filter(([key]) => key.startsWith("can_"));
  if (rights.length) parts.push(callRights(rights, null, "rights:"));
  for (const [key, label] of [
    ["revoke_messages", "revoke messages"],
    ["only_if_banned", "only if banned"],
    ["use_independent_chat_permissions", "independent permissions"],
    ["creates_join_request", "needs approval"],
    ["show_alert", "as an alert"],
  ])
    if (callFlag(p[key])) parts.push(label);
  for (const key of ["text", "caption"])
    if (p[key] != null && p[key] !== "") parts.push(quoteText(p[key]));
  if (p.expire_date != null && Number(p.expire_date) > 0)
    parts.push(`expires ${escapeHtml(untilText(p.expire_date))}`);
  for (const [key, value] of Object.entries(p))
    if (
      !CALL_PARAMS_IN_WORDS.has(key) &&
      !key.startsWith("can_") &&
      value != null &&
      value !== ""
    )
      parts.push(`${escapeHtml(key.replace(/_/g, " "))} ${callValue(value)}`);
  return parts;
}

/** The outcome pill's words: "rejected 400", "succeeded", "response lost" … */
function callOutcome(call) {
  const label = CALL_OUTCOMES[call.outcome] ?? String(call.outcome ?? "");
  return (call.outcome === "rejected" ||
    call.outcome === "failed_after_apply") &&
    call.status != null
    ? `${label} ${call.status}`
    : label;
}

function callBot(call, ctx) {
  if (userOf(ctx, call.bot_id)) return nameWithTag(ctx, call.bot_id);
  return `unknown bot ${escapeHtml(call.bot_id ?? "")}`;
}

/**
 * One Bot API call: the bot, the method, what it asked in words, how it
 * ended, and for any answer other than 200 Telegram's text as it was sent.
 * Clicking it highlights what it touched (interact.highlightCall).
 */
export function renderCall(call, ctx) {
  const tags = [
    call.unimplemented && call.outcome !== "unimplemented_ok"
      ? "unimplemented"
      : null,
    call.fault_injected ? "injected" : null,
    call.journal === "rejected_requests" && call.status !== 401
      ? "unreadable request"
      : null,
  ]
    .filter(Boolean)
    .map((tag) => ` <span class="tv-tag">${escapeHtml(tag)}</span>`)
    .join("");
  const params = callParams(call, ctx);
  const error =
    call.status !== 200 && call.description
      ? `<div class="tv-call-error" title="Telegram's error text">${escapeHtml(call.description)}</div>`
      : "";
  return `<div class="tv-call"${attrs({
    "data-kind": "call",
    "data-chat-key": ctx.key,
    "data-chat-id": ctx.chat?.id,
    "data-call-seq": call.call_seq,
    "data-call-journal": call.journal,
    "data-request-id": call.request_id,
    "data-request-number": call.request_number,
    "data-call-bot-id": call.bot_id,
    "data-call-method": call.method,
    "data-call-outcome": call.outcome,
    "data-target-messages":
      (call.targets?.messages ?? [])
        .map((target) => `${target.chat_id}:${target.message_id}`)
        .join(" ") || null,
    "data-target-user-id": call.targets?.user_id,
    "data-target-ephemeral-id": call.targets?.ephemeral_message_id,
    "data-before-window": call.before_window === true,
    title: `Bot API call, request ${call.request_id}`,
    tabindex: "0",
  })}><div class="tv-call-head"><span class="tv-call-bot tv-id-${identitySlot(call.bot_id)}">${callBot(call, ctx)}</span><span class="tv-call-kind">Bot API call</span></div><div class="tv-call-line"><code class="tv-call-method">${escapeHtml(call.method)}</code><span class="tv-call-outcome"${attrs({ "data-outcome": call.outcome })}>${escapeHtml(callOutcome(call))}</span>${tags}</div>${params.length ? `<div class="tv-call-params">${params.join(" · ")}</div>` : ""}${error}<div class="tv-call-foot">${timeTag(call.at)}</div></div>`;
}

/**
 * The calls filter: a checkbox for each bot and each method among `calls`
 * and the view's filters, checked when the filter lets it through. Nothing
 * when there are no calls and no filter.
 */
export function renderCallFilters(calls, view, ctx, { open = false } = {}) {
  if (!calls.length && !view.bots?.length && !view.methods?.length) return "";
  const bots = new Map();
  for (const bot of ctx.bots.values()) bots.set(Number(bot.id), true);
  for (const call of calls) bots.set(Number(call.bot_id), true);
  for (const id of view.bots ?? []) bots.set(Number(id), true);
  const methods = new Map();
  for (const call of calls) {
    const name = String(call.method);
    const entry = methods.get(name.toLowerCase()) ?? { name, count: 0 };
    entry.count += 1;
    methods.set(name.toLowerCase(), entry);
  }
  for (const name of view.methods ?? [])
    if (!methods.has(name.toLowerCase()))
      methods.set(name.toLowerCase(), { name, count: 0 });
  const box = (value, checked, label) =>
    `<label class="tv-check"><input type="checkbox" value="${escapeAttr(value)}"${checked ? " checked" : ""}><span>${label}</span></label>`;
  const botBoxes = [...bots.keys()]
    .map((id) =>
      box(
        id,
        !view.bots?.length || view.bots.some((bot) => Number(bot) === id),
        callBot({ bot_id: id }, ctx),
      ),
    )
    .join("");
  const methodBoxes = [...methods.values()]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map(({ name, count }) =>
      box(
        name,
        !view.methods?.length ||
          view.methods.some(
            (each) => each.toLowerCase() === name.toLowerCase(),
          ),
        `<code>${escapeHtml(name)}</code> <span class="tv-count">${count}</span>`,
      ),
    )
    .join("");
  const shown = calls.filter((call) => callShown(call, view)).length;
  const filtered = Boolean(view.bots?.length || view.methods?.length);
  return `<details class="tv-call-filters" data-role="call-filters"${open ? " open" : ""}><summary>Filter calls <span class="tv-count" data-role="calls-shown">${filtered ? `${shown} of ${calls.length}` : `${calls.length}`}</span></summary><div class="tv-call-filter-sets"><fieldset data-role="call-filter-bot"><legend>Bots</legend>${botBoxes}</fieldset><fieldset data-role="call-filter-method"><legend>Methods</legend>${methodBoxes}</fieldset></div></details>`;
}

/** The button that loads the calls older than `beforeRequest`. */
export function renderOlderCalls(beforeRequest) {
  if (beforeRequest == null) return "";
  return `<div class="tv-older"><button type="button" class="tv-pill-button" data-role="load-older-calls" data-before-request="${escapeAttr(beforeRequest)}">Load older calls</button></div>`;
}

// ── Streams (chat column, events panel) ────────────────────────────────

/** Member events by the service message they link (event.service_seq). */
export function serviceLinks(items) {
  const links = new Map();
  for (const item of items ?? [])
    if (item.kind === "event" && item.service_seq != null)
      links.set(item.service_seq, item);
  return links;
}

function itemTime(item) {
  if (item.at != null) return Number(item.at);
  return Number(item.message?.date ?? 0) * 1000;
}

function groupKeyOf(item, ctx) {
  if (item.kind !== "message" || serviceType(item.message)) return null;
  const m = item.message;
  const kind = authorKind(item, ctx);
  // Posts on behalf of a chat group by the chat and the signature (an
  // admin's title), and in the test view by who posted.
  const who =
    kind === "channel"
      ? `${m.sender_chat?.id ?? ctx.chat?.id}/${m.author_signature ?? ""}${ctx.as == null ? `/${item.author}` : ""}`
      : m.from?.id;
  return `${kind}:${who}:${item.ephemeral ? `e${m.receiver_user?.id}` : ""}:${item.deleted ? "d" : ""}`;
}

function entryKey(item) {
  if (item.kind === "call") return `c${item.request_id}`;
  return `${item.kind === "event" ? "e" : "m"}${item.seq}`;
}

function drawn(item, ctx, position) {
  if (item.kind === "event") return renderEvent(item, ctx);
  if (item.kind === "call") return renderCall(item, ctx);
  return renderMessage(item, ctx, position);
}

/**
 * Keyed entries for a list of items: day separators, groups of one author's
 * messages within five minutes, and the history marker for view-as. Each
 * entry is { key, html }, so the page replaces only what changed.
 */
export function streamEntries(list, ctx, options = {}) {
  const out = [];
  let lastDay = null;
  const groupKeys = list.map((item) => groupKeyOf(item, ctx));
  const asInfo = ctx.asInfo;
  let markerBefore = -1;
  if (asInfo?.history_may_be_hidden) {
    markerBefore = 0;
    list.forEach((item, index) => {
      if (
        item.kind === "message" &&
        (item.message?.new_chat_members ?? []).some(
          (user) => Number(user.id) === Number(asInfo.user_id),
        )
      )
        markerBefore = index;
    });
  }
  let lastChat = null;
  list.forEach((item, index) => {
    const time = itemTime(item);
    const day = dayKey(time);
    if (day && day !== lastDay) {
      out.push({
        key: `d${day}`,
        html: `<div class="tv-day" data-role="day"><span>${escapeHtml(dayLabel(time))}</span></div>`,
      });
      lastDay = day;
      lastChat = null;
    }
    // In the "all" feed, a header names the chat each run of items is in.
    if (item.chat_label != null && item.chat_ref !== lastChat) {
      out.push({
        key: `c${entryKey(item)}`,
        html: `<div class="tv-chat-switch" data-role="chat-switch" data-chat-ref="${escapeAttr(item.chat_ref)}"><span>In ${escapeHtml(item.chat_label)}</span></div>`,
      });
      lastChat = item.chat_ref;
    }
    if (index === markerBefore)
      out.push({
        key: "history-marker",
        html: '<div class="tv-history-note" data-role="history-hidden">Earlier history may be hidden for new members (not modeled)</div>',
      });
    // Grouped: the same author, within five minutes, on the same day, with
    // no marker between the two.
    const near = (other) =>
      groupKeys[index] != null &&
      groupKeys[other] === groupKeys[index] &&
      list[other].chat_ref === item.chat_ref &&
      Math.abs(itemTime(list[other]) - time) <= 300_000 &&
      dayKey(itemTime(list[other])) === day &&
      Math.max(index, other) !== markerBefore;
    const position = {
      groupedWithPrevious: index > 0 && near(index - 1),
      groupedWithNext: index < list.length - 1 && near(index + 1),
    };
    const html = drawn(item, ctx, position);
    if (html) out.push({ key: entryKey(item), html });
  });
  if (!list.length && options.empty)
    out.push({ key: "empty", html: options.empty });
  return out;
}

/**
 * What the chat column draws. Combined: messages, events (when shown) and
 * calls (when shown) by time; split: messages only. An event whose service
 * message is drawn is left out: the message carries its details.
 */
export function chatStream(
  items,
  ctx,
  { layout = "combined", show = PANELS, calls = [] } = {},
) {
  const shown = new Set(show);
  const inline = layout === "combined";
  const drawnSeqs = new Set(
    items.filter((item) => item.kind === "message").map((item) => item.seq),
  );
  const list = items.filter((item) => {
    if (item.kind === "message") return true;
    if (
      item.kind !== "event" ||
      !inline ||
      !shown.has("events") ||
      ctx.as != null
    )
      return false;
    return item.service_seq == null || !drawnSeqs.has(item.service_seq);
  });
  return inline && shown.has("calls") && ctx.as == null
    ? mergeStream(list, calls)
    : list;
}

/** What the events panel lists: events and service messages, by seq, each change once. */
export function eventsStream(items) {
  const services = new Set(
    items
      .filter((item) => item.kind === "message" && serviceType(item.message))
      .map((item) => item.seq),
  );
  return items.filter((item) => {
    if (item.kind === "message") return services.has(item.seq);
    return (
      item.kind === "event" &&
      (item.service_seq == null || !services.has(item.service_seq))
    );
  });
}

// ── Members ────────────────────────────────────────────────────────────

/** A member's status in words: "restricted until …", "banned forever", "left" … */
export function memberStatusText(member) {
  if (!member) return "not a member";
  switch (member.status) {
    case "restricted":
      return `restricted ${member.until_date ? `until ${untilText(member.until_date)}` : "forever"}${member.is_member === false ? " · not in the chat" : ""}`;
    case "kicked":
      return `banned ${member.until_date ? `until ${untilText(member.until_date)}` : "forever"}`;
    default:
      return member.status;
  }
}

function memberCard(ctx, userId, member, extra = {}) {
  const user = userOf(ctx, userId);
  const name = user ? nameOf(user) : `User ${userId}`;
  const tag = botTag(ctx, user);
  const rows = [["ID", String(userId)]];
  if (member) rows.push(["Status", memberStatusText(member)]);
  if (member?.custom_title) rows.push(["Title", member.custom_title]);
  if (member?.status === "restricted") {
    const off = rightsList(member, false);
    rows.push(["Can't", off.length ? off.join(", ") : "nothing restricted"]);
  }
  if (member?.status === "administrator") {
    const on = rightsList(member, true);
    rows.push(["Rights", on.length ? on.join(", ") : "none"]);
    if (member.is_anonymous) rows.push(["Anonymous", "yes"]);
  }
  if (extra.role) rows.push(["Role", extra.role]);
  const grid = rows
    .map(
      ([label, value]) =>
        `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd>`,
    )
    .join("");
  const status = member?.status ?? null;
  const handle = [
    user?.username ? `@${escapeHtml(user.username)}` : "",
    tag ? ` <span class="tv-tag">${escapeHtml(tag)}</span>` : "",
  ].join("");
  return el(
    "article",
    {
      class: "tv-member",
      "data-chat-key": ctx.key,
      "data-member-id": userId,
      "data-member-status": status,
      "data-member-in-chat": String(
        member ? memberInChat(member) : extra.inChat === true,
      ),
      "data-member-bot": Boolean(user?.is_bot),
    },
    el(
      "header",
      { class: "tv-member-head" },
      avatar(userId, name, ctx),
      el(
        "span",
        { class: "tv-member-names" },
        el("strong", {}, escapeHtml(name)),
        handle ? el("span", {}, handle) : "",
      ),
      status
        ? el(
            "span",
            { class: "tv-status", "data-status": status },
            escapeHtml(status === "kicked" ? "banned" : status),
          )
        : "",
    ),
    el("dl", { class: "tv-member-grid" }, grid),
  );
}

/** Keyed entries for the members panel: chat permissions, members, the rest's count, join requests. */
export function memberEntries(page, ctx) {
  const chat = page.chat ?? {};
  const out = [];
  if (chat.type === "private") {
    out.push({
      key: "section-people",
      html: '<h3 class="tv-section">In this chat</h3>',
    });
    out.push({
      key: `m${chat.user_id}`,
      html: memberCard(ctx, chat.user_id, null, { role: "user", inChat: true }),
    });
    out.push({
      key: `m${chat.bot_id}`,
      html: memberCard(ctx, chat.bot_id, null, { role: "bot", inChat: true }),
    });
    return out;
  }
  if (chat.permissions) {
    const off = Object.keys(chat.permissions).filter(
      (key) => chat.permissions[key] === false,
    );
    out.push({
      key: "permissions",
      html: `<section class="tv-permissions" data-role="chat-permissions"><h3 class="tv-section">Default permissions</h3><p>${off.length ? `Members can't ${escapeHtml(off.map(rightName).join(", "))}` : "Members may do everything"}</p></section>`,
    });
  }
  const members = page.members ?? [];
  const total = Number(page.members_total ?? members.length);
  const inChat = Number(page.members_in_chat ?? total);
  const away = total - inChat;
  out.push({
    key: "section-members",
    html: `<h3 class="tv-section">Members <span class="tv-count" title="in the chat now">${escapeHtml(inChat)}</span>${away > 0 ? ` <span class="tv-section-note">· ${escapeHtml(away)} not in the chat</span>` : ""}</h3>`,
  });
  for (const row of members)
    out.push({
      key: `m${row.user_id}`,
      html: memberCard(ctx, row.user_id, row.member),
    });
  const more = Number(page.members_total ?? members.length) - members.length;
  if (more > 0)
    out.push({
      key: "more",
      html: `<p class="tv-more" data-role="more-members" data-count="${escapeAttr(more)}">${escapeHtml(more)} more members</p>`,
    });
  const requests = page.join_requests ?? [];
  if (requests.length) {
    out.push({
      key: "section-requests",
      html: `<h3 class="tv-section">Join requests <span class="tv-count">${requests.length}</span></h3>`,
    });
    for (const request of requests) {
      const name = personName(ctx, request.user_id);
      const link = request.invite_link_name
        ? `“${request.invite_link_name}”`
        : (request.invite_link ?? "");
      const asked = request.date
        ? `${dayLabel(request.date * 1000)} ${clockTime(request.date * 1000)} UTC`
        : "";
      out.push({
        key: `jr${request.user_id}`,
        html: el(
          "article",
          {
            class: "tv-request",
            "data-chat-key": ctx.key,
            "data-join-request-user-id": request.user_id,
          },
          avatar(request.user_id, name, ctx),
          el(
            "span",
            { class: "tv-member-names" },
            el("strong", {}, escapeHtml(name)),
            el(
              "span",
              {},
              escapeHtml(`asked ${asked}${link ? ` via ${link}` : ""}`),
            ),
          ),
        ),
      });
    }
  }
  return out;
}

// ── Chat list ──────────────────────────────────────────────────────────

const TYPE_LABELS = {
  supergroup: "supergroup",
  group: "basic group",
  channel: "channel",
  private: "private",
  calls: "calls",
};
/**
 * A chat list row's second line: its latest item, a service message or an
 * event worded as the chat words it, a message after its author's name.
 */
function listPreview(entry, ctx) {
  if (entry.type === "calls")
    return `${escapeHtml(entry.call_count ?? 0)} calls without a chat`;
  const last = entry.last;
  if (!last)
    return entry.access === "none"
      ? '<span class="tv-list-event">Not a member</span>'
      : "No messages yet";
  if (last.kind === "event")
    return `<span class="tv-list-event">${eventText(last.event, ctx)}</span>`;
  // A post on behalf of a chat names that chat, and nobody when it is this
  // chat itself (an anonymous admin's post, a channel's own post).
  const sender = last.sender_chat
    ? Number(last.sender_chat.id) === Number(entry.id)
      ? null
      : (last.sender_chat.title ?? "Chat")
    : userOf(ctx, last.author)
      ? personName(ctx, last.author)
      : null;
  const author =
    sender != null
      ? `<span class="tv-list-author">${escapeHtml(sender)}:</span> `
      : "";
  if (last.deleted)
    return `${author}<span class="tv-list-deleted">Deleted message</span>`;
  if (last.message && SERVICE_TYPES.includes(last.media))
    return `<span class="tv-list-event">${serviceText(last, ctx, last.media)}</span>`;
  const media = last.media
    ? (CONTENT_KINDS.find(([key]) => key === last.media)?.[1] ?? last.media)
    : null;
  const text =
    last.preview != null
      ? escapeHtml(oneLine(last.preview, 100))
      : escapeHtml(media ?? "Message");
  return `${author}${last.ephemeral ? '<span class="tv-list-flag">◐</span> ' : ""}${media && last.preview != null ? `${escapeHtml(media)} · ` : ""}${text}`;
}

/**
 * Keyed rows of the chat list. `current` holds the open chats' keys;
 * `search` filters by title, and a row it leaves out has `hidden: true`.
 * Previews name people from the state's own users, so a row reads the same
 * whichever chats are open.
 */
export function chatListEntries(
  state,
  { view = null, current = [], search = "" } = {},
) {
  const ctx = makeContext(
    {
      bots: state?.bots ?? [],
      users: state?.users ?? {},
      files: state?.files ?? {},
    },
    { as: view?.as ?? null, tags: false },
  );
  const open = new Set(current.map(String));
  const needle = String(search ?? "")
    .trim()
    .toLowerCase();
  return (state?.chats ?? []).map((entry) => {
    const href = view
      ? viewToSearch({ ...view, chats: [entry.key], topic: null })
      : `?chat=${searchValue(entry.key)}`;
    const bot =
      entry.type === "private"
        ? state.bots?.find(
            (candidate) => Number(candidate.id) === Number(entry.bot_id),
          )
        : null;
    const title = entry.title ?? String(entry.id ?? entry.key);
    const badges = [
      entry.is_forum ? "forum" : (TYPE_LABELS[entry.type] ?? entry.type),
      entry.migrated_to != null ? "upgraded" : null,
      bot?.deleted ? "deleted bot" : null,
    ].filter(Boolean);
    const memberView = view?.as != null;
    const pending = memberView ? 0 : Number(entry.pending_join_requests) || 0;
    const time = entry.last?.at ?? entry.last_call?.at ?? null;
    const hidden =
      needle &&
      !`${title} ${bot?.username ?? ""} ${entry.key}`
        .toLowerCase()
        .includes(needle);
    const picture =
      entry.type === "calls"
        ? '<span class="tv-avatar tv-avatar--list tv-avatar--calls" aria-hidden="true">⇄</span>'
        : avatar(entry.id ?? entry.key, title, ctx, {
            size: " tv-avatar--list",
            photoId: entry.photo_file_id,
          });
    const chips = [
      ...badges.map((badge) =>
        el("span", { class: "tv-chip" }, escapeHtml(badge)),
      ),
      entry.deleted_count && !memberView
        ? el(
            "span",
            { class: "tv-chip tv-chip--danger" },
            `${escapeHtml(entry.deleted_count)} deleted`,
          )
        : "",
    ];
    const html = el(
      "a",
      {
        class: "tv-list-item",
        href,
        "data-chat-key": entry.key,
        "data-chat-id": entry.id,
        "data-chat-type": entry.type,
        "data-forum": entry.is_forum === true,
        "data-user-id": entry.type === "private" ? entry.user_id : null,
        "data-bot-id": entry.type === "private" ? entry.bot_id : null,
        "aria-current": open.has(String(entry.key)) ? "true" : null,
        hidden: hidden ? "hidden" : null,
      },
      picture,
      el(
        "span",
        { class: "tv-list-copy" },
        el(
          "span",
          { class: "tv-list-line" },
          el("span", { class: "tv-list-title" }, escapeHtml(title)),
          bot
            ? el(
                "span",
                { class: "tv-list-with" },
                `with @${escapeHtml(bot.username ?? bot.first_name)}`,
              )
            : "",
          time != null
            ? el(
                "time",
                { class: "tv-list-time", datetime: isoTime(time) },
                escapeHtml(clockTime(time)),
              )
            : "",
        ),
        el(
          "span",
          { class: "tv-list-line" },
          el("span", { class: "tv-list-preview" }, listPreview(entry, ctx)),
          pending
            ? el(
                "span",
                {
                  class: "tv-requests",
                  title: "pending join requests",
                  "data-role": "pending-requests",
                  "data-count": pending,
                },
                `✉ ${pending} ${pending === 1 ? "request" : "requests"}`,
              )
            : "",
        ),
        el("span", { class: "tv-list-badges" }, ...chips),
      ),
    );
    return { key: entry.key, html, hidden: Boolean(hidden) };
  });
}

// ── Frame: toolbar, columns, phone navigation ──────────────────────────

const PANEL_LABELS = {
  list: "All chats",
  chat: "Messages",
  calls: "Bot calls",
  events: "Events",
  members: "Members",
};

/** The toolbar's controls: panel toggles, layout, view-as and theme. */
export function renderToolbar(view, { people = [] } = {}) {
  const shown = new Set(view.show ?? PANELS);
  const viewAs = view.as != null;
  const toggles = PANELS.map((panel) => {
    const disabled =
      (viewAs && ["calls", "events", "members"].includes(panel)) ||
      (shown.has(panel) && shown.size === 1);
    return `<button type="button" class="tv-toggle" data-role="toggle-panel" data-panel="${panel}" aria-pressed="${shown.has(panel) && !(viewAs && ["calls", "events", "members"].includes(panel))}"${disabled ? " disabled" : ""}>${PANEL_LABELS[panel]}</button>`;
  }).join("");
  const layouts = LAYOUTS.map(
    (layout) =>
      `<button type="button" class="tv-toggle" data-role="layout" data-layout="${layout}" aria-pressed="${view.layout === layout}">${layout === "combined" ? "Combined" : "Split"}</button>`,
  ).join("");
  const options = [{ id: "", name: "Everyone" }, ...people]
    .map(
      ({ id, name }) =>
        `<option value="${escapeAttr(id)}"${String(view.as ?? "") === String(id) ? " selected" : ""}>${escapeHtml(id === "" ? name : `As ${name}`)}</option>`,
    )
    .join("");
  const themes = [
    ["", "Auto theme"],
    ["light", "Light"],
    ["dark", "Dark"],
  ]
    .map(
      ([value, label]) =>
        `<option value="${value}"${(view.theme ?? "") === value ? " selected" : ""}>${label}</option>`,
    )
    .join("");
  const select = (label, role, html) =>
    el(
      "label",
      { class: "tv-select" },
      el("span", { class: "tv-visually-hidden" }, label),
      el("select", { "data-role": role }, html),
    );
  return [
    el(
      "div",
      {
        class: "tv-toolbar-group tv-panel-toggles",
        role: "group",
        "aria-label": "Panels",
      },
      toggles,
    ),
    el(
      "div",
      { class: "tv-toolbar-group", role: "group", "aria-label": "Layout" },
      layouts,
    ),
    select("View as", "view-as", options),
    select("Theme", "theme", themes),
  ].join("");
}

/**
 * The status pill: live, reconnecting or stopped, or for a recording its
 * name and when it ran, in UTC (its marks on hover).
 */
export function renderStatus(status, recording = null) {
  if (recording) {
    const when = recording.window ?? {};
    const marks = `items ${when.start_seq ?? "?"}–${when.stop_seq ?? "?"} · requests ${when.start_request ?? "?"}–${when.stop_request ?? "?"}`;
    return `<span class="tv-live" data-role="status" data-status="recording" role="status" title="${escapeAttr(marks)}"><span class="tv-live-dot" aria-hidden="true"></span><span class="tv-live-label">${escapeHtml(`Recording ${recording.name ?? ""}`.trim())} <span class="tv-status-detail">${escapeHtml(recordingSpan(when.started_at, when.stopped_at))}</span></span></span>`;
  }
  const labels = {
    live: "Live",
    reconnecting: "Connecting…",
    stopped: "Server stopped",
  };
  return `<span class="tv-live" data-role="status" data-status="${escapeAttr(status)}" role="status"><span class="tv-live-dot" aria-hidden="true"></span>${escapeHtml(labels[status] ?? status)}</span>`;
}

/** When a recording ran: "7 Oct 2026 09:00:05–09:00:12 UTC", the day twice when it changed. */
function recordingSpan(start, stop) {
  const startDate = new Date(Number(start));
  const stopDate = new Date(Number(stop));
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(stopDate.getTime()))
    return "";
  const time = (date) => isoTime(date.getTime()).slice(11, 19);
  return dayKey(start) === dayKey(stop)
    ? `${dayLabel(start)} ${time(startDate)}–${time(stopDate)} UTC`
    : `${dayLabel(start)} ${time(startDate)} – ${dayLabel(stop)} ${time(stopDate)} UTC`;
}

function columnTitle(column, info) {
  if (column.panel === "list") return "Chats";
  const label = PANEL_LABELS[column.panel];
  return info?.title ? `${label} · ${info.title}` : label;
}

/** A column's frame: header, the call filters' bar (chat and calls columns) and body slots the page fills and patches. */
export function renderColumn(column, info = {}) {
  const perChat = column.panel !== "list";
  // The chat's day floats over its top only while it is scrolled (interact.js).
  const body =
    column.panel === "chat"
      ? `<div class="tv-wallpaper"><div class="tv-day tv-day--float" data-role="day-float" aria-hidden="true"><span></span></div><div class="tv-scroll" data-slot="scroll"><div data-slot="top"></div><div class="tv-stream" data-slot="items"></div><div data-slot="bottom"></div></div></div>`
      : column.panel === "list"
        ? `<div class="tv-scroll tv-list" data-slot="scroll"><div data-slot="items"></div></div>`
        : `<div class="tv-scroll tv-panel-scroll" data-slot="scroll"><div data-slot="top"></div><div class="tv-panel-list" data-slot="items"></div><div data-slot="bottom"></div></div>`;
  return `<section class="tv-column tv-column--${column.panel}"${attrs({
    "data-panel": column.panel,
    "data-column-id": column.id,
    "data-chat-key": perChat ? (info.key ?? column.ref) : null,
    "data-chat-id": perChat ? (info.chatId ?? null) : null,
    "data-view-as": info.viewAs ?? "",
    "aria-label": columnTitle(column, info),
  })}><header class="tv-pane-header" data-slot="header"></header>${
    column.panel === "chat" || column.panel === "calls"
      ? '<div class="tv-pane-tools" data-slot="tools"></div>'
      : ""
  }<div class="tv-pane-body">${body}</div></section>`;
}

/** The header of a per-chat column: the chat, its kind, open-alone and hide. */
export function renderPaneHeader(
  column,
  {
    page = null,
    entry = null,
    ctx = null,
    openAlone = "",
    topic = null,
    missing = false,
  } = {},
) {
  const chat = page?.chat ?? entry ?? {};
  const title =
    chat.title ??
    (column.ref === "calls" ? "Bot calls without a chat" : column.ref);
  const label = PANEL_LABELS[column.panel];
  const kind = chat.type
    ? chat.is_forum
      ? "forum"
      : (TYPE_LABELS[chat.type] ?? chat.type)
    : missing
      ? "not found"
      : "";
  const members = entry?.member_count
    ? `${entry.member_count} ${entry.member_count === 1 ? "member" : "members"}`
    : null;
  const subtitle = [label, kind, column.panel === "chat" ? members : null]
    .filter(Boolean)
    .join(" · ");
  const photo = chat.photo_file_id ?? entry?.photo_file_id ?? null;
  const pic =
    column.ref === "calls"
      ? '<span class="tv-avatar tv-avatar--header tv-avatar--calls" aria-hidden="true">⇄</span>'
      : avatar(chat.id ?? column.ref, title, ctx ?? makeContext(page ?? {}), {
          size: " tv-avatar--header",
          photoId: photo,
        });
  const topics =
    column.panel === "chat" && chat.is_forum && (chat.topics ?? []).length
      ? `<label class="tv-select tv-select--small"><span class="tv-visually-hidden">Topic</span><select data-role="topic-filter">${[
          ["", "All topics"],
          ["general", "General"],
          ...(chat.topics ?? []).map((entryTopic) => [
            String(entryTopic.message_thread_id),
            entryTopic.name,
          ]),
        ]
          .map(
            ([value, name]) =>
              `<option value="${escapeAttr(value)}"${value ? ` data-topic-id="${escapeAttr(value)}"` : ""}${String(topic ?? "") === value ? " selected" : ""}>${escapeHtml(name)}</option>`,
          )
          .join("")}</select></label>`
      : "";
  return [
    pic,
    el(
      "span",
      { class: "tv-pane-titles" },
      el("span", { class: "tv-pane-title" }, escapeHtml(title)),
      el("span", { class: "tv-pane-subtitle" }, escapeHtml(subtitle)),
    ),
    topics,
    paneButtons(column.panel, label, openAlone),
  ].join("");
}

/** A panel header's "open alone" link and hide button. */
function paneButtons(panel, label, openAlone) {
  return [
    el(
      "a",
      {
        class: "tv-icon-button",
        "data-role": "open-alone",
        href: openAlone,
        target: "_blank",
        rel: "noopener",
        title: "Open this panel alone in a new tab",
        "aria-label": `Open ${label} alone`,
      },
      "↗",
    ),
    el(
      "button",
      {
        type: "button",
        class: "tv-icon-button",
        "data-role": "hide-panel",
        "data-panel": panel,
        title: "Hide this panel",
        "aria-label": `Hide ${label}`,
      },
      "×",
    ),
  ].join("");
}

/**
 * The list column's header: search, count, open-alone and hide. The page
 * fills the search box and the count (renderChatCount) itself, so typing
 * never redraws the box.
 */
export function renderListHeader(openAlone = "") {
  const input = `<input${attrs({ type: "search", "data-role": "chat-search", placeholder: "Search chats", autocomplete: "off" })}>`;
  return [
    el(
      "label",
      { class: "tv-search" },
      el("span", { class: "tv-visually-hidden" }, "Search chats"),
      input,
    ),
    el("span", { class: "tv-count", "data-role": "chat-count" }, ""),
    paneButtons("list", "Chats", openAlone),
  ].join("");
}

/** The chat list's count: every chat, or "3 of 17" while a search leaves some out. */
export function renderChatCount(total, shown, searching) {
  return searching ? `${shown} of ${total}` : String(total);
}

/** A divider between two columns, resizable by pointer and keyboard. */
export function renderDivider(after, label, width = 0, minimum = 0) {
  return el(
    "div",
    {
      class: "tv-divider",
      role: "separator",
      "data-role": "divider",
      "data-after": after,
      tabindex: "0",
      "aria-orientation": "vertical",
      "aria-label": `Resize ${label}`,
      "aria-valuenow": Math.round(width),
      "aria-valuemin": minimum,
    },
    "<span></span>",
  );
}

/**
 * The phone's bottom bar: one tab per column (the chat list is the way back);
 * with two chats or more, each chat's tabs carry its title, shortened.
 */
export function renderPhoneNav(columns, active, titles = {}) {
  const several =
    new Set(columns.filter((column) => column.ref).map((column) => column.ref))
      .size > 1;
  const buttons = columns
    .map((column) => {
      const label =
        several && column.ref
          ? `${PANEL_LABELS[column.panel]} · ${oneLine(titles[column.ref] ?? column.ref, 14)}`
          : PANEL_LABELS[column.panel];
      return `<button type="button" class="tv-phone-button" data-role="phone-pane" data-pane="${escapeAttr(column.id)}"${column.id === active ? ' aria-current="page"' : ""}>${escapeHtml(label)}</button>`;
    })
    .join("");
  return buttons;
}

/** The banner a member sees in a chat they are not in, or another user's private chat. */
export function renderNotMember(page, ctx) {
  const info = page?.as;
  if (!info || info.access !== "none") return "";
  const name = escapeHtml(personName(ctx, info.user_id));
  const chat = page.chat ?? {};
  const text =
    chat.type === "private" && Number(chat.user_id) !== Number(info.user_id)
      ? `${name} can't see this chat`
      : `${name} is not in this chat now (${escapeHtml(info.status === "kicked" ? "banned" : (info.status ?? "never joined"))})`;
  return `<div class="tv-banner" data-role="not-member">${text}</div>`;
}

/** The note shown with view-as in a basic group: only what was posted while the member was in it. */
export function renderAccessNote(page) {
  const info = page?.as;
  if (!info) return "";
  if (info.access === "while_member")
    return '<div class="tv-history-note" data-role="access-note">Shown: what was posted while this member was in the group</div>';
  return "";
}
