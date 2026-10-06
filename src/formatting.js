/**
 * Message text as Telegram stores it: parse_mode (HTML, MarkdownV2 or legacy
 * Markdown) turned into plain text plus MessageEntity objects, the text
 * cleaned and trimmed, and the entities Telegram finds by itself, all with
 * UTF-16 offsets as Telegram reports them. Supported contracts are documented
 * in docs/telegram-behavior.md.
 */

export class FormattingError extends Error {}

const utf8Length = (text) => Buffer.byteLength(text, "utf8");
// TDLib's to_lower changes ASCII letters only.
const asciiLower = (text) =>
  text.replace(/[A-Z]/g, (char) => char.toLowerCase());

function fail(reason) {
  throw new FormattingError(`Bad Request: can't parse entities: ${reason}`);
}

function sortEntities(entities) {
  return entities
    .filter((entity) => entity.length > 0)
    .sort(
      (left, right) =>
        left.offset - right.offset ||
        right.length - left.length ||
        entityPriority(left.type) - entityPriority(right.type),
    );
}

// TDLib MessageEntity.cpp: fix_entities, split_entities, merge_new_entities.
// Styles merge per type and split at continuous/blockquote boundaries; code,
// pre and date_time (TDLib's pre entities) exclude styles. Overlapping
// continuous entities and quotes are pruned.
const STYLES = new Set([
  "bold",
  "italic",
  "underline",
  "strikethrough",
  "spoiler",
]);
const QUOTES = new Set(["blockquote", "expandable_blockquote"]);
const CODE = new Set(["code", "pre", "date_time"]);
function entityPriority(type) {
  return (
    {
      blockquote: 0,
      expandable_blockquote: 0,
      pre: 11,
      code: 20,
      date_time: 30,
      text_link: 49,
      text_mention: 49,
      bold: 90,
      italic: 91,
      underline: 92,
      strikethrough: 93,
      spoiler: 94,
      custom_emoji: 99,
    }[type] ?? 50
  );
}
const endOf = (entity) => entity.offset + entity.length;
const intersects = (a, b) => a.offset < endOf(b) && b.offset < endOf(a);
function nonOverlapping(entities) {
  let end = 0;
  return sortEntities(entities).filter((entity) => {
    if (entity.offset < end) return false;
    end = endOf(entity);
    return true;
  });
}
function normalizeEntities(entities) {
  const quotes = nonOverlapping(
    entities.filter((entity) => QUOTES.has(entity.type)),
  );
  const continuous = nonOverlapping(
    entities.filter(
      (entity) => !STYLES.has(entity.type) && !QUOTES.has(entity.type),
    ),
  ).filter((entity) =>
    quotes.every(
      (quote) =>
        !intersects(entity, quote) ||
        (quote.offset <= entity.offset && endOf(entity) <= endOf(quote)),
    ),
  );
  const base = sortEntities([...quotes, ...continuous]);
  const styles = [];
  for (const type of STYLES) {
    const merged = [];
    for (const entity of sortEntities(
      entities.filter((entry) => entry.type === type),
    )) {
      const previous = merged.at(-1);
      if (previous && entity.offset <= endOf(previous)) {
        previous.length =
          Math.max(endOf(previous), endOf(entity)) - previous.offset;
      } else merged.push({ ...entity });
    }
    for (const entity of merged) {
      const boundaries = [
        ...new Set([
          entity.offset,
          endOf(entity),
          ...base.flatMap((other) =>
            [other.offset, endOf(other)].filter(
              (offset) => entity.offset < offset && offset < endOf(entity),
            ),
          ),
        ]),
      ].sort((a, b) => a - b);
      for (let i = 1; i < boundaries.length; i++) {
        const piece = {
          type,
          offset: boundaries[i - 1],
          length: boundaries[i] - boundaries[i - 1],
        };
        if (
          !continuous.some(
            (other) => CODE.has(other.type) && intersects(piece, other),
          )
        )
          styles.push(piece);
      }
    }
  }
  return sortEntities([...base, ...styles]);
}
function validateRanges(text, entities) {
  const insideSurrogate = (offset) =>
    offset > 0 &&
    offset < text.length &&
    text.charCodeAt(offset - 1) >= 0xd800 &&
    text.charCodeAt(offset - 1) <= 0xdbff &&
    text.charCodeAt(offset) >= 0xdc00 &&
    text.charCodeAt(offset) <= 0xdfff;
  for (const entity of entities) {
    if (
      !Number.isInteger(entity.offset) ||
      entity.offset < 0 ||
      entity.offset > 1000000
    )
      fail(`Receive an entity with incorrect offset ${entity.offset}`);
    if (
      !Number.isInteger(entity.length) ||
      entity.length < 0 ||
      entity.length > 1000000
    )
      fail(`Receive an entity with incorrect length ${entity.length}`);
    if (entity.length === 0) continue;
    if (entity.offset > text.length)
      fail(
        `Entity begins after the end of the text at UTF-16 offset ${entity.offset}`,
      );
    if (endOf(entity) > text.length)
      fail(
        `Entity beginning at UTF-16 offset ${entity.offset} ends after the end of the text at UTF-16 offset ${endOf(entity)}`,
      );
    if (insideSurrogate(entity.offset) || insideSurrogate(endOf(entity)))
      fail("Entity boundary is in the middle of a UTF-16 symbol");
  }
}

function linkEntity(url, offset, length) {
  const mention = /^tg:\/\/user\?id=(\d+)$/.exec(url);
  if (mention) {
    return {
      type: "text_mention",
      offset,
      length,
      user: { id: Number(mention[1]) },
    };
  }
  return { type: "text_link", offset, length, url };
}

/**
 * A date_time format as the Bot API writes it back (Client.cpp
 * get_date_time_format): "r", or w, then d or D, then t or T. TDLib
 * FormattedDate::get_date_flags accepts "r" or "R" alone, or any of tTdDwW,
 * and a short precision wins over a long one; null for anything else.
 */
function dateTimeFormat(format) {
  if (format === "r" || format === "R") return "r";
  if (!/^[tTdDwW]*$/.test(format)) return null;
  const pick = (short, long) =>
    format.includes(short) ? short : format.includes(long) ? long : "";
  return (/[wW]/.test(format) ? "w" : "") + pick("d", "D") + pick("t", "T");
}

/**
 * The date_time_format of an explicit date_time entity, as the Bot API reads
 * it (Client.cpp get_date_time_formatting_type) and writes it back: "r" or
 * "R" alone, or any of tTdDwW where the last of d and D and the last of t and
 * T win; null for anything else.
 */
function givenDateTimeFormat(format) {
  if (format === "r" || format === "R") return "r";
  if (!/^[tTdDwW]*$/.test(format)) return null;
  const last = (pattern) => format.match(pattern)?.at(-1) ?? "";
  return (/[wW]/.test(format) ? "w" : "") + last(/[dD]/g) + last(/[tT]/g);
}

/** td::to_integer<int32>: the leading digits, wrapped to 32 bits. */
function int32Prefix(value) {
  const [, sign, digits] = /^(-?)(\d*)/.exec(value);
  return Number(BigInt.asIntN(32, BigInt(`${sign}${digits || "0"}`)));
}

