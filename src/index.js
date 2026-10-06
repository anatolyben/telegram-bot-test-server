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
 * More than one bot: the bot it starts with is the first; tests add others
 * (POST /_fake/bots). Each bot has its own webhook or update queue, and its
 * own membership and rights in each chat, and Telegram's rules about them
 * hold: a bot posts only where it is a member, edits and stops only its own
 * messages (in a channel, others' with can_edit_messages), pins only with the
 * right to, and learns of its own membership through my_chat_member. A
 * channel's messages come from the channel and reach bots as channel_post.
 * Tests can also make the next calls fail
 * (/_fake/failures), including a call that takes effect but never answers.
 *
 * Nothing here talks to Telegram.
 */
import { createOwnerModel, OwnerError } from "./owner.js";
import { findEntities, formatText, FormattingError } from "./formatting.js";
import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { domainToASCII } from "node:url";
import { getSystemErrorName } from "node:util";
import { unzipSync } from "node:zlib";
import { AsyncLocalStorage } from "node:async_hooks";
import { createClock, createWaits, diagnostic } from "./test-controls.js";
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign,
  timingSafeEqual,
} from "node:crypto";

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
 * A ChatPermissions object as Telegram's Bot API server reads it
 * (get_chat_permissions): unspecified fields are false, except that
 * can_manage_topics and can_edit_tag follow can_pin_messages and
 * can_react_to_messages follows can_send_messages as passed; then, unless
 * use_independent_chat_permissions is set, the broader permissions imply the
 * narrower ones.
 */
function normalizePermissions(input = {}, independent = false) {
  if (!isObject(jsonParam(input, "permissions"))) {
    throw new TelegramError(400, "Bad Request: object expected as permissions");
  }
  const given = (key) => input[key] === true || input[key] === "true";
  const result = Object.fromEntries(
    PERMISSION_KEYS.map((key) => [key, given(key)]),
  );
  if (!("can_manage_topics" in input)) {
    result.can_manage_topics = result.can_pin_messages;
  }
  if (!("can_edit_tag" in input)) result.can_edit_tag = result.can_pin_messages;
  if (!("can_react_to_messages" in input)) {
    result.can_react_to_messages = result.can_send_messages;
  }
  if (!isTrue(independent)) {
    if (result.can_send_other_messages || result.can_add_web_page_previews) {
      for (const key of MEDIA_PERMISSIONS) result[key] = true;
    }
    if (result.can_send_polls) result.can_send_messages = true;
  }
  return result;
}
// How long a webhook connection may stay silent before Telegram closes it and
// tries the update again (telegram-bot-api WebhookActor creates its
// HttpOutboundConnection with a 60-second idle timeout).
const WEBHOOK_TIMEOUT_MS = 60_000;
// Every update type allowed_updates may name, in the order getWebhookInfo
// lists them (telegram-bot-api Client::UpdateType). custom_event and
// custom_query are internal to Telegram and never listed.
const UPDATE_TYPES = Object.freeze([
  "message",
  "edited_message",
  "channel_post",
  "edited_channel_post",
  "inline_query",
  "chosen_inline_result",
  "callback_query",
  "custom_event",
  "custom_query",
  "shipping_query",
  "pre_checkout_query",
  "poll",
  "poll_answer",
  "my_chat_member",
  "chat_member",
  "chat_join_request",
  "chat_boost",
  "removed_chat_boost",
  "message_reaction",
  "message_reaction_count",
  "business_connection",
  "business_message",
  "edited_business_message",
  "deleted_business_messages",
  "purchased_paid_media",
  "managed_bot",
  "guest_message",
  "subscription",
  "stopped_message_generation",
]);
// Sent only to a bot that asks for them in allowed_updates.
const DEFAULT_EXCLUDED_UPDATES = Object.freeze([
  "chat_member",
  "message_reaction",
  "message_reaction_count",
]);
// What Telegram records as a webhook's last error when the connection fails:
// the system's error text (td::Status::public_message is strerror on Linux).
const CONNECTION_ERRORS = Object.freeze({
  ECONNREFUSED: "Connection refused",
  ECONNRESET: "Connection reset by peer",
  ETIMEDOUT: "Connection timed out",
  EHOSTUNREACH: "No route to host",
  ENETUNREACH: "Network is unreachable",
  EPIPE: "Broken pipe",
});
// Why a webhook's host name did not resolve, as glibc's gai_strerror says it
// (td IPAddress::init_host_port: "Failed to resolve host: " + gai_strerror).
// Any other code is EAI_SYSTEM, which libuv reports as the system error.
const RESOLVE_ERRORS = Object.freeze({
  EAI_NONAME: "Name or service not known",
  EAI_NODATA: "No address associated with hostname",
  EAI_AGAIN: "Temporary failure in name resolution",
  EAI_FAIL: "Non-recoverable failure in name resolution",
  EAI_MEMORY: "Memory allocation failure",
});
// How long after a callback query a bot that is not an administrator may send
// the user an ephemeral message.
// https://core.telegram.org/bots/api#ephemeral-messages-and-commands
const EPHEMERAL_REPLY_MS = 15_000;
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
  "options",
  "correct_option_ids",
  "entities",
  "caption_entities",
  "reaction",
]);

// The administrator rights promoteChatMember sets, in the order Telegram's
// Bot API server writes them (json_store_administrator_rights).
const ADMIN_RIGHTS = Object.freeze([
  "can_manage_chat",
  "can_change_info",
  "can_post_messages",
  "can_edit_messages",
  "can_delete_messages",
  "can_invite_users",
  "can_restrict_members",
  "can_pin_messages",
  "can_manage_topics",
  "can_promote_members",
  "can_manage_video_chats",
  "can_post_stories",
  "can_edit_stories",
  "can_delete_stories",
  "can_manage_direct_messages",
  "can_manage_tags",
  "can_send_welcome_messages",
  "is_anonymous",
]);
// Rights an administrator object has only in some kinds of chat.
const CHANNEL_ONLY_RIGHTS = Object.freeze([
  "can_post_messages",
  "can_edit_messages",
  "can_manage_direct_messages",
]);
const GROUP_ONLY_RIGHTS = Object.freeze([
  "can_pin_messages",
  "can_manage_tags",
]);
// What an administrator the owner appointed may do unless told otherwise.
const OWNER_ADMIN_RIGHTS = Object.freeze({
  can_manage_chat: true,
  can_change_info: true,
  can_post_messages: true,
  can_edit_messages: true,
  can_delete_messages: true,
  can_invite_users: true,
  can_restrict_members: true,
  can_pin_messages: true,
});

const CHAT_ACTIONS = new Set([
  "typing",
  "upload_photo",
  "record_video",
  "upload_video",
  "record_voice",
  "upload_voice",
  "upload_document",
  "choose_sticker",
  "find_location",
  "record_video_note",
  "upload_video_note",
]);

// sendDice emoji and the highest value each can roll.
const DICE = Object.freeze({
  "🎲": 6,
  "🎯": 6,
  "🎳": 6,
  "🏀": 5,
  "⚽": 5,
  "🎰": 64,
});

// The emoji a bot may react with: ReactionTypeEmoji's list, Bot API 10.3.
const REACTION_EMOJI = new Set(
  "❤ 👍 👎 🔥 🥰 👏 😁 🤔 🤯 😱 🤬 😢 🎉 🤩 🤮 💩 🙏 👌 🕊 🤡 🥱 🥴 😍 🐳 ❤‍🔥 🌚 🌭 💯 🤣 ⚡ 🍌 🏆 💔 🤨 😐 🍓 🍾 💋 🖕 😈 😴 😭 🤓 👻 👨‍💻 👀 🎃 🙈 😇 😨 🤝 ✍ 🤗 🫡 🎅 🎄 ☃ 💅 🤪 🗿 🆒 💘 🙉 🦄 😘 💊 🙊 😎 👾 🤷‍♂ 🤷 🤷‍♀ 😡".split(
    " ",
  ),
);

// What a member can post besides text and photos: the permission it needs,
// the file's extension, and whether it takes a caption.
const MEMBER_MEDIA = Object.freeze({
  video: { permission: "can_send_videos", ext: "mp4", caption: true },
  animation: {
    permission: "can_send_other_messages",
    ext: "mp4",
    caption: true,
  },
  sticker: { permission: "can_send_other_messages", ext: "webp" },
  voice: { permission: "can_send_voice_notes", ext: "ogg", caption: true },
  audio: { permission: "can_send_audios", ext: "mp3", caption: true },
  video_note: { permission: "can_send_video_notes", ext: "mp4" },
  document: { permission: "can_send_documents", ext: "bin", caption: true },
});

// The media editMessageMedia edits and replaces. A live photo also carries
// photo, and an animation document.
const MEDIA_KINDS = Object.freeze([
  "photo",
  "live_photo",
  "video",
  "animation",
  "audio",
  "document",
]);

// Each kind of file as TDLib has it (FileType.cpp): the name its errors
// print, and the directory it keeps the file in, where file_path starts
// (get_file_type_name). A chat photo is its ProfilePhoto.
const FILE_TYPES = Object.freeze({
  photo: { name: "Photo", directory: "photos" },
  chat_photo: { name: "ChatPhoto", directory: "profile_photos" },
  live_photo: { name: "LivePhotoVideo", directory: "photos" },
  video: { name: "Video", directory: "videos" },
  animation: { name: "Animation", directory: "animations" },
  document: { name: "Document", directory: "documents" },
  sticker: { name: "Sticker", directory: "stickers" },
  voice: { name: "VoiceNote", directory: "voice" },
  audio: { name: "Audio", directory: "music" },
  video_note: { name: "VideoNote", directory: "video_notes" },
});

// The kinds in TDLib's Photo class, each of which stands in only for itself;
// every other kind may stand in for any other (FileManager::check_input_file_id).
const PHOTO_KINDS = new Set(["photo", "chat_photo"]);

// The fields of a Bot API payload that hold a file_id, which differs per bot.
const FILE_ID_FIELDS = new Set(["file_id", "small_file_id", "big_file_id"]);

// The fields that give an inline keyboard button its action, in the order the
// Bot API server reads them (Client.cpp get_inline_keyboard_button_type): the
// first one set wins, and url and callback_data count only when non-empty.
const INLINE_BUTTON_ACTIONS = Object.freeze([
  "url",
  "callback_data",
  "callback_game",
  "pay",
  "switch_inline_query",
  "switch_inline_query_chosen_chat",
  "switch_inline_query_current_chat",
  "login_url",
  "web_app",
  "copy_text",
  "disabled",
]);

// The updates a channel's messages and their edits arrive as
// (https://core.telegram.org/bots/api#update).
const CHANNEL_UPDATES = Object.freeze({
  message: "channel_post",
  edited_message: "edited_channel_post",
});

// The field holding a message's content; a message with none of them is a
// service message. An animation also carries document, and a venue location,
// so they come first.
const CONTENT_FIELDS = Object.freeze([
  "text",
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
]);
// Content that takes a caption (TDLib can_have_message_content_caption).
const CAPTIONED_CONTENT = Object.freeze([
  "photo",
  ...Object.keys(MEMBER_MEDIA).filter((type) => MEMBER_MEDIA[type].caption),
]);
// Content a bot can edit (TDLib is_editable_message_content), and what
// editMessageMedia can replace (can_edit_message_media).
const EDITABLE_CONTENT = Object.freeze(["text", ...CAPTIONED_CONTENT]);
const MEDIA_EDITABLE_CONTENT = Object.freeze([
  "text",
  "photo",
  "video",
  "animation",
  "audio",
  "document",
]);
// The entities a quote keeps (https://core.telegram.org/bots/api#textquote).
const QUOTE_ENTITIES = Object.freeze([
  "bold",
  "italic",
  "underline",
  "strikethrough",
  "spoiler",
  "custom_emoji",
  "date_time",
]);
// Telegram's longest quote (TDLib's message_reply_quote_length_max default).
const QUOTE_LENGTH_MAX = 1024;

/** The content field a message carries, or null for a service message. */
function contentType(message) {
  return CONTENT_FIELDS.find((field) => message[field] !== undefined) ?? null;
}

// Bot API 10.3 methods documented to return True on success, plus the older
// names (kickChatMember, setStickerSetThumb) Telegram still routes to them.
// unimplemented: "ok" answers true only for these.
const TRUE_METHODS = new Set(
  `logOut close setWebhook deleteWebhook sendMessageDraft sendChatAction
  setMessageReaction setUserEmojiStatus banChatMember kickChatMember
  unbanChatMember restrictChatMember promoteChatMember
  setChatAdministratorCustomTitle setChatMemberTag banChatSenderChat
  unbanChatSenderChat setChatPermissions approveChatJoinRequest
  declineChatJoinRequest answerChatJoinRequestQuery sendChatJoinRequestWebApp
  setChatPhoto deleteChatPhoto setChatTitle setChatDescription pinChatMessage
  unpinChatMessage unpinAllChatMessages leaveChat setChatStickerSet
  deleteChatStickerSet editForumTopic closeForumTopic reopenForumTopic
  deleteForumTopic unpinAllForumTopicMessages editGeneralForumTopic
  closeGeneralForumTopic reopenGeneralForumTopic hideGeneralForumTopic
  unhideGeneralForumTopic unpinAllGeneralForumTopicMessages answerCallbackQuery
  setManagedBotAccessSettings setMyCommands deleteMyCommands setMyName
  setMyDescription setMyShortDescription setMyProfilePhoto removeMyProfilePhoto
  setChatMenuButton setMyDefaultAdministratorRights sendGift
  giftPremiumSubscription verifyUser verifyChat removeUserVerification
  removeChatVerification readBusinessMessage deleteBusinessMessages
  setBusinessAccountName setBusinessAccountUsername setBusinessAccountBio
  setBusinessAccountProfilePhoto removeBusinessAccountProfilePhoto
  setBusinessAccountGiftSettings transferBusinessAccountStars
  convertGiftToStars upgradeGift transferGift deleteStory
  editEphemeralMessageText editEphemeralMessageMedia
  editEphemeralMessageCaption editEphemeralMessageReplyMarkup
  approveSuggestedPost declineSuggestedPost deleteMessage deleteMessages
  deleteEphemeralMessage deleteMessageReaction deleteAllMessageReactions
  createNewStickerSet addStickerToSet setStickerPositionInSet
  deleteStickerFromSet replaceStickerInSet setStickerEmojiList
  setStickerKeywords setStickerMaskPosition setStickerSetTitle
  setStickerSetThumbnail setStickerSetThumb setCustomEmojiStickerSetThumbnail
  deleteStickerSet sendRichMessageDraft answerInlineQuery answerShippingQuery
  answerPreCheckoutQuery refundStarPayment editUserStarSubscription
  setPassportDataErrors`
    .split(/\s+/)
    .map((name) => name.toLowerCase()),
);

class TelegramError extends Error {
  constructor(code, description, parameters = null) {
    super(description);
    this.code = code;
    // The Bot API's ResponseParameters, when Telegram sends any.
    this.parameters = parameters;
  }
}

/**
 * A boolean parameter as Client::to_bool reads it: "true", "yes" or "1", in
 * any case and around spaces.
 */
function isTrue(value) {
  return ["true", "yes", "1"].includes(String(value).trim().toLowerCase());
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * A JSON-serialized parameter, undefined when it is absent or empty. Text
 * that is not JSON is still a string here, which Telegram refuses with
 * "can't parse <name> JSON object".
 */
function jsonParam(value, name) {
  if (value === undefined || value === "") return undefined;
  if (typeof value === "string") {
    throw new TelegramError(
      400,
      `Bad Request: can't parse ${name} JSON object`,
    );
  }
  return value;
}

/** A successful Bot API answer that also carries Telegram's description. */
class Described {
  constructor(result, description) {
    this.result = result;
    this.description = description;
  }
}

/**
 * A webhook URL as Telegram's Bot API server reads it (td::parse_url, with
 * https when no scheme is given), or null when Telegram refuses it.
 */
function parseWebhookUrl(url) {
  const scheme = /^[^:/?#@[\]]*/.exec(url)[0];
  let rest = url;
  let secure = true;
  if (url.startsWith("://", scheme.length)) {
    if (!["http", "https"].includes(scheme.toLowerCase())) return null;
    secure = scheme.toLowerCase() === "https";
    rest = url.slice(scheme.length + 3);
  }
  const authority = /^[^/?#]*/.exec(rest)[0];
  let colon = authority.length - 1;
  while (colon > 0 && !":]@".includes(authority[colon])) colon -= 1;
  let port = 0;
  let userinfoHost = authority;
  if (colon > 0 && authority[colon] === ":") {
    const digits = authority.slice(colon + 1).replace(/^0+(?=.)/, "");
    port = /^\d{1,5}$/.test(digits) && Number(digits) > 0 ? Number(digits) : -1;
    userinfoHost = authority.slice(0, colon);
  }
  if (port < 0 || port > 65535) return null;
  const at = userinfoHost.lastIndexOf("@");
  const userinfo = at < 0 ? "" : userinfoHost.slice(0, at);
  const host = userinfoHost.slice(at + 1).toLowerCase();
  const ipv6 = host.startsWith("[") && host.endsWith("]");
  if (ipv6 && !/^[0-9a-f:.]+$/.test(host.slice(1, -1))) return null;
  if (ipv6 && !net.isIPv6(host.slice(1, -1))) return null;
  if (!host || host === ".") return null;
  // Characters RFC 3986 allows, percent-encoded bytes and plain UTF-8.
  const valid = (part, extra) =>
    /^(?:[A-Za-z0-9.\-_!$,~*'();&+=\u0080-\uffff]|%[0-9A-Fa-f]{2})*$/.test(
      extra ? part.replaceAll(":", "") : part,
    );
  if (!ipv6 && (!valid(host, false) || !valid(userinfo, true))) return null;
  // Control characters and spaces in the path are sent percent-encoded.
  const query = rest.slice(authority.length).replace(/[\t\n\v\f\r \0]+$/, "");
  const path = (query.startsWith("/") ? "" : "/") + query;
  const effectivePort = port || (secure ? 443 : 80);
  const asciiHost = ipv6 ? host : domainToASCII(host) || host;
  return {
    https: secure,
    userinfo,
    hostname: ipv6 ? host.slice(1, -1) : asciiHost,
    port: effectivePort,
    hostHeader:
      effectivePort === (secure ? 443 : 80)
        ? asciiHost
        : `${asciiHost}:${effectivePort}`,
    path: path.replace(
      /[\u0000-\u0020]/g,
      (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`,
    ),
  };
}

/**
 * The address Telegram's Bot API server sends a webhook's updates to: the
 * first IPv4 address its host name resolves to, else the first IPv6 one (td
 * IPAddress::init_host_port, which WebhookActor runs with prefer_ipv6 false).
 * Resolves with { address } or with { error }, the text Telegram gives.
 */
async function resolveWebhookHost(hostname) {
  try {
    const addresses = await lookup(hostname, { all: true });
    return {
      address: (addresses.find(({ family }) => family === 4) ?? addresses[0])
        .address,
    };
  } catch (error) {
    const code =
      Number.isInteger(error.errno) && error.errno < 0
        ? getSystemErrorName(error.errno)
        : error.code;
    return {
      error: `Failed to resolve host: ${RESOLVE_ERRORS[code] ?? "System error"}`,
    };
  }
}

/**
 * What Telegram records as a webhook's last error when a connection fails, or
 * null when it records none: a connection closed without an answer is only
 * retried (WebhookActor::handle, "Webhook connection closed").
 */
function connectionErrorText(error, socket) {
  // td SslStream: "SSL error " and each OpenSSL error in braces, as
  // ERR_error_string_n writes it. With peer verification on, a certificate
  // that does not verify fails OpenSSL's handshake.
  if (socket?.authorizationError) {
    return "SSL error {error:0A000086:SSL routines::certificate verify failed}";
  }
  const ssl = [
    ...String(error.message).matchAll(
      /error:([0-9A-F]{8}):([^:\n]*):[^:\n]*:([^:\n]*)/g,
    ),
  ];
  if (ssl.length) {
    return `SSL error ${ssl.map(([, code, library, reason]) => `{error:${code}:${library}::${reason}}`).join("")}`;
  }
  // A failed system call, in strerror's words.
  return (error.syscall && CONNECTION_ERRORS[error.code]) || null;
}

/**
 * An integer parameter as Telegram's Bot API server reads one: its leading
 * digits, the fallback when it is empty, kept within min and max.
 */
function clampedInteger(value, fallback, min, max) {
  const text = String(value ?? "");
  const number = text === "" ? fallback : Number(/^-?\d+/.exec(text)?.[0] ?? 0);
  return Math.min(max, Math.max(min, number));
}

/** A request number, or the fallback when it is missing or not a number. */
function numberParam(value, fallback) {
  const number = Number(value);
  return value != null && value !== "" && Number.isFinite(number)
    ? number
    : fallback;
}

/** The field that gives an inline keyboard button its action, if any. */
function inlineButtonAction(button) {
  const fields = Object(button);
  return INLINE_BUTTON_ACTIONS.find((field) =>
    field === "url" || field === "callback_data"
      ? fields[field] != null && String(fields[field]) !== ""
      : Object.hasOwn(fields, field),
  );
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
    ...(user.is_premium === true ? { is_premium: true } : {}),
  };
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

/**
 * A JSON-serialized list parameter, read as Client::get_array reads it: null
 * is an empty list. A string here is text that was not JSON or, when it reads
 * as JSON, a JSON string, which is no list. read returns each item, or throws
 * an Error that says what is wrong with it.
 */
function jsonList(value, name, className, read) {
  if (typeof value === "string") {
    try {
      JSON.parse(value);
    } catch {
      throw new TelegramError(
        400,
        `Bad Request: can't parse ${name} JSON object`,
      );
    }
  }
  if (value === null) return [];
  if (!Array.isArray(value)) {
    throw new TelegramError(
      400,
      `Bad Request: expected an Array of ${className}`,
    );
  }
  return value.map((item) => {
    try {
      return read(item);
    } catch (error) {
      throw new TelegramError(
        400,
        `Bad Request: can't parse ${className}: ${error.message}`,
      );
    }
  });
}

/** A required string field of a JSON object in a list parameter. */
function requiredString(object, name) {
  const value = object[name];
  if (value === undefined) throw new Error(`Can't find field "${name}"`);
  if (typeof value === "number") return String(value);
  if (typeof value !== "string") {
    throw new Error(`Field "${name}" must be of type String`);
  }
  return value;
}

/** A ReactionType: only emoji and custom_emoji, so never a paid reaction. */
function reactionType(reaction) {
  if (!isObject(reaction)) throw new Error("expected an Object");
  const type = requiredString(reaction, "type");
  if (type === "emoji") {
    return { type, emoji: requiredString(reaction, "emoji") };
  }
  if (type === "custom_emoji") {
    if (reaction.custom_emoji_id === undefined) {
      throw new Error(`Can't find field "custom_emoji_id"`);
    }
    return reaction;
  }
  throw new Error("invalid reaction type specified");
}

/** An InputPollOption's text: the option itself, or its text field. */
function pollOptionText(option) {
  if (typeof option === "string") return option;
  if (!isObject(option)) {
    throw new Error("Expected InputPollOption to be an Object");
  }
  return requiredString(option, "text");
}

/**
 * A quiz's correct_option_ids, or else the older correct_option_id, read as
 * the Bot API server reads them.
 */
function correctOptionIds(p) {
  if (p.correct_option_ids === undefined) {
    return p.correct_option_id === undefined
      ? []
      : [Number.parseInt(String(p.correct_option_id), 10) || 0];
  }
  const ids = p.correct_option_ids;
  // As in jsonList, a string that reads as JSON was a JSON string.
  if (typeof ids === "string") {
    try {
      JSON.parse(ids);
    } catch {
      throw new TelegramError(
        400,
        "Bad Request: can't parse correct option identifiers JSON object",
      );
    }
  }
  if (!Array.isArray(ids)) {
    throw new TelegramError(
      400,
      "Bad Request: expected an Array of correct option identifiers",
    );
  }
  return ids.map((id) => {
    if (typeof id !== "number") {
      throw new TelegramError(
        400,
        "Bad Request: correct option identifier must be of type Number",
      );
    }
    if (!Number.isInteger(id) || id < -(2 ** 31) || id >= 2 ** 31) {
      throw new TelegramError(
        400,
        "Bad Request: invalid correct option identifier specified",
      );
    }
    return id;
  });
}

/**
 * A JSON body's parameters as Telegram's HTTP reader takes them: the fields of
 * a top-level object up to the first malformed one, or a top-level string as
 * "content"; anything else gives none, and a parse error is no error
 * (tdnet HttpReader::parse_json_parameters, td::do_json_skip).
 */
function jsonBodyEntries(text) {
  const entries = [];
  let at = 0;
  const space = () => {
    while (at < text.length && " \t\r\n".includes(text[at])) at += 1;
  };
  // The JSON string at `at`, decoded, or undefined when it is malformed.
  const string = () => {
    const pattern = /"(?:[^"\\]|\\.)*"/y;
    pattern.lastIndex = at;
    const match = pattern.exec(text);
    if (!match) return undefined;
    at += match[0].length;
    try {
      return JSON.parse(match[0]);
    } catch {
      return undefined;
    }
  };
  // Skips one value; false when it is malformed.
  const skip = () => {
    space();
    const open = text[at];
    if (open === '"') return string() !== undefined;
    if (open === "{" || open === "[") {
      const close = open === "{" ? "}" : "]";
      at += 1;
      space();
      if (text[at] !== close) {
        for (;;) {
          if (at >= text.length) return false;
          if (close === "}") {
            if (string() === undefined) return false;
            space();
            if (text[at] !== ":") return false;
            at += 1;
          }
          if (!skip()) return false;
          space();
          if (text[at] === close) break;
          if (text[at] !== ",") return false;
          at += 1;
          space();
        }
      }
      at += 1;
      return true;
    }
    const literal = /true|false|null|[-+.0-9][-+.0-9eE]*/y;
    literal.lastIndex = at;
    const match = literal.exec(text);
    if (match) at += match[0].length;
    return match !== null;
  };
  space();
  if (text[at] === '"') {
    const content = string();
    return content !== undefined && at === text.length
      ? [["content", content]]
      : [];
  }
  if (text[at] !== "{") return entries;
  at += 1;
  for (;;) {
    space();
    if (at >= text.length || text[at] === "}") return entries;
    const key = string();
    space();
    if (key === undefined || text[at] !== ":") return entries;
    at += 1;
    space();
    const start = at;
    let value;
    if (text[at] === '"') {
      value = string();
      if (value === undefined) return entries;
    } else {
      if (!skip()) return entries;
      try {
        value = JSON.parse(text.slice(start, at));
      } catch {
        value = text.slice(start, at);
      }
    }
    entries.push([key, value]);
    space();
    if (text[at] === ",") at += 1;
    else if (text[at] !== "}") return entries;
  }
}

/**
 * A Bot API request's parameters: the query string, then a form or JSON body.
 * As on Telegram, a body of another type is ignored, and only form data that
 * cannot be read is refused (tdnet HttpReader).
 */
async function readRequestParams(request, body) {
  const url = new URL(request.url, "http://localhost");
  const params = coerceParams(url.searchParams.entries());
  if (!body.length) return params;
  const type = String(request.headers["content-type"] ?? "");
  const lowerType = type.toLowerCase();
  if (
    !lowerType.includes("multipart/form-data") &&
    !lowerType.includes("application/x-www-form-urlencoded")
  ) {
    return lowerType.includes("application/json")
      ? { ...params, ...coerceParams(jsonBodyEntries(body.toString("utf8"))) }
      : params;
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
      typeof value === "string" ? value : await uploadedFile(value),
    ]);
  }
  return { ...params, ...coerceParams(entries) };
}

/** An uploaded part's bytes, carrying the file name and type it was sent with. */
async function uploadedFile(file) {
  const bytes = Buffer.from(await file.arrayBuffer());
  if (file.name) bytes.fileName = file.name;
  // A part's type may carry parameters ("text/plain;charset=utf-8"); Telegram
  // reports the bare media type.
  const type = file.type.split(";")[0].trim().toLowerCase();
  if (type && type !== "application/octet-stream") bytes.mimeType = type;
  return bytes;
}

const MIME_TYPES = {
  txt: "text/plain",
  csv: "text/csv",
  html: "text/html",
  md: "text/markdown",
  json: "application/json",
  pdf: "application/pdf",
  zip: "application/zip",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
  mp4: "video/mp4",
};

function guessMimeType(fileName) {
  const extension = /\.([a-z0-9]+)$/i.exec(fileName ?? "")?.[1]?.toLowerCase();
  return extension ? MIME_TYPES[extension] : undefined;
}

/**
 * A photo's width and height from its PNG, GIF or JPEG header, scaled down to
 * Telegram's largest photo size, "bounded by 2560x2560 pixels"
 * (https://core.telegram.org/api/files); none when the header is unreadable.
 */
function photoDimensions(bytes) {
  let size = null;
  if (bytes.length >= 24 && bytes.toString("latin1", 1, 4) === "PNG") {
    size = [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
  } else if (bytes.length >= 10 && bytes.toString("latin1", 0, 4) === "GIF8") {
    size = [bytes.readUInt16LE(6), bytes.readUInt16LE(8)];
  } else if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    // A JPEG's frame header (SOF0 to SOF15, but not DHT, JPG or DAC) holds it.
    for (let at = 2; at + 9 <= bytes.length && bytes[at] === 0xff; ) {
      const marker = bytes[at + 1];
      if (
        marker >= 0xc0 &&
        marker <= 0xcf &&
        ![0xc4, 0xc8, 0xcc].includes(marker)
      ) {
        size = [bytes.readUInt16BE(at + 7), bytes.readUInt16BE(at + 5)];
        break;
      }
      at += 2 + bytes.readUInt16BE(at + 2);
    }
  }
  if (!size?.[0] || !size[1]) return {};
  const scale = Math.min(1, 2560 / Math.max(...size));
  return {
    width: Math.round(size[0] * scale),
    height: Math.round(size[1] * scale),
  };
}

/**
 * Why Telegram cannot read a string as a file_id, in TDLib's words
 * (FileManager::from_persistent_id and tdutils' base64url_decode).
 */
function unreadableFileId(id) {
  const wrong = "wrong remote file identifier specified: ";
  const body = id.replace(/=+$/, "");
  const padding = id.length - body.length;
  if (padding >= 3) return `${wrong}Wrong string padding`;
  if (padding > 0 && id.length % 4 !== 0) return `${wrong}Wrong padding length`;
  if (body.length % 4 === 1) return `${wrong}Wrong string length`;
  if (/[^\w-]/.test(body)) return `${wrong}Wrong character in the string`;
  const bytes = Buffer.from(body, "base64url");
  if (bytes.toString("base64url") !== body) {
    return `${wrong}Wrong padding in the string`;
  }
  // The last byte names the id's format: 2, 3 or 4 (FileManager.h). Format 4
  // puts a serialization version before it, below Version::Next, 62
  // (Version.h).
  const format = bytes.at(-1);
  if (format === 4 && (bytes.length < 2 || bytes.at(-2) >= 62)) {
    return "invalid remote file identifier";
  }
  if (![2, 3, 4].includes(format)) {
    return `${wrong}can't unserialize it. Wrong last symbol`;
  }
  return `${wrong}can't unserialize it`;
}

/**
 * Why TDLib's parse_url cannot read a file's HTTP URL, or null when it can
 * (tdutils HttpUrl.cpp). A URL without a protocol reads as http.
 */
