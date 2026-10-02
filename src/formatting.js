/**
 * parse_mode for bot messages: turns HTML, MarkdownV2 or legacy Markdown into
 * plain text plus MessageEntity objects, with UTF-16 offsets as Telegram
 * reports them. Markup Telegram would reject is rejected with its error text.
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
      (left, right) => left.offset - right.offset || right.length - left.length,
    );
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
    const top = open.findLastIndex((entry) => entry.type === type);
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
      if (top < 0 || input[index + 1] !== "(") {
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
 * Telegram finds by itself where no formatting entity covers them.
 */
export function formatText(text, { parseMode, entities, detect }) {
  let parsed;
  if (Array.isArray(entities)) {
    parsed = {
      text,
      entities: sortEntities(entities.map((entity) => ({ ...entity }))),
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
  const overlaps = (candidate) =>
    parsed.entities.some(
      (entity) =>
        candidate.offset < entity.offset + entity.length &&
        entity.offset < candidate.offset + candidate.length,
    );
  const detected = detect(parsed.text).filter((entity) => !overlaps(entity));
  return {
    text: parsed.text,
    entities: sortEntities([...parsed.entities, ...detected]),
  };
}