/** td::to_integer_safe: only the integer's own decimal form, in range. */
function exactInteger(value, bits) {
  if (!/^-?\d+$/.test(value)) return null;
  const number = BigInt(value);
  return number.toString() === value && BigInt.asIntN(bits, number) === number
    ? number
    : null;
}

/**
 * The parameters of a tg://<host>?... link, or null for another link (TDLib
 * LinkManager::check_tg_url_host).
 */
function tgLinkParameters(url, host) {
  if (!/^tg:/i.test(url)) return null;
  let rest = url.slice(3);
  if (rest.startsWith("//")) rest = rest.slice(2);
  if (
    asciiLower(rest.slice(0, host.length)) !== host ||
    (rest.length > host.length && !"/?#".includes(rest[host.length]))
  )
    return null;
  rest = rest.slice(host.length);
  if (rest.startsWith("/")) rest = rest.slice(1);
  if (!rest.startsWith("?")) return null;
  return rest
    .slice(1)
    .split("#")[0]
    .split("&")
    .map((parameter) => {
      const equals = parameter.indexOf("=");
      return equals < 0
        ? [parameter, ""]
        : [parameter.slice(0, equals), parameter.slice(equals + 1)];
    });
}

/**
 * The entity a MarkdownV2 ![text](url) makes: a custom emoji for
 * tg://emoji?id=, else a date_time for tg://time?unix=&format= (TDLib
 * LinkManager get_link_custom_emoji_id, get_link_formatted_date); null when
 * the URL is neither.
 */
function emojiOrTimeEntity(url) {
  const id = tgLinkParameters(url, "emoji")?.find(([key]) => key === "id")?.[1];
  const emoji = id === undefined ? null : exactInteger(id, 64);
  if (emoji != null && emoji !== 0n) {
    return { type: "custom_emoji", custom_emoji_id: id };
  }
  const parameters = tgLinkParameters(url, "time");
  if (!parameters) return null;
  let unix = 0;
  let format = "";
  for (const [key, value] of parameters) {
    if (key === "unix") {
      unix = Number(exactInteger(value, 32) ?? 0);
      if (unix <= 0) return null;
    }
    if (key === "format") format = value;
  }
  const canonical = dateTimeFormat(format);
  if (unix === 0 || canonical == null) return null;
  return { type: "date_time", unix_time: unix, date_time_format: canonical };
}

// ── HTML ────────────────────────────────────────────────────────────────────

const HTML_ENTITIES = { lt: "<", gt: ">", amp: "&", quot: '"' };

const HTML_TAGS = {
  b: "bold",
  strong: "bold",
  i: "italic",
  em: "italic",
  u: "underline",
  ins: "underline",
  s: "strikethrough",
  strike: "strikethrough",
  del: "strikethrough",
  "tg-spoiler": "spoiler",
  code: "code",
  pre: "pre",
  a: "text_link",
  blockquote: "blockquote",
  "tg-emoji": "custom_emoji",
  "tg-time": "date_time",
  span: "spoiler",
};

function decodeHtml(raw) {
  return raw.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, name) => {
    if (name[0] === "#") {
      const code =
        name[1].toLowerCase() === "x"
          ? parseInt(name.slice(2), 16)
          : parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : match;
    }
    return HTML_ENTITIES[name.toLowerCase()] ?? match;
  });
}