function unparsableUrl(url) {
  const protocol = /^([^:/?#@[\]]*):\/\//.exec(url);
  if (protocol && !["http", "https"].includes(protocol[1].toLowerCase())) {
    return "Unsupported URL protocol";
  }
  const authority = url
    .slice(protocol ? protocol[0].length : 0)
    .split(/[/?#]/)[0];
  let colon = authority.length - 1;
  while (colon > 0 && !":]@".includes(authority[colon])) colon -= 1;
  let userinfoHost = authority;
  if (colon > 0 && authority[colon] === ":") {
    const port = authority.slice(colon + 1);
    if (!/^0*[1-9]\d*$/.test(port) || Number(port) > 65535) {
      return "Wrong port number specified in the URL";
    }
    userinfoHost = authority.slice(0, colon);
  }
  const at = userinfoHost.lastIndexOf("@");
  const userinfo = at === -1 ? "" : userinfoHost.slice(0, at);
  const host = userinfoHost.slice(at + 1);
  const ipv6 = host.startsWith("[") && host.endsWith("]");
  if (ipv6) {
    const address = host.length > 2 ? host.slice(1, -1) : host;
    // inet_pton takes no zone index.
    if (!net.isIPv6(address) || address.includes("%")) {
      return "Wrong IPv6 address specified in the URL";
    }
  }
  if (host === "") return "URL host is empty";
  if (host === ".") return "Host is invalid";
  if (ipv6) return null;
  // Letters, digits, RFC 3986's other allowed characters, percent-encoded
  // bytes and any non-ASCII character.
  const disallowed = (part, name, colonAllowed) => {
    for (let i = 0; i < part.length; i += 1) {
      const char = part[i];
      if (
        /[\w.\-!$,~*'();&+=]/.test(char) ||
        (colonAllowed && char === ":") ||
        char.charCodeAt(0) >= 128
      ) {
        continue;
      }
      if (char !== "%") return `Disallowed character in URL ${name}`;
      if (!/^[\da-f]{2}$/i.test(part.slice(i + 1, i + 3))) {
        return `Wrong percent-encoded symbol in URL ${name}`;
      }
      i += 2;
    }
    return null;
  };
  return (
    disallowed(host, "host", false) ?? disallowed(userinfo, "userinfo", true)
  );
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
 *   floodControl?: boolean,
 *   log?: (line: string) => void,
 * }} options
 */
export async function startTestServer({
  port = 0,
  host = "127.0.0.1",
  botToken,
  botUsername = "fake_test_bot",
  botName = "Fake Test Bot",
  supportsJoinRequestQueries = false,
  chats: chatConfigs = [],
  publicChats = [],
  unimplemented: unimplementedMode = "error",
  loginClientSecret,
  clock: clockOptions,
  floodControl = false,
  log = () => {},
}) {
  if (unimplementedMode !== "error" && unimplementedMode !== "ok") {
    throw new TypeError('unimplemented must be "error" or "ok"');
  }
  const clock = createClock(clockOptions);
  const waits = createWaits();
  const execution = new AsyncLocalStorage();
  const now = () => Math.floor(clock.now() / 1000);
  const instanceId = randomBytes(12).toString("hex");
  let epoch = 0;
  let stopped = false;
  let stopPromise;
  const responseClosures = new Set();
  // Webhook connections are kept open between updates, as Telegram keeps them.
  const agents = {
    http: new http.Agent({ keepAlive: true }),
    https: new https.Agent({ keepAlive: true }),
  };
  // For each Bot API call, a signal that its client hung up before an answer.
  const clientGone = new WeakMap();
  // Webhook attempts under way, and the first unexpected error one raised.
  const deliveries = new Set();
  let deliveryError = null;
  let activeControls = 0;
  let activeOwners = 0;
  let activeHttp = 0;
  let deliveryCount = 0;
  const deliveryJournal = [];
  const deliveryAttempts = new Map();
  const snapshots = new Map();
  const joinDecisions = new Map();
  const expiryTasks = new Map();
  const users = new Map();
  // Every bot this server answers for, by token. Each keeps its own webhook,
  // update queue and commands, as separate bots do on Telegram.
  const bots = new Map();
  function addBot({
    token,
    username,
    firstName,
    joinRequestQueries = false,
    loginClientSecret: secret,
  }) {
    const id = Number(String(token).split(":")[0]);
    if (!Number.isSafeInteger(id) || !String(token).includes(":")) {
      throw new TypeError(
        "Fake Telegram needs a bot token of the form <id>:<secret>",
      );
    }
    if (bots.has(token)) return bots.get(token);
    if (users.has(id)) throw new TypeError(`User ${id} already exists`);
    const record = {
      id,
      is_bot: true,
      first_name: firstName ?? username,
      username,
      photos: [],
      token,
      webhook: null,
      // The update types the bot subscribed to, set by setWebhook or
      // getUpdates; null for Telegram's default.
      subscription: null,
      // Updates not yet confirmed, by getUpdates or by the webhook, in order:
      // Telegram's update queue for the bot. Ids continue from the last one.
      queue: [],
      lastUpdateId: Math.floor(clock.now() / 1000),
      // The waiting getUpdates call and webhook attempts, by update_id.
      pollWaiters: new Set(),
      sending: new Map(),
      // When Telegram next answers a getUpdates conflict at once.
      nextConflictAt: 0,
      // When floodControl next lets setWebhook set a URL.
      nextSetWebhookAt: 0,
      // Command lists by scope and language (see commandsKey).
      commands: new Map(),
      // A guard bot that gets join request queries (Bot API 10.x).
      joinRequestQueries: joinRequestQueries === true,
      // The Telegram Login client secret BotFather shows for the bot.
      loginClientSecret:
        typeof secret === "string" && secret !== ""
          ? secret
          : randomBytes(24).toString("base64url"),
    };
    bots.set(token, record);
    users.set(id, record);
    return record;
  }
  // The bot the server starts with: the one in every configured chat.
  let bot = addBot({
    token: botToken,
    username: botUsername,
    firstName: botName,
    joinRequestQueries: supportsJoinRequestQueries,
    loginClientSecret,
  });
  // Join request queries awaiting answerChatJoinRequestQuery, by query id.
  const joinQueries = new Map();
  // Stored files by file_id, each as { file, botId }. "file_id is unique for
  // each individual bot and can't be transferred from one bot to another"
  // (https://core.telegram.org/bots/api#sending-files): every bot that sees a
  // file gets its own file_id for it, and all share its file_unique_id.
  const files = new Map();
  // The ChatPhoto files of chat and user photos, by the photo's
  // file_unique_id.
  const chatPhotos = new Map();
  // Owner accounts: what a user sees on their own account (owner.js).
  const ownerModel = createOwnerModel({
    log,
    now: clock.now,
    isStopped: () => stopped,
    sleep: delayResponse,
  });
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
  // Business connections (Bot API 7.2+), by id: an account owner connects a
  // bot to answer their private chats.
  // https://core.telegram.org/bots/api#businessconnection
  const businessConnections = new Map();
  // Every update sent, by update_id, with the bot it went to and its exact
  // bytes, so a test can have Telegram deliver it again.
  const sentUpdates = new Map();
  // Counts the moments updates become ready for a webhook, so updates ready
  // at the same server time still go in the order that happened.
  let readyOrder = 0;
  const callbackAnswers = new Map();
  // Callback queries awaiting an answer; any other id is refused.
  const openQueries = new Map();
  // Callback queries sent to bots in the last 15 seconds, by id: a bot that is
  // not an administrator may answer one with an ephemeral message.
  const recentQueries = new Map();
  const calls = [];
  const rejectedRequests = [];
  const callIndex = new Map();
  const rejectedRequestIndex = new Map();
  let requestSequence = 0;
  const unimplemented = new Set();
  /** Reports, once, a method (or a mode of one) this server does not have. */
  function reportUnimplemented(name) {
    if (unimplemented.has(name)) return;
    unimplemented.add(name);
    log(`unimplemented Bot API method ${name}`);
  }
  // Calls a test asked to fail: the next `times` calls of a method (to one
  // chat, from one bot, when named) answer the error, or take effect and never
  // answer.
  const failures = [];
  // Webhook requests in progress, aborted on stop().
  const inFlight = new Set();
  // Telegram never reuses an update, member or message id, and bots commonly
  // treat a repeated one as already handled; counters start from the clock so
  // a restarted fake does not repeat the previous run's ids.
  const startSeconds = Math.floor(clock.now() / 1000);
  let nextUserId = 7_000_000_000 + startSeconds;
  let nextChatId = startSeconds;
  // Basic groups have their own ids: negative, without the -100 prefix.
  let nextBasicGroupId = 4_000_000_000 + (startSeconds % 100_000_000);
  let nextMediaGroupId = BigInt(startSeconds) * 1_000_000n;
  let nextPollId = BigInt(startSeconds) * 1_000_000n;

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
      nextMessageId: Math.max(1, startSeconds - 1_700_000_000),
      inviteLinks: new Map(),
      joinedVia: new Map(),
      joinRequests: new Map(),
      permissions: { ...ALL_PERMISSIONS },
    });
  }

  /** Client::check_chat's first check: chat_id must be given. */
  function requireChatId(chatId) {
    if (chatId == null || chatId === "") {
      throw new TelegramError(400, "Bad Request: chat_id is empty");
    }
  }

  /**
   * The group or channel chat_id names. A Bot API call passes its caller, and
   * the chat must then be one the bot may use (checkChatAccess); the control
   * API passes none.
   */
  function requireChat(chatId, caller = null, access = {}) {
    requireChatId(chatId);
    const chat = chats.get(Number(chatId));
    if (!chat) throw new TelegramError(400, "Bad Request: chat not found");
    if (caller) checkChatAccess(chat, caller, access);
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
    const chat = privateChats.get(id);
    // The user opened it, so it no longer depends on a join request.
    delete chat.contactOnly;
    return chat;
  }

  /**
   * The chat a Bot API call addresses; a group or channel is checked as
   * requireChat checks it. A bot cannot open a private chat: it can only
   * write to users who have messaged it first, as on Telegram, or, for a send
   * (`send`), to someone whose join request it may answer.
   */
  function botChat(chatId, caller, { send = false, ...access } = {}) {
    requireChatId(chatId);
    const id = Number(chatId);
    if (chats.has(id)) return requireChat(id, caller, access);
    if (privateChats.has(id)) return privateChats.get(id);
    const user = users.get(id);
    if (user && !user.is_bot) {
      if (send && joinRequestContact(id, caller)) {
        const chat = messageChat(id);
        chat.contactOnly = true;
        return chat;
      }
      throw new TelegramError(
        403,
        "Forbidden: bot can't initiate conversation with a user",
      );
    }
    throw new TelegramError(400, "Bad Request: chat not found");
  }

  /**
   * Whether the bot may message a user through ChatJoinRequest.user_chat_id:
   * "for 5 minutes ... until the join request is processed", in a chat where
   * it receives join requests.
   */
  function joinRequestContact(userId, record) {
    return [...chats.values()].some((chat) => {
      const request = chat.joinRequests.get(Number(userId));
      return (
        request != null &&
        now() < request.date + 300 &&
        receives(chat, record, "chat_join_request")
      );
    });
  }

  /**
   * user_id, or another user id parameter, as Client::get_user_id reads it:
   * the integer its leading digits spell, which must be positive.
   */
  function userIdParam(value, field = "user_id") {
    const id = parseInt(String(value ?? ""), 10);
    if (!(id > 0)) {
      throw new TelegramError(400, `Bad Request: invalid ${field} specified`);
    }
    return id;
  }

  function requireUser(userId) {
    const user = users.get(Number(userId));
    if (!user) throw new TelegramError(400, "Bad Request: user not found");
    return user;
  }

  /**
   * The command list a setMyCommands, getMyCommands or deleteMyCommands call
   * addresses: Telegram keeps one per scope and language_code. The scope is
   * read as Client::get_bot_command_scope reads it, and its chat checked as
   * check_bot_command_scope checks it; then TDLib allows only the "chat"
   * scope in a private chat and none in a channel
   * (BotCommandScope::get_bot_command_scope), and a language_code that is
   * empty or two lower-case letters (validate_bot_language_code).
   */
  function commandsKey(p, caller) {
    const scope = jsonParam(p.scope, "BotCommandScope");
    let type = "default";
    let chatId = null;
    let userId = null;
    try {
      if (scope !== undefined) {
        if (!isObject(scope)) {
          throw new Error("BotCommandScope must be an Object");
        }
        type = requiredString(scope, "type");
      }
      if (["chat", "chat_administrators", "chat_member"].includes(type)) {
        chatId = requiredString(scope, "chat_id");
        if (chatId === "") throw new Error("Empty chat_id specified");
      } else if (
        ![
          "default",
          "all_private_chats",
          "all_group_chats",
          "all_chat_administrators",
        ].includes(type)
      ) {
        throw new Error("Unsupported type specified");
      }
      if (type === "chat_member") {
        const value = scope.user_id;
        if (value === undefined) throw new Error(`Can't find field "user_id"`);
        if (!["number", "string"].includes(typeof value)) {
          throw new Error(`Field "user_id" must be a Number`);
        }
        if (!/^-?\d+$/.test(String(value))) {
          throw new Error(`Field "user_id" must be a valid Number`);
        }
        userId = Number(value);
        if (userId <= 0) throw new Error("Invalid user_id specified");
      }
    } catch (error) {
      throw new TelegramError(
        400,
        `Bad Request: can't parse BotCommandScope: ${error.message}`,
      );
    }
    if (chatId !== null) {
      chatId = Number(chatId);
      const chat = chats.has(chatId) ? requireChat(chatId, caller) : null;
      if (!chat && !users.has(chatId)) {
        throw new TelegramError(400, "Bad Request: chat not found");
      }
      if (!chat && type !== "chat") {
        throw new TelegramError(
          400,
          "Bad Request: can't use specified scope in private chats",
        );
      }
      if (chat?.type === "channel") {
        throw new TelegramError(
          400,
          "Bad Request: can't change commands in channel chats",
        );
      }
    }
    const language = String(p.language_code ?? "");
    if (language !== "" && !/^[a-z]{2}$/.test(language)) {
      throw new TelegramError(
        400,
        "Bad Request: invalid language code specified",
      );
    }
    return JSON.stringify([type, chatId, userId, language]);
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
    return {
      id: chat.id,
      title: chat.title,
      type: chat.type,
      ...(chat.topics ? { is_forum: true } : {}),
    };
  }

  function memberStatus(chat, userId) {
    const id = Number(userId);
    let member = chat.members.get(id) ?? { status: "left" };
    if (
      ["restricted", "kicked"].includes(member.status) &&
      member.until_date > 0 &&
      member.until_date <= Math.floor(clock.now() / 1000)
    ) {
      member = {
        status:
          member.status === "restricted" && member.is_member !== false
            ? "member"
            : "left",
      };
      chat.members.set(id, member);
    }
    return member;
  }

  /**
   * The administrator rights this kind of chat has: a channel administrator
   * posts and edits; a group administrator pins, and only a supergroup has
   * topics.
   */
  function chatAdminRights(chat) {
    return ADMIN_RIGHTS.filter((right) =>
      chat.type === "channel"
        ? !GROUP_ONLY_RIGHTS.includes(right) && right !== "can_manage_topics"
        : !CHANNEL_ONLY_RIGHTS.includes(right) &&
          (right !== "can_manage_topics" || chat.type === "supergroup"),
    );
  }

  /** The member's ChatMember object, as the given bot sees it. */
  function chatMemberObject(chat, userId, viewer = null) {
    return memberObject(chat, userId, memberStatus(chat, userId), viewer);
  }

  /**
   * A ChatMember object for one state of a member. can_be_edited belongs to
   * the bot that asks: only the bot that promoted an administrator may edit it.
   */
  function memberObject(chat, userId, member, viewer = null) {
    const user = requireUser(userId);
    const base = { user: userObject(user), status: member.status };
    if (member.status === "administrator") {
      const granted = { ...OWNER_ADMIN_RIGHTS, ...(member.rights ?? {}) };
      const rights = chatAdminRights(chat);
      return {
        ...base,
        can_be_edited: viewer != null && member.promotedBy === viewer.id,
        ...Object.fromEntries(
          rights.map((right) => [right, granted[right] === true]),
        ),
        ...(member.customTitle ? { custom_title: member.customTitle } : {}),
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

  /** Whether a member holds an administrator right (a creator holds all). */
  function hasRight(chat, userId, right) {
    const member = memberStatus(chat, userId);
    if (member.status === "creator") return true;
    if (member.status !== "administrator") return false;
    return chatMemberObject(chat, userId)[right] === true;
  }

  function chatKind(chat) {
    return chat.type === "channel" || chat.type === "group"
      ? chat.type
      : "supergroup";
  }

  /**
   * Refuse a call to a group or channel the way Telegram's Bot API server does
   * once the method has read its other arguments (Client.cpp check_chat and
   * check_chat_access): a chat the bot was never in is not found; a bot
   * kicked from or no longer in a supergroup or channel is refused even
   * reads; in a basic group a bot that left or was removed may still make the
   * calls that only read (`readOnly`, AccessRights::Read), but nothing else.
   * An upgraded basic group answers with the new chat id, except to getChat,
   * leaveChat and the source of a forward, copy or reply (`readsUpgraded`).
   */
  function checkChatAccess(chat, caller, { readOnly, readsUpgraded } = {}) {
    if (!chat.members.has(caller.id)) {
      throw new TelegramError(400, "Bad Request: chat not found");
    }
    if (chat.migratedTo != null && !readsUpgraded) {
      throw new TelegramError(
        400,
        "Bad Request: group chat was upgraded to a supergroup chat",
        { migrate_to_chat_id: chat.migratedTo },
      );
    }
    if (chat.type === "group" && readOnly) return;
    if (memberStatus(chat, caller.id).status === "kicked") {
      throw new TelegramError(
        403,
        `Forbidden: bot was kicked from the ${chatKind(chat)} chat`,
      );
    }
    if (!isInChat(chat, caller.id)) {
      throw new TelegramError(
        403,
        `Forbidden: bot is not a member of the ${chatKind(chat)} chat`,
      );
    }
  }

  /** Refuse a bot's send the way Telegram does when it may not post there. */
  function requireCanSend(chat, caller) {
    // A private chat here is with the first bot: users write only to it, and
    // no other bot may message someone who never wrote to that bot.
    if (chat.type === "private") {
      if (joinRequestContact(chat.id, caller)) return;
      // A business connection gives its bot the owner's private chat
      // (BusinessConnection.user_chat_id).
      if (
        caller.id === bot.id ? chat.contactOnly : !chat.openTo?.has(caller.id)
      ) {
        throw new TelegramError(
          403,
          "Forbidden: bot can't initiate conversation with a user",
        );
      }
      return;
    }
    const member = memberStatus(chat, caller.id);
    if (
      chat.type === "channel" &&
      !hasRight(chat, caller.id, "can_post_messages")
    ) {
      throw new TelegramError(
        400,
        "Bad Request: need administrator rights in the channel chat",
      );
    }
    if (
      member.status === "restricted" &&
      member.permissions?.can_send_messages !== true
    ) {
      throw new TelegramError(
        400,
        "Bad Request: not enough rights to send text messages to the chat",
      );
    }
  }

  /** A send into a forum names a topic that exists, or none (General). */
  function requireTopic(chat, threadId) {
    if (!threadId || !chat.topics) return;
    if (!chat.topics.has(Number(threadId))) {
      throw new TelegramError(400, "Bad Request: message thread not found");
    }
  }

  /** A group pins with can_pin_messages, a channel with can_edit_messages. */
  function requirePinRights(chat, caller) {
    if (chat.type === "private") return;
    const right =
      chat.type === "channel" ? "can_edit_messages" : "can_pin_messages";
    if (!hasRight(chat, caller.id, right)) {
      throw new TelegramError(
        400,
        "Bad Request: not enough rights to manage pinned messages in the chat",
      );
    }
  }

  /**
   * The most recent pinned message by sending date, which getChat shows and
   * unpinChatMessage without message_id unpins. chat.pinned is kept newest
   * first by message id, which follows the sending date.
   */
  function latestPin(chat) {
    return (chat.pinned ?? [])
      .map((id) => chat.messages.get(id))
      .find((entry) => entry && !entry.deleted);
  }

  /** A pinned message as the Bot API shows it: without reply_to_message. */
  function pinnedMessage(message) {
    const { reply_to_message: _reply, ...pinned } = message;
    return pinned;
  }

  /**
   * Pin a message for whoever pinned it, keeping chat.pinned newest first.
   * Returns the pinned_message service message Telegram posts for the pin.
   */
  function pin(chat, entry, from) {
    const id = entry.message.message_id;
    chat.pinned = [...new Set([id, ...(chat.pinned ?? [])])].sort(
      (a, b) => b - a,
    );
    return addMessage(chat, from, {
      pinned_message: pinnedMessage(entry.message),
    });
  }

  /**
   * Whether the user may post, given their own and the chat's permissions. A
   * channel's subscribers have none: TDLib keeps no member permissions in a
   * broadcast channel (RestrictedRights with ChannelType::Broadcast).
   */
  function canPost(chat, userId, permission = "can_send_messages") {
    const member = memberStatus(chat, userId);
    if (!isInChat(chat, userId)) return false;
    if (["creator", "administrator"].includes(member.status)) return true;
    if (chat.type === "channel") return false;
    if (
      member.status === "restricted" &&
      member.permissions[permission] !== true
    ) {
      return false;
    }
    return chat.permissions[permission] === true;
  }

  /** promoteChatMember and unbanChatMember work only there. */
  function requireSupergroupOrChannel(chat) {
    if (chat.type === "group") {
      throw new TelegramError(
        400,
        "Bad Request: method is available only in supergroup and channel chats",
      );
    }
  }

  /** Refuse a bot without the right, with the text TDLib gives for the call. */
  function requireRight(chat, caller, right, description) {
    if (!hasRight(chat, caller.id, right)) {
      throw new TelegramError(400, `Bad Request: ${description}`);
    }
  }

  function restrictionUntil(value) {
    const until = Number(value ?? 0);
    const duration = until - Math.floor(clock.now() / 1000);
    return duration < 30 || duration > 366 * 86400 ? 0 : until;
  }

  function requireDeleteRights(chat, entry, caller) {
    const age = Math.floor(clock.now() / 1000) - entry.message.date;
    if (
      age >= 48 * 3600 ||
      entry.message.supergroup_chat_created ||
      entry.message.channel_chat_created ||
      entry.message.forum_topic_created ||
      (chat.type === "private" && entry.message.dice && age <= 24 * 3600)
    ) {
      throw new TelegramError(400, "Bad Request: message can't be deleted");
    }
    if (chat.type === "private") return;
    const own = entry.author === caller.id;
    const allowed =
      hasRight(chat, caller.id, "can_delete_messages") ||
      (chat.type === "group" &&
        memberStatus(chat, caller.id).status === "administrator") ||
      (own &&
        (chat.type !== "channel" ||
          hasRight(chat, caller.id, "can_post_messages")));
    if (!allowed)
      throw new TelegramError(400, "Bad Request: message can't be deleted");
  }

  /**
   * Telegram refuses to restrict or remove the chat owner, an administrator
   * or the bot itself.
   */
  function assertCanModerate(chat, userId, { self, caller = bot } = {}) {
    if (Number(userId) === caller.id && self) {
      throw new TelegramError(400, `Bad Request: ${self}`);
    }
    // A basic group removes members through messages.deleteChatUser, which
    // answers a non-administrator with CHAT_ADMIN_REQUIRED.
    requireRight(
      chat,
      caller,
      "can_restrict_members",
      chat.type === "group"
        ? "CHAT_ADMIN_REQUIRED"
        : "not enough rights to restrict/unrestrict chat member",
    );
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
   * `link` is the invite link they joined through, if any; it is kept apart
   * from the member's status, which restricting or promoting them replaces.
   */
  function admit(chat, userId, link = null) {
    const current = memberStatus(chat, userId);
    chat.members.set(
      Number(userId),
      current.status === "restricted"
        ? { ...current, is_member: true }
        : { status: "member" },
    );
    if (link) chat.joinedVia.set(Number(userId), link);
    else chat.joinedVia.delete(Number(userId));
  }

  /** Managing invite links needs the can_invite_users administrator right. */
  function requireInviteRights(chat, caller) {
    if (!hasRight(chat, caller.id, "can_invite_users")) {
      throw new TelegramError(
        400,
        "Bad Request: not enough rights to manage chat invite link",
      );
    }
  }

  /**
   * Store an invite link of the caller's: a new one, https://t.me/+ and an
   * opaque hash, or the edited `fields.invite_link`.
   */
  function addInviteLink(chat, caller, fields = {}) {
    const invite = {
      invite_link:
        fields.invite_link ??
        `https://t.me/+${randomBytes(12).toString("base64url")}`,
      ...(fields.name ? { name: fields.name } : {}),
      creator: userObject(caller),
      ...(fields.expire_date ? { expire_date: fields.expire_date } : {}),
      ...(fields.member_limit ? { member_limit: fields.member_limit } : {}),
      creates_join_request: fields.creates_join_request === true,
      is_primary: fields.is_primary === true,
      is_revoked: false,
    };
    chat.inviteLinks.set(invite.invite_link, invite);
    return invite;
  }

  /**
   * Each administrator has a primary link of their own; a new one revokes
   * only that administrator's previous one.
   */
  function replacePrimaryLink(chat, caller) {
    for (const invite of chat.inviteLinks.values()) {
      if (invite.is_primary && invite.creator.id === caller.id) {
        invite.is_revoked = true;
      }
    }
    return addInviteLink(chat, caller, { is_primary: true });
  }

  /** The caller's current primary link, generated when it has none. */
  function primaryLink(chat, caller) {
    const current = [...chat.inviteLinks.values()].find(
      (invite) =>
        invite.is_primary &&
        !invite.is_revoked &&
        invite.creator.id === caller.id,
    );
    return current ?? replacePrimaryLink(chat, caller);
  }

  /**
   * The fields of a link to create or edit, read as Telegram's server reads
   * them: one left out takes its default, a negative expire_date is 0 and
   * member_limit is clamped to 0-100000 (Client::get_integer_arg).
   */
  function inviteLinkFields(p) {
    const fields = {
      name: p.name ? String(p.name) : "",
      expire_date: Math.max(0, Math.trunc(Number(p.expire_date)) || 0),
      member_limit: Math.min(
        100000,
        Math.max(0, Math.trunc(Number(p.member_limit)) || 0),
      ),
      creates_join_request: isTrue(p.creates_join_request),
    };
    if (fields.creates_join_request && fields.member_limit) {
      throw new TelegramError(
        400,
        "Bad Request: member limit can't be specified for links requiring administrator approval",
      );
    }
    return fields;
  }

  /**
   * Whether a link no longer admits anyone: revoked, past its expire_date, or
   * already holding member_limit members who joined through it.
   */
  function inviteExpired(chat, invite) {
    if (invite.is_revoked) return true;
    if (invite.expire_date && invite.expire_date <= now()) return true;
    if (!invite.member_limit) return false;
    const members = [...chat.joinedVia].filter(
      ([id, link]) => link === invite.invite_link && isInChat(chat, id),
    );
    return members.length >= invite.member_limit;
  }

  /**
   * A bot sees a link another administrator created with the second half of
   * its hash replaced by "..." (ChatInviteLink.invite_link).
   */
  function inviteLinkSeenBy(record, payload) {
    const invite = payload?.invite_link;
    if (!invite || typeof invite !== "object") return payload;
    if (invite.creator.id === record.id) return payload;
    const hash = invite.invite_link.slice("https://t.me/+".length);
    return {
      ...payload,
      invite_link: {
        ...invite,
        invite_link: `https://t.me/+${hash.slice(0, hash.length / 2)}...`,
      },
    };
  }

  /**
   * Send a chat_member update only when the member actually changed. `before`
   * is the member's state from memberStatus; a change stores a new state.
   */
  function memberChanged(chat, userId, before, actor, extra) {
    const after = chatMemberObject(chat, userId);
    if (
      JSON.stringify(memberObject(chat, userId, before)) ===
      JSON.stringify(after)
    )
      return Promise.resolve();
    scheduleExpiry(chat, userId);
    appliedCheckpoint();
    waits.notify();
    return emitMemberChange(chat, userId, before, actor, extra);
  }

  /**
   * Apply allowed_updates as Telegram's Bot API server reads it
   * (telegram-bot-api Client::get_allowed_update_types): names in any case,
   * unknown names skipped, the default set when no name is known or the list
   * is empty, and no change for anything that is not a list of strings.
   */
  function subscribe(record, value) {
    if (!Array.isArray(value) || value.some((name) => typeof name !== "string"))
      return;
    const names = new Set(value.map((name) => name.toLowerCase()));
    const known = UPDATE_TYPES.filter((type) => names.has(type));
    const isDefault =
      known.length === 0 ||
      UPDATE_TYPES.every(
        (type) => names.has(type) !== DEFAULT_EXCLUDED_UPDATES.includes(type),
      );
    record.subscription = isDefault ? null : known;
  }

  function allowed(record, type) {
    return record.subscription
      ? record.subscription.includes(type)
      : !DEFAULT_EXCLUDED_UPDATES.includes(type);
  }

  /**
   * Deliver an update to the bots that receive it: those in the group or
   * channel it happened in, the bot a private chat is with, or the bots named.
   * A channel's messages go out as channel_post and edited_channel_post.
   */
  function emit(type, payload, { to = null, except = null } = {}) {
    waits.notify();
    const chatId = payload?.chat?.id ?? payload?.message?.chat?.id;
    const chat = chatId == null ? null : chats.get(Number(chatId));
    const kind =
      chat?.type === "channel" ? (CHANNEL_UPDATES[type] ?? type) : type;
    const recipients = (
      to ??
      (chat
        ? [...bots.values()].filter(
            (record) => record.id !== except && isInChat(chat, record.id),
          )
        : [bot])
    ).filter((record) => !chat || receives(chat, record, type));
    return Promise.all(
      recipients.map((record) => emitTo(record, kind, payload)),
    );
  }

  /**
   * Whether a bot's rights in the chat let it receive this update type: only
   * administrators get chat_member and message_reaction, and only bots with
   * can_invite_users get chat_join_request
   * (https://core.telegram.org/bots/api#update).
   */
  function receives(chat, record, type) {
    if (type === "chat_member" || type === "message_reaction") {
      return ["administrator", "creator"].includes(
        memberStatus(chat, record.id).status,
      );
    }
    if (type === "chat_join_request") {
      return hasRight(chat, record.id, "can_invite_users");
    }
    return true;
  }

  /**
   * Deliver one update to one bot: to its webhook when one is set, otherwise
   * to the queue its getUpdates reads. Resolves once the update has been
   * handed over: queued for getUpdates, its first webhook attempt finished,
   * or held behind an earlier update the webhook refused.
   */
  function emitTo(record, type, payload) {
    return emitOne(record, type, payload).delivered;
  }

  /** Send one update to one bot; says which update_id it got, if any. */
  function emitOne(record, type, payload) {
    if (!allowed(record, type)) {
      return { updateId: null, delivered: Promise.resolve() };
    }
    // Each bot has its own update queue, numbered without gaps.
    record.lastUpdateId += 1;
    const update = {
      update_id: record.lastUpdateId,
      [type]: seenBy(record, inviteLinkSeenBy(record, payload)),
    };
    // Serialised now, so later state changes cannot rewrite a sent update.
    const body = JSON.stringify(update);
    // Telegram keeps an update for a day after it happened, a button press
    // for 150 seconds (the timeouts of telegram-bot-api's add_update calls).
    const happened =
      type === "business_connection"
        ? now()
        : (payload.edit_date ?? payload.date ?? now());
    sentUpdates.set(updateKey(record.id, update.update_id), {
      record,
      body,
      expiresAt: type === "callback_query" ? now() + 150 : happened + 86_400,
      queue: webhookQueue(type, payload, update.update_id),
    });
    record.queue.push(JSON.parse(body));
    if (!record.webhook || stopped) {
      wakePollers(record);
      return { updateId: update.update_id, delivered: Promise.resolve() };
    }
    const delivered = new Promise((handed) => {
      record.sending.set(update.update_id, {
        receipt: newAttempt(record, update.update_id),
        delay: 1,
        fails: 0,
        readyAt: clock.now(),
        order: ++readyOrder,
        handed,
      });
    });
    pump(record);
    return { updateId: update.update_id, delivered };
  }

  function updateKey(botId, updateId) {
    return `${botId}:${updateId}`;
  }

  /**
   * The queue an update waits in for the webhook, numbered as Telegram's Bot
   * API server numbers it (telegram-bot-api Client.cpp, the webhook_queue_id
   * of each add_update: an id plus a kind shifted left by 33 bits): messages
   * by chat, member changes, join requests and button presses by user. One
   * queue's updates arrive in order, one at a time; different queues are
   * delivered at once. Any other update has a queue of its own, numbered
   * after all of these (WebhookActor's unique_queue_id_).
   */
  function webhookQueue(type, payload, updateId) {
    const queue = (id, kind = 0) => BigInt(id) + (BigInt(kind) << 33n);
    switch (type) {
      case "message":
      case "edited_message":
      case "channel_post":
      case "edited_channel_post":
        return queue(payload.chat.id);
      case "callback_query":
        return queue(payload.from.id, 3);
      case "my_chat_member":
        return queue(payload.chat.id, 5);
      case "chat_member":
        return queue(payload.new_chat_member.user.id, 6);
      case "chat_join_request":
        return queue(payload.from.id, 6);
      case "message_reaction":
        return queue(payload.chat.id, 8);
      case "business_connection":
        return queue(payload.user.id, 10);
      case "business_message":
      case "edited_business_message":
      case "deleted_business_messages":
        return queue(payload.chat.id, 11);
      default:
        return (1n << 60n) + BigInt(updateId);
    }
  }

  function wakePollers(record) {
    for (const waiter of record.pollWaiters) waiter.wake();
  }

  /** A webhook attempt's receipt, outstanding until the attempt settles. */
  function newAttempt(record, updateId) {
    const attemptKey = `${record.id}:${updateId}`;
    const attempt = (deliveryAttempts.get(attemptKey) ?? 0) + 1;
    deliveryAttempts.set(attemptKey, attempt);
    const receipt = {
      update_id: updateId,
      bot_id: record.id,
      attempt,
      epoch,
      received_at: clock.now(),
      outcome: "queued",
    };
    deliveryJournal.push(receipt);
    deliveryCount += 1;
    return receipt;
  }

  function settle(receipt, outcome = receipt.outcome) {
    receipt.outcome = outcome;
    receipt.completed_at = clock.now();
    deliveryCount -= 1;
    waits.notify();
  }

  /** The update has gone as far as it can for now; whoever waits may go on. */
  function hand(state) {
    state.handed?.();
    state.handed = null;
  }

  /**
   * Send what the webhook may take now: the first unconfirmed update of each
   * queue that is not waiting to be retried, up to max_connections requests
   * at a time (telegram-bot-api WebhookActor::send_updates). The queue ready
   * longest goes first, then the lowest queue id, as WebhookActor's queues_
   * orders them: an update is ready from when it was loaded, a refused one
   * from when it may be tried again.
   */
  function pump(record) {
    const webhook = record.webhook;
    // Nothing goes out before the host's address is known
    // (WebhookActor::create_new_connections).
    if (stopped || !webhook?.ip_address) return;
    let busy = 0;
    for (const state of record.sending.values()) if (state.request) busy += 1;
    const started = new Set();
    const waiting = new Set();
    const ready = [];
    // Updates pending when the webhook starts are loaded at the same moment.
    let loaded;
    for (const update of record.queue) {
      const { queue } = sentUpdates.get(updateKey(record.id, update.update_id));
      let state = record.sending.get(update.update_id);
      if (!state) {
        loaded ??= ++readyOrder;
        state = {
          receipt: newAttempt(record, update.update_id),
          delay: 1,
          fails: 0,
          readyAt: clock.now(),
          order: loaded,
        };
        record.sending.set(update.update_id, state);
      }
      if (waiting.has(queue)) hand(state);
      if (started.has(queue) || waiting.has(queue)) continue;
      if (state.retry) {
        waiting.add(queue);
        continue;
      }
      started.add(queue);
      if (!state.request)
        ready.push({ queue, updateId: update.update_id, state });
    }
    ready.sort(
      (a, b) =>
        a.state.readyAt - b.state.readyAt ||
        a.state.order - b.state.order ||
        (a.queue < b.queue ? -1 : 1),
    );
    for (const { updateId, state } of ready) {
      if (busy >= webhook.max_connections) break;
      busy += 1;
      const sending = attempt(record, webhook, updateId, state).catch(
        (error) => {
          deliveryError ??= error;
        },
      );
      deliveries.add(sending);
      sending.finally(() => deliveries.delete(sending));
    }
  }

  /** One attempt to deliver a queued update, then a retry if it failed. */
  async function attempt(record, webhook, updateId, state) {
    const sent = sentUpdates.get(updateKey(record.id, updateId));
    const { receipt } = state;
    receipt.started_at = clock.now();
    state.request = new AbortController();
    const answer = await postUpdate(webhook, sent.body, state.request);
    // A webhook removed or replaced meanwhile has already settled this attempt.
    if (record.sending.get(updateId) !== state) return;
    state.request = null;
    if (answer.status) receipt.status = answer.status;
    if (answer.status >= 200 && answer.status <= 299) {
      receipt.outcome = "delivered";
      forget(record, updateId);
      pump(record);
      await runWebhookAnswer(record, answer);
      settle(receipt);
      hand(state);
      return;
    }
    settle(receipt, answer.status ? "rejected" : "failed");
    // telegram-bot-api WebhookActor::on_update_error: the first failure is
    // retried at once and later ones after twice the previous wait, up to a
    // random 60 to 120 seconds. Retry-After, at most an hour, replaces the
    // wait. An update whose next try would come after it expires is dropped.
    const retryAfter = Math.min(3600, answer.retryAfter ?? 0);
    let delay = state.delay;
    let wait = retryAfter;
    if (retryAfter === 0 && state.fails > 0) {
      delay = Math.min(60 + Math.floor(Math.random() * 61), delay * 2);
      wait = delay;
    }
    const expired = now() + wait > sent.expiresAt;
    if (expired) {
      forget(record, updateId);
    } else {
      state.delay = delay;
      state.fails += 1;
      state.receipt = newAttempt(record, updateId);
      // Behind the queues already waiting.
      state.readyAt = clock.now() + wait * 1000;
      state.order = ++readyOrder;
      if (wait > 0) {
        state.retry = clock.schedule(() => {
          state.retry = null;
          pump(record);
        }, wait * 1000);
      }
    }
    hand(state);
    pump(record);
    const type = Object.keys(JSON.parse(sent.body))[1];
    log(
      answer.status
        ? `webhook answered ${answer.status} for ${type}`
        : `webhook delivery failed for ${type}: ${answer.error.message}`,
    );
    if (expired) log(`webhook gave up on expired update ${updateId} (${type})`);
  }

  /** A test has Telegram send an update again: one attempt, never retried. */
  function redeliver(sent) {
    const { record } = sent;
    const receipt = newAttempt(record, JSON.parse(sent.body).update_id);
    receipt.started_at = clock.now();
    const abort = new AbortController();
    const resent = (async () => {
      const answer = await postUpdate(record.webhook, sent.body, abort);
      if (answer.status) receipt.status = answer.status;
      const ok = answer.status >= 200 && answer.status <= 299;
      if (ok) await runWebhookAnswer(record, answer);
      settle(
        receipt,
        abort.signal.aborted
          ? "cancelled"
          : ok
            ? "delivered"
            : answer.status
              ? "rejected"
              : "failed",
      );
    })().catch((error) => {
      deliveryError ??= error;
    });
    deliveries.add(resent);
    resent.finally(() => deliveries.delete(resent));
    return resent;
  }

  /** The bot's webhook confirmed an update, or Telegram dropped it. */
  function forget(record, updateId) {
    record.sending.delete(updateId);
    const index = record.queue.findIndex(
      (update) => update.update_id === updateId,
    );
    if (index >= 0) record.queue.splice(index, 1);
  }

  /**
   * End the bot's webhook attempts when its webhook is removed or replaced, or
   * the server stops. Updates not yet confirmed stay pending, as on Telegram.
   */
  function closeAttempts(record, outcome) {
    for (const state of record.sending.values()) {
      state.request?.abort();
      state.retry?.();
      settle(state.receipt, outcome);
      hand(state);
    }
    record.sending.clear();
  }

  /**
   * POST an update to a webhook with exactly the headers Telegram sends
   * (telegram-bot-api WebhookActor::send_update). Resolves with the answer, or
   * with the connection error, and records a failure for getWebhookInfo.
   */
  async function postUpdate(webhook, body, abort) {
    const target = parseWebhookUrl(webhook.url);
    inFlight.add(abort);
    const answer = await new Promise((resolve) => {
      let request;
      try {
        request = (target.https ? https : http).request(
          {
            host: webhook.ip_address,
            port: target.port,
            // The path's UTF-8 bytes, as Telegram writes them.
            path: Buffer.from(target.path).toString("latin1"),
            method: "POST",
            setHost: false,
            agent: target.https ? agents.https : agents.http,
            ...(target.https && !net.isIP(target.hostname)
              ? { servername: target.hostname }
              : {}),
            signal: abort.signal,
            headers: {
              Host: target.hostHeader,
              ...(target.userinfo
                ? {
                    Authorization: `Basic ${Buffer.from(target.userinfo).toString("base64")}`,
                  }
                : {}),
              ...(webhook.secret_token
                ? { "X-Telegram-Bot-Api-Secret-Token": webhook.secret_token }
                : {}),
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(body),
              Connection: "keep-alive",
              "Accept-Encoding": "gzip, deflate",
            },
          },
          (response) => {
            const chunks = [];
            response.on("data", (chunk) => chunks.push(chunk));
            response.on("error", (error) => resolve({ error }));
            response.on("end", () =>
              resolve({
                status: response.statusCode,
                reason: response.statusMessage,
                headers: response.headers,
                body: Buffer.concat(chunks),
              }),
            );
          },
        );
      } catch (error) {
        resolve({ error });
        return;
      }
      // Telegram closes a webhook connection that stays silent for a minute
      // (HttpConnectionBase::timeout_expired).
      request.setTimeout(WEBHOOK_TIMEOUT_MS, () => {
        const text = "Read timeout expired";
        resolve({ error: new Error(text), text });
        request.destroy();
      });
      request.on("error", (error) =>
        resolve({ error, text: connectionErrorText(error, request.socket) }),
      );
      request.end(body);
    });
    inFlight.delete(abort);
    if (abort.signal.aborted) return answer;
    if (answer.error) {
      if (answer.text) recordWebhookError(webhook, answer.text);
    } else if (answer.status < 200 || answer.status > 299) {
      const value = String(answer.headers["retry-after"] ?? "");
      answer.retryAfter = /^-?\d{1,9}$/.test(value)
        ? Math.max(0, Number(value))
        : 0;
      recordWebhookError(
        webhook,
        `Wrong response from the webhook: ${answer.status} ${answer.reason}`,
      );
    }
    return answer;
  }

  function recordWebhookError(webhook, message) {
    webhook.last_error_date = now();
    webhook.last_error_message = message;
  }

  /**
   * Run the Bot API call a webhook answered with, as the bot, the way
   * Telegram does (bots/api#making-requests-when-getting-updates;
   * telegram-bot-api WebhookActor::handle): any method but setWebhook,
   * deleteWebhook, close, logOut and the get methods. Its result goes nowhere.
   */
  async function runWebhookAnswer(record, answer) {
    const type = String(answer.headers["content-type"] ?? "");
    if (
      !answer.body.length ||
      !/application\/json|application\/x-www-form-urlencoded|multipart\/form-data/i.test(
        type,
      )
    )
      return;
    try {
      const body = /^(gzip|deflate)$/i.test(
        String(answer.headers["content-encoding"] ?? ""),
      )
        ? unzipSync(answer.body)
        : answer.body;
      const params = await readRequestParams(
        { url: "/", headers: { "content-type": type } },
        body,
      );
      const method = String(params.method ?? "");
      const name = method.toLowerCase();
      if (
        !name ||
        ["setwebhook", "deletewebhook", "close", "logout"].includes(name) ||
        name.startsWith("get")
      )
        return;
      const response = await fetch(`${origin}/bot${record.token}/${method}`, {
        method: "POST",
        headers: { "content-type": type },
        body,
      });
      await response.arrayBuffer();
    } catch {
      // An answer Telegram cannot read runs nothing, nor does a stopping server.
    }
  }

  /**
   * setWebhook and deleteWebhook, as telegram-bot-api's
   * process_set_webhook_query and do_set_webhook handle them. Like a Bot API
   * server run with --local, this one takes http URLs, any port and local
   * addresses. A host name is resolved once, when the webhook is set.
   */
  async function changeWebhook(record, p, url) {
    // With floodControl, a URL at most once a second, before anything else is
    // checked (process_set_webhook_query's next_allowed_set_webhook_time_).
    if (url && floodControl === true) {
      if (clock.now() < record.nextSetWebhookAt) {
        throw new TelegramError(429, "Too Many Requests: retry after 1", {
          retry_after: 1,
        });
      }
      record.nextSetWebhookAt = clock.now() + 1000;
    }
    const current = record.webhook;
    const attached =
      typeof p.certificate === "string" && p.certificate.startsWith("attach://")
        ? p[p.certificate.slice("attach://".length)]
        : p.certificate;
    const certificate = url && Buffer.isBuffer(attached) ? attached : null;
    const maxConnections = url
      ? clampedInteger(p.max_connections, 40, 1, 100)
      : 0;
    const ipAddress = url ? String(p.ip_address ?? "") : "";
    const secret = url ? String(p.secret_token ?? "") : "";
    const drop = isTrue(p.drop_pending_updates);
    if (
      (current?.url ?? "") === url &&
      !current?.has_custom_certificate &&
      !certificate &&
      (current?.max_connections ?? 0) === maxConnections &&
      (current?.fixed_ip ? current.ip_address : "") === ipAddress &&
      (current?.secret_token ?? "") === secret &&
      !drop
    ) {
      subscribe(record, p.allowed_updates);
      return new Described(
        true,
        url ? "Webhook is already set" : "Webhook is already deleted",
      );
    }
    if (url)
      abortLongPoll(record, "Conflict: terminated by setWebhook request");
    // The old webhook goes first, even if the new one is then refused.
    if (current) {
      closeAttempts(record, url ? "cancelled" : "poll_queue");
      record.webhook = null;
    }
    if (drop) record.queue.length = 0;
    if (!url) {
      return new Described(
        true,
        current ? "Webhook was deleted" : "Webhook is already deleted",
      );
    }
    const target = parseWebhookUrl(url);
    if (!target) {
      throw new TelegramError(
        400,
        "Bad Request: invalid webhook URL specified",
      );
    }
    if (Buffer.byteLength(secret) > 256) {
      throw new TelegramError(400, "Bad Request: secret token is too long");
    }
    if (!/^[A-Za-z0-9_-]*$/.test(secret)) {
      throw new TelegramError(
        400,
        "Bad Request: secret token contains illegal characters",
      );
    }
    if (certificate?.length > 3 << 20) {
      throw new TelegramError(
        400,
        `Bad Request: certificate size is too big (${certificate.length} bytes)`,
      );
    }
    subscribe(record, p.allowed_updates);
    if (ipAddress && !net.isIP(ipAddress)) {
      throw new TelegramError(
        400,
        "Bad Request: bad webhook: Invalid IP address specified",
      );
    }
    const webhook = {
      url,
      secret_token: secret,
      max_connections: maxConnections,
      has_custom_certificate: certificate != null,
      // The address Telegram sends to: the one given, or the host's.
      fixed_ip: ipAddress !== "",
      ip_address:
        ipAddress || (net.isIP(target.hostname) ? target.hostname : ""),
      last_error_date: 0,
      last_error_message: "",
    };
    record.webhook = webhook;
    if (!webhook.ip_address) {
      // Telegram answers once it has the host's address, and a host that does
      // not resolve closes the webhook again (WebhookActor::resolve_ip_address,
      // Client::webhook_verified and on_webhook_closed).
      const resolved = await resolveWebhookHost(target.hostname);
      if (record.webhook !== webhook) {
        await conflictPause(record);
        throw new TelegramError(
          409,
          "Conflict: terminated by other setWebhook",
        );
      }
      if (resolved.error) {
        closeAttempts(record, "poll_queue");
        record.webhook = null;
        throw new TelegramError(
          400,
          `Bad Request: bad webhook: ${resolved.error}`,
        );
      }
      webhook.ip_address = resolved.address;
    }
    pump(record);
    return new Described(true, "Webhook was set");
  }

  /** Telegram's update queue forgets an update once it expires. */
  function dropExpired(record) {
    const time = now();
    for (let i = record.queue.length - 1; i >= 0; i -= 1) {
      const { update_id: id } = record.queue[i];
      if (sentUpdates.get(updateKey(record.id, id)).expiresAt < time) {
        record.queue.splice(i, 1);
      }
    }
  }

  /** End the bot's waiting getUpdates call with a 409 conflict. */
  function abortLongPoll(record, message) {
    for (const waiter of [...record.pollWaiters]) waiter.abort(message);
  }

  /**
   * Telegram answers a getUpdates conflict at once, but holds another one
   * within 3 seconds for 3 seconds (telegram-bot-api fail_query_conflict).
   */
  function conflictPause(record) {
    if (clock.now() >= record.nextConflictAt) {
      record.nextConflictAt = clock.now() + 3000;
      return Promise.resolve();
    }
    return delayResponse(3000);
  }

  /**
   * Tell the bots that a member changed from `before` (a memberStatus state):
   * a bot hears of its own membership through my_chat_member, whoever changed
   * it, and the chat's other bots through chat_member, each with its own
   * can_be_edited.
   */
  function emitMemberChange(chat, userId, before, actor, extra = {}) {
    waits.notify();
    const change = (viewer) => ({
      chat: chatObject(chat),
      from: userObject(actor),
      date: now(),
      old_chat_member: memberObject(chat, userId, before, viewer),
      new_chat_member: chatMemberObject(chat, userId, viewer),
      ...extra,
    });
    const target = [...bots.values()].find(
      (record) => record.id === Number(userId),
    );
    const others = [...bots.values()].filter(
      (record) =>
        record !== target &&
        isInChat(chat, record.id) &&
        receives(chat, record, "chat_member"),
    );
    return Promise.all([
      ...(target ? [emitTo(target, "my_chat_member", change(target))] : []),
      ...others.map((record) => emitTo(record, "chat_member", change(record))),
    ]);
  }

  /**
   * Someone adds, promotes, demotes or removes a bot. Telegram tells that bot
   * through my_chat_member, the chat's administrator bots through chat_member,
   * and a group's members through a service message. The change is made at
   * once; the returned promise settles when the updates have been handed over.
   */
  function setBotMembership(chat, record, { status, rights, actor }) {
    const before = memberStatus(chat, record.id);
    const wasIn = isInChat(chat, record.id);
    const botsBefore = botsIn(chat);
    chat.members.set(record.id, { status, ...(rights ? { rights } : {}) });
    const after = chatMemberObject(chat, record.id);
    appliedCheckpoint();
    const handed = [emitMemberChange(chat, record.id, before, actor)];
    const isIn = isInChat(chat, record.id);
    if (chat.type !== "channel" && wasIn !== isIn) {
      const service = addMessage(
        chat,
        actor,
        isIn
          ? { new_chat_members: [userObject(record)] }
          : { left_chat_member: userObject(record) },
      );
      // The bot itself gets it too: new_chat_members and left_chat_member
      // "may be the bot itself" (https://core.telegram.org/bots/api#message).
      handed.push(
        emit("message", service, {
          to: [...new Set([...botsBefore, ...botsIn(chat)])],
        }),
      );
    }
    return Promise.all(handed).then(() => after);
  }

  /**
   * Whether a person may add members: the creator, an administrator with
   * can_invite_users, or a member when the chat's permissions allow it.
   */
  function canAddMembers(chat, userId) {
    const member = memberStatus(chat, userId);
    if (member.status === "creator") return true;
    if (member.status === "administrator") {
      return hasRight(chat, userId, "can_invite_users");
    }
    return canPost(chat, userId, "can_invite_users");
  }

  /** Whether a person may add or change administrators. */
  function canAddAdmins(chat, userId) {
    const member = memberStatus(chat, userId);
    return (
      member.status === "creator" ||
      (member.status === "administrator" &&
        hasRight(chat, userId, "can_promote_members"))
    );
  }

  /**
   * Whether a person holds a right such as can_change_info: the creator
   * always, an administrator granted it, a member the chat's permissions
   * allow.
   */
  function personHasRight(chat, userId, right) {
    const member = memberStatus(chat, userId);
    if (member.status === "creator") return true;
    if (member.status === "administrator") {
      return hasRight(chat, userId, right);
    }
    return canPost(chat, userId, right);
  }

  /**
   * A person adds the bot through its t.me/<bot>?startgroup=<parameter> link
   * (https://core.telegram.org/api/links#group-channel-bot-links). With admin
   * rights requested, only someone who can add admins may; without, someone
   * who can add members. An existing administrator's rights are combined with
   * the requested ones. The link then invokes messages.startBot with the
   * parameter, which posts "/start@<bot> <parameter>" from the person
   * (https://core.telegram.org/bots/features#deep-linking). A channel's
   * t.me/<bot>?startchannel&admin=<rights> link always asks for admin rights,
   * has no parameter and never invokes messages.startBot.
   */
  async function addBotViaLink(chat, record, { by, startParameter, rights }) {
    const actor = requireUser(by ?? creatorOf(chat));
    const asAdmin = rights != null;
    if (chat.type === "channel" && !asAdmin) {
      throw new TelegramError(400, "a startchannel link needs admin rights");
    }
    if (chat.type === "channel" && startParameter) {
      throw new TelegramError(
        400,
        "a startchannel link has no start parameter",
      );
    }
    if (
      asAdmin ? !canAddAdmins(chat, actor.id) : !canAddMembers(chat, actor.id)
    ) {
      throw new TelegramError(400, "CHAT_ADMIN_REQUIRED");
    }
    const current = memberStatus(chat, record.id);
    if (asAdmin) {
      const existing =
        current.status === "administrator"
          ? chatMemberObject(chat, record.id)
          : {};
      const combined = {};
      for (const [right, value] of Object.entries(rights)) {
        combined[right] = value === true || existing[right] === true;
      }
      for (const [right, value] of Object.entries(existing)) {
        if (right.startsWith("can_") && value === true) combined[right] = true;
      }
      await setBotMembership(chat, record, {
        status: "administrator",
        rights: combined,
        actor,
      });
    } else if (!isInChat(chat, record.id)) {
      await setBotMembership(chat, record, { status: "member", actor });
    }
    if (chat.type === "channel") return chatMemberObject(chat, record.id);
    const text =
      `/start@${record.username}` +
      (startParameter ? ` ${String(startParameter)}` : "");
    const message = addMessage(chat, actor, { text });
    const entities = findEntities(text);
    if (entities.length > 0) message.entities = entities;
    await emit("message", message);
    return chatMemberObject(chat, record.id);
  }

  /**
   * The creator or an administrator upgrades a basic group to a supergroup
   * (https://core.telegram.org/api/channel#migration): a new supergroup takes
   * its members, administrators and bots; the old chat says where it went
   * (migrate_to_chat_id) and the new one where it came from
   * (migrate_from_chat_id).
   */
  async function migrateToSupergroup(chat, { by }) {
    if (chat.type !== "group") {
      throw new TelegramError(400, "only a basic group can be upgraded");
    }
    if (chat.migratedTo != null) {
      throw new TelegramError(400, "the group was already upgraded");
    }
    const actor = requireUser(by ?? creatorOf(chat));
    if (
      !["creator", "administrator"].includes(
        memberStatus(chat, actor.id).status,
      )
    ) {
      throw new TelegramError(400, "CHAT_ADMIN_REQUIRED");
    }
    nextChatId += 1;
    const supergroup = {
      ...chat,
      id: -(1_000_000_000_000 + nextChatId),
      type: "supergroup",
      members: new Map(
        [...chat.members].map(([id, member]) => [id, structuredClone(member)]),
      ),
      messages: new Map(),
      ephemeral: new Map(),
      inviteLinks: new Map(),
      joinedVia: new Map(),
      joinRequests: new Map(),
      pinned: [],
      migratedFrom: chat.id,
    };
    delete supergroup.migratedTo;
    chats.set(supergroup.id, supergroup);
    chat.migratedTo = supergroup.id;
    await emit(
      "message",
      addMessage(chat, actor, { migrate_to_chat_id: supergroup.id }),
    );
    await emit(
      "message",
      addMessage(supergroup, actor, { migrate_from_chat_id: chat.id }),
    );
    return chatObject(supergroup);
  }

  /** A person renames the chat; bots get the new_chat_title service message. */
  async function renameByPerson(chat, { by, title }) {
    const actor = requireUser(by ?? creatorOf(chat));
    if (!personHasRight(chat, actor.id, "can_change_info")) {
      throw new TelegramError(400, "CHAT_ADMIN_REQUIRED");
    }
    const name = String(title ?? "").trim();
    if (!name || name.length > 128) {
      throw new TelegramError(400, "CHAT_TITLE_EMPTY");
    }
    if (name === chat.title) throw new TelegramError(400, "CHAT_NOT_MODIFIED");
    chat.title = name;
    const message = addMessage(chat, actor, { new_chat_title: name });
    await emit("message", message);
    return { message_id: message.message_id };
  }

  /** A person sets the chat photo; bots get the new_chat_photo service message. */
  async function changePhotoByPerson(chat, { by, base64 }) {
    const actor = requireUser(by ?? creatorOf(chat));
    if (!personHasRight(chat, actor.id, "can_change_info")) {
      throw new TelegramError(400, "CHAT_ADMIN_REQUIRED");
    }
    const bytes = Buffer.from(String(base64 ?? ""), "base64");
    if (bytes.length === 0) throw new TelegramError(400, "PHOTO_INVALID");
    chat.photo = registerPhoto(bytes);
    const message = addMessage(chat, actor, {
      new_chat_photo: photoSizes(chat.photo),
    });
    await emit("message", message);
    return { message_id: message.message_id };
  }

  /**
   * A person pins a message; bots get the pinned_message service message.
   * Pinning takes can_pin_messages, in a channel can_edit_messages
   * (DialogManager::can_pin_messages).
   */
  async function pinByPerson(chat, messageId, { user_id: userId }) {
    const actor = requireUser(userId);
    const entry = chat.messages.get(Number(messageId));
    if (!entry || entry.deleted) {
      throw new TelegramError(400, "MESSAGE_ID_INVALID");
    }
    const right =
      chat.type === "channel" ? "can_edit_messages" : "can_pin_messages";
    if (!personHasRight(chat, actor.id, right)) {
      throw new TelegramError(400, "CHAT_ADMIN_REQUIRED");
    }
    const message = pin(chat, entry, actor);
    await emit("message", message);
    return { message_id: message.message_id };
  }

  /** The bots that are members of a chat. */
  function botsIn(chat) {
    return [...bots.values()].filter((record) => isInChat(chat, record.id));
  }

  function requireBot(botId) {
    const record = [...bots.values()].find(
      (entry) => entry.id === Number(botId),
    );
    if (!record) throw new TelegramError(400, "Bad Request: bot not found");
    return record;
  }

  /**
   * Store a new message. A channel's messages are sent by the channel itself,
   * with sender_chat and no from (Bot API server Client.cpp); who posted it is
   * kept as the entry's author for the rules that depend on it.
   */
  function addMessage(chat, from, fields) {
    const message = {
      message_id: chat.nextMessageId++,
      ...(chat.type === "channel"
        ? { sender_chat: chatObject(chat) }
        : { from: userObject(from) }),
      chat: chatObject(chat),
      date: now(),
      ...fields,
    };
    chat.messages.set(message.message_id, {
      message,
      deleted: false,
      author: from.id,
    });
    appliedCheckpoint();
    waits.notify();
    return message;
  }

  /**
   * An ephemeral message has message_id 0 and its own ephemeral_message_id in
   * the chat (https://core.telegram.org/bots/api#message). It takes no chat
   * message id, so only the editEphemeralMessage… and deleteEphemeralMessage
   * methods reach it.
   */
  function addEphemeralMessage(chat, from, receiver, fields) {
    chat.ephemeral ??= new Map();
    chat.nextEphemeralMessageId ??= 1;
    const message = {
      message_id: 0,
      ephemeral_message_id: chat.nextEphemeralMessageId++,
      from: userObject(from),
      receiver_user: userObject(receiver),
      chat: chatObject(chat),
      date: now(),
      ...fields,
    };
    // `after` places it among the chat's messages when they are listed.
    chat.ephemeral.set(message.ephemeral_message_id, {
      message,
      deleted: false,
      author: from.id,
      after: chat.nextMessageId - 1,
    });
    appliedCheckpoint();
    waits.notify();
    return message;
  }

  /**
   * Store a file of one kind of media with what its sender says about it
   * (file_name, mime_type, width, height, duration, length, title, performer,
   * emoji). Image bytes only: accepting a file path here would let anyone who
   * can reach the control API read any file on the host through the file
   * download URL.
   */
  function registerFile(bytes, kind, meta = {}) {
    // A photo's size is its image's; its sender says nothing about it.
    const said = kind === "photo" ? photoDimensions(bytes) : meta;
    const fileName = said.file_name ?? bytes.fileName;
    const mimeType =
      said.mime_type ??
      bytes.mimeType ??
      (fileName ? guessMimeType(fileName) : undefined);
    const file = {
      ...Object.fromEntries(
        Object.entries(said).filter(([, value]) => value != null),
      ),
      ...(fileName ? { file_name: fileName } : {}),
      ...(mimeType ? { mime_type: mimeType } : {}),
      kind,
      data: bytes,
      file_unique_id: fileUniqueId(),
      ids: {},
    };
    return fileView(file);
  }

  function registerPhoto(bytes) {
    return registerFile(bytes, "photo");
  }

  /**
   * The ChatPhoto getChat shows for a chat's or user's photo. Its small and
   * big photos are files of their own, of TDLib's ProfilePhoto type, which no
   * send takes (PhotoSizeSource::get_file_type); both hold the whole image.
   */
  function chatPhotoObject(photo) {
    if (!chatPhotos.has(photo.file_unique_id)) {
      const { data } = files.get(photo.file_id).file;
      chatPhotos.set(photo.file_unique_id, {
        small: registerFile(data, "chat_photo"),
        big: registerFile(data, "chat_photo"),
      });
    }
    const { small, big } = chatPhotos.get(photo.file_unique_id);
    return {
      small_file_id: small.file_id,
      small_file_unique_id: small.file_unique_id,
      big_file_id: big.file_id,
      big_file_unique_id: big.file_unique_id,
    };
  }

  /** The file_id one bot knows a stored file by, made when it first sees it. */
  function fileIdFor(file, botId) {
    if (!file.ids[botId]) {
      file.ids[botId] = randomBytes(24).toString("base64url");
      files.set(file.ids[botId], { file, botId });
    }
    return file.ids[botId];
  }

  /**
   * A stored file as messages hold it: by the first bot's file_id, which
   * seenBy turns into each other bot's own.
   */
  function fileView(file) {
    const { data, ids: _ids, ...described } = file;
    return {
      file_id: fileIdFor(file, bot.id),
      size: data.length,
      ...described,
    };
  }

  /** Where a bot downloads a file, under its own file_id. */
  function filePath(file, fileId) {
    const extension = PHOTO_KINDS.has(file.kind)
      ? "jpg"
      : (MEMBER_MEDIA[file.kind]?.ext ?? "mp4");
    return `${FILE_TYPES[file.kind].directory}/${fileId}.${extension}`;
  }

  /**
   * A Bot API payload as one bot sees it: every file_id in it that bot's own.
   * Stored messages carry the first bot's, as the control API shows them.
   */
  function seenBy(record, payload) {
    if (record.id === bot.id || payload === undefined) return payload;
    return JSON.parse(JSON.stringify(payload), (key, value) =>
      FILE_ID_FIELDS.has(key) && files.has(value)
        ? fileIdFor(files.get(value).file, record.id)
        : value,
    );
  }

  /**
   * The file a send or edit names, of the kind it sends: an upload, also as
   * attach://<name>; the file_id of a file the calling bot was given; or an
   * HTTP URL, which TDLib takes any string with a dot for and refuses when
   * parse_url cannot read it (FileManager::from_persistent_id). This server
   * stands in for a URL with a one-byte file instead of fetching it. Null when
   * it names nothing. A file keeps its kind when sent again; a live photo's
   * video sent on its own is a video (Client.cpp JsonLivePhoto). Telegram's
   * server refuses another bot's file with MEDIA_EMPTY, which reaches the bot
   * as `mediaEmpty`.
   */
  function sentFile(
    p,
    value,
    kind,
    caller,
    meta,
    {
      typeName = FILE_TYPES[kind].name,
      mediaEmpty = "Bad Request: wrong file identifier/HTTP URL specified",
    } = {},
  ) {
    const named = namedFile(p, value);
    if (named === null) return null;
    if (Buffer.isBuffer(named)) return registerFile(named, kind, meta);
    const held = files.get(named);
    if (held) {
      const heldKind = held.file.kind;
      if (
        heldKind !== kind &&
        (PHOTO_KINDS.has(heldKind) || PHOTO_KINDS.has(kind))
      ) {
        throw new TelegramError(
          400,
          `Bad Request: can't use file of type ${FILE_TYPES[heldKind].name} as ${typeName}`,
        );
      }
      if (held.botId !== caller.id) throw new TelegramError(400, mediaEmpty);
      const view = fileView(held.file);
      return heldKind === "live_photo" && kind !== "live_photo"
        ? { ...view, kind: "video" }
        : view;
    }
    if (named.includes(".")) {
      const unparsable = unparsableUrl(named);
      if (unparsable) {
        throw new TelegramError(
          400,
          `Bad Request: invalid file HTTP URL specified: ${unparsable}`,
        );
      }
      return registerFile(Buffer.alloc(1), kind, meta);
    }
    throw new TelegramError(400, `Bad Request: ${unreadableFileId(named)}`);
  }

  /**
   * What a send's file field names: uploaded bytes, given directly or as
   * attach://<name>, or a string; null for nothing (Client.cpp get_input_file).
   */
  function namedFile(p, value) {
    if (typeof value === "string" && value.startsWith("attach://")) {
      const upload = p[value.slice("attach://".length)];
      return Buffer.isBuffer(upload) ? upload : null;
    }
    return Buffer.isBuffer(value) || (typeof value === "string" && value !== "")
      ? value
      : null;
  }

  /**
   * What a sender says about the media it uploads, as the Bot API reads it:
   * sizes up to 10000 and durations up to a day, 0 meaning unsaid
   * (Client.cpp get_integer_arg, get_input_video, MAX_LENGTH, MAX_DURATION).
   */
  function senderMeta(p) {
    const number = (name, max) => {
      const value = Math.min(max, Math.trunc(numberParam(p[name], 0)));
      return value > 0 ? { [name]: value } : {};
    };
    return {
      ...number("width", 10000),
      ...number("height", 10000),
      ...number("length", 10000),
      ...number("duration", 86400),
      ...(p.title ? { title: String(p.title) } : {}),
      ...(p.performer ? { performer: String(p.performer) } : {}),
      ...(p.emoji ? { emoji: String(p.emoji) } : {}),
    };
  }

  /** The Message field for a stored file of a media type, as the Bot API has it. */
  function mediaField(type, file) {
    const base = {
      file_id: file.file_id,
      file_unique_id: file.file_unique_id,
      file_size: file.size,
    };
    const duration = file.duration ?? 1;
    switch (type) {
      case "photo":
        return photoSizes(file);
      case "video":
      case "animation":
        return {
          ...base,
          width: file.width ?? 1280,
          height: file.height ?? 720,
          duration,
          mime_type: file.mime_type ?? "video/mp4",
          ...(file.file_name ? { file_name: file.file_name } : {}),
        };
      case "live_photo":
        return {
          ...base,
          width: file.width ?? 1280,
          height: file.height ?? 720,
          duration,
          mime_type: file.mime_type ?? "video/mp4",
        };
      case "sticker":
        return {
          ...base,
          type: "regular",
          width: 512,
          height: 512,
          ...(file.emoji ? { emoji: file.emoji } : {}),
          is_animated: false,
          is_video: false,
        };
      case "voice":
        return {
          ...base,
          duration,
          mime_type: file.mime_type ?? "audio/ogg",
        };
      case "audio":
        return {
          ...base,
          duration,
          mime_type: file.mime_type ?? "audio/mpeg",
          ...(file.file_name ? { file_name: file.file_name } : {}),
          ...(file.title ? { title: file.title } : {}),
          ...(file.performer ? { performer: file.performer } : {}),
        };
      case "video_note":
        return { ...base, length: file.length ?? 240, duration };
      default:
        return {
          ...base,
          file_name: file.file_name ?? "file",
          mime_type: file.mime_type ?? "application/octet-stream",
        };
    }
  }

  /**
   * Message fields for one piece of media. An animation is also a document
   * with its file name and type, and a live photo also the photo it moves
   * (Client.cpp JsonMessage).
   */
  function mediaFields(type, file, photo) {
    const fields = { [type]: mediaField(type, file) };
    if (type === "animation") {
      const { file_id, file_unique_id, file_size, file_name, mime_type } =
        fields.animation;
      fields.document = {
        file_id,
        file_unique_id,
        file_size,
        ...(file_name ? { file_name } : {}),
        mime_type,
      };
    }
    if (type === "live_photo") {
      fields.photo = photoSizes(photo);
      fields.live_photo = { photo: fields.photo, ...fields.live_photo };
    }
    return fields;
  }

  /**
   * A photo's sizes. Telegram lists several, each bounded by a box from
   * 100x100 up; here there is one, the largest.
   */
  function photoSizes(photo) {
    return [
      {
        file_id: photo.file_id,
        file_unique_id: photo.file_unique_id,
        width: photo.width ?? 800,
        height: photo.height ?? 800,
        file_size: photo.size,
      },
    ];
  }

  // ── Bot API ────────────────────────────────────────────────────────────
  // Each method runs as the bot whose token the request carried.
  const methods = {
    getMe: (_p, caller) => ({
      ...userObject(caller),
      can_join_groups: true,
      can_read_all_group_messages: true,
      supports_inline_queries: false,
      supports_join_request_queries: caller.joinRequestQueries,
      // Every bot here can be connected to a business account.
      can_connect_to_business: true,
    }),
    setWebhook: (p, caller) =>
      changeWebhook(caller, p, p.url == null ? "" : String(p.url)),
    deleteWebhook: (p, caller) => changeWebhook(caller, p, ""),
    getWebhookInfo: (_p, caller) => {
      const webhook = caller.webhook;
      if (!webhook) dropExpired(caller);
      // telegram-bot-api JsonWebhookInfo
      return {
        url: webhook?.url ?? "",
        has_custom_certificate: webhook?.has_custom_certificate ?? false,
        pending_update_count: caller.queue.length,
        ...(webhook?.last_error_date
          ? {
              last_error_date: webhook.last_error_date,
              last_error_message: webhook.last_error_message,
            }
          : {}),
        ...(webhook
          ? {
              max_connections: webhook.max_connections,
              ip_address: webhook.ip_address || "<unknown>",
            }
          : {}),
        ...(caller.subscription
          ? {
              allowed_updates: caller.subscription.filter(
                (type) => !type.startsWith("custom_"),
              ),
            }
          : {}),
      };
    },
    getUpdates: async (p, caller) => {
      const queue = caller.queue;
      if (caller.webhook) {
        await conflictPause(caller);
        throw new TelegramError(
          409,
          "Conflict: can't use getUpdates method while webhook is active; use deleteWebhook to delete the webhook first",
        );
      }
      subscribe(caller, p.allowed_updates);
      const offset = numberParam(p.offset, 0);
      // An offset confirms every update before it: they are gone for good.
      if (offset > 0) {
        while (queue.length && queue[0].update_id < offset) queue.shift();
      } else if (offset < 0) {
        queue.splice(0, Math.max(0, queue.length + offset));
      }
      dropExpired(caller);
      const limit = Math.min(100, Math.max(1, numberParam(p.limit, 100)));
      const timeoutMs = Math.max(0, numberParam(p.timeout, 0)) * 1000;
      if (queue.length === 0 && timeoutMs > 0) {
        // A new waiting poll ends the one before it, as on Telegram
        // (telegram-bot-api Client::abort_long_poll).
        abortLongPoll(
          caller,
          "Conflict: terminated by other getUpdates request; make sure that only one bot instance is running",
        );
        // A client that hangs up stops waiting with it.
        const hangup = clientGone.get(execution.getStore());
        await new Promise((resolve, reject) => {
          const finish = () => {
            clearTimeout(waiter.timer);
            caller.pollWaiters.delete(waiter);
            hangup?.removeEventListener("abort", waiter.wake);
          };
          const waiter = {
            wake: () => {
              finish();
              resolve();
            },
            abort: (message) => {
              finish();
              conflictPause(caller).then(() =>
                reject(new TelegramError(409, message)),
              );
            },
          };
          waiter.timer = setTimeout(waiter.wake, timeoutMs);
          caller.pollWaiters.add(waiter);
          if (hangup?.aborted) waiter.wake();
          else hangup?.addEventListener("abort", waiter.wake, { once: true });
        });
      }
      return queue.slice(0, limit);
    },
    // The commands are read before the scope (process_set_my_commands_query).
    setMyCommands: (p, caller) => {
      const commands =
        p.commands === undefined || p.commands === ""
          ? []
          : jsonList(p.commands, "commands", "BotCommand", (command) => {
              if (!isObject(command)) throw new Error("expected an Object");
              requiredString(command, "command");
              requiredString(command, "description");
              return command;
            });
      caller.commands.set(commandsKey(p, caller), commands);
      return true;
    },
    deleteMyCommands: (p, caller) => {
      caller.commands.delete(commandsKey(p, caller));
      return true;
    },
    // Only the list set for exactly this scope and language, else none.
    getMyCommands: (p, caller) =>
      caller.commands.get(commandsKey(p, caller)) ?? [],
    answerCallbackQuery: (p, caller) => {
      if (openQueries.get(String(p.callback_query_id)) !== caller.id) {
        throw new TelegramError(
          400,
          "Bad Request: query is too old and response timeout expired or query ID is invalid",
        );
      }
      // The text is 0-200 characters; Telegram refuses longer text
      // (https://core.telegram.org/method/messages.setBotCallbackAnswer).
      if ([...String(p.text ?? "")].length > 200) {
        throw new TelegramError(400, "Bad Request: MESSAGE_TOO_LONG");
      }
      openQueries.delete(String(p.callback_query_id));
      callbackAnswers.set(String(p.callback_query_id), {
        text: p.text ?? "",
        show_alert: isTrue(p.show_alert),
      });
      waits.notify();
      return true;
    },
    getChat: (p, caller) => {
      requireChatId(p.chat_id);
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
        const chat = requireChat(id, caller, {
          readOnly: true,
          readsUpgraded: true,
        });
        const pinned = latestPin(chat);
        return {
          ...chatObject(chat),
          ...(pinned ? { pinned_message: pinnedMessage(pinned.message) } : {}),
          // Default member permissions are for groups and supergroups only.
          ...(chat.type !== "channel"
            ? { permissions: { ...chat.permissions } }
            : {}),
          ...(chat.description ? { description: chat.description } : {}),
          // The bot's own primary link, while it may manage invite links;
          // an upgraded basic group has none.
          ...(chat.migratedTo == null &&
          hasRight(chat, caller.id, "can_invite_users")
            ? { invite_link: primaryLink(chat, caller).invite_link }
            : {}),
          ...(chat.photo ? { photo: chatPhotoObject(chat.photo) } : {}),
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
      // The pin is in the user's private chat with the first bot, which users
      // write to; another bot's private chat with them is another chat.
      const pinned =
        caller.id === bot.id && privateChats.has(id)
          ? latestPin(privateChats.get(id))
          : undefined;
      return {
        id: user.id,
        type: "private",
        first_name: user.first_name,
        ...(user.last_name ? { last_name: user.last_name } : {}),
        ...(user.username ? { username: user.username } : {}),
        ...(user.bio ? { bio: user.bio } : {}),
        ...(photo ? { photo: chatPhotoObject(photo) } : {}),
        ...(pinned ? { pinned_message: pinnedMessage(pinned.message) } : {}),
        accent_color_id: 0,
        max_reaction_count: 11,
        accepted_gift_types: { ...NO_GIFTS },
      };
    },
    // The bot reads its own status with Read access, anyone else's with
    // ReadMembers (process_get_chat_member_query).
    getChatMember: (p, caller) => {
      const userId = userIdParam(p.user_id);
      const chat = requireChat(p.chat_id, caller, {
        readOnly: userId === caller.id,
      });
      return chatMemberObject(chat, userId, caller);
    },
    // Other bots are left out unless return_bots is set.
    getChatAdministrators: (p, caller) => {
      const chat = requireChat(p.chat_id, caller);
      return [...chat.members.entries()]
        .filter(([, m]) => ["creator", "administrator"].includes(m.status))
        .filter(
          ([id]) =>
            isTrue(p.return_bots) || id === caller.id || !users.get(id)?.is_bot,
        )
        .map(([id]) => chatMemberObject(chat, id, caller));
    },
    getChatMemberCount: (p, caller) => {
      const chat = requireChat(p.chat_id, caller);
      return [...chat.members.keys()].filter((id) => isInChat(chat, id)).length;
    },
    getUserProfilePhotos: (p) => {
      const user = requireUser(userIdParam(p.user_id));
      const offset = Math.max(0, numberParam(p.offset, 0));
      const limit = Math.min(100, Math.max(1, numberParam(p.limit, 100)));
      const photos = (user.photos ?? []).slice(offset, offset + limit);
      return {
        total_count: user.photos?.length ?? 0,
        photos: photos.map(photoSizes),
      };
    },
    getFile: (p, caller) => {
      const held = files.get(String(p.file_id));
      if (!held) throw new TelegramError(400, "Bad Request: invalid file_id");
      // Another bot's file_id reads as one, but its download fails
      // (Client.cpp on_update_file).
      if (held.botId !== caller.id) {
        throw new TelegramError(
          400,
          "Bad Request: wrong file_id or the file is temporarily unavailable",
        );
      }
      return {
        file_id: p.file_id,
        file_unique_id: held.file.file_unique_id,
        file_size: held.file.data.length,
        file_path: filePath(held.file, p.file_id),
      };
    },
    sendMessage: (p, caller) =>
      p.business_connection_id
        ? sendBusinessMessage(p, caller)
        : sendFrom(p, caller, textFields(p)),
    getBusinessConnection: (p, caller) =>
      businessConnectionObject(
        requireBusinessConnection(p.business_connection_id, caller),
      ),
    sendPhoto: (p, caller) => sendMedia(p, caller, "photo"),
    sendDocument: (p, caller) => sendMedia(p, caller, "document"),
    sendVideo: (p, caller) => sendMedia(p, caller, "video"),
    sendAnimation: (p, caller) => sendMedia(p, caller, "animation"),
    sendSticker: (p, caller) => sendMedia(p, caller, "sticker"),
    editMessageText: (p, caller) => editMessage(p, caller, "text", textEdit(p)),
    editMessageReplyMarkup: (p, caller) =>
      editMessage(p, caller, "reply_markup", () => {}),
    editMessageCaption: (p, caller) =>
      editMessage(p, caller, "caption", captionEdit(p)),
    editMessageMedia: (p, caller) =>
      editMessage(p, caller, "media", mediaEdit(p, caller)),
    // Ephemeral messages are edited and deleted by the bot that sent them,
    // through their own methods, which return True.
    editEphemeralMessageText: (p, caller) =>
      editEphemeralMessage(
        p,
        caller,
        ephemeralTextEdit(textFields(p, "Bad Request: MESSAGE_TOO_LONG")),
      ),
    editEphemeralMessageReplyMarkup: (p, caller) =>
      editEphemeralMessage(p, caller, () => {}),
    editEphemeralMessageCaption: (p, caller) => {
      const formatted = captionFields(p, "Bad Request: MEDIA_CAPTION_TOO_LONG");
      return editEphemeralMessage(
        p,
        caller,
        ephemeralTextEdit({
          text: formatted.caption,
          entities: formatted.caption_entities,
        }),
      );
    },
    editEphemeralMessageMedia: (p, caller) =>
      editEphemeralMessage(p, caller, mediaEdit(p, caller)),
    deleteEphemeralMessage: (p, caller) => {
      const receiverId = userIdParam(p.receiver_user_id, "receiver_user_id");
      ownEphemeralMessage(p, caller, receiverId, { readOnly: true }).deleted =
        true;
      appliedCheckpoint();
      waits.notify();
      return true;
    },
    // A poll may carry a photo, uploaded with it as attach://<name>.
    sendPoll: (p, caller) => {
      const texts = jsonList(
        p.options === undefined ? "" : p.options,
        "options",
        "InputPollOption",
        pollOptionText,
      );
      const quiz = p.type === "quiz";
      const correct = quiz ? correctOptionIds(p) : [];
      const chat = botChat(p.chat_id, caller, { send: true });
      if (!String(p.question ?? "").trim()) {
        throw new TelegramError(400, "Bad Request: text must be non-empty");
      }
      if (texts.length === 0) {
        throw new TelegramError(
          400,
          "Bad Request: poll must have at least one answer option",
        );
      }
      if (texts.length > 12) {
        throw new TelegramError(
          400,
          "Bad Request: poll can't have more than 12 options",
        );
      }
      for (const text of texts) {
        if (!text.trim()) {
          throw new TelegramError(400, "Bad Request: text must be non-empty");
        }
        if ([...text.trim()].length > 100) {
          throw new TelegramError(
            400,
            "Bad Request: poll options length must not exceed 100",
          );
        }
      }
      if (quiz && correct.length === 0) {
        throw new TelegramError(
          400,
          "Bad Request: correct quiz option list must be non-empty",
        );
      }
      if (correct.some((id, index) => index > 0 && id <= correct[index - 1])) {
        throw new TelegramError(
          400,
          "Bad Request: correct quiz option list must be increasing",
        );
      }
      if (correct.some((id) => id < 0 || id >= texts.length)) {
        throw new TelegramError(
          400,
          "Bad Request: wrong quiz correct_option_id",
        );
      }
      const membersOnly = isTrue(p.members_only);
      if (membersOnly && chat.type !== "channel") {
        throw new TelegramError(
          400,
          "Bad Request: poll voters can be restricted only in channel chats",
        );
      }
      const attached =
        typeof p.media?.media === "string" &&
        p.media.media.startsWith("attach://")
          ? p[p.media.media.slice("attach://".length)]
          : null;
      const photo = Buffer.isBuffer(attached) ? registerPhoto(attached) : null;
      nextPollId += 1n;
      return sendFrom(p, caller, {
        poll: {
          id: String(nextPollId),
          question: String(p.question),
          // persistent_id is the option's data. Telegram does not document
          // its form; TDLib, when it chose it for a new poll, counted from "0".
          options: texts.map((text, index) => ({
            persistent_id: String.fromCharCode(48 + index),
            text,
            voter_count: 0,
          })),
          total_voter_count: 0,
          is_closed: isTrue(p.is_closed),
          is_anonymous: p.is_anonymous === undefined || isTrue(p.is_anonymous),
          allows_multiple_answers: isTrue(p.allows_multiple_answers),
          allows_revoting:
            p.allows_revoting === undefined
              ? !quiz
              : isTrue(p.allows_revoting),
          members_only: membersOnly,
          type: quiz ? "quiz" : "regular",
          // The Bot API server still adds the single correct option as the
          // older correct_option_id.
          ...(correct.length === 1 ? { correct_option_id: correct[0] } : {}),
          ...(quiz ? { correct_option_ids: correct } : {}),
          ...(p.description ? { description: String(p.description) } : {}),
          ...(photo ? { media: { photo: photoSizes(photo) } } : {}),
        },
      });
    },
    // Bots get updates about the polls they stop and the polls they sent
    // (https://core.telegram.org/bots/api#update), so the bot that stops a
    // poll and the bot that sent it get the closed poll as a poll update. The
    // answer comes from TDLib's result, not after the update is delivered
    // (telegram-bot-api TdOnStopPollCallback). Its keyboard is checked as a
    // send's: read with the request, its callback_data once the poll is
    // found open (process_stop_poll_query, PollManager::stop_poll).
    stopPoll: (p, caller) => {
      const markup = inlineMarkup(p.reply_markup);
      const chat = botChat(p.chat_id, caller);
      const entry = chat.messages.get(Number(p.message_id));
      if (!entry || entry.deleted || !entry.message.poll) {
        throw new TelegramError(
          400,
          "Bad Request: message with poll to stop not found",
        );
      }
      requireEditable(chat, entry, caller, "poll");
      if (entry.message.poll.is_closed) {
        throw new TelegramError(
          400,
          "Bad Request: poll has already been closed",
        );
      }
      requireButtonData(markup);
      entry.message.poll.is_closed = true;
      // Only a message's poll carries its description and media.
      const {
        description: _description,
        media: _media,
        ...state
      } = entry.message.poll;
      const sender = [...bots.values()].find(
        (record) => record.id === entry.author && record.id !== caller.id,
      );
      void emit("poll", structuredClone(state), {
        to: sender ? [caller, sender] : [caller],
      });
      return entry.message.poll;
    },
    forwardMessage: (p, caller) => {
      const { source, content } = forwardable(p, caller, false);
      return sendFrom(
        {
          chat_id: p.chat_id,
          message_thread_id: p.message_thread_id,
          protect_content: p.protect_content,
        },
        caller,
        {
          ...content,
          forward_origin: messageOrigin(source.chat, source.message),
        },
      );
    },
    // A caption given replaces the original's on media that takes one, and an
    // empty one removes it; a text message keeps no caption (TDLib
    // dup_message_content). It is parsed first either way (get_caption in the
    // Bot API server); only a kept caption must fit 1024 characters, which
    // Telegram's server checks (MEDIA_CAPTION_TOO_LONG).
    copyMessage: async (p, caller) => {
      if (p.caption != null) {
        formatOrFail(String(p.caption), p.parse_mode, p.caption_entities);
      }
      const { content } = forwardable(p, caller, true);
      if (
        p.caption !== undefined &&
        CAPTIONED_CONTENT.includes(contentType(content))
      ) {
        delete content.caption;
        delete content.caption_entities;
        Object.assign(content, captionFields(p));
      }
      const copy = await sendFrom(p, caller, content);
      return { message_id: copy.message_id };
    },
    // The message is looked up before the rights: the Bot API server's
    // check_message, then TDLib's can_pin_message.
    pinChatMessage: (p, caller) => {
      const chat = botChat(p.chat_id, caller);
      const entry = chat.messages.get(Number(p.message_id));
      if (!entry || entry.deleted) {
        throw new TelegramError(400, "Bad Request: message to pin not found");
      }
      requirePinRights(chat, caller);
      // The Bot API delivers the service message to the pinning bot too
      // (need_skip_update_message keeps an outgoing messagePinMessage). Not
      // awaited: the bot may be inside its webhook.
      emit(
        "message",
        pin(chat, entry, caller),
        chat.type === "private" ? { to: [caller] } : {},
      );
      return true;
    },
    unpinChatMessage: (p, caller) => {
      const chat = botChat(p.chat_id, caller);
      // No message_id (or 0) means the most recent pin.
      const asked = Number(p.message_id);
      const entry = asked > 0 ? chat.messages.get(asked) : latestPin(chat);
      if (!entry || entry.deleted) {
        throw new TelegramError(400, "Bad Request: message to unpin not found");
      }
      requirePinRights(chat, caller);
      const id = entry.message.message_id;
      chat.pinned = (chat.pinned ?? []).filter((each) => each !== id);
      return true;
    },
    unpinAllChatMessages: (p, caller) => {
      const chat = botChat(p.chat_id, caller);
      requirePinRights(chat, caller);
      chat.pinned = [];
      return true;
    },
    // The permissions are read before the chat (get_chat_permissions).
    setChatPermissions: (p, caller) => {
      const permissions = normalizePermissions(
        p.permissions,
        p.use_independent_chat_permissions,
      );
      const chat = requireChat(p.chat_id, caller);
      if (chat.type === "channel") {
        throw new TelegramError(
          400,
          "Bad Request: can't change channel chat permissions",
        );
      }
      requireRight(
        chat,
        caller,
        "can_restrict_members",
        "not enough rights to change chat permissions",
      );
      chat.permissions = permissions;
      return true;
    },
    leaveChat: (p, caller) => {
      const chat = requireChat(p.chat_id, caller, {
        readOnly: true,
        readsUpgraded: true,
      });
      // TDLib refuses to leave a basic group that was upgraded.
      if (chat.migratedTo != null) {
        throw new TelegramError(400, "Bad Request: chat is deactivated");
      }
      // Telegram answers at once; the updates follow on their own.
      if (isInChat(chat, caller.id)) {
        void setBotMembership(chat, caller, { status: "left", actor: caller });
      }
      return true;
    },
    // A bot deletes its own messages, and others' with can_delete_messages.
    deleteMessage: (p, caller) => {
      const chat = botChat(p.chat_id, caller);
      const entry = chat.messages.get(Number(p.message_id));
      if (!entry || entry.deleted) {
        throw new TelegramError(
          400,
          "Bad Request: message to delete not found",
        );
      }
      requireDeleteRights(chat, entry, caller);
      entry.deleted = true;
      appliedCheckpoint();
      waits.notify();
      return true;
    },
    deleteMessages: (p, caller) => {
      const ids = messageIds(p.message_ids);
      const chat = botChat(p.chat_id, caller);
      const entries = ids
        .map((id) => chat.messages.get(id))
        .filter((entry) => entry && !entry.deleted);
      for (const entry of entries) requireDeleteRights(chat, entry, caller);
      for (const entry of entries) entry.deleted = true;
      appliedCheckpoint();
      waits.notify();
      return true;
    },
    restrictChatMember: (p, caller) => {
      const userId = userIdParam(p.user_id);
      const permissions = normalizePermissions(
        p.permissions,
        p.use_independent_chat_permissions,
      );
      const chat = requireChat(p.chat_id, caller);
      if (chat.type !== "supergroup") {
        throw new TelegramError(
          400,
          "Bad Request: method is available only in supergroups",
        );
      }
      requireUser(userId);
      assertCanModerate(chat, userId, { self: "can't restrict self", caller });
      const before = memberStatus(chat, userId);
      const inChat = isInChat(chat, userId);
      // Passing every permission as true lifts the restriction.
      if (PERMISSION_KEYS.every((key) => permissions[key])) {
        if (before.status === "restricted") {
          chat.members.set(userId, { status: inChat ? "member" : "left" });
        }
      } else {
        chat.members.set(userId, {
          status: "restricted",
          is_member: inChat,
          until_date: restrictionUntil(p.until_date),
          permissions,
        });
      }
      memberChanged(chat, userId, before, caller);
      return true;
    },
    banChatMember: (p, caller) => {
      const userId = userIdParam(p.user_id);
      const chat = requireChat(p.chat_id, caller);
      const user = requireUser(userId);
      assertCanModerate(chat, userId, { caller });
      const before = memberStatus(chat, userId);
      const wasIn = isInChat(chat, userId);
      const botsBefore = botsIn(chat);
      // A basic group keeps no ban list: a removed person is no longer a
      // participant, which TDLib reports as left (ChatManager.cpp
      // finish_get_chat_participant), while a removed bot sees itself banned.
      chat.members.set(
        userId,
        chat.type !== "group"
          ? { status: "kicked", until_date: restrictionUntil(p.until_date) }
          : user.is_bot
            ? { status: "kicked", until_date: 0 }
            : { status: "left" },
      );
      // revoke_messages decides what the removed user can still see; a ban
      // deletes nothing for the chat's other members (only deleteMessage does).
      memberChanged(chat, userId, before, caller);
      // A basic group removes the member with messages.deleteChatUser, which
      // "sends a service message on it"; a removed bot hears of it too.
      if (chat.type === "group" && wasIn) {
        emit(
          "message",
          addMessage(chat, caller, {
            left_chat_member: userObject(user),
          }),
          { to: [...new Set([...botsBefore, ...botsIn(chat)])] },
        );
      }
      return true;
    },
    unbanChatMember: (p, caller) => {
      const userId = userIdParam(p.user_id);
      const chat = requireChat(p.chat_id, caller);
      requireSupergroupOrChannel(chat);
      requireRight(
        chat,
        caller,
        "can_restrict_members",
        "not enough rights to restrict/unrestrict chat member",
      );
      requireUser(userId);
      const before = memberStatus(chat, userId);
      if (before.status === "kicked") {
        chat.members.set(userId, { status: "left" });
      } else if (isTrue(p.only_if_banned)) {
        return true;
      } else {
        // Without only_if_banned, Telegram guarantees the user is not a member
        // afterwards: a current member is removed, keeping any restriction.
        assertCanModerate(chat, userId, { caller });
        if (before.status === "restricted") {
          chat.members.set(userId, { ...before, is_member: false });
        } else if (before.status === "member") {
          chat.members.set(userId, { status: "left" });
        }
      }
      memberChanged(chat, userId, before, caller);
      return true;
    },
    // answerChatJoinRequestQuery names no chat, so Telegram's server checks
    // none for it (`query`).
    approveChatJoinRequest: (p, caller, { query = false } = {}) => {
      const userId = userIdParam(p.user_id);
      const chat = requireChat(p.chat_id, query ? null : caller);
      requireRight(
        chat,
        caller,
        "can_invite_users",
        "not enough rights to manage chat join requests",
      );
      if (!chat.joinRequests.has(userId)) {
        throw new TelegramError(400, "Bad Request: HIDE_REQUESTER_MISSING");
      }
      const request = chat.joinRequests.get(userId);
      chat.joinRequests.delete(userId);
      joinDecisions.set(`${chat.id}:${userId}`, {
        state: "approved",
        botId: caller.id,
      });
      const before = memberStatus(chat, userId);
      admit(chat, userId);
      // via_join_request is only for requests made without an invite link;
      // every request here came through one, so the link is reported instead.
      emitMemberChange(chat, userId, before, caller, {
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
    declineChatJoinRequest: (p, caller, { query = false } = {}) => {
      const userId = userIdParam(p.user_id);
      const chat = requireChat(p.chat_id, query ? null : caller);
      requireRight(
        chat,
        caller,
        "can_invite_users",
        "not enough rights to manage chat join requests",
      );
      if (!chat.joinRequests.delete(userId)) {
        throw new TelegramError(400, "Bad Request: HIDE_REQUESTER_MISSING");
      }
      joinDecisions.set(`${chat.id}:${userId}`, {
        state: "declined",
        botId: caller.id,
      });
      waits.notify();
      return true;
    },
    createChatInviteLink: (p, caller) => {
      const chat = requireChat(p.chat_id, caller);
      // TDLib refuses a member_limit with creates_join_request before it
      // checks the bot's rights.
      const fields = inviteLinkFields(p);
      requireInviteRights(chat, caller);
      return { ...addInviteLink(chat, caller, fields) };
    },
    exportChatInviteLink: (p, caller) => {
      const chat = requireChat(p.chat_id, caller);
      requireInviteRights(chat, caller);
      return replacePrimaryLink(chat, caller).invite_link;
    },
    sendVoice: (p, caller) => sendMedia(p, caller, "voice"),
    sendAudio: (p, caller) => sendMedia(p, caller, "audio"),
    sendVideoNote: (p, caller) => sendMedia(p, caller, "video_note"),
    // A live_period other than 0 sends a live location, which TDLib checks
    // with its own text (Client.cpp process_send_location_query, Location.cpp
    // process_live_location).
    sendLocation: (p, caller) => {
      const location = coordinates(
        p,
        Math.trunc(numberParam(p.live_period, 0)) !== 0
          ? "Bad Request: invalid live location specified"
          : "Bad Request: invalid location specified",
      );
      return sendFrom(p, caller, () => ({
        location: { ...location, ...liveLocation(p) },
      }));
    },
    sendVenue: (p, caller) => {
      const location = coordinates(
        p,
        "Bad Request: wrong venue location specified",
      );
      // UNVERIFIED: Telegram's Bot API and TDLib do not check these; the
      // answer for an empty title or address is not documented.
      if (!p.title || !p.address) {
        throw new TelegramError(
          400,
          "Bad Request: venue needs title and address",
        );
      }
      return sendFrom(p, caller, {
        venue: { location, title: String(p.title), address: String(p.address) },
        location,
      });
    },
    sendContact: (p, caller) => {
      for (const field of ["phone_number", "first_name"]) {
        if (p[field] === undefined || p[field] === "") {
          throw new TelegramError(
            400,
            `Bad Request: parameter "${field}" is required`,
          );
        }
      }
      return sendFrom(p, caller, {
        contact: {
          phone_number: String(p.phone_number),
          first_name: String(p.first_name),
          ...(p.last_name ? { last_name: String(p.last_name) } : {}),
          ...(p.vcard ? { vcard: String(p.vcard) } : {}),
        },
      });
    },
    sendDice: (p, caller) => {
      const emoji = p.emoji ?? "🎲";
      if (!DICE[emoji]) {
        throw new TelegramError(400, "Bad Request: invalid dice emoji");
      }
      return sendFrom(p, caller, {
        dice: { emoji, value: 1 + Math.floor(Math.random() * DICE[emoji]) },
      });
    },
    sendChatAction: (p, caller) => {
      if (!CHAT_ACTIONS.has(p.action)) {
        throw new TelegramError(
          400,
          "Bad Request: wrong parameter action in request",
        );
      }
      const chat = botChat(p.chat_id, caller, { send: true });
      requireCanSend(chat, caller);
      return true;
    },
    // An album of up to 10 photos and videos, or of documents or audios
    // alone; one item is sent as an ordinary message (TDLib
    // MessagesManager::send_message_group, check_message_group_message_contents).
    sendMediaGroup: (p, caller) => {
      if (p.media === undefined || p.media === "") {
        throw new TelegramError(
          400,
          'Bad Request: parameter "media" is required',
        );
      }
      const items = jsonList(p.media, "media", "InputMedia", (item) => {
        if (!isObject(item)) throw new Error("expected an Object");
        requiredString(item, "type");
        return item;
      });
      const types = items.map((item) => item.type);
      if (
        types.some(
          (type) => !["photo", "video", "document", "audio"].includes(type),
        )
      ) {
        throw new TelegramError(400, "Bad Request: unsupported media type");
      }
      const chat = botChat(p.chat_id, caller, { send: true });
      if (items.length === 0) {
        throw new TelegramError(
          400,
          "Bad Request: there are no messages to send",
        );
      }
      requireCanSend(chat, caller);
      // Telegram parses every InputMedia caption, then reads every file,
      // before it sends any of the album.
      const formatted = items.map((item) => {
        const caption = captionFields(item);
        if (namedFile(p, item.media) === null) {
          throw new TelegramError(
            400,
            "Bad Request: can't parse InputMedia: media not found",
          );
        }
        return caption;
      });
      // Then it reads every file, as send_message_group does before it counts
      // the album.
      const media = items.map((item) =>
        // An album's documents go as plain files (Client.cpp get_input_media).
        sentFile(p, item.media, item.type, caller, senderMeta(item), {
          typeName: item.type === "document" ? "DocumentAsFile" : undefined,
        }),
      );
      if (items.length > 10) {
        throw new TelegramError(
          400,
          "Bad Request: too many messages to send as an album",
        );
      }
      for (const alone of ["document", "audio"]) {
        if (types.includes(alone) && types.some((type) => type !== alone)) {
          throw new TelegramError(
            400,
            `Bad Request: ${alone} can't be mixed with other media types`,
          );
        }
      }
      const mediaGroupId =
        items.length > 1 ? String(nextMediaGroupId++) : undefined;
      // One send of every item, each answering the same message.
      return sendFrom(
        {
          chat_id: p.chat_id,
          message_thread_id: p.message_thread_id,
          reply_parameters: p.reply_parameters,
          reply_to_message_id: p.reply_to_message_id,
          allow_sending_without_reply: p.allow_sending_without_reply,
          protect_content: p.protect_content,
        },
        caller,
        media.map((file, index) => ({
          ...mediaFields(file.kind, file),
          ...formatted[index],
          ...(mediaGroupId ? { media_group_id: mediaGroupId } : {}),
        })),
      );
    },
    promoteChatMember: (p, caller) => {
      const userId = userIdParam(p.user_id);
      const chat = requireChat(p.chat_id, caller);
      requireSupergroupOrChannel(chat);
      requireUser(userId);
      if (!hasRight(chat, caller.id, "can_promote_members")) {
        throw new TelegramError(400, "Bad Request: not enough rights");
      }
      const current = memberStatus(chat, userId);
      if (current.status === "creator") {
        throw new TelegramError(400, "Bad Request: USER_CREATOR");
      }
      if (!isInChat(chat, userId)) {
        throw new TelegramError(400, "Bad Request: USER_NOT_PARTICIPANT");
      }
      if (
        current.status === "administrator" &&
        current.promotedBy !== caller.id
      ) {
        throw new TelegramError(400, "Bad Request: CHAT_ADMIN_REQUIRED");
      }
      const rights = Object.fromEntries(
        ADMIN_RIGHTS.map((right) => [right, isTrue(p[right])]),
      );
      // "For backward compatibility, defaults to True for promotions of
      // channel administrators."
      if (
        chat.type === "channel" &&
        Object.values(rights).some(Boolean) &&
        p.can_restrict_members === undefined
      ) {
        rights.can_restrict_members = true;
      }
      // TDLib drops the rights this kind of chat does not have before the
      // server checks the rest; with none left, the user stays a member
      // (DialogParticipant.cpp AdministratorRights and Administrator).
      const kept = chatAdminRights(chat);
      for (const right of ADMIN_RIGHTS) {
        if (!kept.includes(right)) rights[right] = false;
      }
      for (const [right, granted] of Object.entries(rights)) {
        if (
          granted &&
          right !== "is_anonymous" &&
          right !== "can_manage_chat" &&
          !hasRight(chat, caller.id, right)
        ) {
          throw new TelegramError(400, "Bad Request: RIGHT_FORBIDDEN");
        }
      }
      if (Object.values(rights).some(Boolean)) {
        // Any right implies can_manage_chat, as on Telegram.
        chat.members.set(userId, {
          status: "administrator",
          rights: { ...rights, can_manage_chat: true },
          promotedBy: caller.id,
        });
      } else {
        chat.members.set(userId, { status: "member" });
      }
      void memberChanged(chat, userId, current, caller);
      return true;
    },
    setChatAdministratorCustomTitle: (p, caller) => {
      const userId = userIdParam(p.user_id);
      const chat = requireChat(p.chat_id, caller);
      if (chat.type === "channel") {
        throw new TelegramError(
          400,
          "Bad Request: method is available only in groups and supergroups",
        );
      }
      const member = memberStatus(chat, userId);
      if (member.status === "creator") {
        throw new TelegramError(
          400,
          "Bad Request: only the owner can edit their custom title",
        );
      }
      if (member.status !== "administrator") {
        throw new TelegramError(
          400,
          "Bad Request: user is not an administrator",
        );
      }
      if (member.promotedBy !== caller.id) {
        throw new TelegramError(
          400,
          "Bad Request: not enough rights to change custom title of the user",
        );
      }
      // Telegram's server renames the RANK_* errors for this method.
      const title = String(p.custom_title ?? "");
      if (/\p{Extended_Pictographic}/u.test(title)) {
        throw new TelegramError(
          400,
          "Bad Request: CUSTOM_TITLE_EMOJI_NOT_ALLOWED",
        );
      }
      if ([...title].length > 16) {
        throw new TelegramError(400, "Bad Request: CUSTOM_TITLE_INVALID");
      }
      chat.members.set(userId, { ...member, customTitle: title || undefined });
      void memberChanged(chat, userId, member, caller);
      return true;
    },
    // TDLib cleans the title and cuts it to 128 characters, and setting the
    // current title again succeeds without a change (DialogManager.cpp
    // set_dialog_title).
    setChatTitle: (p, caller) => {
      const chat = requireChat(p.chat_id, caller);
      const title = stripEmpty(p.title, 128).replace(/\s+/g, " ");
      if (!title) {
        throw new TelegramError(400, "Bad Request: title must be non-empty");
      }
      requireInfoRight(chat, caller, "change chat title");
      if (title === chat.title) return true;
      chat.title = title;
      // The Bot API delivers the service message to the bot that made the
      // change too (need_skip_update_message keeps outgoing title, photo and
      // pin messages). Not awaited: the bot may be inside its webhook.
      void emit("message", addMessage(chat, caller, { new_chat_title: title }));
      return true;
    },
    // The description is cut to 255 characters (ChatManager.cpp
    // set_channel_description).
    setChatDescription: (p, caller) => {
      const chat = requireChat(p.chat_id, caller);
      requireInfoRight(chat, caller, "set chat description");
      const description = stripEmpty(p.description, 255);
      if (description === (chat.description ?? "")) {
        throw new TelegramError(
          400,
          "Bad Request: chat description is not modified",
        );
      }
      chat.description = description || undefined;
      return true;
    },
    setChatPhoto: (p, caller) => {
      const chat = requireChat(p.chat_id, caller);
      requireInfoRight(chat, caller, "change chat photo");
      if (!Buffer.isBuffer(p.photo)) {
        throw new TelegramError(
          400,
          "Bad Request: there is no photo in the request",
        );
      }
      chat.photo = registerPhoto(p.photo);
      void emit(
        "message",
        addMessage(chat, caller, { new_chat_photo: photoSizes(chat.photo) }),
      );
      return true;
    },
    deleteChatPhoto: (p, caller) => {
      const chat = requireChat(p.chat_id, caller);
      requireInfoRight(chat, caller, "change chat photo");
      if (!chat.photo) {
        throw new TelegramError(400, "Bad Request: CHAT_NOT_MODIFIED");
      }
      chat.photo = undefined;
      void emit(
        "message",
        addMessage(chat, caller, { delete_chat_photo: true }),
      );
      return true;
    },
    // An edit sets every field of the link; one left out takes its default.
    editChatInviteLink: (p, caller) => {
      const chat = requireChat(p.chat_id, caller);
      requireInviteRights(chat, caller);
      const fields = inviteLinkFields(p);
      if (String(p.invite_link ?? "") === "") {
        throw new TelegramError(
          400,
          "Bad Request: invite link must be non-empty",
        );
      }
      const invite = chat.inviteLinks.get(String(p.invite_link));
      if (!invite || invite.is_revoked) {
        throw new TelegramError(400, "Bad Request: INVITE_HASH_EXPIRED");
      }
      if (invite.creator.id !== caller.id) {
        throw new TelegramError(400, "Bad Request: CHAT_ADMIN_REQUIRED");
      }
      // Only a non-primary link can be edited.
      if (invite.is_primary) {
        throw new TelegramError(400, "Bad Request: CHAT_INVITE_PERMANENT");
      }
      return {
        ...addInviteLink(chat, caller, {
          ...fields,
          invite_link: invite.invite_link,
        }),
      };
    },
    // A bot sets at most one reaction of its own on a message, an emoji from
    // ReactionTypeEmoji's list; an album takes it on its first message.
    setMessageReaction: (p, caller) => {
      const reactions =
        p.reaction === undefined || p.reaction === ""
          ? []
          : jsonList(p.reaction, "reaction types", "ReactionType", reactionType);
      const chat = botChat(p.chat_id, caller, { readOnly: true });
      let entry = chat.messages.get(Number(p.message_id));
      if (!entry || entry.deleted) {
        throw new TelegramError(400, "Bad Request: MESSAGE_ID_INVALID");
      }
      const group = entry.message.media_group_id;
      if (group) {
        entry = [...chat.messages.values()].find(
          (other) => !other.deleted && other.message.media_group_id === group,
        );
      }
      // TDLib reads "" as no reaction, "$" as the paid one and "#…" as a
      // custom emoji, so none of them is an emoji reaction.
      if (
        reactions.some(
          ({ type, emoji }) =>
            type === "emoji" &&
            (emoji === "" || emoji === "$" || emoji.startsWith("#")),
        )
      ) {
        throw new TelegramError(
          400,
          "Bad Request: invalid reaction type specified",
        );
      }
      if (reactions.length > 1) {
        throw new TelegramError(400, "Bad Request: REACTIONS_TOO_MANY");
      }
      if (
        reactions.some(
          (reaction) =>
            reaction.type === "emoji" && !REACTION_EMOJI.has(reaction.emoji),
        )
      ) {
        throw new TelegramError(400, "Bad Request: REACTION_INVALID");
      }
      entry.reactions ??= new Map();
      if (reactions.length) {
        entry.reactions.set(
          caller.id,
          reactions.map((reaction) => String(reaction.emoji ?? "")),
        );
      } else entry.reactions.delete(caller.id);
      return true;
    },
    // Removes a user's reaction, or a chat's (actor_chat_id) when no user_id
    // is given; needs can_delete_messages.
    deleteMessageReaction: (p, caller) => {
      // user_id is read before the chat.
      const byUser = p.user_id != null && p.user_id !== "";
      const userId = byUser ? userIdParam(p.user_id) : null;
      const chat = requireChat(p.chat_id, caller);
      if (!hasRight(chat, caller.id, "can_delete_messages")) {
        throw new TelegramError(
          400,
          "Bad Request: not enough rights to delete reactions",
        );
      }
      const entry = chat.messages.get(Number(p.message_id));
      if (!entry || entry.deleted) {
        throw new TelegramError(400, "Bad Request: MESSAGE_ID_INVALID");
      }
      if (!byUser) {
        const actor = String(p.actor_chat_id ?? "");
        if (!actor) {
          throw new TelegramError(400, "Bad Request: sender_chat_id is empty");
        }
        if (!/^-?\d+$/.test(actor)) {
          throw new TelegramError(
            400,
            "Bad Request: sender_chat_id is not a valid Integer",
          );
        }
        // Members react as themselves here, so no chat's reaction is ever
        // there to remove.
        return true;
      }
      const user = requireUser(userId);
      if (entry.reactions?.has(user.id)) {
        void changeReaction(chat, entry, user, []);
      }
      return true;
    },
    // A guard bot answers a join request query: approve, decline, or leave it
    // to the other administrators.
    answerChatJoinRequestQuery: (p, caller) => {
      // The result is read trimmed and lower-cased, before the query id.
      const result = String(p.result ?? "")
        .trim()
        .toLowerCase();
      if (!["approve", "decline", "queue"].includes(result)) {
        throw new TelegramError(
          400,
          "Bad Request: invalid query result specified",
        );
      }
      const id = String(p.chat_join_request_query_id ?? "");
      const query = joinQueries.get(id);
      if (!query || query.botId !== caller.id) {
        throw new TelegramError(
          400,
          "Bad Request: query is too old and response timeout expired or query ID is invalid",
        );
      }
      joinQueries.delete(id);
      const target = { chat_id: query.chatId, user_id: query.userId };
      if (result === "approve") {
        methods.approveChatJoinRequest(target, caller, { query: true });
      }
      if (result === "decline") {
        methods.declineChatJoinRequest(target, caller, { query: true });
      }
      return true;
    },
    // Revokes a link the bot created; a revoked primary link is replaced by
    // a new one.
    revokeChatInviteLink: (p, caller) => {
      const chat = requireChat(p.chat_id, caller);
      requireInviteRights(chat, caller);
      if (String(p.invite_link ?? "") === "") {
        throw new TelegramError(
          400,
          "Bad Request: invite link must be non-empty",
        );
      }
      const invite = chat.inviteLinks.get(String(p.invite_link));
      if (!invite) {
        throw new TelegramError(400, "Bad Request: INVITE_HASH_EXPIRED");
      }
      if (invite.creator.id !== caller.id) {
        throw new TelegramError(400, "Bad Request: CHAT_ADMIN_REQUIRED");
      }
      if (!invite.is_revoked && invite.is_primary) {
        replacePrimaryLink(chat, caller);
      }
      invite.is_revoked = true;
      return { ...invite };
    },
  };

  const methodsByLowerName = new Map(
    Object.entries(methods).map(([name, handler]) => [
      name.toLowerCase(),
      handler,
    ]),
  );

  /** deleteMessages' message_ids, checked as Client::get_message_ids does. */
  function messageIds(value) {
    if (value === undefined || value === "") {
      throw new TelegramError(
        400,
        "Bad Request: message identifiers are not specified",
      );
    }
    if (!Array.isArray(jsonParam(value, "message_ids"))) {
      throw new TelegramError(
        400,
        "Bad Request: expected an Array of message identifiers",
      );
    }
    if (value.length > 100) {
      throw new TelegramError(
        400,
        "Bad Request: too many message identifiers specified",
      );
    }
    return value.map((id) => {
      if (!["number", "string"].includes(typeof id)) {
        throw new TelegramError(
          400,
          "Bad Request: message identifier must be a Number",
        );
      }
      if (!/^-?\d+$/.test(String(id)) || Math.abs(Number(id)) >= 2 ** 31) {
        throw new TelegramError(
          400,
          "Bad Request: can't parse message identifier as a Number",
        );
      }
      if (Number(id) <= 0) {
        throw new TelegramError(
          400,
          "Bad Request: invalid message identifier specified",
        );
      }
      return Number(id);
    });
  }

  /**
   * reply_markup, checked as Client::get_reply_markup reads it, when it has
   * an inline keyboard with at least one row; else undefined. Like the Bot API
   * server, it refuses a button without text or an action while reading the
   * request, before any chat or message check, and keeps of each button only
   * its text, icon, style and the one action it reads, as
   * JsonInlineKeyboardButton returns it.
   */
  function inlineMarkup(value) {
    const markup = jsonParam(value, "reply keyboard markup");
    if (markup === undefined) return undefined;
    if (!isObject(markup)) {
      throw new TelegramError(
        400,
        "Bad Request: object expected as reply markup",
      );
    }
    for (const field of ["keyboard", "inline_keyboard"]) {
      if (field in markup && !Array.isArray(markup[field])) {
        throw new TelegramError(
          400,
          `Bad Request: field "${field}" must be of type Array`,
        );
      }
    }
    if (!(markup.inline_keyboard?.length > 0)) return undefined;
    const kept = (button) => {
      if (typeof button !== "object" || button === null) return button;
      try {
        requiredString(button, "text");
      } catch (error) {
        throw new TelegramError(
          400,
          `Bad Request: can't parse InlineKeyboardButton: ${error.message}`,
        );
      }
      const action = inlineButtonAction(button);
      if (!action) {
        throw new TelegramError(
          400,
          "Bad Request: can't parse InlineKeyboardButton: Text buttons are not allowed in the inline keyboard",
        );
      }
      return Object.fromEntries(
        ["text", "icon_custom_emoji_id", "style", action]
          .filter((field) => Object.hasOwn(button, field))
          .map((field) => [field, button[field]]),
      );
    };
    return {
      inline_keyboard: markup.inline_keyboard.map((row) =>
        Array.isArray(row) ? row.map(kept) : row,
      ),
    };
  }

  /**
   * callback_data is 1-64 bytes (https://core.telegram.org/bots/api#inlinekeyboardbutton).
   * Telegram's servers, not the Bot API server, refuse longer data, so this
   * comes after the chat and message checks, as the message is stored.
   */
  function requireButtonData(markup) {
    for (const button of markup?.inline_keyboard.flat() ?? []) {
      if (
        inlineButtonAction(button) === "callback_data" &&
        Buffer.byteLength(String(button.callback_data)) > 64
      ) {
        throw new TelegramError(400, "Bad Request: BUTTON_DATA_INVALID");
      }
    }
  }

  /**
   * A reply keyboard, its removal or ForceReply. Telegram keeps it on the
   * message without showing it in Message.reply_markup, and such a message
   * can't be edited (TDLib can_edit_message).
   */
  function isReplyKeyboard(markup) {
    return (
      (Array.isArray(markup?.keyboard) && markup.keyboard.length > 0) ||
      (!inlineMarkup(markup) &&
        (isTrue(markup?.remove_keyboard) || isTrue(markup?.force_reply)))
    );
  }

  /**
   * Sends one message, or, when the content is a list, an album of them in
   * one send (sendMessageAlbum).
   */
  async function sendFrom(p, caller, fields) {
    const parameters = replyParameters(p);
    // Message.reply_markup only ever carries an inline keyboard; reply
    // keyboards and ForceReply are shown to the user, not echoed back. The
    // inline rows are read even when a reply keyboard wins.
    const inline = inlineMarkup(p.reply_markup);
    const keyboard = isReplyKeyboard(p.reply_markup);
    const markup = keyboard ? undefined : inline;
    const ephemeral = p.ephemeral_message_parameters;
    const chat = botChat(p.chat_id, caller, { send: true });
    requireCanSend(chat, caller);
    requireTopic(chat, p.message_thread_id);
    const reply = replyFields(chat, p, caller, parameters);
    // Content given as a function is read only now, after the chat and reply
    // checks, as TDLib reads a file or live location only when it sends.
    const body = typeof fields === "function" ? fields() : fields;
    // Telegram's server, not the Bot API server or TDLib, decides who may
    // get an ephemeral message, so that comes after their checks.
    const receiver =
      ephemeral?.receiver_user_id != null
        ? ephemeralReceiver(chat, caller, ephemeral, body)
        : null;
    requireButtonData(markup);
    const bodies = Array.isArray(body) ? body : [body];
    if (floodControl === true) await waitForFlood(chat, caller, bodies.length);
    const sent = bodies.map((item) => {
      const content = {
        ...item,
        ...reply,
        ...(markup ? { reply_markup: markup } : {}),
        ...(p.message_thread_id && chat.topics
          ? {
              message_thread_id: Number(p.message_thread_id),
              is_topic_message: true,
            }
          : {}),
        ...(isTrue(p.protect_content) ? { has_protected_content: true } : {}),
      };
      if (receiver) return addEphemeralMessage(chat, caller, receiver, content);
      const message = addMessage(chat, caller, content);
      if (keyboard) chat.messages.get(message.message_id).replyKeyboard = true;
      return message;
    });
    return Array.isArray(body) ? sent : sent[0];
  }

  /**
   * The member an ephemeral message (Bot API 10.2) may go to: one who is not a
   * bot, in a group or supergroup. A bot that administers the chat may send one
   * at any time; any other bot only within 15 seconds of an eligible action,
   * named by callback_query_id or reply_parameters.ephemeral_message_id
   * (https://core.telegram.org/bots/api#ephemeral-messages-and-commands).
   * Members cannot send ephemeral messages here, so only a callback query from
   * the receiver qualifies. First, TDLib refuses content it does not send as
   * an ephemeral message: a poll, a dice or a live location
   * (MessagesManager::send_ephemeral_message,
   * is_allowed_ephemeral_message_content).
   * UNVERIFIED: Telegram does not document the errors after that one.
   */
  function ephemeralReceiver(chat, caller, ephemeral, body) {
    if (
      ["poll", "dice"].includes(contentType(body)) ||
      body.location?.live_period
    ) {
      throw new TelegramError(
        400,
        "Bad Request: unallowed message content specified",
      );
    }
    const receiver = requireUser(ephemeral.receiver_user_id);
    if (!["group", "supergroup"].includes(chat.type)) {
      throw new TelegramError(400, "Bad Request: PEER_ID_INVALID");
    }
    if (receiver.is_bot) {
      throw new TelegramError(400, "Bad Request: USER_IS_BOT");
    }
    if (!isInChat(chat, receiver.id)) {
      throw new TelegramError(400, "Bad Request: USER_NOT_PARTICIPANT");
    }
    if (memberStatus(chat, caller.id).status === "administrator") {
      return receiver;
    }
    const query = recentQueries.get(String(ephemeral.callback_query_id ?? ""));
    if (
      query?.botId !== caller.id ||
      query.userId !== receiver.id ||
      clock.now() - query.at > EPHEMERAL_REPLY_MS
    ) {
      throw new TelegramError(400, "Bad Request: CHAT_ADMIN_REQUIRED");
    }
    return receiver;
  }

  // Flood control, when floodControl is set: the limits Telegram publishes for
  // a bot's messages, not its internal algorithm.
  // https://core.telegram.org/bots/faq#my-bot-is-hitting-limits-how-do-i-avoid-this
  // Recent send times (server clock, ms), oldest first, for each bot in each
  // chat and for each bot across its chats; an album adds one per message.
  const recentSends = new Map();
  function floodWait(chat, caller, count) {
    const at = clock.now();
    const inChat = `${caller.id}:${chat.id}`;
    const limits = [
      // "In a single chat, avoid sending more than one message per second.
      // We may allow short bursts that go over this limit": an album goes
      // once the chat's last send is a second old.
      [inChat, 1, 1000],
      // "In a group, bots are not be able to send more than 20 messages per
      // minute."
      ...(chat.type === "group" || chat.type === "supergroup"
        ? [[inChat, 20, 60_000]]
        : []),
      // "bots are not able to broadcast more than about 30 messages per second"
      [String(caller.id), 30, 1000],
    ];
    let wakeupAt = at;
    for (const [key, limit, windowMs] of limits) {
      // The send fits once the window holds room for all its messages.
      const oldest = recentSends.get(key)?.at(-Math.max(1, limit - count + 1));
      if (oldest !== undefined && oldest > at - windowMs) {
        wakeupAt = Math.max(wakeupAt, oldest + windowMs);
      }
    }
    return wakeupAt - at;
  }

  /**
   * A send over a limit gets FLOOD_WAIT_X from Telegram, X being the whole
   * seconds to wait. The Bot API server's TDLib, for a bot, waits X seconds and
   * sends again while the waits of the send add up to at most 8 seconds;
   * after that it fails the send with 429 "Too Many Requests: retry after X"
   * (NetQueryCreator.cpp total_timeout_limit, NetQueryDelayer::delay), which
   * the Bot API server passes on (Client::fail_query_with_error).
   */
  async function waitForFlood(chat, caller, count) {
    let waited = 0;
    for (
      let wait = floodWait(chat, caller, count);
      wait > 0 && !stopped;
      wait = floodWait(chat, caller, count)
    ) {
      const seconds = Math.ceil(wait / 1000);
      waited += seconds;
      if (waited > 8) {
        throw new TelegramError(
          429,
          `Too Many Requests: retry after ${seconds}`,
          { retry_after: seconds },
        );
      }
      await delayResponse(seconds * 1000);
    }
    for (const key of [`${caller.id}:${chat.id}`, String(caller.id)]) {
      const sends = recentSends.get(key) ?? [];
      sends.push(...Array(count).fill(clock.now()));
      // No limit looks further back than 30 sends.
      recentSends.set(key, sends.slice(-30));
    }
  }

  /**
   * reply_parameters, or the older reply_to_message_id, as
   * Client::get_reply_parameters reads them.
   */
  function replyParameters(p) {
    const given = jsonParam(p.reply_parameters, "reply parameters");
    if (given === undefined) {
      return p.reply_to_message_id != null
        ? {
            message_id: p.reply_to_message_id,
            allow_sending_without_reply: isTrue(p.allow_sending_without_reply),
          }
        : null;
    }
    if (!isObject(given)) {
      throw new TelegramError(
        400,
        "Bad Request: object expected as reply parameters",
      );
    }
    return given;
  }

  /**
   * The reply fields of a bot send. Its reply parameters answer a message in
   * this chat with reply_to_message, or, with chat_id, one in another chat the
   * bot can read with external_reply; a quote must be found in the message it
   * answers. A message_id of 0 or less names no message, as none does
   * (Client.cpp check_reply_parameters). Else, in a forum topic, the send
   * answers the topic's creation message.
   * https://core.telegram.org/bots/api#replyparameters
   */
  function replyFields(chat, p, caller, parameters) {
    if (parameters?.message_id == null || Number(parameters.message_id) <= 0) {
      const topic =
        p.message_thread_id && chat.topics
          ? chat.messages.get(Number(p.message_thread_id))
          : null;
      if (!topic) return {};
      const { reply_to_message: _nested, ...original } = topic.message;
      return { reply_to_message: original };
    }
    // A chat_id naming the send's own chat is an ordinary reply (Client.cpp
    // check_reply_parameters).
    const source =
      parameters.chat_id == null ||
      String(parameters.chat_id) === String(p.chat_id)
        ? chat
        : (chats.get(Number(parameters.chat_id)) ??
          privateChats.get(Number(parameters.chat_id)));
    if (!source) throw new TelegramError(400, "Bad Request: chat not found");
    // Another group or channel is checked for reading (check_chat with
    // AccessRights::Read in Client.cpp check_reply_parameters).
    if (source !== chat && source.type !== "private") {
      checkChatAccess(source, caller, { readOnly: true, readsUpgraded: true });
    }
    // Only members read a supergroup's or a channel's messages (Client.cpp
    // have_message_access).
    if (
      ["supergroup", "channel"].includes(source.type) &&
      !isInChat(source, caller.id)
    ) {
      throw new TelegramError(
        400,
        "Bad Request: message to be replied not found",
      );
    }
    const entry = source.messages.get(Number(parameters.message_id));
    if (
      !entry ||
      entry.deleted ||
      (source.type === "group" && !isInChat(source, caller.id))
    ) {
      if (isTrue(parameters.allow_sending_without_reply)) return {};
      throw new TelegramError(
        400,
        "Bad Request: message to be replied not found",
      );
    }
    const quote = replyQuote(entry.message, parameters);
    if (source === chat) {
      const { reply_to_message: _nested, ...original } = entry.message;
      return { reply_to_message: original, ...(quote ? { quote } : {}) };
    }
    const automatic = quote ?? automaticQuote(entry.message);
    return {
      external_reply: externalReply(source, entry.message),
      ...(automatic ? { quote: automatic } : {}),
    };
  }

  /** The text a quote is taken from: a message's text, or its caption. */
  function quotable(message) {
    return message.text !== undefined
      ? { text: message.text, entities: message.entities ?? [] }
      : {
          text: message.caption ?? "",
          entities: message.caption_entities ?? [],
        };
  }

  function quoteEntities(entities) {
    return entities.filter((entity) => QUOTE_ENTITIES.includes(entity.type));
  }

  /**
   * reply_parameters.quote: an exact substring of the replied message,
   * including its bold, italic, underline, strikethrough, spoiler,
   * custom_emoji and date_time entities, else the send fails with
   * QUOTE_TEXT_INVALID (https://core.telegram.org/method/messages.sendMessage).
   * Its position is the one the sender gives.
   */
  function replyQuote(message, parameters) {
    if (parameters.quote == null || parameters.quote === "") return null;
    const quote = formatOrFail(
      String(parameters.quote),
      parameters.quote_parse_mode,
      parameters.quote_entities,
    );
    if (!quote.text) return null;
    const entities = quoteEntities(quote.entities);
    const original = quotable(message);
    const kept = quoteEntities(original.entities);
    const key = (list) =>
      list
        .map((entity) => JSON.stringify(Object.entries(entity).sort()))
        .sort()
        .join();
    const length = quote.text.length;
    let found = false;
    for (
      let at = original.text.indexOf(quote.text);
      at !== -1 && !found;
      at = original.text.indexOf(quote.text, at + 1)
    ) {
      // The original's entities over that stretch, cut to it.
      const within = kept
        .map((entity) => {
          const start = Math.max(entity.offset, at);
          const end = Math.min(entity.offset + entity.length, at + length);
          return { ...entity, offset: start - at, length: end - start };
        })
        .filter((entity) => entity.length > 0);
      found = key(within) === key(entities);
    }
    if (!found) throw new TelegramError(400, "Bad Request: QUOTE_TEXT_INVALID");
    return {
      text: quote.text,
      ...(entities.length > 0 ? { entities } : {}),
      position: Number(parameters.quote_position ?? 0),
      is_manual: true,
    };
  }

  /**
   * The quote Telegram adds to a reply to another chat that chose none: the
   * replied message's text or caption, up to 1024 characters, with the
   * entities a quote keeps (TDLib RepliedMessageInfo.cpp and
   * MessageQuote::create_automatic_quote).
   */
  function automaticQuote(message) {
    const original = quotable(message);
    if (!original.text) return null;
    const text = [...original.text].slice(0, QUOTE_LENGTH_MAX).join("");
    const entities = quoteEntities(original.entities)
      .filter((entity) => entity.offset < text.length)
      .map((entity) => ({
        ...entity,
        length: Math.min(entity.length, text.length - entity.offset),
      }));
    return {
      text,
      ...(entities.length > 0 ? { entities } : {}),
      position: 0,
    };
  }

  /**
   * Where a message came from, as a forward or an external reply shows it: a
   * forward keeps its first origin, a channel post names the channel, and
   * anything else its sender (TDLib get_forwarded_message_origin).
   */
  function messageOrigin(chat, message) {
    if (message.forward_origin) return structuredClone(message.forward_origin);
    return chat.type === "channel"
      ? {
          type: "channel",
          chat: message.chat,
          message_id: message.message_id,
          date: message.date,
        }
      : { type: "user", sender_user: message.from, date: message.date };
  }

  /**
   * ExternalReplyInfo for a reply to another chat: the message's origin, its
   * chat and id when the chat is a supergroup or a channel, and its media
   * without the caption, or a text's link preview options (TDLib
   * RepliedMessageInfo.cpp, Client.cpp JsonExternalReplyInfo).
   * https://core.telegram.org/bots/api#externalreplyinfo
   */
  function externalReply(chat, message) {
    const origin = messageOrigin(chat, message);
    const type = contentType(message);
    const content =
      type === "text"
        ? message.link_preview_options
          ? { link_preview_options: message.link_preview_options }
          : {}
        : type
          ? { [type]: message[type] }
          : {};
    return {
      origin,
      ...(origin.type === "channel"
        ? { chat: origin.chat, message_id: origin.message_id }
        : ["supergroup", "channel"].includes(chat.type)
          ? { chat: chatObject(chat), message_id: message.message_id }
          : {}),
      ...structuredClone(content),
    };
  }

  /**
   * text, entities and link_preview_options of a bot's message, after
   * parse_mode or explicit entities. Telegram allows 4096 characters (code
   * points, as TDLib's utf8_length counts them) after parsing: a send is
   * refused by TDLib with "message is too long", an edit by Telegram's server
   * with MESSAGE_TOO_LONG.
   */
  function textFields(p, tooLong = "Bad Request: message is too long") {
    const preview = jsonParam(p.link_preview_options, "link preview options");
    if (preview !== undefined && !isObject(preview)) {
      throw new TelegramError(
        400,
        "Bad Request: object expected as link preview options",
      );
    }
    const text = String(p.text ?? "");
    if (!text) {
      throw new TelegramError(400, "Bad Request: message text is empty");
    }
    const formatted = formatOrFail(text, p.parse_mode, p.entities);
    if (!formatted.text) {
      throw new TelegramError(400, "Bad Request: text must be non-empty");
    }
    if ([...formatted.text].length > 4096)
      throw new TelegramError(400, tooLong);
    const options = linkPreviewOptions(p, formatted);
    return {
      text: formatted.text,
      ...(formatted.entities.length > 0
        ? { entities: formatted.entities }
        : {}),
      ...(options ? { link_preview_options: options } : {}),
    };
  }

  /**
   * Message.link_preview_options: the options a send or edit gave, only when
   * they differ from the defaults. As TDLib keeps them, a disabled preview
   * drops the URL, small or large media need an explicit URL
   * (InputMessageText.cpp), and disabling the preview of a text without a
   * link changes nothing (MessageContent.cpp).
   */
  function linkPreviewOptions(p, formatted) {
    const given =
      p.link_preview_options ??
      (isTrue(p.disable_web_page_preview) ? { is_disabled: true } : null);
    if (given === null || typeof given !== "object") return null;
    const disabled = isTrue(given.is_disabled);
    const url = disabled ? "" : String(given.url ?? "");
    const options = {
      ...(disabled && hasPreviewLink(formatted) ? { is_disabled: true } : {}),
      ...(url ? { url } : {}),
      ...(url && isTrue(given.prefer_small_media)
        ? { prefer_small_media: true }
        : {}),
      ...(url && isTrue(given.prefer_large_media)
        ? { prefer_large_media: true }
        : {}),
      ...(isTrue(given.show_above_text) ? { show_above_text: true } : {}),
    };
    return Object.keys(options).length > 0 ? options : null;
  }

  /** Whether a text has a link a preview could show (TDLib get_first_url). */
  function hasPreviewLink({ text, entities }) {
    return entities.some((entity) => {
      const url =
        entity.type === "url" && entity.length > 4
          ? text.slice(entity.offset, entity.offset + entity.length)
          : entity.type === "text_link"
            ? String(entity.url ?? "")
            : "";
      const scheme = url.slice(0, 8).toLowerCase();
      return (
        url !== "" &&
        !["ton:", "ftp:", "tonsite:"].includes(scheme) &&
        !scheme.startsWith("tg:") &&
        // A bare domain gets no preview.
        (entity.type !== "url" || /[/?#]/.test(url))
      );
    });
  }

  /**
   * caption and caption_entities of a bot's media message; a caption that is
   * only spaces is none. 1024 characters at most, refused like text.
   */
  function captionFields(
    p,
    tooLong = "Bad Request: message caption is too long",
  ) {
    if (p.caption == null || p.caption === "") return {};
    const formatted = formatOrFail(
      String(p.caption),
      p.parse_mode,
      p.caption_entities,
    );
    if (!formatted.text) return {};
    if ([...formatted.text].length > 1024)
      throw new TelegramError(400, tooLong);
    return {
      caption: formatted.text,
      ...(formatted.entities.length > 0
        ? { caption_entities: formatted.entities }
        : {}),
    };
  }

  function formatOrFail(text, parseMode, entities) {
    // The Bot API server refuses more than 32 KB of text before parsing it.
    if (Buffer.byteLength(text) > 1 << 15) {
      throw new TelegramError(400, "Bad Request: text is too long");
    }
    try {
      return formatText(text, { parseMode, entities, user: entityUser });
    } catch (error) {
      if (error instanceof FormattingError) {
        throw new TelegramError(400, error.message);
      }
      throw error;
    }
  }

  /**
   * text and entities of a member's message. The member's app cleans and
   * trims the text as TDLib does, and Telegram refuses an empty message with
   * MESSAGE_EMPTY (https://core.telegram.org/method/messages.sendMessage).
   */
  function memberText(text) {
    const formatted = formatText(String(text ?? ""));
    if (!formatted.text) throw new TelegramError(400, "MESSAGE_EMPTY");
    return {
      text: formatted.text,
      ...(formatted.entities.length > 0
        ? { entities: formatted.entities }
        : {}),
    };
  }

  /**
   * The User a text_mention shows. The Bot API server writes what it knows of
   * the user (Client.cpp JsonUser): an unknown one has only its id, is_bot
   * false and an empty first_name.
   */
  function entityUser(id) {
    const user = users.get(id);
    return user ? userObject(user) : { id, is_bot: false, first_name: "" };
  }

  /**
   * A bot sends a photo, document, video, animation, sticker, voice note, audio
   * file or video note. A send that names no file fails first (Client.cpp
   * process_send_photo_query and the like). A file sent again by file_id
   * keeps its kind and what its first sender said about it.
   */
  function sendMedia(p, caller, type) {
    if (namedFile(p, p[type]) === null) {
      throw new TelegramError(
        400,
        `Bad Request: there is no ${type.replace("_", " ")} in the request`,
      );
    }
    const caption =
      type === "photo" || MEMBER_MEDIA[type].caption ? captionFields(p) : {};
    // sendDocument's disable_content_type_detection sends a plain file
    // (MessageContent.cpp get_input_message_content).
    const typeName =
      type === "document" && isTrue(p.disable_content_type_detection)
        ? "DocumentAsFile"
        : undefined;
    return sendFrom(p, caller, () => {
      const meta = senderMeta(p);
      const file = sentFile(p, p[type], type, caller, meta, { typeName });
      // TDLib takes a video note at most 640 wide, after the Bot API caps it
      // at 10000 (MessageContent.cpp create_input_message_content).
      if (type === "video_note" && meta.length > 640) {
        throw new TelegramError(400, "Bad Request: wrong video note length");
      }
      return { ...mediaFields(file.kind, file), ...caption };
    });
  }

  /**
   * A live location's period, heading and proximity alert radius, checked as
   * TDLib checks them (Location.cpp process_live_location); none without a
   * live_period (Client.cpp process_send_location_query).
   */
  function liveLocation(p) {
    const [period, heading, radius] = [
      p.live_period,
      p.heading,
      p.proximity_alert_radius,
    ].map((value) => Math.trunc(numberParam(value, 0)));
    if (period === 0) return {};
    if (period !== 0x7fffffff && (period < 60 || period > 86400)) {
      throw new TelegramError(
        400,
        "Bad Request: wrong live location period specified",
      );
    }
    if (heading !== 0 && (heading < 1 || heading > 360)) {
      throw new TelegramError(
        400,
        "Bad Request: wrong live location heading specified",
      );
    }
    if (radius < 0 || radius > 100000) {
      throw new TelegramError(
        400,
        "Bad Request: wrong live location proximity alert radius specified",
      );
    }
    return {
      live_period: period,
      ...(heading > 0 ? { heading } : {}),
      ...(radius > 0 ? { proximity_alert_radius: radius } : {}),
    };
  }

  /**
   * latitude and longitude as Client::get_location reads them; TDLib refuses
   * a point off the map with `invalid` (Location.cpp, Venue.cpp).
   */
  function coordinates(p, invalid) {
    for (const field of ["latitude", "longitude"]) {
      if (String(p[field] ?? "").trim() === "") {
        throw new TelegramError(400, `Bad Request: ${field} is empty`);
      }
    }
    const latitude = Number(p.latitude);
    const longitude = Number(p.longitude);
    if (
      !Number.isFinite(latitude) ||
      !Number.isFinite(longitude) ||
      Math.abs(latitude) > 90 ||
      Math.abs(longitude) > 180
    ) {
      throw new TelegramError(400, invalid);
    }
    return { latitude, longitude };
  }

  /**
   * Text as TDLib's strip_empty_characters leaves it: trimmed, cut to `max`
   * characters, and empty when only invisible characters remain (misc.cpp).
   */
  function stripEmpty(value, max) {
    const text = [...String(value ?? "").trim()].slice(0, max).join("").trim();
    return /[^\s\u200b-\u200f\u202e\ufeff]/u.test(text) ? text : "";
  }

  /** Changing a chat's title, description or photo needs can_change_info. */
  /** `change` names the call in TDLib's text, e.g. "change chat title". */
  function requireInfoRight(chat, caller, change) {
    requireRight(
      chat,
      caller,
      "can_change_info",
      `not enough rights to ${change}`,
    );
  }

  // ── Business connections ────────────────────────────────────────────────
  function businessConnectionObject(connection) {
    return {
      id: connection.id,
      user: userObject(requireUser(connection.ownerId)),
      user_chat_id: connection.ownerId,
      date: connection.date,
      rights: { ...connection.rights },
      is_enabled: connection.isEnabled,
    };
  }

  /**
   * The caller's connection with that id. The Bot API answers any failure
   * to find one with "business connection not found" (telegram-bot-api
   * TdOnCheckBusinessConnectionCallback).
   */
  function requireBusinessConnection(id, caller) {
    const connection = businessConnections.get(String(id ?? ""));
    if (!connection || connection.botId !== caller.id) {
      throw new TelegramError(
        400,
        "Bad Request: business connection not found",
      );
    }
    return connection;
  }

  /** A business send's chat_id, as Client::get_business_connection_chat_id reads it. */
  function businessChatId(value) {
    if (value == null || value === "") {
      throw new TelegramError(400, "Bad Request: chat identifier is empty");
    }
    if (!/^-?\d+$/.test(String(value))) {
      throw new TelegramError(
        400,
        "Bad Request: chat identifier must be a valid Integer",
      );
    }
    return Number(value);
  }

  function businessChat(connection, userId) {
    const key = Number(userId);
    if (!connection.chats.has(key)) {
      connection.chats.set(key, {
        entries: [],
        nextMessageId: 1,
        lastInboundAt: null,
      });
    }
    return connection.chats.get(key);
  }

  /** A business chat is the owner's private chat with a person. */
  function businessChatObject(userId) {
    const user = requireUser(userId);
    return {
      id: user.id,
      type: "private",
      first_name: user.first_name,
      ...(user.last_name ? { last_name: user.last_name } : {}),
      ...(user.username ? { username: user.username } : {}),
    };
  }

  function addBusinessMessage(connection, userId, direction, from, fields) {
    const chat = businessChat(connection, userId);
    const message = {
      message_id: chat.nextMessageId++,
      from: userObject(from),
      chat: businessChatObject(userId),
      date: now(),
      business_connection_id: connection.id,
      ...fields,
    };
    if (message.text && !message.entities) {
      const entities = findEntities(message.text);
      if (entities.length > 0) message.entities = entities;
    }
    chat.entries.push({ direction, deleted: false, message });
    return message;
  }

  /**
   * The business chat the bot sends or edits in, as the owner. It needs an
   * enabled connection with can_reply, and can_reply covers sending and
   * editing only in chats "that had incoming messages in the last 24 hours"
   * (https://core.telegram.org/bots/api#businessbotrights); past that,
   * Telegram answers BUSINESS_PEER_USAGE_MISSING
   * (https://core.telegram.org/method/messages.sendMessage).
   */
  function businessReplyChat(p, caller) {
    const userId = businessChatId(p.chat_id);
    const connection = requireBusinessConnection(
      p.business_connection_id,
      caller,
    );
    // UNVERIFIED: Telegram does not document the error for a disabled
    // connection; a disabled connection is treated as an invalid one.
    if (!connection.isEnabled) {
      throw new TelegramError(400, "Bad Request: BUSINESS_CONNECTION_INVALID");
    }
    // BOT_ACCESS_FORBIDDEN is Telegram's error for an operation a business
    // connection does not allow (connected-business-bots page); that a missing
    // can_reply right produces it is UNVERIFIED. The Bot API answers an
    // upper-case 403 server error as a 400 (Client::fail_query_with_error).
    if (connection.rights.can_reply !== true) {
      throw new TelegramError(400, "Bad Request: BOT_ACCESS_FORBIDDEN");
    }
    requireUser(userId);
    const chat = businessChat(connection, userId);
    if (
      chat.lastInboundAt == null ||
      clock.now() - chat.lastInboundAt > 24 * 60 * 60 * 1000
    ) {
      throw new TelegramError(400, "Bad Request: BUSINESS_PEER_USAGE_MISSING");
    }
    return { connection, userId, chat };
  }

  /** The bot answers in a business chat, as the owner. */
  function sendBusinessMessage(p, caller) {
    const text = textFields(p);
    const markup = inlineMarkup(p.reply_markup);
    const { connection, userId } = businessReplyChat(p, caller);
    requireButtonData(markup);
    return addBusinessMessage(
      connection,
      userId,
      "bot",
      requireUser(connection.ownerId),
      {
        ...text,
        sender_business_bot: userObject(caller),
      },
    );
  }

  /**
   * The business message a bot edits for the owner. The person's messages are
   * not the owner's to edit, and the owner's own messages without an inline
   * keyboard only within 48 hours of being sent
   * (https://core.telegram.org/bots/api#editmessagetext). The errors are
   * messages.editMessage's (https://core.telegram.org/method/messages.editMessage),
   * all Bad Request through the Bot API (Client.cpp fail_query_with_error);
   * which one Telegram gives in each case is UNVERIFIED. Business chats here
   * hold text messages only, so caption and media edits are not modelled.
   */
  function businessEditEntry(p, caller, kind) {
    if (kind === "caption" || kind === "media") {
      // Not modelled: Telegram's answer to a method it does not know, with
      // the gap reported by GET /_fake/calls and the log.
      const method =
        kind === "caption" ? "editMessageCaption" : "editMessageMedia";
      reportUnimplemented(`${method} with business_connection_id`);
      throw new TelegramError(404, "Not Found: method not found");
    }
    const { chat } = businessReplyChat(p, caller);
    const entry = chat.entries.find(
      (each) => each.message.message_id === Number(p.message_id),
    );
    if (!entry || entry.deleted) {
      throw new TelegramError(400, "Bad Request: MESSAGE_ID_INVALID");
    }
    if (entry.direction === "inbound") {
      throw new TelegramError(400, "Bad Request: MESSAGE_AUTHOR_REQUIRED");
    }
    if (
      entry.direction === "owner" &&
      !inlineMarkup(entry.message.reply_markup) &&
      now() - entry.message.date >= 48 * 3600
    ) {
      throw new TelegramError(400, "Bad Request: MESSAGE_EDIT_TIME_EXPIRED");
    }
    return entry;
  }

  /**
   * A test connects a bot to an owner's account, or changes an existing
   * connection (rights, enabled). Telegram sends the bot business_connection
   * each time.
   */
  function connectBusiness(body) {
    const existing =
      body.id != null ? businessConnections.get(String(body.id)) : null;
    const ownerId = Number(body.owner_id ?? existing?.ownerId);
    const owner = requireUser(ownerId);
    if (owner.is_bot) {
      throw new TelegramError(
        400,
        "a business account owner is a user, not a bot",
      );
    }
    const record =
      body.bot_id != null
        ? requireBot(body.bot_id)
        : existing
          ? requireBot(existing.botId)
          : bot;
    const connection = existing ?? {
      id: String(body.id ?? randomBytes(12).toString("base64url")),
      ownerId,
      botId: record.id,
      date: now(),
      chats: new Map(),
    };
    connection.ownerId = ownerId;
    connection.botId = record.id;
    connection.rights = { ...(body.rights ?? existing?.rights ?? {}) };
    connection.isEnabled =
      body.is_enabled !== undefined
        ? body.is_enabled === true
        : (existing?.isEnabled ?? true);
    businessConnections.set(connection.id, connection);
    // The owner's private chat with the bot is open to it from now on.
    const privateChat = messageChat(ownerId);
    privateChat.openTo ??= new Set();
    privateChat.openTo.add(record.id);
    const sent = emitOne(
      record,
      "business_connection",
      businessConnectionObject(connection),
    );
    return {
      connection: businessConnectionObject(connection),
      update_id: sent.updateId,
      delivered: sent.delivered,
    };
  }

  /**
   * A message in a business chat: from the person, or from the owner answering
   * by hand. The bot gets business_message while the connection is enabled.
   */
  async function sayInBusinessChat(connectionId, userId, { sender, text }) {
    const connection = businessConnections.get(String(connectionId));
    if (!connection) {
      throw new TelegramError(404, `No business connection ${connectionId}`);
    }
    if (sender !== "person" && sender !== "owner") {
      throw new TelegramError(400, 'sender must be "person" or "owner"');
    }
    const from = requireUser(sender === "person" ? userId : connection.ownerId);
    requireUser(userId);
    const message = addBusinessMessage(
      connection,
      userId,
      sender === "person" ? "inbound" : "owner",
      from,
      { text: String(text ?? "") },
    );
    if (sender === "person")
      businessChat(connection, userId).lastInboundAt = clock.now();
    let updateId = null;
    if (connection.isEnabled) {
      const sent = emitOne(
        requireBot(connection.botId),
        "business_message",
        structuredClone(message),
      );
      updateId = sent.updateId;
      await sent.delivered;
    }
    return {
      message_id: message.message_id,
      date: message.date,
      update_id: updateId,
    };
  }

  /**
   * The message a forward or copy reads, when the bot can see it. A service
   * message can be neither forwarded nor copied, and a protected one only
   * copied by a bot (TDLib can_forward_message). Only the content goes along:
   * a single album item leaves its album behind (get_forwarded_messages).
   */
  function forwardable(p, caller, copy) {
    // The source is only read (AccessRights::Read), so an upgraded basic
    // group's old id still serves its messages.
    const sourceChat = botChat(p.from_chat_id, caller, {
      readOnly: true,
      readsUpgraded: true,
    });
    const entry = sourceChat.messages.get(Number(p.message_id));
    if (
      !entry ||
      entry.deleted ||
      (sourceChat.type !== "private" && !isInChat(sourceChat, caller.id))
    ) {
      throw new TelegramError(400, "Bad Request: message to forward not found");
    }
    if (
      contentType(entry.message) === null ||
      (!copy && entry.message.has_protected_content)
    ) {
      throw new TelegramError(
        400,
        copy
          ? "Bad Request: the message can't be copied"
          : "Bad Request: the message can't be forwarded",
      );
    }
    const {
      message_id: _id,
      from: _from,
      sender_chat: _senderChat,
      chat: _chat,
      date: _date,
      edit_date: _edited,
      reply_markup: _markup,
      reply_to_message: _reply,
      external_reply: _external,
      quote: _quote,
      receiver_user: _receiver,
      ephemeral_message_id: _ephemeral,
      forward_origin: _origin,
      message_thread_id: _thread,
      is_topic_message: _topic,
      media_group_id: _album,
      has_protected_content: _protected,
      ...content
    } = structuredClone(entry.message);
    return { source: { chat: sourceChat, message: entry.message }, content };
  }

  /**
   * Whether the bot may edit a message or stop its poll, as TDLib's
   * MessagesManager::can_edit_message decides: its own messages, and in a
   * channel any post with can_edit_messages, but its own only while it has
   * can_post_messages. A media edit is refused with its own text
   * (edit_message_media), and stopPoll ("poll") with get_message_poll_id's.
   */
  function requireEditable(chat, entry, caller, kind) {
    const own = entry.author === caller.id;
    const allowed =
      chat.type === "channel"
        ? hasRight(chat, caller.id, "can_edit_messages") ||
          (own && hasRight(chat, caller.id, "can_post_messages"))
        : own;
    if (!allowed) {
      const refusal =
        kind === "media"
          ? "message media can't be edited"
          : kind === "poll"
            ? "poll can't be stopped"
            : "message can't be edited";
      throw new TelegramError(400, `Bad Request: ${refusal}`);
    }
  }

  /**
   * Whether a bot may make this kind of edit ("text", "caption", "media" or
   * "reply_markup") to a message it may edit, as TDLib's can_edit_message and
   * edit methods decide (MessagesManager.cpp). A forward, or a message sent
   * with a reply keyboard, can't be edited at all; text edits need a text
   * message, caption edits media that takes a caption, and media edits media
   * or text. Other content only has its inline keyboard changed; an open poll
   * counts as editable, since it can still be stopped.
   */
  function requireEditableContent(entry, kind) {
    const message = entry.message;
    const type = contentType(message);
    const editable =
      !message.forward_origin &&
      !entry.replyKeyboard &&
      (EDITABLE_CONTENT.includes(type) ||
        (kind === "reply_markup" && type !== null) ||
        (type === "poll" && !message.poll.is_closed));
    if (kind === "media") {
      if (!editable || !MEDIA_EDITABLE_CONTENT.includes(type)) {
        throw new TelegramError(
          400,
          "Bad Request: message media can't be edited",
        );
      }
      return;
    }
    if (!editable) {
      throw new TelegramError(400, "Bad Request: message can't be edited");
    }
    if (kind === "text" && type !== "text") {
      throw new TelegramError(
        400,
        "Bad Request: there is no text in the message to edit",
      );
    }
    if (kind === "caption" && !CAPTIONED_CONTENT.includes(type)) {
      throw new TelegramError(
        400,
        "Bad Request: there is no caption in the message to edit",
      );
    }
  }

  /**
   * Apply a bot edit to a stored message, as Telegram does: only messages the
   * bot may edit (requireEditable), and only as requireEditableContent
   * allows; an edit without reply_markup removes the inline keyboard, and an
   * edit that changes nothing is refused. With business_connection_id it
   * edits a business chat.
   */
  function editMessage(p, caller, kind, apply) {
    const markup = inlineMarkup(p.reply_markup);
    let entry;
    if (p.business_connection_id) {
      entry = businessEditEntry(p, caller, kind);
    } else {
      const chat = botChat(p.chat_id, caller);
      entry = chat.messages.get(Number(p.message_id));
      if (!entry || entry.deleted) {
        throw new TelegramError(400, "Bad Request: message to edit not found");
      }
      requireEditable(chat, entry, caller, kind);
      requireEditableContent(entry, kind);
    }
    requireButtonData(markup);
    const edited = editedMessage(entry.message, markup, apply);
    const same = (message) =>
      JSON.stringify([
        message.text,
        message.entities,
        message.caption,
        message.caption_entities,
        message.reply_markup,
        ...MEDIA_KINDS.map((kind) => message[kind]),
      ]);
    if (same(edited) === same(entry.message)) {
      throw new TelegramError(
        400,
        "Bad Request: message is not modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message",
      );
    }
    entry.message = edited;
    // Its buttons' presses now go to this bot (pressButton).
    if (markup) entry.keyboardBot = caller.id;
    appliedCheckpoint();
    waits.notify();
    return edited;
  }

  /**
   * Edit an ephemeral message the bot sent; the editEphemeralMessage… methods
   * return True. UNVERIFIED: Telegram does not document whether an edit without
   * reply_markup removes the keyboard, as a regular edit does, or whether one
   * that changes nothing is refused; this server removes it and accepts the
   * edit. Its keyboard is checked as a regular edit's: read with the request,
   * after receiver_user_id and before the chat (do_edit_ephemeral_message in
   * telegram-bot-api's Client.cpp), and its callback_data once the message is
   * found.
   */
  function editEphemeralMessage(p, caller, apply) {
    const receiverId = userIdParam(p.receiver_user_id, "receiver_user_id");
    const markup = inlineMarkup(p.reply_markup);
    const entry = ownEphemeralMessage(p, caller, receiverId);
    requireButtonData(markup);
    entry.message = editedMessage(entry.message, markup, apply);
    appliedCheckpoint();
    waits.notify();
    return true;
  }

  /** A copy of the message with the edit, reply_markup and edit_date applied. */
  function editedMessage(message, markup, apply) {
    const edited = structuredClone(message);
    apply(edited);
    if (markup) edited.reply_markup = markup;
    else delete edited.reply_markup;
    edited.edit_date = now();
    return edited;
  }

  /**
   * The ephemeral message chat_id, ephemeral_message_id and the receiver's id,
   * read before the chat (get_user_id in telegram-bot-api's Client.cpp), name,
   * sent by the calling bot.
   * UNVERIFIED: Telegram does not document the error for a message that does
   * not exist or was deleted.
   */
  function ownEphemeralMessage(p, caller, receiverId, access = {}) {
    const entry = botChat(p.chat_id, caller, access).ephemeral?.get(
      Number(p.ephemeral_message_id),
    );
    if (
      !entry ||
      entry.deleted ||
      entry.message.from.id !== caller.id ||
      entry.message.receiver_user.id !== receiverId
    ) {
      throw new TelegramError(400, "Bad Request: MESSAGE_ID_INVALID");
    }
    return entry;
  }

  /**
   * The text edit of editMessageText. TDLib does not check an edit's length
   * (edit_message_text); Telegram's server refuses a long one with
   * MESSAGE_TOO_LONG.
   */
  function textEdit(p) {
    const formatted = textFields(p, "Bad Request: MESSAGE_TOO_LONG");
    return (message) => {
      delete message.entities;
      delete message.link_preview_options;
      Object.assign(message, formatted);
    };
  }

  /**
   * The caption edit of editMessageCaption. An empty caption removes it:
   * Telegram leaves an empty one out. As with text, Telegram's server refuses
   * a long caption edit (TDLib checks only sends).
   */
  function captionEdit(p) {
    const formatted = captionFields(p, "Bad Request: MEDIA_CAPTION_TOO_LONG");
    return (message) => {
      delete message.caption;
      delete message.caption_entities;
      Object.assign(message, formatted);
    };
  }

  /**
   * The edit of editEphemeralMessageText and editEphemeralMessageCaption. TDLib
   * sends both as the same request with one message text
   * (EditEphemeralMessageQuery in MessageQueryManager.cpp), so Telegram's
   * server applies either to a text message's text or a media message's
   * caption. UNVERIFIED: Telegram does not document which of these edits its
   * server refuses. Here a caption longer than 1024 characters fails as a
   * caption edit does, and an empty text leaves a text message as it was, as
   * any text leaves content that takes no caption.
   */
  function ephemeralTextEdit({ text = "", entities, link_preview_options }) {
    return (message) => {
      const type = contentType(message);
      if (type === "text") {
        if (!text) return;
        delete message.entities;
        delete message.link_preview_options;
        Object.assign(message, {
          text,
          ...(entities ? { entities } : {}),
          ...(link_preview_options ? { link_preview_options } : {}),
        });
        return;
      }
      if (!CAPTIONED_CONTENT.includes(type)) return;
      if ([...text].length > 1024) {
        throw new TelegramError(400, "Bad Request: MEDIA_CAPTION_TOO_LONG");
      }
      delete message.caption;
      delete message.caption_entities;
      if (text) {
        Object.assign(message, {
          caption: text,
          ...(entities ? { caption_entities: entities } : {}),
        });
      }
    };
  }

  /**
   * The media edit of editMessageMedia and editEphemeralMessageMedia. The new
   * media is an upload attached as attach://<name>, a file_id the bot was
   * given or an HTTP URL; a live photo names its still photo too. The Bot API
   * reads it before the message, in get_input_media's order (Client.cpp): the
   * caption's markup, the type, the file, a live photo's still photo, then
   * whether an edit takes the type. TDLib reads the files and checks the
   * caption's length once it has the message (MessageContent.cpp
   * get_input_message_content). In an album the media may change only to a
   * kind the album allows (MessagesManager::edit_message_media).
   */
  function mediaEdit(p, caller) {
    if (p.media === undefined || p.media === "") {
      throw new TelegramError(
        400,
        'Bad Request: parameter "media" is required',
      );
    }
    if (typeof p.media === "string") {
      throw new TelegramError(
        400,
        "Bad Request: can't parse input media JSON object",
      );
    }
    const input = p.media;
    const unreadable = (reason) =>
      new TelegramError(400, `Bad Request: can't parse InputMedia: ${reason}`);
    if (!isObject(input)) throw unreadable("expected an Object");
    if (input.caption != null && input.caption !== "") {
      try {
        // The markup only; TDLib checks entities and length later.
        formatOrFail(String(input.caption), input.parse_mode);
      } catch (error) {
        if (!(error instanceof TelegramError)) throw error;
        const reason = error.message.replace(/^Bad Request: /, "");
        throw unreadable(reason[0].toUpperCase() + reason.slice(1));
      }
    }
    let type;
    try {
      type = requiredString(input, "type");
    } catch (error) {
      throw unreadable(error.message);
    }
    const reason =
      namedFile(p, input.media) === null
        ? "media not found"
        : type === "live_photo" && namedFile(p, input.photo) === null
          ? "Photo not found"
          : type === "voice_note"
            ? `type "${type}" is not allowed`
            : !MEDIA_KINDS.includes(type)
              ? `type "${type}" is unsupported`
              : null;
    if (reason) throw unreadable(reason);
    // Only a send turns Telegram's MEDIA_EMPTY into the Bot API's text
    // (MessagesManager.cpp process_send_message_fail_error); an edit gets it
    // as it is (EditMessageQuery::on_error).
    const refused = { mediaEmpty: "Bad Request: MEDIA_EMPTY" };
    return (message) => {
      const current = MEDIA_KINDS.find((kind) => message[kind]);
      const photo =
        type === "live_photo"
          ? sentFile(p, input.photo, "photo", caller, {}, refused)
          : null;
      // InputMediaLivePhoto gives no size or duration for its video, and an
      // InputMediaDocument with disable_content_type_detection is a plain
      // file (Client.cpp get_input_media).
      const file = sentFile(
        p,
        input.media,
        type,
        caller,
        type === "live_photo" ? {} : senderMeta(input),
        {
          ...refused,
          typeName:
            type === "document" && input.disable_content_type_detection === true
              ? "DocumentAsFile"
              : undefined,
        },
      );
      const formatted = captionFields(input);
      const albumKind = (kind) => (kind === "live_photo" ? "photo" : kind);
      if (message.media_group_id && albumKind(current) !== albumKind(type)) {
        if (type === "animation") {
          throw new TelegramError(
            400,
            "Bad Request: message content type can't be used in an album",
          );
        }
        if (
          [current, type].some((kind) => ["audio", "document"].includes(kind))
        ) {
          throw new TelegramError(
            400,
            "Bad Request: can't change media type in the album",
          );
        }
      }
      delete message.text;
      delete message.entities;
      delete message.link_preview_options;
      for (const kind of MEDIA_KINDS) delete message[kind];
      delete message.caption;
      delete message.caption_entities;
      Object.assign(
        message,
        mediaFields(type === "live_photo" ? type : file.kind, file, photo),
        formatted,
      );
    };
  }

  /** A group, forum or channel with its owner and no bot in it yet. */
  function createChat({
    title,
    type,
    owner_id: ownerId,
    owner_name,
    is_forum,
  }) {
    if (
      type !== undefined &&
      !["supergroup", "channel", "group"].includes(type)
    ) {
      throw new TelegramError(
        400,
        'type must be "supergroup", "channel" or "group"',
      );
    }
    const kind = type ?? "supergroup";
    const owner = Number(ownerId);
    if (!Number.isSafeInteger(owner) || owner <= 0) {
      throw new TelegramError(400, "chat needs an owner_id");
    }
    if (!users.has(owner)) {
      users.set(owner, {
        id: owner,
        is_bot: false,
        first_name: owner_name ?? "Chat Owner",
        bio: "",
        photos: [],
      });
    }
    nextChatId += 1;
    const chat = {
      id:
        kind === "group"
          ? -nextBasicGroupId++
          : -(1_000_000_000_000 + nextChatId),
      title: String(title ?? (kind === "channel" ? "Channel" : "Group")),
      type: kind,
      members: new Map([[owner, { status: "creator" }]]),
      messages: new Map(),
      nextMessageId: Math.max(1, startSeconds - 1_700_000_000),
      inviteLinks: new Map(),
      joinedVia: new Map(),
      joinRequests: new Map(),
      permissions: { ...ALL_PERMISSIONS },
      // A forum keeps its topics by thread id.
      ...(kind === "supergroup" && isTrue(is_forum)
        ? { topics: new Map() }
        : {}),
    };
    chats.set(chat.id, chat);
    return chat;
  }

  function creatorOf(chat) {
    return [...chat.members.entries()].find(
      ([, member]) => member.status === "creator",
    )?.[0];
  }

  // ── Test controls (/_fake/*) ───────────────────────────────────────────
  function scheduleExpiry(chat, userId) {
    const key = `${chat.id}:${userId}`;
    expiryTasks.get(key)?.();
    expiryTasks.delete(key);
    const member = chat.members.get(Number(userId));
    if (
      !["restricted", "kicked"].includes(member?.status) ||
      !member.until_date
    )
      return;
    const cancel = clock.schedule(
      () => {
        expiryTasks.delete(key);
        memberStatus(chat, userId);
        waits.notify();
      },
      Math.max(0, member.until_date * 1000 - clock.now()),
      { passive: true },
    );
    expiryTasks.set(key, cancel);
  }

  function matchesCall(call, condition) {
    return (
      call.bot_id === condition.botId &&
      call.method.toLowerCase() === condition.method.toLowerCase() &&
      (condition.chatId == null ||
        String(call.params.chat_id) === String(condition.chatId)) &&
      (condition.userId == null ||
        String(call.target_user_id) === String(condition.userId)) &&
      (condition.messageId == null ||
        Number(call.params.message_id) === condition.messageId ||
        call.params.message_ids?.map(Number).includes(condition.messageId)) &&
      (condition.requestId == null ||
        call.request_id === condition.requestId) &&
      Object.entries(condition.params ?? {}).every(
        ([key, value]) =>
          JSON.stringify(call.params[key]) === JSON.stringify(value),
      )
    );
  }

  function observe(condition, describe = false) {
    if (condition.kind === "call") {
      const key = `${condition.botId}:${condition.method.toLowerCase()}`;
      let result = null;
      const matching = [];
      for (const index of condition.includeRejectedRequests
        ? [callIndex, rejectedRequestIndex]
        : [callIndex]) {
        const candidates = index.get(key) ?? [];
        // Each journal's sequence is ordered; skip the already observed prefix.
        let low = 0;
        let high = candidates.length;
        if (!describe) {
          while (low < high) {
            const middle = (low + high) >>> 1;
            if (candidates[middle].seq <= (condition.afterSeq ?? 0))
              low = middle + 1;
            else high = middle;
          }
        }
        for (let i = low; i < candidates.length; i++) {
          const call = candidates[i];
          if (!matchesCall(call, condition)) continue;
          if (describe) {
            matching.push(call);
            if (matching.length > 8) matching.shift();
          }
          if (
            result == null &&
            call.seq > (condition.afterSeq ?? 0) &&
            (condition.outcome == null || call.outcome === condition.outcome) &&
            (condition.stage == null ||
              call.timeline?.some((e) => e.stage === condition.stage))
          ) {
            result = call;
            if (!describe) return { result };
          }
        }
      }
      return { result, observed: { matching } };
    }
    const chat =
      chats.get(condition.chatId) ?? privateChats.get(condition.chatId);
    if (!chat)
      return {
        result: null,
        observed: { chatId: condition.chatId, exists: false },
      };
    if (condition.kind === "message") {
      const entries =
        condition.messageId == null
          ? [...chat.messages.values(), ...(chat.ephemeral?.values() ?? [])]
          : [chat.messages.get(condition.messageId)].filter(Boolean);
      const matching = entries.filter(
        (entry) =>
          (condition.userId == null || entry.author === condition.userId) &&
          (condition.botId == null || entry.author === condition.botId) &&
          (condition.text == null || entry.message.text === condition.text) &&
          (condition.caption == null ||
            entry.message.caption === condition.caption),
      );
      const entry = matching.find(
        (entry) =>
          condition.deleted == null || entry.deleted === condition.deleted,
      );
      return {
        result: entry ? { exists: true, ...entry } : null,
        observed: matching
          .slice(-4)
          .map((entry) => ({ exists: true, ...entry })),
      };
    }
    const member = chatMemberObject(chat, condition.userId, bot);
    if (condition.kind === "member") {
      const matched =
        member.status === condition.status &&
        Object.entries(condition.permissions ?? {}).every(
          ([key, value]) => member[key] === value,
        );
      return { result: matched ? member : null, observed: member };
    }
    const decision = joinDecisions.get(`${chat.id}:${condition.userId}`);
    const state = chat.joinRequests.has(condition.userId)
      ? "pending"
      : (decision?.state ?? "absent");
    const view = {
      state,
      member,
      ...(decision && state !== "pending" ? { botId: decision.botId } : {}),
    };
    return {
      result:
        state === condition.state &&
        (condition.botId == null ||
          state === "pending" ||
          decision?.botId === condition.botId)
          ? view
          : null,
      observed: view,
    };
  }

  async function waitFor(condition, { timeoutMs = 1000 } = {}) {
    if (
      !condition ||
      !["message", "member", "joinRequest", "call"].includes(condition.kind)
    )
      throw new TypeError("Unknown fake wait kind");
    if (condition.kind === "call") {
      if (
        !Number.isSafeInteger(condition.botId) ||
        typeof condition.method !== "string" ||
        !/^[A-Za-z]+$/.test(condition.method)
      )
        throw new TypeError("Call waits require exact botId and method");
    } else {
      if (!Number.isSafeInteger(condition.chatId))
        throw new TypeError("State waits require exact chatId");
      if (
        condition.kind !== "message" &&
        !Number.isSafeInteger(condition.userId)
      )
        throw new TypeError("Membership/join waits require exact userId");
      if (
        condition.kind === "message" &&
        condition.messageId == null &&
        !(
          (condition.userId != null || condition.botId != null) &&
          (condition.text != null || condition.caption != null)
        )
      )
        throw new TypeError(
          "Message waits require messageId or author plus exact text/caption",
        );
      if (
        condition.kind === "member" &&
        ![
          "creator",
          "administrator",
          "member",
          "restricted",
          "left",
          "kicked",
        ].includes(condition.status)
      )
        throw new TypeError("Member waits require a supported status");
      if (
        condition.kind === "joinRequest" &&
        !["pending", "approved", "declined"].includes(condition.state)
      )
        throw new TypeError("Join waits require pending/approved/declined");
    }
    condition = structuredClone(condition);
    const secrets = () =>
      [...bots.values()].flatMap((record) => [
        record.token,
        record.loginClientSecret,
        record.webhook?.secret_token,
      ]);
    return waits.wait(
      () => observe(condition).result,
      timeoutMs,
      () =>
        diagnostic(
          {
            expected: condition,
            observed: observe(condition, true).observed,
            outstanding: outstanding(),
          },
          secrets(),
        ),
    );
  }

  function outstanding() {
    return {
      controls: activeControls,
      http: activeHttp,
      owners: activeOwners,
      deliveries: deliveryCount,
      polls: [...bots.values()].reduce(
        (n, record) => n + record.pollWaiters.size,
        0,
      ),
      delayedOrNetworkRequests: inFlight.size,
      waits: waits.size,
    };
  }

  function requireQuiescent() {
    const work = outstanding();
    if (
      activeControls ||
      activeHttp ||
      activeOwners ||
      deliveryCount ||
      work.polls ||
      inFlight.size ||
      clock.busy()
    ) {
      throw new TelegramError(
        409,
        `Fake fixture is busy; outstanding ${JSON.stringify(work)}`,
      );
    }
  }

  function snapshot() {
    requireQuiescent();
    const records = new Map(
      [...bots].map(([token, record]) => {
        const { pollWaiters, sending, ...fixture } = record;
        return [token, fixture];
      }),
    );
    const fixtureUsers = new Map(
      [...users].map(([id, user]) => [
        id,
        user.is_bot && bots.has(user.token) ? records.get(user.token) : user,
      ]),
    );
    const fixtureUpdates = new Map(
      [...sentUpdates].map(([id, sent]) => [
        id,
        { ...sent, record: records.get(sent.record.token) },
      ]),
    );
    const state = structuredClone({
      users: fixtureUsers,
      bots: records,
      sentUpdates: fixtureUpdates,
      chats,
      privateChats,
      businessConnections,
      joinQueries,
      files,
      callbackAnswers,
      openQueries,
      recentQueries,
      calls,
      rejectedRequests,
      requestSequence,
      failures,
      unimplemented,
      publicByUsername,
      joinDecisions,
      deliveryJournal,
      deliveryAttempts,
      loginCodes,
      recentSends,
      counters: {
        nextPublicId,
        nextUserId,
        nextChatId,
        nextBasicGroupId,
        nextMediaGroupId,
        nextPollId,
      },
      owner: ownerModel.snapshot(),
      time: clock.now(),
    });
    const id = `${instanceId}-${randomBytes(12).toString("hex")}`;
    snapshots.set(id, state);
    return id;
  }

  function restore(id) {
    if (!snapshots.has(id))
      throw new TelegramError(404, "Unknown snapshot for this server");
    requireQuiescent();
    const state = structuredClone(snapshots.get(id));
    waits.cancel("Fake fixture restored");
    clock.clear();
    expiryTasks.clear();
    clock.restore(state.time);
    for (const [target, source] of [
      [users, state.users],
      [bots, state.bots],
      [sentUpdates, state.sentUpdates],
      [chats, state.chats],
      [privateChats, state.privateChats],
      [businessConnections, state.businessConnections],
      [joinQueries, state.joinQueries],
      [files, state.files],
      [callbackAnswers, state.callbackAnswers],
      [openQueries, state.openQueries],
      [recentQueries, state.recentQueries],
      [publicByUsername, state.publicByUsername],
      [joinDecisions, state.joinDecisions],
      [loginCodes, state.loginCodes],
      [deliveryAttempts, state.deliveryAttempts],
      [recentSends, state.recentSends],
    ]) {
      target.clear();
      for (const [key, value] of source) target.set(key, value);
    }
    for (const record of bots.values()) {
      record.pollWaiters = new Set();
      record.sending = new Map();
    }
    for (const { file } of files.values()) {
      if (!Buffer.isBuffer(file.data)) file.data = Buffer.from(file.data);
    }
    bot = bots.get(botToken);
    // Do not spread a fixture journal into function arguments: large replay
    // histories exceed the engine's argument limit and leave a partial restore.
    for (const [target, entries] of [
      [calls, state.calls],
      [rejectedRequests, state.rejectedRequests],
      [failures, state.failures],
      [deliveryJournal, state.deliveryJournal],
    ]) {
      target.length = 0;
      for (const entry of entries) target.push(entry);
    }
    callIndex.clear();
    rejectedRequestIndex.clear();
    for (const receipt of calls) indexCall(receipt, callIndex);
    for (const receipt of rejectedRequests)
      indexCall(receipt, rejectedRequestIndex);
    requestSequence = state.requestSequence;
    unimplemented.clear();
    for (const method of state.unimplemented) unimplemented.add(method);
    ({
      nextPublicId,
      nextUserId,
      nextChatId,
      nextBasicGroupId,
      nextMediaGroupId,
      nextPollId,
    } = state.counters);
    ownerModel.restore(state.owner);
    epoch += 1;
    for (const chat of chats.values())
      for (const userId of chat.members.keys()) scheduleExpiry(chat, userId);
    waits.notify();
    return { restored: true, epoch };
  }

  async function drainDeliveries({ botId, timeoutMs = 1000 } = {}) {
    if (
      botId != null &&
      ![...bots.values()].some((record) => record.id === botId)
    )
      throw new TypeError("Unknown botId");
    return waits.wait(
      () => {
        const outstanding = deliveryJournal.filter(
          (e) =>
            e.completed_at == null && (botId == null || e.bot_id === botId),
        );
        return outstanding.length ? null : { drained: true };
      },
      timeoutMs,
      () =>
        diagnostic({
          outstanding: deliveryJournal
            .filter(
              (e) =>
                e.completed_at == null && (botId == null || e.bot_id === botId),
            )
            .slice(-8),
        }),
    );
  }

  async function control(method, parts, body) {
    const managed = [
      "wait",
      "snapshots",
      "restore",
      "clock",
      "deliveries",
    ].includes(parts[0]);
    if (stopped && method !== "GET")
      throw new TelegramError(409, "Fake server stopped");
    if (!managed) activeControls += 1;
    try {
      return await controlInner(method, parts, body);
    } finally {
      if (!managed) activeControls -= 1;
      waits.notify();
    }
  }

  /**
   * A failed wait, drain or clock advance over HTTP is a normal control
   * answer, not a server failure: bad input (400), a deadline (408), or work
   * that was cancelled or is not allowed (409).
   */
  function controlFailure(error) {
    if (error instanceof TelegramError) throw error;
    throw new TelegramError(
      error instanceof TypeError ? 400 : error.timedOut ? 408 : 409,
      error.message,
    );
  }

  async function controlInner(method, parts, body) {
    const [resource, id, sub, subId] = parts;
    if (resource === "wait" && method === "POST")
      return waitFor(body.condition, { timeoutMs: body.timeoutMs }).catch(
        controlFailure,
      );
    if (resource === "snapshots" && method === "POST") return snapshot();
    if (resource === "snapshots" && id && method === "DELETE") {
      if (!snapshots.delete(id))
        throw new TelegramError(404, "Unknown snapshot for this server");
      return { ok: true };
    }
    if (resource === "restore" && method === "POST")
      return restore(body.snapshot);
    if (resource === "clock" && method === "GET") return clock.state();
    if (resource === "clock" && method === "POST") {
      const state = await clock.advance(body.ms).catch(controlFailure);
      waits.notify();
      return state;
    }
    if (resource === "deliveries" && method === "GET")
      return structuredClone(deliveryJournal);
    if (resource === "deliveries" && method === "POST")
      return drainDeliveries(body).catch(controlFailure);
    if (resource === "owners") {
      try {
        return ownerModel.control(method, parts.slice(1), body);
      } catch (error) {
        if (error instanceof OwnerError) {
          throw new TelegramError(error.status, error.message);
        }
        throw error;
      }
    }
    if (resource === "bots" && !id && method === "POST") {
      try {
        return userObject(
          addBot({
            token: String(body.token ?? ""),
            username: body.username,
            firstName: body.first_name,
            joinRequestQueries: body.supports_join_request_queries === true,
            loginClientSecret: body.login_client_secret,
          }),
        );
      } catch (error) {
        throw new TelegramError(400, error.message);
      }
    }
    if (resource === "bots" && !id && method === "GET") {
      return [...bots.values()].map((record) => ({
        ...userObject(record),
        webhook: record.webhook ? { url: record.webhook.url } : null,
        login_client_secret: record.loginClientSecret,
      }));
    }
    if (resource === "chats" && !id && method === "POST") {
      return chatObject(createChat(body));
    }
    if (resource === "chats" && id && !sub && method === "GET") {
      const chat = requireChat(id);
      return {
        ...chatObject(chat),
        pinned: [...(chat.pinned ?? [])],
        members: [...chat.members.entries()].map(([userId, member]) => ({
          user_id: userId,
          status: member.status,
        })),
      };
    }
    if (resource === "chats" && id && sub === "bots" && method === "POST") {
      // The owner (or `by`) adds, promotes, demotes or removes a bot.
      const chat = requireChat(id);
      const record = requireBot(body.bot_id);
      if (body.start_parameter !== undefined) {
        return addBotViaLink(chat, record, {
          by: body.by,
          startParameter: body.start_parameter,
          rights: body.rights ?? null,
        });
      }
      const status = body.status ?? "administrator";
      if (!["administrator", "member", "left", "kicked"].includes(status)) {
        throw new TelegramError(
          400,
          'status must be "administrator", "member", "left" or "kicked"',
        );
      }
      return setBotMembership(chat, record, {
        status,
        rights: body.rights ?? null,
        actor: requireUser(body.by ?? creatorOf(chat)),
      });
    }
    if (resource === "chats" && id && sub === "migrate" && method === "POST") {
      return migrateToSupergroup(requireChat(id), body);
    }
    if (resource === "chats" && id && sub === "title" && method === "POST") {
      return renameByPerson(requireChat(id), body);
    }
    if (resource === "chats" && id && sub === "photo" && method === "POST") {
      return changePhotoByPerson(requireChat(id), body);
    }
    if (resource === "failures" && method === "POST") {
      if (typeof body.method !== "string" || body.method === "") {
        throw new TelegramError(
          400,
          "a failure needs the method it applies to",
        );
      }
      for (const field of ["attempt", "times", "delay_ms"]) {
        if (
          body[field] != null &&
          (!Number.isInteger(Number(body[field])) ||
            Number(body[field]) < (field === "delay_ms" ? 0 : 1))
        ) {
          throw new TelegramError(400, `invalid failure ${field}`);
        }
      }
      if (Number(body.delay_ms) > 30000)
        throw new TelegramError(400, "failure delay_ms must be at most 30000");
      const errorCode = numberParam(body.error_code, 400);
      const retryAfter =
        body.retry_after == null ? null : numberParam(body.retry_after, 1);
      // Telegram's 429 always carries retry_after (Query::set_retry_after_error).
      if (errorCode === 429 && !(retryAfter > 0)) {
        throw new TelegramError(400, "a 429 failure needs a retry_after");
      }
      const rule = {
        id: randomBytes(9).toString("hex"),
        method: body.method,
        user_id: body.user_id == null ? null : String(body.user_id),
        message_id: body.message_id == null ? null : String(body.message_id),
        attempt: numberParam(body.attempt, 1),
        matched: 0,
        delay_ms: numberParam(body.delay_ms, 0),
        chat_id: body.chat_id == null ? null : String(body.chat_id),
        bot_id: body.bot_id == null ? null : Number(body.bot_id),
        remaining: Math.max(1, numberParam(body.times, 1)),
        error_code: errorCode,
        // By default the description Telegram gives the code: "Too Many
        // Requests: retry after N" for 429, else its prefix ("Forbidden",
        // "Conflict", ...), which is the HTTP reason phrase.
        description: String(
          body.description ??
            (errorCode === 429
              ? `Too Many Requests: retry after ${retryAfter}`
              : (http.STATUS_CODES[errorCode] ?? "Bad Request")),
        ),
        retry_after: retryAfter,
        drop_after_apply: body.drop_after_apply === true,
        delay_only:
          body.delay_ms != null &&
          body.error_code == null &&
          body.drop_after_apply !== true,
      };
      failures.push(rule);
      return rule;
    }
    if (resource === "failures" && method === "GET") return failures;
    if (resource === "failures" && method === "DELETE") {
      failures.length = 0;
      return { ok: true };
    }
    if (resource === "business" && id === "connections") {
      const [, , connectionId, chatsPart, userId, messagesPart] = parts;
      if (method === "POST" && !connectionId) {
        const { delivered, ...result } = connectBusiness(body);
        await delivered;
        return result;
      }
      if (method === "GET" && connectionId && !chatsPart) {
        const connection = businessConnections.get(String(connectionId));
        if (!connection) {
          throw new TelegramError(
            404,
            `No business connection ${connectionId}`,
          );
        }
        return businessConnectionObject(connection);
      }
      if (chatsPart === "chats" && userId && messagesPart === "messages") {
        const connection = businessConnections.get(String(connectionId));
        if (!connection) {
          throw new TelegramError(
            404,
            `No business connection ${connectionId}`,
          );
        }
        if (method === "POST")
          return sayInBusinessChat(connectionId, userId, body);
        if (method === "GET") {
          return [...businessChat(connection, userId).entries]
            .reverse()
            .map((entry) => structuredClone(entry));
        }
      }
    }
    if (
      resource === "updates" &&
      id &&
      sub === "redeliver" &&
      method === "POST"
    ) {
      // Telegram delivers an update again when a webhook did not confirm it;
      // this sends the same bytes to the same bot. Each bot numbers its own
      // updates, so bot_id says whose update it is when two bots share an id.
      const matches = [...bots.values()]
        .filter(
          (record) => body.bot_id == null || record.id === Number(body.bot_id),
        )
        .map((record) => sentUpdates.get(updateKey(record.id, Number(id))))
        .filter(Boolean);
      if (matches.length === 0) throw new TelegramError(404, `No update ${id}`);
      if (matches.length > 1) {
        throw new TelegramError(
          409,
          `More than one bot got update ${id}; name one with bot_id`,
        );
      }
      const [sent] = matches;
      if (!sent.record.webhook?.ip_address) {
        throw new TelegramError(409, `The bot for update ${id} has no webhook`);
      }
      await redeliver(sent);
      return { update_id: Number(id) };
    }
    if (resource === "users" && method === "POST" && !id) {
      const user = {
        id: nextUserId++,
        is_bot: body.is_bot === true,
        is_premium: body.is_premium === true,
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
        // Ephemeral messages have message_id 0; each takes its place from the
        // message sent just before it.
        const order = (entry) => [
          entry.message.message_id || entry.after,
          entry.message.ephemeral_message_id ?? 0,
        ];
        return [...chat.messages.values(), ...(chat.ephemeral?.values() ?? [])]
          .filter((entry) => !entry.deleted)
          .sort((left, right) => {
            const [a, b] = [order(left), order(right)];
            return b[0] - a[0] || b[1] - a[1];
          })
          .map((entry) => entry.message);
      }
      if (sub === "ephemeral-messages" && subId) {
        const entry = chat.ephemeral?.get(Number(subId));
        if (method === "GET" && !parts[4]) {
          return entry
            ? { exists: true, deleted: entry.deleted, message: entry.message }
            : { exists: false, deleted: false };
        }
        if (method === "POST" && parts[4] === "callback") {
          // Only the receiver sees an ephemeral message.
          const user = requireUser(body.user_id);
          if (entry && entry.message.receiver_user.id !== user.id) {
            throw new TelegramError(
              400,
              "Only the receiver of an ephemeral message can press its buttons",
            );
          }
          return pressButton(chat, user, entry, body.data);
        }
      }
      if (sub === "messages" && method === "GET" && subId) {
        const entry = chat.messages.get(Number(subId));
        return entry
          ? {
              exists: true,
              deleted: entry.deleted,
              message: entry.message,
              reactions: Object.fromEntries(entry.reactions ?? []),
            }
          : { exists: false, deleted: false };
      }
      if (sub === "members" && method === "GET" && subId) {
        return chatMemberObject(chat, subId, bot);
      }
      if (sub === "topics") {
        if (!chat.topics) {
          throw new TelegramError(400, "Bad Request: the chat is not a forum");
        }
        return topicControl(chat, method, subId, parts[4], body);
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
    if (resource === "bot" && method === "GET") {
      return { ...userObject(bot), login_client_secret: bot.loginClientSecret };
    }
    if (resource === "login" && (id === "approve" || id === "cancel")) {
      // What the login page's buttons do, without a browser.
      const request = loginRequest(
        new URL(String(body.auth_url ?? ""), "http://fake").searchParams,
      );
      if (request.error) throw new TelegramError(400, request.error);
      return {
        redirect_url:
          id === "approve"
            ? approveLogin(request, requireUser(body.user_id))
            : loginRedirect(request.redirectUri, {
                error: "access_denied",
                state: request.state,
              }),
      };
    }
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
        return pressButton(
          existing,
          requireUser(id),
          existing.messages.get(Number(subId)),
          body.data,
        );
      }
      if (method === "POST" && !subId) {
        const fields = memberText(body.text);
        const message = addMessage(messageChat(id), requireUser(id), fields);
        await emit("message", message);
        return { message_id: message.message_id };
      }
    }
    if (resource === "chats" && id && sub === "albums" && method === "POST") {
      return postAlbum(requireChat(id), body);
    }
    if (
      resource === "chats" &&
      id &&
      sub === "messages" &&
      subId &&
      parts[4] === "edit" &&
      method === "POST"
    ) {
      return editByMember(requireChat(id), subId, body);
    }
    if (
      resource === "chats" &&
      id &&
      sub === "messages" &&
      subId &&
      parts[4] === "reactions" &&
      method === "POST"
    ) {
      return reactByMember(requireChat(id), subId, body);
    }
    if (
      resource === "chats" &&
      id &&
      sub === "messages" &&
      subId &&
      parts[4] === "pin" &&
      method === "POST"
    ) {
      return pinByPerson(requireChat(id), subId, body);
    }
    if (
      resource === "chats" &&
      id &&
      sub === "messages" &&
      subId &&
      parts[4] === "callback"
    ) {
      const user = requireUser(body.user_id);
      const chat = requireChat(id);
      return pressButton(
        chat,
        user,
        chat.messages.get(Number(subId)),
        body.data,
      );
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
      const entities = findEntities(text);
      const message = addMessage(chat, guestBot, {
        text,
        ...(entities.length > 0 ? { entities } : {}),
        guest_bot_caller_user: userObject(caller),
      });
      await emit("message", message);
      return { message_id: message.message_id };
    }
    if (resource === "calls" && method === "GET") {
      return structuredClone({
        calls,
        rejected_requests: rejectedRequests,
        unimplemented: [...unimplemented],
      });
    }
    if (resource === "webhook" && method === "GET") return bot.webhook;
    throw new TelegramError(
      404,
      `Unknown fake control ${method} /${parts.join("/")}`,
    );
  }

  /**
   * The owner (or `by`) creates or renames a forum topic. Telegram posts a
   * service message for each, and a topic's id is its creation message's id.
   */
  async function topicControl(chat, method, threadId, action, body) {
    if (method === "GET" && !threadId) {
      return [...chat.topics.entries()].map(([id, topic]) => ({
        message_thread_id: id,
        name: topic.name,
      }));
    }
    const actor = requireUser(body.by ?? creatorOf(chat));
    const name = body.name == null ? null : String(body.name).trim();
    if (name !== null && (name === "" || name.length > 128)) {
      throw new TelegramError(400, "Bad Request: TOPIC_TITLE_EMPTY");
    }
    if (method === "POST" && !threadId) {
      if (name === null) {
        throw new TelegramError(400, "Bad Request: TOPIC_TITLE_EMPTY");
      }
      const message = addMessage(chat, actor, {
        forum_topic_created: { name, icon_color: 7322096 },
        is_topic_message: true,
      });
      message.message_thread_id = message.message_id;
      chat.topics.set(message.message_id, { name });
      await emit("message", message);
      return { message_thread_id: message.message_id, name };
    }
    if (method === "POST" && threadId && action === "edit") {
      const topic = chat.topics.get(Number(threadId));
      if (!topic) throw new TelegramError(400, "Bad Request: TOPIC_ID_INVALID");
      if (name !== null) topic.name = name;
      const message = addMessage(chat, actor, {
        forum_topic_edited: { name: topic.name },
        message_thread_id: Number(threadId),
        is_topic_message: true,
      });
      await emit("message", message);
      return { message_thread_id: Number(threadId), name: topic.name };
    }
    throw new TelegramError(404, `Unknown topic control ${method}`);
  }

  /**
   * A member presses an inline button: Telegram sends the bot a callback_query
   * and waits for its answer, which it hands back to the member.
   */
  async function pressButton(chat, user, entry, data) {
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
    // Only the bot that put the keyboard on the message hears its buttons
    // pressed: the bot that sent it, or the bot whose edit last set it.
    // UNVERIFIED: Telegram does not document which bot hears a press on a
    // keyboard a bot put on someone else's message, such as a channel post
    // edited with can_edit_messages.
    const sender = [...bots.values()].find(
      (record) => record.id === (entry.keyboardBot ?? entry.author),
    );
    openQueries.set(queryId, (sender ?? bot).id);
    for (const [id, query] of recentQueries) {
      if (clock.now() - query.at > EPHEMERAL_REPLY_MS) recentQueries.delete(id);
    }
    recentQueries.set(queryId, {
      botId: (sender ?? bot).id,
      userId: user.id,
      at: clock.now(),
    });
    await emit(
      "callback_query",
      {
        id: queryId,
        from: userObject(user),
        message: entry.message,
        // An opaque global identifier of the chat, not its id: a signed
        // 64-bit number, the same for every press in the chat.
        chat_instance: createHash("sha256")
          .update(String(chat.id))
          .digest()
          .readBigInt64BE(0)
          .toString(),
        data: String(data ?? ""),
      },
      { to: sender ? [sender] : [bot] },
    );
    try {
      const answer = await waits.wait(
        () => callbackAnswers.get(queryId) ?? null,
        10_000,
      );
      callbackAnswers.delete(queryId);
      return { answered: true, ...answer };
    } catch (error) {
      if (stopped) throw error;
      return { answered: false };
    } finally {
      openQueries.delete(queryId);
    }
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
    if (link && (!invite || inviteExpired(chat, invite))) {
      throw new TelegramError(400, "INVITE_HASH_EXPIRED");
    }
    if (invite?.creates_join_request) {
      joinDecisions.delete(`${chat.id}:${user.id}`);
      chat.joinRequests.set(user.id, {
        invite_link: { ...invite },
        date: now(),
      });
      const request = {
        chat: chatObject(chat),
        from: userObject(user),
        user_chat_id: user.id,
        date: now(),
        ...(user.bio ? { bio: user.bio } : {}),
        invite_link: { ...invite },
      };
      // A guard bot in the chat gets the request as a query to answer. Only
      // bots with can_invite_users receive join requests at all.
      const guard = [...bots.values()].find(
        (record) =>
          record.joinRequestQueries &&
          isInChat(chat, record.id) &&
          receives(chat, record, "chat_join_request"),
      );
      const others = [...bots.values()].filter(
        (record) => record !== guard && isInChat(chat, record.id),
      );
      if (guard) {
        const queryId = randomBytes(8).readBigUInt64BE().toString();
        joinQueries.set(queryId, {
          chatId: chat.id,
          userId: user.id,
          botId: guard.id,
        });
        await emit(
          "chat_join_request",
          { ...request, query_id: queryId },
          { to: [guard] },
        );
      }
      await emit("chat_join_request", request, { to: others });
      return { status: "requested" };
    }
    const before = memberStatus(chat, user.id);
    admit(chat, user.id, invite?.invite_link);
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
    const before = memberStatus(chat, userId);
    chat.members.set(
      user.id,
      before.status === "restricted"
        ? { ...before, is_member: false }
        : { status: "left" },
    );
    await emitMemberChange(chat, user.id, before, user);
    const service = addMessage(chat, user, {
      left_chat_member: userObject(user),
    });
    await emit("message", service);
    return { status: "left" };
  }

  /**
   * Where a member's forwarded message came from: a user, a user who hides
   * their account (a name only), or a channel post.
   */
  function forwardOrigin(from) {
    const date = now();
    if (from.chat_id != null) {
      const source = requireChat(from.chat_id);
      if (source.type !== "channel") {
        throw new TelegramError(400, "forward_from.chat_id must be a channel");
      }
      const original =
        from.message_id != null
          ? source.messages.get(Number(from.message_id))
          : null;
      return {
        type: "channel",
        chat: chatObject(source),
        message_id: Number(from.message_id ?? 1),
        date: original?.message.date ?? date,
      };
    }
    if (from.user_id != null) {
      return {
        type: "user",
        sender_user: userObject(requireUser(from.user_id)),
        date,
      };
    }
    if (from.sender_name) {
      return {
        type: "hidden_user",
        sender_user_name: String(from.sender_name),
        date,
      };
    }
    throw new TelegramError(
      400,
      "forward_from needs user_id, sender_name, or a channel chat_id",
    );
  }

  /** A member posts 2 to 10 photos or videos as one album. */
  async function postAlbum(
    chat,
    { user_id: userId, items, message_thread_id },
  ) {
    if (!Array.isArray(items) || items.length < 2 || items.length > 10) {
      throw new TelegramError(400, "an album needs 2 to 10 items");
    }
    const mediaGroupId = String(nextMediaGroupId++);
    const ids = [];
    for (const item of items) {
      if (!["photo", "video"].includes(item?.type)) {
        throw new TelegramError(400, "album items are photos or videos");
      }
      const { message_id: id } = await post(
        chat,
        {
          user_id: userId,
          media: { type: item.type, base64: item.base64 },
          caption: item.caption,
          message_thread_id,
        },
        { mediaGroupId },
      );
      ids.push(id);
    }
    return { media_group_id: mediaGroupId, message_ids: ids };
  }

  /**
   * The author edits their message: the bots in the chat get edited_message
   * with the whole message and its edit_date.
   */
  async function editByMember(
    chat,
    messageId,
    { user_id: userId, text, caption },
  ) {
    const entry = chat.messages.get(Number(messageId));
    if (!entry || entry.deleted) {
      throw new TelegramError(400, "MESSAGE_ID_INVALID");
    }
    if (entry.author !== Number(userId)) {
      throw new TelegramError(403, "MESSAGE_AUTHOR_REQUIRED");
    }
    const message = entry.message;
    const field = message.text !== undefined ? "text" : "caption";
    const value = field === "text" ? text : caption;
    if (value === undefined || value === null) {
      throw new TelegramError(400, `the edit needs ${field}`);
    }
    if (String(value) === (message[field] ?? "")) {
      throw new TelegramError(400, "MESSAGE_NOT_MODIFIED");
    }
    message[field] = String(value);
    const entities = findEntities(message[field]);
    const entityField = field === "text" ? "entities" : "caption_entities";
    if (entities.length > 0) message[entityField] = entities;
    else delete message[entityField];
    message.edit_date = now();
    await emit("edited_message", structuredClone(message));
    return { message_id: message.message_id, edit_date: message.edit_date };
  }

  /**
   * A member sets their reaction on a message (one emoji, or none to take it
   * back). Telegram tells the chat's administrator bots through
   * message_reaction, when they asked for it in allowed_updates.
   */
  async function reactByMember(chat, messageId, { user_id: userId, emoji }) {
    const user = requireUser(userId);
    const entry = chat.messages.get(Number(messageId));
    if (!entry || entry.deleted) {
      throw new TelegramError(400, "MESSAGE_ID_INVALID");
    }
    if (!isInChat(chat, user.id)) {
      throw new TelegramError(403, "CHAT_WRITE_FORBIDDEN");
    }
    return changeReaction(chat, entry, user, emoji ? [String(emoji)] : []);
  }

  function reactionList(emojis) {
    return emojis.map((emoji) => ({ type: "emoji", emoji }));
  }

  async function changeReaction(chat, entry, user, emojis) {
    entry.reactions ??= new Map();
    const before = entry.reactions.get(user.id) ?? [];
    if (emojis.length) entry.reactions.set(user.id, emojis);
    else entry.reactions.delete(user.id);
    await emit("message_reaction", {
      chat: chatObject(chat),
      message_id: entry.message.message_id,
      user: userObject(user),
      date: now(),
      old_reaction: reactionList(before),
      new_reaction: reactionList(emojis),
    });
    return { reactions: Object.fromEntries(entry.reactions) };
  }

  async function post(
    chat,
    {
      user_id: userId,
      text,
      photo_base64: photoBase64,
      media,
      caption,
      reply_to: replyTo,
      message_thread_id: threadId,
      forward_from: forwardFrom,
    },
    { mediaGroupId = null } = {},
  ) {
    const user = requireUser(userId);
    requireTopic(chat, threadId);
    const type = photoBase64 ? "photo" : (media?.type ?? null);
    if (type && type !== "photo" && !MEMBER_MEDIA[type]) {
      throw new TelegramError(
        400,
        `media type must be photo or one of ${Object.keys(MEMBER_MEDIA).join(", ")}`,
      );
    }
    const permission =
      type === "photo"
        ? "can_send_photos"
        : type
          ? MEMBER_MEDIA[type].permission
          : "can_send_messages";
    // A channel has no member permissions: only the creator and
    // administrators with can_post_messages post there.
    if (
      chat.type === "channel"
        ? !hasRight(chat, user.id, "can_post_messages")
        : !canPost(chat, userId, permission)
    ) {
      throw new TelegramError(403, "CHAT_WRITE_FORBIDDEN");
    }
    const fields = {};
    if (type) {
      const base64 = photoBase64 ?? media.base64 ?? "";
      if (typeof base64 !== "string") {
        throw new TelegramError(
          400,
          `${photoBase64 != null ? "photo_base64" : "media.base64"} must be a base64 string`,
        );
      }
      const bytes = Buffer.from(base64, "base64");
      const file = registerFile(bytes, type, {
        file_name: media?.file_name,
        mime_type: media?.mime_type,
        duration: media?.duration,
      });
      Object.assign(fields, mediaFields(type, file));
      const formatted =
        caption && (type === "photo" || MEMBER_MEDIA[type].caption)
          ? formatText(String(caption))
          : null;
      if (formatted?.text) {
        fields.caption = formatted.text;
        if (formatted.entities.length > 0)
          fields.caption_entities = formatted.entities;
      }
    } else {
      Object.assign(fields, memberText(text));
    }
    if (mediaGroupId) fields.media_group_id = mediaGroupId;
    if (forwardFrom) fields.forward_origin = forwardOrigin(forwardFrom);
    // A message in a topic that answers nothing replies to the topic's
    // creation message, which is how a bot learns the topic's name.
    const replied =
      replyTo != null
        ? chat.messages.get(Number(replyTo))
        : threadId
          ? chat.messages.get(Number(threadId))
          : null;
    if (replied) {
      const { reply_to_message: _nested, ...original } = replied.message;
      fields.reply_to_message = original;
    }
    if (threadId && chat.topics) {
      fields.message_thread_id = Number(threadId);
      fields.is_topic_message = true;
    }
    const message = addMessage(chat, user, fields);
    await emit("message", message);
    return { message_id: message.message_id };
  }

  // ── HTTP ───────────────────────────────────────────────────────────────
  // ── Telegram Login (OpenID Connect) ────────────────────────────────────
  // The code flow at oauth.telegram.org, as documented at
  // https://core.telegram.org/bots/telegram-login and in its discovery
  // document, https://oauth.telegram.org/.well-known/openid-configuration.
  const LOGIN_ISSUER = "https://oauth.telegram.org";
  // UNVERIFIED: how long Telegram keeps an unused code; OAuth recommends a
  // short life (RFC 6749 §4.1.2).
  const LOGIN_CODE_TTL_MS = 60_000;
  // The documented token response says "expires_in": 3600.
  const LOGIN_TOKEN_TTL_S = 3600;
  let loginKey;
  function requireLoginKey() {
    return (loginKey ??= generateKeyPairSync("rsa", { modulusLength: 2048 }));
  }
  const loginKid = randomBytes(8).toString("hex");
  const loginCodes = new Map();
  // `sub` is an opaque id, not the Telegram id (the documented example has a
  // different sub and id); it is stable for a user ("public" subject type).
  const subjectSalt = randomBytes(16);

  function loginSubject(userId) {
    const digest = createHash("sha256")
      .update(subjectSalt)
      .update(String(userId))
      .digest();
    return (digest.readBigUInt64BE(0) % 10n ** 19n).toString();
  }

  function base64url(value) {
    return Buffer.from(value).toString("base64url");
  }

  function signIdToken(claims) {
    const header = { alg: "RS256", typ: "JWT", kid: loginKid };
    const input = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
    const signature = sign(
      "sha256",
      Buffer.from(input),
      requireLoginKey().privateKey,
    );
    return `${input}.${signature.toString("base64url")}`;
  }

  function discoveryDocument() {
    return {
      issuer: LOGIN_ISSUER,
      authorization_endpoint: `${origin}/auth`,
      token_endpoint: `${origin}/token`,
      jwks_uri: `${origin}/.well-known/jwks.json`,
      response_types_supported: ["code"],
      token_endpoint_auth_methods_supported: [
        "client_secret_basic",
        "client_secret_post",
      ],
      subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: ["RS256"],
      scopes_supported: ["openid", "phone", "profile", "telegram:bot_access"],
      claims_supported: [
        "aud",
        "preferred_username",
        "phone_number",
        "exp",
        "iat",
        "iss",
        "name",
        "picture",
        "sub",
      ],
      code_challenge_methods_supported: ["plain", "S256"],
      grant_types_supported: ["authorization_code"],
    };
  }

  function jwks() {
    return {
      keys: [
        {
          ...requireLoginKey().publicKey.export({ format: "jwk" }),
          alg: "RS256",
          use: "sig",
          kid: loginKid,
        },
      ],
    };
  }

  function loginRedirect(redirectUri, params) {
    const url = new URL(redirectUri);
    for (const [key, value] of Object.entries(params)) {
      if (value != null) url.searchParams.set(key, value);
    }
    return url.toString();
  }

  /**
   * A /auth request, checked. The docs make openid required and PKCE
   * recommended; the discovery document lists "plain" and "S256".
   */
  function loginRequest(query) {
    const clientId = String(query.get("client_id") ?? "");
    const record = [...bots.values()].find(
      (entry) => String(entry.id) === clientId,
    );
    if (!record) return { error: "unknown client_id" };
    const redirectUri = query.get("redirect_uri") ?? "";
    try {
      new URL(redirectUri);
    } catch {
      return { error: "redirect_uri must be an absolute URL" };
    }
    if (query.get("response_type") !== "code") {
      return { error: 'response_type must be "code"' };
    }
    const scopes = String(query.get("scope") ?? "")
      .split(/\s+/)
      .filter(Boolean);
    if (!scopes.includes("openid")) {
      return { error: 'scope must include "openid"' };
    }
    const challenge = query.get("code_challenge");
    const method =
      query.get("code_challenge_method") ?? (challenge ? "plain" : null);
    if (challenge && method !== "S256" && method !== "plain") {
      return { error: 'code_challenge_method must be "S256" or "plain"' };
    }
    if (!challenge && query.get("code_challenge_method")) {
      return { error: "code_challenge_method without code_challenge" };
    }
    return {
      bot: record,
      redirectUri,
      scopes,
      state: query.get("state"),
      nonce: query.get("nonce"),
      challenge,
      method,
    };
  }

  /** The user allows the login: a one-time code goes back to redirect_uri. */
  function approveLogin(request, user) {
    if (user.is_bot) throw new TelegramError(400, "a bot cannot log in");
    const code = randomBytes(24).toString("base64url");
    loginCodes.set(code, {
      ...request,
      userId: user.id,
      expiresAt: clock.now() + LOGIN_CODE_TTL_MS,
      used: false,
    });
    return loginRedirect(request.redirectUri, { code, state: request.state });
  }

  function escapeHtml(value) {
    return String(value).replace(
      /[&<>"']/g,
      (character) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[character],
    );
  }

  /** The login page: one button per fake user, and Cancel. */
  function loginPage(url, request) {
    const action = escapeHtml(`/auth${url.search}`);
    const people = [...users.values()].filter((user) => !user.is_bot);
    const buttons = people
      .map(
        (user) =>
          `<form method="post" action="${action}"><input type="hidden" name="user_id" value="${user.id}"><button>Log in as ${escapeHtml(
            [user.first_name, user.last_name].filter(Boolean).join(" "),
          )}</button></form>`,
      )
      .join("\n");
    return `<!doctype html><html><head><meta charset="utf-8"><title>Log in to ${escapeHtml(
      request.bot.first_name,
    )}</title></head><body><h1>Log in to ${escapeHtml(request.bot.first_name)}</h1>
${buttons}
<form method="post" action="${action}"><input type="hidden" name="cancel" value="1"><button>Cancel</button></form>
</body></html>`;
  }

  function sendOAuthError(response, status, error, description, headers = {}) {
    response.writeHead(status, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...headers,
    });
    response.end(JSON.stringify({ error, error_description: description }));
  }

  /**
   * POST /token: the code for an ID token, with the client authenticated by
   * HTTP Basic as the docs show (client_secret_post is listed too), and the
   * PKCE verifier checked against the challenge (RFC 7636).
   */
  function exchangeCode(request, body, response) {
    const form = new URLSearchParams(body.toString("utf8"));
    let clientId = form.get("client_id");
    let secret = form.get("client_secret");
    const basic = String(request.headers.authorization ?? "").match(
      /^Basic\s+(.+)$/i,
    );
    if (basic) {
      const decoded = Buffer.from(basic[1], "base64").toString("utf8");
      const colon = decoded.indexOf(":");
      clientId = decodeURIComponent(decoded.slice(0, colon));
      secret = decodeURIComponent(decoded.slice(colon + 1));
    }
    const record = [...bots.values()].find(
      (entry) => String(entry.id) === String(clientId ?? ""),
    );
    const expected = Buffer.from(record?.loginClientSecret ?? "");
    const given = Buffer.from(String(secret ?? ""));
    if (
      !record ||
      expected.length !== given.length ||
      !timingSafeEqual(expected, given)
    ) {
      sendOAuthError(
        response,
        401,
        "invalid_client",
        "Client authentication failed",
        {
          "WWW-Authenticate": 'Basic realm="oauth.telegram.org"',
        },
      );
      return;
    }
    if (form.get("grant_type") !== "authorization_code") {
      sendOAuthError(
        response,
        400,
        "unsupported_grant_type",
        'grant_type must be "authorization_code"',
      );
      return;
    }
    const code = loginCodes.get(String(form.get("code") ?? ""));
    const invalid = (description) =>
      sendOAuthError(response, 400, "invalid_grant", description);
    if (!code || code.bot.id !== record.id) return invalid("Unknown code");
    if (code.used) return invalid("The code was already used");
    code.used = true;
    if (clock.now() > code.expiresAt) return invalid("The code has expired");
    if (form.get("redirect_uri") !== code.redirectUri) {
      return invalid("redirect_uri does not match the authorization request");
    }
    if (code.challenge) {
      const verifier = String(form.get("code_verifier") ?? "");
      const derived =
        code.method === "S256"
          ? createHash("sha256").update(verifier).digest("base64url")
          : verifier;
      if (!verifier || derived !== code.challenge) {
        return invalid("code_verifier does not match the code_challenge");
      }
    }
    const user = requireUser(code.userId);
    const issuedAt = Math.floor(clock.now() / 1000);
    const claims = {
      iss: LOGIN_ISSUER,
      aud: String(record.id),
      sub: loginSubject(user.id),
      iat: issuedAt,
      exp: issuedAt + LOGIN_TOKEN_TTL_S,
      ...(code.nonce ? { nonce: code.nonce } : {}),
    };
    // The profile scope adds the user's id, name, username and photo.
    if (code.scopes.includes("profile")) {
      Object.assign(claims, {
        id: user.id,
        name: [user.first_name, user.last_name].filter(Boolean).join(" "),
        given_name: user.first_name,
        ...(user.last_name ? { family_name: user.last_name } : {}),
        ...(user.username ? { preferred_username: user.username } : {}),
        ...(user.photos?.length
          ? { picture: `${origin}/userpic/${user.id}.jpg` }
          : {}),
      });
    }
    // telegram:bot_access "allows your bot to send direct messages to the
    // user after login".
    if (code.scopes.includes("telegram:bot_access")) {
      const chat = messageChat(user.id);
      chat.openTo ??= new Set();
      chat.openTo.add(record.id);
    }
    response.writeHead(200, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    });
    response.end(
      JSON.stringify({
        access_token: randomBytes(24).toString("base64url"),
        token_type: "Bearer",
        expires_in: LOGIN_TOKEN_TTL_S,
        id_token: signIdToken(claims),
      }),
    );
  }

  /** The login routes, at oauth.telegram.org's paths; false when not one. */
  function serveLogin(request, url, body, response) {
    const path = url.pathname;
    if (
      path === "/.well-known/openid-configuration" &&
      request.method === "GET"
    ) {
      send(response, 200, discoveryDocument());
      return true;
    }
    if (path === "/.well-known/jwks.json" && request.method === "GET") {
      send(response, 200, jwks());
      return true;
    }
    if (path === "/token" && request.method === "POST") {
      exchangeCode(request, body, response);
      return true;
    }
    const picture = path.match(/^\/userpic\/(\d+)\.jpg$/);
    if (picture && request.method === "GET") {
      const held = files.get(
        users.get(Number(picture[1]))?.photos?.[0]?.file_id,
      );
      if (!held) {
        response.writeHead(404).end();
        return true;
      }
      response.writeHead(200, { "Content-Type": "image/jpeg" });
      response.end(held.file.data);
      return true;
    }
    if (path !== "/auth" || !["GET", "POST"].includes(request.method)) {
      return false;
    }
    const loginQuery = loginRequest(url.searchParams);
    if (loginQuery.error) {
      // An unverified client or redirect_uri is never redirected to
      // (RFC 6749 §4.1.2.1); the page reports the problem instead.
      response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
      response.end(`Login refused: ${loginQuery.error}`);
      return true;
    }
    if (request.method === "GET") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(loginPage(url, loginQuery));
      return true;
    }
    const form = new URLSearchParams(body.toString("utf8"));
    let location;
    if (form.get("cancel")) {
      location = loginRedirect(loginQuery.redirectUri, {
        error: "access_denied",
        state: loginQuery.state,
      });
    } else {
      const user = users.get(Number(form.get("user_id")));
      if (!user || user.is_bot) {
        response.writeHead(400, {
          "Content-Type": "text/plain; charset=utf-8",
        });
        response.end("Login refused: unknown user");
        return true;
      }
      location = approveLogin(loginQuery, user);
    }
    response.writeHead(302, { Location: location });
    response.end();
    return true;
  }

  function send(response, status, payload, headers = {}) {
    response.writeHead(status, {
      "Content-Type": "application/json",
      ...headers,
    });
    response.end(JSON.stringify(payload));
  }

  const server = http.createServer(async (request, response) => {
    let closed;
    const closure = new Promise((resolve) => {
      closed = resolve;
    });
    responseClosures.add(closure);
    response.once("close", () => {
      responseClosures.delete(closure);
      closed();
    });
    const receivedAt = clock.now();
    const management =
      /^\/_fake\/(wait|snapshots|restore|clock|deliveries)(\/|$)/.test(
        request.url,
      );
    if (!management) {
      activeHttp += 1;
      response.once("close", () => {
        activeHttp -= 1;
        waits.notify();
      });
    }
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
      const ownerCall = url.pathname.match(/^\/_owner\/([^/]+)\/([A-Za-z]+)$/);
      if (ownerCall && request.method === "POST") {
        const args = body.length ? parseJsonObject(body) : {};
        let answer;
        activeOwners += 1;
        try {
          answer = await ownerModel.rpc(
            decodeURIComponent(ownerCall[1]),
            ownerCall[2],
            args,
          );
        } finally {
          activeOwners -= 1;
          waits.notify();
        }
        // A dropped response: the call ran, and the connection closes unanswered.
        if (answer.drop) {
          request.socket.destroy();
          return;
        }
        send(response, answer.status, answer.body);
        return;
      }
      if (serveLogin(request, url, body, response)) return;
      // A file_path names the bot's own file_id, so it works with that bot's
      // token alone.
      const download = url.pathname.match(/^\/file\/bot([^/]+)\/(.+)$/);
      if (download) {
        const fileId = download[2].replace(/^[^/]*\/|\.[^.]*$/g, "");
        const held = files.get(fileId);
        if (
          !held ||
          held.botId !== bots.get(download[1])?.id ||
          filePath(held.file, fileId) !== download[2]
        ) {
          response.writeHead(404).end();
          return;
        }
        response.writeHead(200, {
          "Content-Type": PHOTO_KINDS.has(held.file.kind)
            ? "image/jpeg"
            : "application/octet-stream",
        });
        response.end(held.file.data);
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
      const caller = bots.get(call[1]);
      if (!caller) {
        recordCall(
          {
            method: call[2],
            bot_id: Number(call[1].split(":")[0]) || 0,
            params: {},
            at: receivedAt,
            applied: false,
            outcome: "rejected",
            status: 401,
            failed: 401,
          },
          response,
          rejectedRequests,
        );
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
        recordCall(
          {
            method,
            bot_id: caller.id,
            params: { raw_body: body.toString("utf8") },
            at: receivedAt,
            applied: false,
            outcome: "rejected",
            status: error.code,
            failed: error.code,
          },
          response,
          rejectedRequests,
        );
        // Telegram's HTTP reader answers a body it cannot read with the bare
        // status and closes the connection (td::HttpConnectionBase).
        response.writeHead(error.code, { Connection: "close" }).end();
        return;
      }
      // Bot API method names are case-insensitive.
      const handler = methodsByLowerName.get(method.toLowerCase());
      const faultTrace = {};
      const failure = takeFailure(method, caller, params, faultTrace);
      const receipt = {
        seq: calls.length + 1,
        method,
        bot_id: caller.id,
        params: summarize(params),
        at: receivedAt,
        applied: false,
        outcome: "pending",
        ...faultTrace,
        ...(failure
          ? {
              fault_id: failure.id,
              attempt: failure.matched,
              delay_ms: failure.delay_ms,
            }
          : {}),
      };
      recordCall(receipt, response);
      const gone = new AbortController();
      response.once("close", () => {
        if (!response.writableFinished) gone.abort();
      });
      clientGone.set(receipt, gone.signal);
      if (failure && !failure.drop_after_apply && !failure.delay_only) {
        Object.assign(receipt, {
          failed: failure.error_code,
          status: failure.error_code,
          outcome: "rejected",
          completed_at: clock.now(),
        });
        waits.notify();
        if (failure.delay_ms) await delayResponse(failure.delay_ms);
        send(
          response,
          failure.error_code,
          {
            ok: false,
            error_code: failure.error_code,
            description: failure.description,
            ...(failure.retry_after != null
              ? { parameters: { retry_after: failure.retry_after } }
              : {}),
          },
          // HttpConnection::send_response adds Retry-After to every 429.
          failure.error_code === 429
            ? { "Retry-After": String(failure.retry_after) }
            : {},
        );
        return;
      }
      if (!handler) {
        const answerTrue =
          unimplementedMode === "ok" && TRUE_METHODS.has(method.toLowerCase());
        Object.assign(receipt, {
          outcome: answerTrue ? "unimplemented_ok" : "rejected",
          status: answerTrue ? 200 : 404,
          completed_at: clock.now(),
        });
        if (!answerTrue) receipt.failed = 404;
        reportUnimplemented(method);
        if (answerTrue) {
          send(response, 200, { ok: true, result: true });
        } else {
          // Telegram's answer to a method it does not know; which methods this
          // server lacks is reported by GET /_fake/calls and the log.
          send(response, 404, {
            ok: false,
            error_code: 404,
            description: "Not Found: method not found",
          });
        }
        return;
      }
      try {
        const result = await execution.run(receipt, () =>
          handler(params, caller),
        );
        // Uninstrumented handlers and successful reads/no-ops retain their
        // completion checkpoint; message/membership helpers checkpoint earlier.
        Object.assign(receipt, {
          applied: true,
          status: 200,
          completed_at: clock.now(),
          outcome:
            failure?.drop_after_apply ||
            receipt.timeline.some((e) => e.stage === "response_lost")
              ? "response_lost"
              : failure?.delay_ms
                ? "delayed"
                : "succeeded",
        });
        if (receipt.outcome === "response_lost") receipt.dropped = true;
        appliedCheckpoint(receipt);
        stage(receipt, "handler_completed");
        // The call took effect, but its answer is lost on the way back.
        if (failure?.drop_after_apply) {
          receipt.dropped = true;
          stage(receipt, "response_lost");
          request.socket.destroy();
          return;
        }
        if (failure?.delay_ms) await delayResponse(failure.delay_ms);
        send(
          response,
          200,
          result instanceof Described
            ? {
                ok: true,
                result: seenBy(caller, result.result),
                description: result.description,
              }
            : { ok: true, result: seenBy(caller, result) },
        );
      } catch (error) {
        Object.assign(receipt, {
          applied: receipt.applied,
          outcome: receipt.applied ? "failed_after_apply" : "rejected",
          failed: error instanceof TelegramError ? error.code : 500,
          status: error instanceof TelegramError ? error.code : 500,
          completed_at: clock.now(),
        });
        if (!(error instanceof TelegramError)) throw error;
        // The Bot API server repeats retry_after in a Retry-After header
        // (telegram-bot-api HttpConnection.cpp).
        if (error.parameters?.retry_after) {
          response.setHeader(
            "Retry-After",
            String(error.parameters.retry_after),
          );
        }
        send(response, error.code, {
          ok: false,
          error_code: error.code,
          description: error.message,
          ...(error.parameters ? { parameters: error.parameters } : {}),
        });
      }
    } catch (error) {
      // A failure of this server itself: Telegram's bare 500, with the cause
      // only in the log.
      log(`internal error: ${error.stack ?? error.message}`);
      send(response, 500, {
        ok: false,
        error_code: 500,
        description: "Internal Server Error",
      });
    }
  });

  function delayResponse(ms) {
    const abort = new AbortController();
    inFlight.add(abort);
    return new Promise((resolve) => {
      const finish = () => {
        cancel();
        inFlight.delete(abort);
        abort.signal.removeEventListener("abort", finish);
        resolve();
        waits.notify();
      };
      const cancel = clock.schedule(finish, ms);
      abort.signal.addEventListener("abort", finish, { once: true });
    });
  }

  function recordCall(receipt, response, journal = calls) {
    const target = Number(targetUser(receipt.method, receipt.params));
    if (Number.isSafeInteger(target)) receipt.target_user_id = target;
    receipt.seq = journal.length + 1;
    receipt.request_id = `${instanceId}:${epoch}:${++requestSequence}`;
    receipt.timeline = [{ stage: "received", at: receipt.at }];
    const socket = response.socket;
    function lost() {
      if (receipt.applied) {
        receipt.outcome = "response_lost";
        receipt.dropped = true;
      }
      receipt.completed_at = clock.now();
      if (!receipt.timeline.some((e) => e.stage === "response_lost"))
        stage(receipt, "response_lost");
    }
    response.once("finish", () => {
      if (socket.destroyed) lost();
      else {
        receipt.completed_at = clock.now();
        stage(receipt, "response_sent");
      }
    });
    response.once("close", () => {
      if (
        !response.writableFinished ||
        (socket.destroyed &&
          !receipt.timeline.some((e) => e.stage === "response_sent"))
      )
        lost();
    });
    journal.push(receipt);
    indexCall(receipt, journal === calls ? callIndex : rejectedRequestIndex);
    waits.notify();
  }

  function appliedCheckpoint(receipt = execution.getStore()) {
    if (
      !receipt ||
      receipt.timeline.some((event) => event.stage === "state_applied")
    )
      return;
    receipt.applied = true;
    stage(receipt, "validated");
    stage(receipt, "state_applied");
  }

  function indexCall(receipt, index) {
    const key = `${receipt.bot_id}:${receipt.method.toLowerCase()}`;
    let bucket = index.get(key);
    if (!bucket) index.set(key, (bucket = []));
    bucket.push(receipt);
  }

  function stage(receipt, name) {
    receipt.timeline.push({ stage: name, at: clock.now() });
    waits.notify();
  }

  function targetUser(method, params) {
    return (
      params.user_id ??
      params.receiver_user_id ??
      params.ephemeral_message_parameters?.receiver_user_id ??
      (method.toLowerCase() === "deletemessage"
        ? (
            chats.get(Number(params.chat_id)) ??
            privateChats.get(Number(params.chat_id))
          )?.messages.get(Number(params.message_id))?.author
        : undefined)
    );
  }

  function takeFailure(method, caller, params, trace) {
    const index = failures.findIndex(
      (rule) =>
        rule.method.toLowerCase() === method.toLowerCase() &&
        (rule.chat_id === null || rule.chat_id === String(params.chat_id)) &&
        (rule.bot_id === null || rule.bot_id === caller.id) &&
        (rule.user_id === null ||
          rule.user_id === String(targetUser(method, params))) &&
        (rule.message_id === null ||
          rule.message_id === String(params.message_id) ||
          (Array.isArray(params.message_ids) &&
            params.message_ids.some((id) => String(id) === rule.message_id))),
    );
    if (index < 0) return null;
    const rule = failures[index];
    rule.matched += 1;
    Object.assign(trace, {
      fault_id: rule.id,
      attempt: rule.matched,
      fault_injected: rule.matched >= rule.attempt,
    });
    if (rule.matched < rule.attempt) return null;
    rule.remaining -= 1;
    if (rule.remaining <= 0) failures.splice(index, 1);
    return rule;
  }

  function summarize(params) {
    const out = {};
    for (const [key, value] of Object.entries(params)) {
      out[key] = Buffer.isBuffer(value)
        ? `<${value.length} bytes>`
        : structuredClone(value);
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
    waitFor,
    snapshot: () => act("POST", "snapshots"),
    restore: (snapshot) => act("POST", "restore", { snapshot }),
    releaseSnapshot: (snapshot) => act("DELETE", `snapshots/${snapshot}`),
    getClock: () => act("GET", "clock"),
    advanceTime: (ms) => act("POST", "clock", { ms }),
    drainDeliveries,
    getDeliveries: () => act("GET", "deliveries"),
    addBot: ({ token, username, firstName, supportsJoinRequestQueries } = {}) =>
      act("POST", "bots", {
        token,
        username,
        first_name: firstName,
        supports_join_request_queries: supportsJoinRequestQueries === true,
      }),
    createChat: async ({ title, type, ownerId, ownerName, isForum } = {}) =>
      (
        await act("POST", "chats", {
          title,
          type,
          owner_id: ownerId,
          owner_name: ownerName,
          is_forum: isForum,
        })
      ).id,
    getChat: (chatId) => act("GET", `chats/${chatId}`),
    addBotViaLink: (chatId, botId, { by, startParameter, rights } = {}) =>
      act("POST", `chats/${chatId}/bots`, {
        bot_id: botId,
        start_parameter: startParameter ?? "",
        ...(by != null ? { by } : {}),
        ...(rights ? { rights } : {}),
      }),
    migrateToSupergroup: async (chatId, { by } = {}) =>
      (await act("POST", `chats/${chatId}/migrate`, by != null ? { by } : {}))
        .id,
    renameChat: (chatId, { by, title } = {}) =>
      act("POST", `chats/${chatId}/title`, { by, title }),
    changeChatPhoto: (chatId, { by, bytes } = {}) =>
      act("POST", `chats/${chatId}/photo`, {
        by,
        base64: Buffer.from(bytes ?? []).toString("base64"),
      }),
    setBotMembership: (chatId, botId, { status, rights, by } = {}) =>
      act("POST", `chats/${chatId}/bots`, {
        bot_id: botId,
        status,
        rights,
        by,
      }),
    createTopic: async (chatId, name, { by } = {}) =>
      (await act("POST", `chats/${chatId}/topics`, { name, by }))
        .message_thread_id,
    renameTopic: (chatId, threadId, name, { by } = {}) =>
      act("POST", `chats/${chatId}/topics/${threadId}/edit`, { name, by }),
    failNext: (rule) =>
      act("POST", "failures", {
        method: rule.method,
        user_id: rule.userId,
        message_id: rule.messageId,
        attempt: rule.attempt,
        delay_ms: rule.delayMs,
        chat_id: rule.chatId,
        bot_id: rule.botId,
        times: rule.times,
        error_code: rule.errorCode,
        description: rule.description,
        retry_after: rule.retryAfter,
        drop_after_apply: rule.dropAfterApply === true,
      }),
    clearFailures: () => act("DELETE", "failures"),
    createUser: async (fields = {}) => (await act("POST", "users", fields)).id,
    createOwner: ({ userId, firstName, lastName, username } = {}) =>
      act("POST", "owners", {
        user_id: userId,
        first_name: firstName,
        last_name: lastName,
        username,
      }),
    updateOwner: (ownerId, { authorized } = {}) =>
      act("POST", `owners/${ownerId}`, { authorized }),
    getOwner: (ownerId) => act("GET", `owners/${ownerId}`),
    addOwnerUser: (ownerId, { id, firstName, lastName, username, bot } = {}) =>
      act("POST", `owners/${ownerId}/users`, {
        id,
        first_name: firstName,
        last_name: lastName,
        username,
        bot,
      }),
    addOwnerDialog: (ownerId, fields = {}) =>
      act("POST", `owners/${ownerId}/dialogs`, {
        kind: fields.kind,
        id: fields.id,
        title: fields.title,
        first_name: fields.firstName,
        last_name: fields.lastName,
        username: fields.username,
        participants_count: fields.participantsCount,
        folder: fields.folder,
        pinned: fields.pinned,
        muted: fields.muted,
        mute_until: fields.muteUntil,
        unread_count: fields.unreadCount,
        date: fields.date,
      }),
    updateOwnerDialog: (ownerId, peerId, fields = {}) =>
      act("POST", `owners/${ownerId}/dialogs/${peerId}`, {
        folder: fields.folder,
        pinned: fields.pinned,
        muted: fields.muted,
        mute_until: fields.muteUntil,
        unread_count: fields.unreadCount,
      }),
    addOwnerMessages: (ownerId, peerId, messages) =>
      act("POST", `owners/${ownerId}/dialogs/${peerId}/messages`, {
        messages: messages.map((message) => ({
          id: message.id,
          date: message.date,
          from_id: message.fromId,
          out: message.out,
          text: message.text,
          action: message.action,
          reply_to: message.replyTo,
          media: message.media,
          edit_date: message.editDate,
        })),
      }),
    editOwnerMessage: (ownerId, peerId, messageId, { text, editDate } = {}) =>
      act("POST", `owners/${ownerId}/dialogs/${peerId}/messages/${messageId}`, {
        text,
        edit_date: editDate,
      }),
    deleteOwnerMessage: (ownerId, peerId, messageId) =>
      act(
        "DELETE",
        `owners/${ownerId}/dialogs/${peerId}/messages/${messageId}`,
      ),
    setOwnerFilter: (ownerId, filter) =>
      act("POST", `owners/${ownerId}/filters`, {
        id: filter.id,
        title: filter.title,
        emoticon: filter.emoticon,
        color: filter.color,
        include_peers: filter.includePeers,
        exclude_peers: filter.excludePeers,
        pinned_peers: filter.pinnedPeers,
        contacts: filter.contacts,
        non_contacts: filter.nonContacts,
        groups: filter.groups,
        broadcasts: filter.broadcasts,
        bots: filter.bots,
        exclude_muted: filter.excludeMuted,
        exclude_read: filter.excludeRead,
        exclude_archived: filter.excludeArchived,
      }),
    orderOwnerFilters: (ownerId, ids) =>
      act("POST", `owners/${ownerId}/filters/order`, { ids }),
    deleteOwnerFilter: (ownerId, filterId) =>
      act("DELETE", `owners/${ownerId}/filters/${filterId}`),
    failOwnerCall: (ownerId, fault) =>
      act("POST", `owners/${ownerId}/faults`, {
        method: fault.method,
        peer_id: fault.peerId,
        times: fault.times,
        delay_ms: fault.delayMs,
        preset: fault.preset,
        seconds: fault.seconds,
        error_message: fault.errorMessage,
        code: fault.code,
      }),
    clearOwnerFaults: (ownerId) => act("DELETE", `owners/${ownerId}/faults`),
    getOwnerCalls: (ownerId) => act("GET", `owners/${ownerId}/calls`),
    resetOwners: () => act("DELETE", "owners"),
    approveLogin: async (authUrl, userId) =>
      (
        await act("POST", "login/approve", {
          auth_url: authUrl,
          user_id: userId,
        })
      ).redirect_url,
    cancelLogin: async (authUrl) =>
      (await act("POST", "login/cancel", { auth_url: authUrl })).redirect_url,
    connectBusiness: ({ ownerId, rights, id, isEnabled, botId } = {}) =>
      act("POST", "business/connections", {
        owner_id: ownerId,
        rights,
        ...(id != null ? { id } : {}),
        ...(isEnabled !== undefined ? { is_enabled: isEnabled } : {}),
        ...(botId != null ? { bot_id: botId } : {}),
      }),
    getBusinessConnection: (connectionId) =>
      act("GET", `business/connections/${connectionId}`),
    sayInBusinessChat: (connectionId, userId, sender, text) =>
      act(
        "POST",
        `business/connections/${connectionId}/chats/${userId}/messages`,
        { sender, text },
      ),
    getBusinessChat: (connectionId, userId) =>
      act(
        "GET",
        `business/connections/${connectionId}/chats/${userId}/messages`,
      ),
    redeliverUpdate: (updateId, { botId } = {}) =>
      act(
        "POST",
        `updates/${updateId}/redeliver`,
        botId != null ? { bot_id: botId } : {},
      ),
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
              ...(message.media
                ? {
                    media: {
                      type: message.media.type,
                      base64: Buffer.from(message.media.bytes ?? []).toString(
                        "base64",
                      ),
                      ...(message.media.fileName
                        ? { file_name: message.media.fileName }
                        : {}),
                      ...(message.media.mimeType
                        ? { mime_type: message.media.mimeType }
                        : {}),
                    },
                  }
                : {}),
              ...(message.forwardFrom
                ? {
                    forward_from: {
                      ...(message.forwardFrom.userId != null
                        ? { user_id: message.forwardFrom.userId }
                        : {}),
                      ...(message.forwardFrom.chatId != null
                        ? { chat_id: message.forwardFrom.chatId }
                        : {}),
                      ...(message.forwardFrom.messageId != null
                        ? { message_id: message.forwardFrom.messageId }
                        : {}),
                      ...(message.forwardFrom.senderName
                        ? { sender_name: message.forwardFrom.senderName }
                        : {}),
                    },
                  }
                : {}),
              ...(message.caption ? { caption: message.caption } : {}),
              ...(message.replyTo != null ? { reply_to: message.replyTo } : {}),
              ...(message.threadId != null
                ? { message_thread_id: message.threadId }
                : {}),
            };
      return (
        await act("POST", `chats/${chatId}/messages`, {
          user_id: userId,
          ...fields,
        })
      ).message_id;
    },
    postAlbum: async (chatId, userId, items, { threadId } = {}) =>
      act("POST", `chats/${chatId}/albums`, {
        user_id: userId,
        items: items.map((item) => ({
          type: item.type,
          base64: Buffer.from(item.bytes ?? []).toString("base64"),
          ...(item.caption ? { caption: item.caption } : {}),
        })),
        ...(threadId != null ? { message_thread_id: threadId } : {}),
      }),
    editMessage: (chatId, messageId, userId, { text, caption } = {}) =>
      act("POST", `chats/${chatId}/messages/${messageId}/edit`, {
        user_id: userId,
        text,
        caption,
      }),
    react: (chatId, messageId, userId, emoji = null) =>
      act("POST", `chats/${chatId}/messages/${messageId}/reactions`, {
        user_id: userId,
        emoji,
      }),
    pinMessage: (chatId, messageId, userId) =>
      act("POST", `chats/${chatId}/messages/${messageId}/pin`, {
        user_id: userId,
      }),
    pressButton: (chatId, messageId, userId, data) =>
      act("POST", `chats/${chatId}/messages/${messageId}/callback`, {
        user_id: userId,
        data,
      }),
    pressEphemeralButton: (chatId, ephemeralMessageId, userId, data) =>
      act(
        "POST",
        `chats/${chatId}/ephemeral-messages/${ephemeralMessageId}/callback`,
        { user_id: userId, data },
      ),
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
    getEphemeralMessage: (chatId, ephemeralMessageId) =>
      act("GET", `chats/${chatId}/ephemeral-messages/${ephemeralMessageId}`),
    getDirectMessages: (userId) => act("GET", `users/${userId}/dm`),
    getMember: (chatId, userId) =>
      act("GET", `chats/${chatId}/members/${userId}`),
    getJoinRequests: (chatId) => act("GET", `chats/${chatId}/join-requests`),
    getCalls: () => act("GET", "calls"),
    stop: () =>
      (stopPromise ??= (async () => {
        stopped = true;
        waits.cancel("Fake server stopped", true);
        for (const record of bots.values()) {
          wakePollers(record);
          closeAttempts(record, "cancelled");
        }
        for (const abort of [...inFlight]) abort.abort();
        clock.clear();
        expiryTasks.clear();
        snapshots.clear();
        const closing = [...responseClosures];
        await new Promise((resolve) => {
          server.close(resolve);
          server.closeAllConnections();
        });
        await Promise.all(closing);
        await Promise.all([...deliveries]);
        agents.http.destroy();
        agents.https.destroy();
        if (deliveryError) throw deliveryError;
      })()),
  };
}

export { createOwnerClient, ownerApi } from "./owner-client.js";
