/**
 * parse_mode for bot messages: turns HTML, MarkdownV2 or legacy Markdown into
 * plain text plus MessageEntity objects, with UTF-16 offsets as Telegram
 * reports them. Supported contracts are documented in README.md.
 */

export class FormattingError extends Error {}

const utf8Length = (text) => Buffer.byteLength(text, "utf8");

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
// Styles merge per type and split at continuous/blockquote boundaries; code
// and pre exclude styles. Overlapping continuous entities and quotes are pruned.
const STYLES = new Set([
  "bold",
  "italic",
  "underline",
  "strikethrough",
  "spoiler",
]);
const QUOTES = new Set(["blockquote", "expandable_blockquote"]);
const CODE = new Set(["code", "pre"]);
function entityPriority(type) {
  return (
    {
      blockquote: 0,
      expandable_blockquote: 0,
      pre: 11,
      code: 20,
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
      if (open.entity)
        entities.push({ ...open.entity, offset: open.offset, length });
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
        const id = /^tg:\/\/emoji\?id=(\d+)$/.exec(url)?.[1];
        if (!id) fail(`Custom emoji entity must contain a tg://emoji URL`);
        entities.push({
          type: "custom_emoji",
          offset: entry.offset,
          length,
          custom_emoji_id: id,
        });
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

/**
 * The text and entities a bot message ends up with. Explicit entities win over
 * parse_mode, as on Telegram; `detect` adds the links, mentions and commands
 * Telegram finds by itself outside code, pre and explicit links.
 */
export function formatText(text, { parseMode, entities, detect }) {
  let parsed;
  if (Array.isArray(entities)) {
    parsed = {
      text,
      entities: entities.map((entity) => ({ ...entity })),
    };
  } else {
    const mode = typeof parseMode === "string" ? parseMode.toLowerCase() : "";
    if (mode === "html") parsed = parseHtml(text);
    else if (mode === "markdownv2") parsed = parseMarkdownV2(text);
    else if (mode === "markdown") parsed = parseMarkdown(text);
    else if (!mode) parsed = { text, entities: [] };
    else
      throw new FormattingError(
        `Bad Request: unsupported parse_mode "${parseMode}"`,
      );
  }
  validateRanges(parsed.text, parsed.entities);
  parsed.entities = normalizeEntities(parsed.entities);
  // Automatically found entities can coexist with styles, but not continuous
  // entities such as code, pre or an explicit text link.
  const detected = detect(parsed.text).filter((candidate) =>
    parsed.entities.every(
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
    text: parsed.text,
    entities: normalizeEntities([...parsed.entities, ...detected]),
  };
}