function parseAttributes(source, offset) {
  const attributes = {};
  const pattern =
    /\s*([a-z-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/giy;
  let index = 0;
  while (index < source.length) {
    pattern.lastIndex = index;
    const match = pattern.exec(source);
    if (!match || match[0].length === 0) {
      if (/^\s*$/.test(source.slice(index))) break;
      fail(
        `Expected equal sign in declaration of an attribute of the tag at byte offset ${offset}`,
      );
    }
    attributes[match[1].toLowerCase()] = decodeHtml(
      match[2] ?? match[3] ?? match[4] ?? "",
    );
    index = pattern.lastIndex;
  }
  return attributes;
}

export function parseHtml(input) {
  let text = "";
  const entities = [];
  const stack = [];
  let index = 0;
  while (index < input.length) {
    const char = input[index];
    if (char === "&") {
      const match = /^&(#x[0-9a-f]+|#\d+|[a-z]+);/i.exec(input.slice(index));
      if (match) {
        text += decodeHtml(match[0]);
        index += match[0].length;
        continue;
      }
      text += char;
      index++;
      continue;
    }
    if (char !== "<") {
      text += char;
      index++;
      continue;
    }
    const byteOffset = utf8Length(input.slice(0, index));
    const end = input.indexOf(">", index);
    if (end < 0) fail(`Unclosed start tag at byte offset ${byteOffset}`);
    const tag = input.slice(index + 1, end);
    index = end + 1;
    if (tag.startsWith("/")) {
      const name = tag.slice(1).trim().toLowerCase();
      const open = stack.pop();
      if (!open) fail(`Unexpected end tag at byte offset ${byteOffset}`);
      if (open.name !== name) {
        fail(
          `Unmatched end tag at byte offset ${byteOffset}, expected "</${open.name}>", found "</${name}>"`,
        );
      }
      const length = text.length - open.offset;
      if (open.entity?.type === "date_time") {
        // TDLib checks the format only around some text, and makes the
        // entity only for a positive time.
        if (length > 0) {
          const format = dateTimeFormat(open.entity.format);
          if (format == null) fail("Invalid date format used");
          if (open.entity.unix > 0) {
            entities.push({
              type: "date_time",
              offset: open.offset,
              length,
              unix_time: open.entity.unix,
              date_time_format: format,
            });
          }
        }
      } else if (open.entity) {
        entities.push({ ...open.entity, offset: open.offset, length });
      }
      continue;
    }
    const nameMatch = /^([a-z][a-z0-9-]*)/i.exec(tag);
    const name = nameMatch?.[1].toLowerCase();
    if (!name || !(name in HTML_TAGS)) {
      fail(
        `Unsupported start tag "${name ?? tag}" at byte offset ${byteOffset}`,
      );
    }
    const attributes = parseAttributes(tag.slice(name.length), byteOffset);
    let entity = { type: HTML_TAGS[name] };
    if (name === "a") {
      if (!attributes.href) entity = null;
      else entity = linkEntity(attributes.href, 0, 0);
    } else if (name === "span") {
      if (attributes.class !== "tg-spoiler")
        fail(
          `Tag "span" must have class "tg-spoiler" at byte offset ${byteOffset}`,
        );
    } else if (name === "tg-emoji") {
      if (!attributes["emoji-id"])
        fail(
          `Custom emoji entity must contain a tg://emoji URL at byte offset ${byteOffset}`,
        );
      entity = {
        type: "custom_emoji",
        custom_emoji_id: attributes["emoji-id"],
      };
    } else if (name === "tg-time") {
      entity = {
        type: "date_time",
        unix: int32Prefix(attributes.unix ?? ""),
        format: attributes.format ?? "",
      };
    } else if (name === "blockquote" && "expandable" in attributes) {
      entity = { type: "expandable_blockquote" };
    } else if (name === "code") {
      const pre = stack.at(-1);
      const language = /^language-(.+)$/.exec(attributes.class ?? "")?.[1];
      if (pre?.name === "pre" && pre.offset === text.length) {
        if (language) pre.entity.language = language;
        entity = null;
      }
    }
    stack.push({ name, offset: text.length, entity });
  }
  if (stack.length > 0)
    fail(
      `Can't find end tag corresponding to start tag "${stack.at(-1).name}"`,
    );
  return { text, entities: sortEntities(entities) };
}

// ── MarkdownV2 ──────────────────────────────────────────────────────────────

const V2_RESERVED = new Set("_*[]()~`>#+-=|{}.!".split(""));

const V2_ENTITY_NAMES = {
  bold: "Bold",
  italic: "Italic",
  underline: "Underline",
  strikethrough: "Strikethrough",
  spoiler: "Spoiler",
};

export function parseMarkdownV2(input) {
  let text = "";
  const entities = [];
  const open = [];
  let quote = null;
  let index = 0;
  const byteOffset = (at) => utf8Length(input.slice(0, at));
  const atLineStart = (at) => at === 0 || input[at - 1] === "\n";

  const toggle = (type, width, at) => {
    const top = open.at(-1)?.type === type ? open.length - 1 : -1;
    if (top >= 0) {
      const [entry] = open.splice(top, 1);
      entities.push({
        type,
        offset: entry.offset,
        length: text.length - entry.offset,
      });
    } else {
      open.push({ type, offset: text.length, at });
    }
    return at + width;
  };

  const closeQuote = () => {
    if (!quote) return;
    let length = text.length - quote.offset;
    if (text.endsWith("\n")) length--;
    entities.push({ type: quote.type, offset: quote.offset, length });
    quote = null;
  };

  while (index < input.length) {
    const char = input[index];
    if (atLineStart(index)) {
      if (input.startsWith("**>", index)) {
        closeQuote();
        quote = { type: "expandable_blockquote", offset: text.length };
        index += 3;
        continue;
      }
      if (char === ">") {
        if (!quote) quote = { type: "blockquote", offset: text.length };
        index++;
        continue;
      }
      if (quote && quote.type === "blockquote") closeQuote();
    }
    if (char === "\\") {
      const next = input[index + 1];
      if (next === undefined)
        fail(
          `Character '\\' is reserved and must be escaped with the preceding '\\'`,
        );
      text += next;
      index += 2;
      continue;
    }
    if (
      char === "\n" &&
      quote?.type === "expandable_blockquote" &&
      input[index + 1] !== ">"
    ) {
      text += char;
      index++;
      closeQuote();
      continue;
    }
    if (input.startsWith("```", index)) {
      const close = findUnescaped(input, "```", index + 3);
      if (close < 0)
        fail(
          `Can't find end of Pre entity at byte offset ${byteOffset(index)}`,
        );
      let body = input.slice(index + 3, close);
      let language;
      const newline = body.indexOf("\n");
      if (newline >= 0 && /^[^\s`]+$/.test(body.slice(0, newline))) {
        language = body.slice(0, newline);
        body = body.slice(newline + 1);
      }
      const offset = text.length;
      text += unescapeCode(body);
      entities.push({
        type: "pre",
        offset,
        length: text.length - offset,
        ...(language ? { language } : {}),
      });
      index = close + 3;
      continue;
    }
    if (char === "`") {
      const close = findUnescaped(input, "`", index + 1);
      if (close < 0)
        fail(
          `Can't find end of Code entity at byte offset ${byteOffset(index)}`,
        );
      const offset = text.length;
      text += unescapeCode(input.slice(index + 1, close));
      entities.push({ type: "code", offset, length: text.length - offset });
      index = close + 1;
      continue;
    }
    if (input.startsWith("||", index)) {
      if (
        quote?.type === "expandable_blockquote" &&
        (input[index + 2] === "\n" || index + 2 === input.length)
      ) {
        index += 2;
        closeQuote();
        continue;
      }
      index = toggle("spoiler", 2, index);
      continue;
    }
    if (input.startsWith("__", index)) {
      index = toggle("underline", 2, index);
      continue;
    }
    if (char === "_") {
      index = toggle("italic", 1, index);
      continue;
    }
    if (char === "*") {
      index = toggle("bold", 1, index);
      continue;
    }
    if (char === "~") {
      index = toggle("strikethrough", 1, index);
      continue;
    }
    if (char === "[" || (char === "!" && input[index + 1] === "[")) {
      const emoji = char === "!";
      open.push({
        type: emoji ? "custom_emoji_link" : "link",
        offset: text.length,
        at: index,
      });
      index += emoji ? 2 : 1;
      continue;
    }
    if (char === "]") {
      const top = open.findLastIndex(
        (entry) => entry.type === "link" || entry.type === "custom_emoji_link",
      );
      if (
        top >= 0 &&
        top === open.length - 1 &&
        open[top].type === "custom_emoji_link" &&
        input[index + 1] !== "("
      )
        fail("The entity must contain a tg://emoji or tg://time URL");
      if (top < 0 || top !== open.length - 1 || input[index + 1] !== "(") {
        fail(
          `Character ']' is reserved and must be escaped with the preceding '\\'`,
        );
      }
      const [entry] = open.splice(top, 1);
      let close = index + 2;
      let url = "";
      while (close < input.length && input[close] !== ")") {
        if (input[close] === "\\" && close + 1 < input.length) close++;
        url += input[close];
        close++;
      }
      if (close >= input.length)
        fail(`Can't find end of a URL at byte offset ${byteOffset(index + 2)}`);
      const length = text.length - entry.offset;
      if (entry.type === "custom_emoji_link") {
        const entity = emojiOrTimeEntity(url);
        if (!entity) fail("Invalid tg://emoji or tg://time URL specified");
        entities.push({ ...entity, offset: entry.offset, length });
      } else {
        entities.push(linkEntity(url, entry.offset, length));
      }
      index = close + 1;
      continue;
    }
    if (V2_RESERVED.has(char)) {
      fail(
        `Character '${char}' is reserved and must be escaped with the preceding '\\'`,
      );
    }
    text += char;
    index++;
  }
  closeQuote();
  const unclosed = open[0];
  if (unclosed) {
    const name = V2_ENTITY_NAMES[unclosed.type];
    if (name)
      fail(
        `Can't find end of ${name} entity at byte offset ${byteOffset(unclosed.at)}`,
      );
    fail(`Can't find end of a URL at byte offset ${byteOffset(unclosed.at)}`);
  }
  return { text, entities: sortEntities(entities) };
}

function findUnescaped(input, token, from) {
  for (let index = from; index < input.length; index++) {
    if (input[index] === "\\") {
      index++;
      continue;
    }
    if (input.startsWith(token, index)) return index;
  }
  return -1;
}

function unescapeCode(body) {
  return body.replace(/\\([\\`])/g, "$1");
}

// ── Markdown (legacy) ───────────────────────────────────────────────────────

export function parseMarkdown(input) {
  let text = "";
  const entities = [];
  let index = 0;
  const byteOffset = (at) => utf8Length(input.slice(0, at));
  while (index < input.length) {
    const char = input[index];
    if (char === "\\" && "_*`[".includes(input[index + 1] ?? "")) {
      text += input[index + 1];
      index += 2;
      continue;
    }
    if (input.startsWith("```", index)) {
      const close = input.indexOf("```", index + 3);
      if (close < 0)
        fail(
          `Can't find end of the entity starting at byte offset ${byteOffset(index)}`,
        );
      let body = input.slice(index + 3, close);
      let language;
      const newline = body.indexOf("\n");
      if (newline >= 0 && /^[^\s`]+$/.test(body.slice(0, newline))) {
        language = body.slice(0, newline);
        body = body.slice(newline + 1);
      }
      entities.push({
        type: "pre",
        offset: text.length,
        length: body.length,
        ...(language ? { language } : {}),
      });
      text += body;
      index = close + 3;
      continue;
    }
    const simple = { "*": "bold", _: "italic", "`": "code" }[char];
    if (simple) {
      const close = input.indexOf(char, index + 1);
      if (close < 0)
        fail(
          `Can't find end of the entity starting at byte offset ${byteOffset(index)}`,
        );
      const body = input.slice(index + 1, close);
      entities.push({ type: simple, offset: text.length, length: body.length });
      text += body;
      index = close + 1;
      continue;
    }
    if (char === "[") {
      const match = /^\[([^\]]*)\]\(([^)]*)\)/.exec(input.slice(index));
      if (!match)
        fail(
          `Can't find end of the entity starting at byte offset ${byteOffset(index)}`,
        );
      entities.push(linkEntity(match[2], text.length, match[1].length));
      text += match[1];
      index += match[0].length;
      continue;
    }
    text += char;
    index++;
  }
  return { text, entities: sortEntities(entities) };
}

// The entity types Telegram finds by itself, and the ones a bot may give
// (Client.cpp get_text_entity_type).
const FOUND_TYPES = new Set([
  "mention",
  "hashtag",
  "cashtag",
  "bot_command",
  "url",
  "email",
  "phone_number",
  "bank_card_number",
]);
const GIVEN_TYPES = new Set([
  ...STYLES,
  ...QUOTES,
  "code",
  "pre",
  "text_link",
  "text_mention",
  "custom_emoji",
  "date_time",
]);

/**
 * An explicit entity as the Bot API reads it (Client.cpp get_text_entity,
 * get_text_entity_type): null for a type Telegram finds by itself, which it
 * ignores, and an unknown type refused. A date_time needs a positive
 * unix_time (TDLib FormattedDate::get_formatted_date) and comes back with its
 * format in Telegram's order.
 */
function givenEntity(entity) {
  const refuse = (reason) => {
    throw new FormattingError(
      `Bad Request: can't parse MessageEntity: ${reason}`,
    );
  };
  // JsonObject::get_*_string_field: a string, or a number as written.
  const string = (name) => {
    const value = entity[name];
    if (value === undefined || ["string", "number"].includes(typeof value))
      return value === undefined ? undefined : String(value);
    refuse(`Field "${name}" must be of type String`);
  };
  if (entity === null || typeof entity !== "object" || Array.isArray(entity))
    refuse("expected an Object");
  const type = string("type");
  if (type === undefined) refuse(`Can't find field "type"`);
  if (type === "") refuse("Type is not specified");
  if (FOUND_TYPES.has(type)) return null;
  if (!GIVEN_TYPES.has(type)) refuse("Unsupported type specified");
  if (type !== "date_time") return { ...entity };
  const time = entity.unix_time;
  if (time === undefined) refuse(`Can't find field "unix_time"`);
  if (!["string", "number"].includes(typeof time))
    refuse(`Field "unix_time" must be a Number`);
  const unix = exactInteger(String(time), 32);
  if (unix == null) refuse(`Field "unix_time" must be a valid Number`);
  const format = givenDateTimeFormat(string("date_time_format") ?? "");
  if (format == null) refuse("Invalid date-time format specified");
  if (unix <= 0n) {
    throw new FormattingError("Bad Request: invalid date specified");
  }
  return {
    type,
    offset: entity.offset,
    length: entity.length,
    unix_time: Number(unix),
    date_time_format: format,
  };
}

/**
 * The text and entities a message ends up with, as the Bot API server and
 * TDLib make them. A parse_mode other than "none" wins over explicit entities
 * (Client.cpp get_formatted_text); then the text is cleaned and trimmed, and
 * the links, mentions, commands, hashtags and cashtags Telegram finds by
 * itself are added outside code, pre and explicit links. `ltrim` is how many
 * characters were cut from the start. `user` gives the User a text_mention
 * shows for a user id.
 */
export function formatText(text, { parseMode, entities, user } = {}) {
  const mode = typeof parseMode === "string" ? parseMode.toLowerCase() : "";
  let parsed;
  if (text && mode && mode !== "none") {
    if (mode === "html") parsed = parseHtml(text);
    else if (mode === "markdownv2") parsed = parseMarkdownV2(text);
    else if (mode === "markdown") parsed = parseMarkdown(text);
    else throw new FormattingError("Bad Request: unsupported parse_mode");
  } else {
    parsed = {
      text,
      entities: Array.isArray(entities)
        ? entities.map(givenEntity).filter(Boolean)
        : [],
    };
  }
  validateRanges(parsed.text, parsed.entities);
  const trimmed = cleanAndTrim(parsed.text, normalizeEntities(parsed.entities));
  // Automatically found entities can coexist with styles, but not continuous
  // entities such as code, pre or an explicit text link.
  const detected = findEntities(trimmed.text).filter((candidate) =>
    trimmed.entities.every(
      (entity) =>
        STYLES.has(entity.type) ||
        (QUOTES.has(entity.type)
          ? !intersects(candidate, entity) ||
            (entity.offset <= candidate.offset &&
              endOf(candidate) <= endOf(entity))
          : !intersects(candidate, entity)),
    ),
  );
  return {
    text: trimmed.text,
    entities: normalizeEntities([...trimmed.entities, ...detected]).map(
      (entity) =>
        entity.type === "text_mention" && user && entity.user?.id != null
          ? { ...entity, user: user(Number(entity.user.id)) }
          : entity,
    ),
    ltrim: trimmed.ltrim,
  };
}

/**
 * Whether cleaned text shows nothing (TDLib is_empty_string): it has only
 * spaces, newlines and the characters TDLib's strip_empty_characters counts
 * as blank. Those are the no-break, Ogham, U+2000 to U+200A, narrow no-break,
 * medium mathematical and ideographic spaces, the Mongolian vowel separator,
 * zero-width characters and direction marks, U+202E, the Braille blank, the
 * byte order mark, the object replacement character and tag characters.
 */
export const isEmptyText = (text) =>
  /^[\n \u00a0\u1680\u180e\u2000-\u200f\u202e\u202f\u205f\u2800\u3000\ufeff\ufffc\u{e0000}-\u{e007f}]*$/u.test(
    text,
  );

/**
 * Text as TDLib's clean_input_string leaves it, as cleanAndTrim below cleans
 * it when there are no entities to move.
 */
export const cleanInput = (text) =>
  text
    .replace(/[\r\u2028-\u202e\u030a\u0333\u033f]/g, "")
    .replace(/[\0-\t\v-\x1f]/g, " ")
    .replace(/[\u200e\u200f](?=[\u200e\u200f])/g, "\u200c");

/**
 * TDLib fix_formatted_text for a message being sent. clean_input_string turns
 * control characters other than \n into spaces and drops \r, U+2028 to U+202E
 * and the combining marks U+030A, U+0333 and U+033F; in a run of
 * left-to-right and right-to-left marks all but the last become zero-width
 * non-joiners. Then spaces and newlines are cut from the end, and from the
 * start up to the first entity; `ltrim` counts those cut from the start.
 * Entities move with the text; empty text comes back empty.
 */
function cleanAndTrim(text, entities) {
  let clean = "";
  // removed[i]: characters dropped before UTF-16 offset i.
  const removed = [0];
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    const drop =
      code === 0x0d ||
      (code >= 0x2028 && code <= 0x202e) ||
      code === 0x30a ||
      code === 0x333 ||
      code === 0x33f;
    removed.push(removed[index] + (drop ? 1 : 0));
    if (!drop) clean += code < 0x20 && code !== 0x0a ? " " : text[index];
  }
  clean = clean.replace(/[\u200e\u200f](?=[\u200e\u200f])/g, "\u200c");
  let moved = normalizeEntities(
    entities.map((entity) => {
      const offset = entity.offset - removed[entity.offset];
      return {
        ...entity,
        offset,
        length: endOf(entity) - removed[endOf(entity)] - offset,
      };
    }),
  );
  let end = clean.length;
  while (end > 0 && (clean[end - 1] === " " || clean[end - 1] === "\n")) end--;
  if (end === 0) return { text: "", entities: [], ltrim: 0 };
  moved = moved
    .filter((entity) => entity.offset < end)
    .map((entity) =>
      endOf(entity) > end ? { ...entity, length: end - entity.offset } : entity,
    );
  const first = Math.min(end, ...moved.map((entity) => entity.offset));
  let start = 0;
  while (start < first && (clean[start] === " " || clean[start] === "\n"))
    start++;
  return {
    text: clean.slice(start, end),
    entities: sortEntities(
      moved.map((entity) => ({ ...entity, offset: entity.offset - start })),
    ),
    ltrim: start,
  };
}

// ── Entities Telegram finds by itself ───────────────────────────────────────
// TDLib MessageEntity.cpp find_entities: mentions, bot commands, hashtags,
// cashtags, tg:// links, URLs and emails; a match overlapping an earlier one
// is dropped. Phone numbers are a TODO there, so none are found. Bank card
// numbers and media timestamps are not looked for: the Bot API never shows
// them. Unicode classes stand in for TDLib's get_unicode_simple_category.

const isWordCharacter = (char) => /^[\p{L}\p{N}_]$/u.test(char);
const isAlphaDigitOrUnderscore = (char) => /^[A-Za-z0-9_]$/.test(char ?? "");
const isDigit = (char) => /^[0-9]$/.test(char ?? "");
/** The character (code point) at a UTF-16 offset, or "" at the end. */
const charAt = (text, index) =>
  index < text.length ? String.fromCodePoint(text.codePointAt(index)) : "";
/** The character (code point) ending at a UTF-16 offset, or "" at the start. */
const charBefore = (text, index) =>
  [...text.slice(Math.max(0, index - 2), index)].at(-1) ?? "";

function isHashtagLetter(char) {
  const code = char.codePointAt(0);
  return (
    char === "_" ||
    code === 0x200c ||
    code === 0xb7 ||
    (code >= 0xd80 && code <= 0xdff) ||
    /^[\p{L}\p{Nd}]$/u.test(char)
  );
}

function isUrlUnicodeSymbol(char) {
  const code = char.codePointAt(0);
  if (code >= 0x2000 && code <= 0x206f) {
    // Zero-width non-joiner and joiner, and dashes.
    return (
      code === 0x200c || code === 0x200d || (code >= 0x2010 && code <= 0x2015)
    );
  }
  return !/^\p{Z}$/u.test(char);
}

const isUrlPathSymbol = (char) =>
  !'\n<>"«»'.includes(char) && isUrlUnicodeSymbol(char);
const isUserDataSymbol = (char) =>
  !"\n/[]{}()'`<>\"@«»".includes(char) && isUrlUnicodeSymbol(char);
const isDomainSymbol = (char) =>
  char.codePointAt(0) < 0xc0
    ? /^[.A-Za-z0-9_~-]$/.test(char)
    : isUrlUnicodeSymbol(char);
// Dots in a protocol are not allowed; other letters are taken so that the
// protocol is then refused.
const isProtocolSymbol = (char) =>
  char.codePointAt(0) < 0x80
    ? /^[A-Za-z0-9+-]$/.test(char)
    : !/^\p{Z}$/u.test(char);
const BAD_PATH_END = ".:;,('?!`";

/** The end of a path that starts at `from` (a /, ? or #), or `from`. */
function pathEnd(text, from) {
  let end = from + 1;
  while (end < text.length && isUrlPathSymbol(charAt(text, end)))
    end += charAt(text, end).length;
  while (end > from + 1 && BAD_PATH_END.includes(text[end - 1])) end--;
  return text[from] === "/" || end > from + 1 ? end : from;
}

function matchMentions(text) {
  const found = [];
  let index = 0;
  while ((index = text.indexOf("@", index)) >= 0) {
    if (index > 0 && isWordCharacter(charBefore(text, index))) {
      index++;
      continue;
    }
    const begin = ++index;
    while (isAlphaDigitOrUnderscore(text[index])) index++;
    const size = index - begin;
    if (size < 2 || size > 32 || isWordCharacter(charAt(text, index))) continue;
    found.push([begin - 1, index]);
  }
  return found;
}

function matchBotCommands(text) {
  const found = [];
  const blocks = (char) => isWordCharacter(char) || "/<>".includes(char || "x");
  let index = 0;
  while ((index = text.indexOf("/", index)) >= 0) {
    if (index > 0 && blocks(charBefore(text, index))) {
      index++;
      continue;
    }
    const begin = ++index;
    while (isAlphaDigitOrUnderscore(text[index])) index++;
    let end = index;
    if (end - begin < 1 || end - begin > 64) continue;
    if (text[index] === "@") {
      const username = ++index;
      while (isAlphaDigitOrUnderscore(text[index])) index++;
      if (index - username < 3 || index - username > 32) continue;
      end = index;
    }
    if (blocks(charAt(text, index))) continue;
    found.push([begin - 1, end]);
  }
  return found;
}

function matchHashtags(text) {
  const found = [];
  let index = 0;
  while ((index = text.indexOf("#", index)) >= 0) {
    if (index > 0 && isHashtagLetter(charBefore(text, index))) {
      index++;
      continue;
    }
    const begin = ++index;
    let size = 0;
    let end = -1;
    let hasLetter = false;
    while (index < text.length) {
      const char = charAt(text, index);
      if (!isHashtagLetter(char)) break;
      index += char.length;
      // At most 256 characters are part of the hashtag.
      if (size === 255) end = index;
      if (size !== 256) {
        hasLetter ||= /^\p{L}$/u.test(char);
        size++;
      }
    }
    if (end < 0) end = index;
    if (size < 1) continue;
    if (end === index && text[index] === "@") {
      let username = index + 1;
      while (username - index < 33 && isAlphaDigitOrUnderscore(text[username]))
        username++;
      if (username - index - 1 >= 3) {
        index = username;
        end = username;
      }
    }
    if (text[index] === "#" || !hasLetter) continue;
    found.push([begin - 1, end]);
  }
  return found;
}

function matchCashtags(text) {
  const found = [];
  const blocks = (char) =>
    char === "$" || (char !== "" && isHashtagLetter(char));
  let index = 0;
  while ((index = text.indexOf("$", index)) >= 0) {
    if (index > 0 && blocks(charBefore(text, index))) {
      index++;
      continue;
    }
    const begin = ++index;
    if (text.startsWith("1INCH", index)) index += 5;
    else while (/^[A-Z]$/.test(text[index] ?? "")) index++;
    let end = index;
    if (end - begin < 1 || end - begin > 8) continue;
    if (text[index] === "@") {
      let username = index + 1;
      while (isAlphaDigitOrUnderscore(text[username])) username++;
      if (username - index - 1 >= 3 && username - index - 1 <= 32) {
        end = username;
        index = username;
      }
    }
    if (blocks(charAt(text, index))) continue;
    found.push([begin - 1, end]);
  }
  return found;
}

/** tg://, ton:// and tonsite:// links (TDLib match_tg_urls). */
function matchTgUrls(text) {
  const found = [];
  let index = 0;
  while (text.length - index > 5) {
    index = text.indexOf(":", index);
    if (index < 0) break;
    let begin = -1;
    if (text.startsWith("//", index + 1)) {
      const scheme = asciiLower(text.slice(Math.max(0, index - 7), index));
      if (scheme.endsWith("tg")) begin = index - 2;
      else if (scheme.endsWith("ton")) begin = index - 3;
      // TDLib starts a tonsite:// link three characters back as well.
      else if (scheme === "tonsite") begin = index - 3;
    }
    if (begin < 0) {
      index++;
      continue;
    }
    index += 3;
    const domain = index;
    while (index - domain !== 253 && /^[A-Za-z0-9_-]$/.test(text[index] ?? ""))
      index++;
    if (index === domain) continue;
    if ("/?#".includes(text[index] || "x")) index = pathEnd(text, index);
    found.push([begin, index]);
  }
  return found;
}

/** Candidate links and emails around each dot (TDLib match_urls). */
function matchUrls(text) {
  const found = [];
  let start = 0;
  while (true) {
    const dot = text.indexOf(".", start);
    if (dot < 0 || dot + 1 === text.length) break;
    if (text[dot + 1] === " ") {
      start = dot + 2;
      continue;
    }
    const back = (from, accepts) => {
      let at = from;
      while (at > start && accepts(charBefore(text, at)))
        at -= charBefore(text, at).length;
      return at;
    };
    let domainBegin = back(dot, isDomainSymbol);
    let lastAt = -1;
    let domainEnd = dot;
    while (domainEnd < text.length) {
      const char = charAt(text, domainEnd);
      if (char === "@") lastAt = domainEnd;
      else if (!isDomainSymbol(char)) break;
      domainEnd += char.length;
    }
    if (lastAt >= 0) domainBegin = back(domainBegin, isUserDataSymbol);

    let urlEnd = domainEnd;
    if (text[urlEnd] === ":") {
      let portEnd = urlEnd + 1;
      while (isDigit(text[portEnd])) portEnd++;
      let portBegin = urlEnd + 1;
      while (portBegin !== portEnd && text[portBegin] === "0") portBegin++;
      if (
        portBegin !== portEnd &&
        portEnd - portBegin <= 5 &&
        Number(text.slice(portBegin, portEnd)) <= 65535
      )
        urlEnd = portEnd;
    }
    if ("/?#".includes(text[urlEnd] || "x")) urlEnd = pathEnd(text, urlEnd);
    while (urlEnd > dot + 1 && text[urlEnd - 1] === ".") urlEnd--;

    let bad = false;
    let urlBegin = domainBegin;
    if (urlBegin !== start && text[urlBegin - 1] === "@") {
      if (lastAt >= 0) bad = true;
      const userData = back(urlBegin - 1, isUserDataSymbol);
      if (userData === urlBegin - 1) bad = true;
      urlBegin = userData;
    }
    if (urlBegin !== start) {
      if (
        text.endsWith("://", urlBegin) &&
        (urlBegin - start >= 6 || utf8Length(text.slice(start, urlBegin)) >= 6)
      ) {
        const protocol = asciiLower(
          text.slice(back(urlBegin - 3, isProtocolSymbol), urlBegin - 3),
        );
        if (protocol.endsWith("http") && protocol !== "shttp") urlBegin -= 7;
        else if (protocol.endsWith("https")) urlBegin -= 8;
        else if (
          protocol.endsWith("ftp") &&
          protocol !== "tftp" &&
          protocol !== "sftp"
        )
          urlBegin -= 6;
        else if (protocol.endsWith("tonsite")) urlBegin -= 10;
        else bad = true;
      } else {
        const before = charBefore(text, urlBegin);
        if (isWordCharacter(before) || "/#@".includes(before)) bad = true;
      }
    }

    if (!bad) {
      if (urlEnd > dot + 1) found.push([urlBegin, urlEnd]);
      while (text[urlEnd] === ".") urlEnd++;
    } else {
      while (text[urlEnd - 1] !== ".") urlEnd--;
    }
    start = Math.max(urlEnd, dot + 1);
  }
  return found;
}

/** TDLib is_email_address. */
function isEmailAddress(text) {
  const at = text.indexOf("@");
  if (at < 0 || at === text.length - 1) return false;
  const userParts = text.slice(0, at).split(/[.+]/);
  if (
    userParts.length >= 12 ||
    userParts.slice(0, -1).some((part) => part.length >= 27) ||
    userParts.at(-1).length === 0 ||
    userParts.at(-1).length >= 36 ||
    !userParts.every((part) => /^[A-Za-z0-9_-]*$/.test(part))
  )
    return false;
  const domainParts = text.slice(at + 1).split(".");
  const tld = domainParts.pop();
  return (
    domainParts.length >= 1 &&
    domainParts.length <= 6 &&
    /^[A-Za-z]{2,8}$/.test(tld) &&
    domainParts.every(
      (part) =>
        part.length < 31 &&
        /^[A-Za-z0-9]([A-Za-z0-9_-]*[A-Za-z0-9])?$/.test(part),
    )
  );
}

/**
 * How much of a candidate is a link, or 0 when it is none (TDLib fix_url):
 * unbalanced brackets and trailing punctuation end it, and a link without a
 * protocol needs a top-level domain from TDLib's list of common ones.
 */
function urlLength(url) {
  let rest = url;
  const hasProtocol = /^(?:https?|ftp|tonsite):\/\//.test(
    asciiLower(url.slice(0, 10)),
  );
  if (hasProtocol) rest = rest.slice(rest.indexOf(":") + 3);
  const domainEnd = rest.search(/[/?#]|$/);
  let domain = rest.slice(0, domainEnd);
  const path = rest.slice(domainEnd);
  domain = domain.slice(domain.indexOf("@") + 1);
  if (domain.includes(":")) domain = domain.slice(0, domain.lastIndexOf(":"));
  if (asciiLower(domain) === "teiegram.org") return 0;

  const balance = { "(": 0, "[": 0, "{": 0 };
  const closes = { ")": "(", "]": "[", "}": "{" };
  let pathLength = 0;
  for (; pathLength < path.length; pathLength++) {
    const char = path[pathLength];
    if (char in balance) balance[char]++;
    if (char in closes && --balance[closes[char]] < 0) break;
  }
  while (pathLength > 0 && BAD_PATH_END.includes(path[pathLength - 1]))
    pathLength--;
  const length = url.length - (path.length - pathLength);

  const parts = domain.split(".");
  if (
    parts.some(
      (part) => part === "" || utf8Length(part) >= 64 || part.endsWith("-"),
    ) ||
    parts.length === 1
  )
    return 0;
  const isOctet = (part) =>
    /^(?:0|[1-9][0-9]{0,2})$/.test(part) && Number(part) <= 255;
  if (parts.length === 4 && parts.every(isOctet)) return length;
  if (/^[0-9.]*$/.test(domain)) return 0;
  const tld = parts.at(-1);
  if ([...tld].length <= 1) return 0;
  if (tld.startsWith("xn--")) {
    if (tld.length <= 5 || !/^[A-Za-z0-9]+$/.test(tld.slice(4))) return 0;
  } else if (/[_-]/.test(tld) || (!hasProtocol && !isCommonTld(tld))) {
    return 0;
  }
  return parts.at(-2).includes("_") ? 0 : length;
}

function isCommonTld(tld) {
  if (/^[a-z]*$/.test(tld)) return COMMON_TLDS.has(tld);
  const lower = tld.toLowerCase();
  // Only the first letter capitalized does not count.
  if (
    lower !== tld &&
    [...lower].slice(1).join("") === [...tld].slice(1).join("")
  )
    return false;
  return COMMON_TLDS.has(lower);
}

/**
 * The entities Telegram finds in text by itself, with UTF-16 offsets:
 * mentions, bot commands, hashtags, cashtags, links and emails.
 */
export function findEntities(text) {
  const found = [];
  const add = (type, begin, end) =>
    found.push({ type, offset: begin, length: end - begin });
  for (const [begin, end] of matchMentions(text)) {
    const username = text.slice(begin + 1, end);
    if (username.length >= 4 || SHORT_USERNAMES.has(username.toLowerCase()))
      add("mention", begin, end);
  }
  for (const [begin, end] of matchBotCommands(text))
    add("bot_command", begin, end);
  for (const [begin, end] of matchHashtags(text)) add("hashtag", begin, end);
  for (const [begin, end] of matchCashtags(text)) add("cashtag", begin, end);
  for (const [begin, end] of matchTgUrls(text)) add("url", begin, end);
  for (const [begin, end] of matchUrls(text)) {
    const url = text.slice(begin, end);
    if (isEmailAddress(url)) add("email", begin, end);
    else if (url.startsWith("mailto:") && isEmailAddress(url.slice(7)))
      add("email", begin + 7, end);
    else {
      const length = urlLength(url);
      if (length > 0) add("url", begin, begin + length);
    }
  }
  // TDLib fix_entity_offsets: by position, longer first; overlaps are dropped.
  let reached = 0;
  return found
    .sort(
      (left, right) => left.offset - right.offset || right.length - left.length,
    )
    .filter((entity) => {
      if (entity.offset < reached) return false;
      reached = endOf(entity);
      return true;
    });
}

// TDLib find_mentions: a username shorter than 4 characters is a mention
// only when it is one of these.
const SHORT_USERNAMES = new Set(["gif", "nft", "pic", "ufc", "vid"]);

// TDLib is_common_tld: the top-level domains a link without a protocol may have.
const COMMON_TLDS = new Set(
  `
  aaa aarp abb abbott abbvie abc able abogado abudhabi ac academy accenture
  accountant accountants aco actor ad ads adult ae aeg aero aetna af afl
  africa ag agakhan agency ai aig airbus airforce airtel akdn al alibaba
  alipay allfinanz allstate ally alsace alstom am amazon americanexpress
  americanfamily amex amfam amica amsterdam analytics android anquan anz ao
  aol apartments app apple aq aquarelle ar arab aramco archi army arpa art
  arte as asda asia associates at athleta attorney au auction audi audible
  audio auspost author auto autos aw aws ax axa az azure ba baby baidu banamex
  band bank bar barcelona barclaycard barclays barefoot bargains baseball
  basketball bauhaus bayern bb bbc bbt bbva bcg bcn bd be beats beauty beer
  bentley berlin best bestbuy bet bf bg bh bharti bi bible bid bike bing bingo
  bio biz bj black blackfriday blockbuster blog bloomberg blue bm bms bmw bn
  bnpparibas bo boats boehringer bofa bom bond boo book booking bosch bostik
  boston bot boutique box br bradesco bridgestone broadway broker brother
  brussels bs bt build builders business buy buzz bv bw by bz bzh ca cab cafe
  cal call calvinklein cam camera camp canon capetown capital capitalone car
  caravan cards care career careers cars casa case cash casino cat catering
  catholic cba cbn cbre cc cd center ceo cern cf cfa cfd cg ch chanel channel
  charity chase chat cheap chintai christmas chrome church ci cipriani circle
  cisco citadel citi citic city ck cl claims cleaning click clinic clinique
  clothing cloud club clubmed cm cn co coach codes coffee college cologne com
  commbank community company compare computer comsec condos construction
  consulting contact contractors cooking cool coop corsica country coupon
  coupons courses cpa cr credit creditcard creditunion cricket crown crs
  cruise cruises cu cuisinella cv cw cx cy cymru cyou cz dabur dad dance data
  date dating datsun day dclk dds de deal dealer deals degree delivery dell
  deloitte delta democrat dental dentist desi design dev dhl diamonds diet
  digital direct directory discount discover dish diy dj dk dm dnp do docs
  doctor dog domains dot download drive dtv dubai dunlop dupont durban dvag
  dvr dz earth eat ec eco edeka edu education ee eg email emerck energy
  engineer engineering enterprises epson equipment er ericsson erni es esq
  estate et eu eurovision eus events exchange expert exposed express
  extraspace fage fail fairwinds faith family fan fans farm farmers fashion
  fast fedex feedback ferrari ferrero fi fidelity fido film final finance
  financial fire firestone firmdale fish fishing fit fitness fj fk flickr
  flights flir florist flowers fly fm fo foo food football ford forex forsale
  forum foundation fox fr free fresenius frl frogans frontier ftr fujitsu fun
  fund furniture futbol fyi ga gal gallery gallo gallup game games gap garden
  gay gb gbiz gd gdn ge gea gent genting george gf gg ggee gh gi gift gifts
  gives giving gl glass gle global globo gm gmail gmbh gmo gmx gn godaddy gold
  goldpoint golf goo goodyear goog google gop got gov gp gq gr grainger
  graphics gratis green gripe grocery group gs gt gu gucci guge guide guitars
  guru gw gy hair hamburg hangout haus hbo hdfc hdfcbank health healthcare
  help helsinki here hermes hiphop hisamitsu hitachi hiv hk hkt hm hn hockey
  holdings holiday homedepot homegoods homes homesense honda horse hospital
  host hosting hot hotels hotmail house how hr hsbc ht hu hughes hyatt hyundai
  ibm icbc ice icu id ie ieee ifm ikano il im imamat imdb immo immobilien in
  inc industries infiniti info ing ink institute insurance insure int
  international intuit investments io ipiranga iq ir irish is ismaili ist
  istanbul it itau itv jaguar java jcb je jeep jetzt jewelry jio jll jm jmp
  jnj jo jobs joburg jot joy jp jpmorgan jprs juegos juniper kaufen kddi ke
  kerryhotels kerrylogistics kerryproperties kfh kg kh ki kia kids kim kindle
  kitchen kiwi km kn koeln komatsu kosher kp kpmg kpn kr krd kred kuokgroup kw
  ky kyoto kz la lacaixa lamborghini lamer lancaster land landrover lanxess
  lasalle lat latino latrobe law lawyer lb lc lds lease leclerc lefrak legal
  lego lexus lgbt li lidl life lifeinsurance lifestyle lighting like lilly
  limited limo lincoln link lipsy live living lk llc llp loan loans locker
  locus lol london lotte lotto love lpl lplfinancial lr ls lt ltd ltda lu
  lundbeck luxe luxury lv ly ma madrid maif maison makeup man management mango
  map market marketing markets marriott marshalls mattel mba mc mckinsey md me
  med media meet melbourne meme memorial men menu merckmsd mg mh miami
  microsoft mil mini mint mit mitsubishi mk ml mlb mls mm mma mn mo mobi
  mobile moda moe moi mom monash money monster mormon mortgage moscow moto
  motorcycles mov movie mp mq mr ms msd mt mtn mtr mu museum music mv mw mx my
  mz na nab nagoya name navy nba nc ne nec net netbank netflix network neustar
  new news next nextdirect nexus nf nfl ng ngo nhk ni nico nike nikon ninja
  nissan nissay nl no nokia norton now nowruz nowtv np nr nra nrw ntt nu nyc
  nz obi observer office okinawa olayan olayangroup ollo om omega one ong
  onion onl online ooo open oracle orange org organic origins osaka otsuka ott
  ovh pa page panasonic paris pars partners parts party pay pccw pe pet pf
  pfizer pg ph pharmacy phd philips phone photo photography photos physio pics
  pictet pictures pid pin ping pink pioneer pizza pk pl place play playstation
  plumbing plus pm pn pnc pohl poker politie porn post pr pramerica praxi
  press prime pro prod productions prof progressive promo properties property
  protection pru prudential ps pt pub pw pwc py qa qpon quebec quest racing
  radio re read realestate realtor realty recipes red redstone redumbrella
  rehab reise reisen reit reliance ren rent rentals repair report republican
  rest restaurant review reviews rexroth rich richardli ricoh ril rio rip ro
  rocks rodeo rogers room rs rsvp ru rugby ruhr run rw rwe ryukyu sa saarland
  safe safety sakura sale salon samsclub samsung sandvik sandvikcoromant
  sanofi sap sarl sas save saxo sb sbi sbs sc scb schaeffler schmidt
  scholarships school schule schwarz science scot sd se search seat secure
  security seek select sener services seven sew sex sexy sfr sg sh shangrila
  sharp shell shia shiksha shoes shop shopping shouji show si silk sina
  singles site sj sk ski skin sky skype sl sling sm smart smile sn sncf so
  soccer social softbank software sohu solar solutions song sony soy spa space
  sport spot sr srl ss st stada staples star statebank statefarm stc stcgroup
  stockholm storage store stream studio study style su sucks supplies supply
  support surf surgery suzuki sv swatch swiss sx sy sydney systems sz tab
  taipei talk taobao target tatamotors tatar tattoo tax taxi tc tci td tdk
  team tech technology tel temasek tennis teva tf tg th thd theater theatre
  tiaa tickets tienda tips tires tirol tj tjmaxx tjx tk tkmaxx tl tm tmall tn
  to today tokyo ton tools top toray toshiba total tours town toyota toys tr
  trade trading training travel travelers travelersinsurance trust trv tt tube
  tui tunes tushu tv tvs tw tz ua ubank ubs ug uk unicom university uno uol
  ups us uy uz va vacations vana vanguard vc ve vegas ventures verisign
  vermögensberater vermögensberatung versicherung vet vg vi viajes video vig
  viking villas vin vip virgin visa vision viva vivo vlaanderen vn vodka volvo
  vote voting voto voyage vu wales walmart walter wang wanggou watch watches
  weather weatherchannel webcam weber website wed wedding weibo weir wf
  whoswho wien wiki williamhill win windows wine winners wme wolterskluwer
  woodside work works world wow ws wtc wtf xbox xerox xihuan xin ελ ευ бг бел
  дети ею католик ком мкд мон москва онлайн орг рус рф сайт срб укр қаз հայ
  ישראל קום ابوظبي ارامكو الاردن البحرين الجزائر السعودية العليان المغرب
  امارات ایران بارت بازار بيتك بھارت تونس سودان سورية شبكة عراق عرب عمان
  فلسطين قطر كاثوليك كوم مصر مليسيا موريتانيا موقع همراه پاکستان ڀارت कॉम नेट
  भारत भारतम् भारोत संगठन বাংলা ভারত ভাৰত ਭਾਰਤ ભારત ଭାରତ இந்தியா இலங்கை
  சிங்கப்பூர் భారత్ ಭಾರತ ഭാരതം ලංකා คอม ไทย ລາວ გე みんな アマゾン クラウド グーグル コム ストア
  セール ファッション ポイント 世界 中信 中国 中國 中文网 亚马逊 企业 佛山 信息 健康 八卦 公司 公益 台湾 台灣 商城 商店 商标 嘉里
  嘉里大酒店 在线 大拿 天主教 娱乐 家電 广东 微博 慈善 我爱你 手机 招聘 政务 政府 新加坡 新闻 时尚 書籍 机构 淡马锡 游戏 澳門 点看
  移动 组织机构 网址 网店 网站 网络 联通 谷歌 购物 通販 集团 電訊盈科 飞利浦 食品 餐厅 香格里拉 香港 닷넷 닷컴 삼성 한국 xxx
  xyz yachts yahoo yamaxun yandex ye yodobashi yoga yokohama you youtube yt
  yun za zappos zara zero zip zm zone zuerich zw
`
    .trim()
    .split(/\s+/),
);
