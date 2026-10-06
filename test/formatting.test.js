// parse_mode, explicit entities, replies and uploaded file names on bot sends,
// as the Bot API documents them.
import { afterEach, describe, expect, it } from "vitest";

import { startTestServer } from "../src/index.js";
import {
  parseHtml,
  parseMarkdown,
  parseMarkdownV2,
} from "../src/formatting.js";

const TOKEN = "123456:TEST";
const GROUP = -1001000000001;
const OWNER = 5000000001;

const cleanups = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()();
});

async function setup() {
  const server = await startTestServer({
    botToken: TOKEN,
    chats: [{ id: GROUP, title: "Test Group", ownerId: OWNER }],
  });
  cleanups.push(() => server.stop());
  async function api(method, params = {}) {
    const response = await fetch(`${server.origin}/bot${TOKEN}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    });
    return { status: response.status, ...(await response.json()) };
  }
  return { server, api };
}

describe("HTML", () => {
  it("turns tags into entities with UTF-16 offsets", () => {
    expect(
      parseHtml(
        '<b>bold <i>both</i></b> &lt;x&gt; 😀<a href="https://e.com">link</a> <code>c</code>',
      ),
    ).toEqual({
      text: "bold both <x> 😀link c",
      entities: [
        { type: "bold", offset: 0, length: 9 },
        { type: "italic", offset: 5, length: 4 },
        { type: "text_link", offset: 16, length: 4, url: "https://e.com" },
        { type: "code", offset: 21, length: 1 },
      ],
    });
  });

  it("reads pre languages, spoilers, mentions, custom emoji and blockquotes", () => {
    expect(
      parseHtml(
        '<pre><code class="language-js">x()</code></pre><span class="tg-spoiler">s</span>' +
          '<a href="tg://user?id=42">u</a><tg-emoji emoji-id="5368324170671202286">👍</tg-emoji>' +
          "<blockquote expandable>q</blockquote>",
      ).entities,
    ).toEqual([
      { type: "pre", offset: 0, length: 3, language: "js" },
      { type: "spoiler", offset: 3, length: 1 },
      { type: "text_mention", offset: 4, length: 1, user: { id: 42 } },
      {
        type: "custom_emoji",
        offset: 5,
        length: 2,
        custom_emoji_id: "5368324170671202286",
      },
      { type: "expandable_blockquote", offset: 7, length: 1 },
    ]);
  });

  it("rejects markup Telegram rejects", () => {
    expect(() => parseHtml("<b>open")).toThrow(
      `can't parse entities: Can't find end tag corresponding to start tag "b"`,
    );
    expect(() => parseHtml("<b>x</i>")).toThrow("Unmatched end tag");
    expect(() => parseHtml("<div>x</div>")).toThrow(
      'Unsupported start tag "div" at byte offset 0',
    );
  });
});

describe("MarkdownV2", () => {
  it("parses nested styles, links, code and escapes", () => {
    expect(
      parseMarkdownV2(
        "*bold _italic_* __u__ ~s~ ||sp|| [l](https://e.com/a\\)b) `c\\`d` 1\\.5",
      ),
    ).toEqual({
      text: "bold italic u s sp l c`d 1.5",
      entities: [
        { type: "bold", offset: 0, length: 11 },
        { type: "italic", offset: 5, length: 6 },
        { type: "underline", offset: 12, length: 1 },
        { type: "strikethrough", offset: 14, length: 1 },
        { type: "spoiler", offset: 16, length: 2 },
        { type: "text_link", offset: 19, length: 1, url: "https://e.com/a)b" },
        { type: "code", offset: 21, length: 3 },
      ],
    });
  });

  it("parses pre blocks and blockquotes", () => {
    expect(
      parseMarkdownV2("```py\nprint(1)\n```\n>quoted\n>more\nafter"),
    ).toEqual({
      text: "print(1)\n\nquoted\nmore\nafter",
      entities: [
        { type: "pre", offset: 0, length: 9, language: "py" },
        { type: "blockquote", offset: 10, length: 11 },
      ],
    });
  });

  it("rejects unescaped reserved characters and unclosed entities", () => {
    expect(() => parseMarkdownV2("v1.5")).toThrow(
      "Character '.' is reserved and must be escaped with the preceding '\\'",
    );
    expect(() => parseMarkdownV2("*open")).toThrow(
      "Can't find end of Bold entity at byte offset 0",
    );
  });
});

describe("Markdown (legacy)", () => {
  it("parses bold, italic, code, pre and links", () => {
    expect(parseMarkdown("*b* _i_ `c` [l](https://e.com) a\\_b")).toEqual({
      text: "b i c l a_b",
      entities: [
        { type: "bold", offset: 0, length: 1 },
        { type: "italic", offset: 2, length: 1 },
        { type: "code", offset: 4, length: 1 },
        { type: "text_link", offset: 6, length: 1, url: "https://e.com" },
      ],
    });
    expect(() => parseMarkdown("*open")).toThrow(
      "Can't find end of the entity starting at byte offset 0",
    );
  });
});

describe("bot sends", () => {
  it("applies parse_mode to text and captions, and keeps detected links", async () => {
    const { api } = await setup();
    const sent = await api("sendMessage", {
      chat_id: GROUP,
      text: "<b>Hi</b> see https://e.com",
      parse_mode: "HTML",
    });
    expect(sent.result).toMatchObject({
      text: "Hi see https://e.com",
      entities: [
        { type: "bold", offset: 0, length: 2 },
        { type: "url", offset: 7, length: 13 },
      ],
    });

    const edited = await api("editMessageText", {
      chat_id: GROUP,
      message_id: sent.result.message_id,
      text: "*now* bold",
      parse_mode: "MarkdownV2",
    });
    expect(edited.result).toMatchObject({
      text: "now bold",
      entities: [{ type: "bold", offset: 0, length: 3 }],
    });

    // A parse_mode wins: Telegram ignores entities sent with it.
    const both = await api("sendMessage", {
      chat_id: GROUP,
      text: "<b>raw</b>",
      parse_mode: "HTML",
      entities: [{ type: "italic", offset: 0, length: 3 }],
    });
    expect(both.result).toMatchObject({
      text: "raw",
      entities: [{ type: "bold", offset: 0, length: 3 }],
    });

    expect(
      await api("sendMessage", {
        chat_id: GROUP,
        text: "1.5",
        parse_mode: "MarkdownV2",
      }),
    ).toMatchObject({
      status: 400,
      description:
        "Bad Request: can't parse entities: Character '.' is reserved and must be escaped with the preceding '\\'",
    });
    expect(
      await api("sendMessage", {
        chat_id: GROUP,
        text: "<b></b>",
        parse_mode: "HTML",
      }),
    ).toMatchObject({
      status: 400,
      description: "Bad Request: text must be non-empty",
    });
    expect(
      await api("sendMessage", { chat_id: GROUP, text: "" }),
    ).toMatchObject({
      status: 400,
      description: "Bad Request: message text is empty",
    });
  });

  it("takes parse_mode none as no parsing, and refuses an unknown mode without naming it", async () => {
    const { api } = await setup();
    const none = await api("sendMessage", {
      chat_id: GROUP,
      text: "<b>raw</b>",
      parse_mode: "none",
    });
    expect(none.result.text).toBe("<b>raw</b>");
    expect(none.result.entities).toBeUndefined();
    // Explicit entities still apply with "none", in any letter case.
    const withEntities = await api("sendMessage", {
      chat_id: GROUP,
      text: "<b>raw</b>",
      parse_mode: "None",
      entities: [{ type: "italic", offset: 0, length: 3 }],
    });
    expect(withEntities.result).toMatchObject({
      text: "<b>raw</b>",
      entities: [{ type: "italic", offset: 0, length: 3 }],
    });
    expect(
      await api("sendMessage", {
        chat_id: GROUP,
        text: "x",
        parse_mode: "Foo",
      }),
    ).toMatchObject({
      status: 400,
      description: "Bad Request: unsupported parse_mode",
    });
  });

  it("refuses text over 4096 and captions over 1024 characters after parsing", async () => {
    const { server, api } = await setup();
    // Telegram counts characters, so an emoji (two UTF-16 units) counts once.
    expect(
      (await api("sendMessage", { chat_id: GROUP, text: "😀".repeat(4096) }))
        .ok,
    ).toBe(true);
    expect(
      (
        await api("sendMessage", {
          chat_id: GROUP,
          text: `<b>${"x".repeat(4096)}</b>`,
          parse_mode: "HTML",
        })
      ).ok,
    ).toBe(true);
    const photo = "https://example.com/a.jpg";
    expect(
      (
        await api("sendPhoto", {
          chat_id: GROUP,
          photo,
          caption: "y".repeat(1024),
        })
      ).ok,
    ).toBe(true);
    const before = await server.getMessages(GROUP);
    for (const text of ["x".repeat(4097), `<b>${"x".repeat(4097)}</b>`]) {
      expect(
        await api("sendMessage", { chat_id: GROUP, text, parse_mode: "HTML" }),
      ).toMatchObject({
        status: 400,
        description: "Bad Request: message is too long",
      });
    }
    // The raw text is limited too, before any parsing.
    expect(
      await api("sendMessage", { chat_id: GROUP, text: "x".repeat(32769) }),
    ).toMatchObject({
      status: 400,
      description: "Bad Request: text is too long",
    });
    expect(
      await api("sendPhoto", {
        chat_id: GROUP,
        photo,
        caption: "y".repeat(1025),
      }),
    ).toMatchObject({
      status: 400,
      description: "Bad Request: message caption is too long",
    });
    expect(await server.getMessages(GROUP)).toEqual(before);
  });

  it("answers over-long edits with Telegram's errors", async () => {
    const { api } = await setup();
    const text = await api("sendMessage", { chat_id: GROUP, text: "short" });
    expect(
      await api("editMessageText", {
        chat_id: GROUP,
        message_id: text.result.message_id,
        text: "x".repeat(4097),
      }),
    ).toMatchObject({
      status: 400,
      description: "Bad Request: MESSAGE_TOO_LONG",
    });
    const photo = await api("sendPhoto", {
      chat_id: GROUP,
      photo: "https://example.com/a.jpg",
      caption: "short",
    });
    expect(
      await api("editMessageCaption", {
        chat_id: GROUP,
        message_id: photo.result.message_id,
        caption: "y".repeat(1025),
      }),
    ).toMatchObject({
      status: 400,
      description: "Bad Request: MEDIA_CAPTION_TOO_LONG",
    });
    expect(
      await api("editMessageMedia", {
        chat_id: GROUP,
        message_id: photo.result.message_id,
        media: {
          type: "photo",
          media: photo.result.photo[0].file_id,
          caption: "y".repeat(1025),
        },
      }),
    ).toMatchObject({
      status: 400,
      description: "Bad Request: message caption is too long",
    });
  });

  it("trims spaces and newlines around text and captions, moving entities with the text", async () => {
    const { api } = await setup();
    const send = async (params) =>
      (await api("sendMessage", { chat_id: GROUP, ...params })).result;
    expect((await send({ text: "  hi  \n" })).text).toBe("hi");
    expect(
      await send({ text: "\n  <b>hi</b> there  ", parse_mode: "HTML" }),
    ).toMatchObject({
      text: "hi there",
      entities: [{ type: "bold", offset: 0, length: 2 }],
    });
    // Nothing is cut before the first entity starts, and an entity ends with
    // the text.
    expect(
      await send({
        text: "  hi  ",
        entities: [{ type: "bold", offset: 0, length: 6 }],
      }),
    ).toMatchObject({
      text: "  hi",
      entities: [{ type: "bold", offset: 0, length: 4 }],
    });
    // Control characters turn into spaces and \r is dropped first.
    expect((await send({ text: "\ta\r\nb\tc\t" })).text).toBe("a\nb c");
    expect(
      await api("sendMessage", { chat_id: GROUP, text: " \n " }),
    ).toMatchObject({
      status: 400,
      description: "Bad Request: text must be non-empty",
    });

    const photo = "https://example.com/a.jpg";
    const captioned = await api("sendPhoto", {
      chat_id: GROUP,
      photo,
      caption: " <i>cap</i> \n",
      parse_mode: "HTML",
    });
    expect(captioned.result).toMatchObject({
      caption: "cap",
      caption_entities: [{ type: "italic", offset: 0, length: 3 }],
    });
    const blank = await api("sendPhoto", {
      chat_id: GROUP,
      photo,
      caption: "  ",
    });
    expect(blank.result.caption).toBeUndefined();
  });

  it("refuses text of characters that show nothing, unless a link preview URL goes with it", async () => {
    const { api } = await setup();
    const empty = {
      status: 400,
      description: "Bad Request: text must be non-empty",
    };
    // Spaces of every width, zero-width and direction marks, the Braille
    // blank, the byte order mark and tag characters show nothing.
    for (const text of [
      "\u200b",
      "\u00a0",
      "\u3000",
      "\u2800",
      "\ufeff",
      "\u{e0020}",
      " \u200b\n",
      "\u200f\u200f  \u200e\u200e\u200e\u200c \u200f\u200e \u200f",
    ]) {
      expect(await api("sendMessage", { chat_id: GROUP, text })).toMatchObject(
        empty,
      );
    }
    // A Hangul filler is not one of them.
    expect(
      (await api("sendMessage", { chat_id: GROUP, text: "\u3164" })).result
        .text,
    ).toBe("\u3164");
    const sent = await api("sendMessage", { chat_id: GROUP, text: "x" });
    expect(
      await api("editMessageText", {
        chat_id: GROUP,
        message_id: sent.result.message_id,
        text: "\u200b",
      }),
    ).toMatchObject(empty);
    // A bot's caption keeps them.
    const photo = await api("sendPhoto", {
      chat_id: GROUP,
      photo: "https://example.com/a.jpg",
      caption: "\u200b",
    });
    expect(photo.result.caption).toBe("\u200b");
    // A link preview may go without text, unless the preview is disabled.
    const url = "https://example.com/a";
    const preview = await api("sendMessage", {
      chat_id: GROUP,
      text: "   ",
      link_preview_options: { url },
    });
    expect(preview.result).toMatchObject({
      text: "",
      link_preview_options: { url },
    });
    expect(
      await api("sendMessage", {
        chat_id: GROUP,
        text: "   ",
        link_preview_options: { url, is_disabled: true },
      }),
    ).toMatchObject(empty);
  });

  it("drops separators, overrides and three combining marks, and turns runs of direction marks into joiners", async () => {
    const { api } = await setup();
    const cleaned = await api("sendMessage", {
      chat_id: GROUP,
      text: "a\u2028b\u202ec\u030ad\u0333e\u033f f",
      entities: [{ type: "bold", offset: 11, length: 1 }],
    });
    expect(cleaned.result).toMatchObject({
      text: "abcde f",
      entities: [{ type: "bold", offset: 6, length: 1 }],
    });
    // All but the last mark of a run become zero-width non-joiners.
    const marks = await api("sendMessage", {
      chat_id: GROUP,
      text: "\u200f\u200f  \u200e\u200e\u200e\u200c \u200f\u200e \u200f a",
    });
    expect(marks.result.text).toBe(
      "\u200c\u200f  \u200c\u200c\u200e\u200c \u200c\u200e \u200f a",
    );
  });

  it("checks a text's emptiness and length only after the chat, the reply and the message", async () => {
    const { api } = await setup();
    const unknown = -1009999999999;
    const photo = "https://example.com/a.jpg";
    const long = "y".repeat(2000);
    const refused = (description) => ({
      status: 400,
      description: `Bad Request: ${description}`,
    });
    for (const text of ["x".repeat(5000), "\u200b"]) {
      expect(
        await api("sendMessage", { chat_id: unknown, text }),
      ).toMatchObject(refused("chat not found"));
      expect(
        await api("sendMessage", {
          chat_id: GROUP,
          text,
          reply_parameters: { message_id: 999999 },
        }),
      ).toMatchObject(refused("message to be replied not found"));
    }
    // An empty text is refused as the request is read.
    expect(
      await api("sendMessage", { chat_id: unknown, text: "" }),
    ).toMatchObject(refused("message text is empty"));
    expect(
      await api("sendPhoto", { chat_id: unknown, photo, caption: long }),
    ).toMatchObject(refused("chat not found"));
    expect(
      await api("sendMediaGroup", {
        chat_id: GROUP,
        reply_parameters: { message_id: 999999 },
        media: [
          { type: "photo", media: photo, caption: long },
          { type: "photo", media: photo },
        ],
      }),
    ).toMatchObject(refused("message to be replied not found"));
    const sent = await api("sendPhoto", { chat_id: GROUP, photo });
    expect(
      await api("copyMessage", {
        chat_id: unknown,
        from_chat_id: GROUP,
        message_id: sent.result.message_id,
        caption: long,
      }),
    ).toMatchObject(refused("chat not found"));
    expect(
      await api("editMessageText", {
        chat_id: GROUP,
        message_id: 999999,
        text: "x".repeat(5000),
      }),
    ).toMatchObject(refused("message to edit not found"));
    expect(
      await api("editMessageCaption", {
        chat_id: GROUP,
        message_id: 999999,
        caption: long,
      }),
    ).toMatchObject(refused("message to edit not found"));
    for (const text of ["x".repeat(5000), "  "]) {
      expect(
        await api("editMessageText", {
          chat_id: GROUP,
          message_id: sent.result.message_id,
          text,
        }),
      ).toMatchObject(refused("there is no text in the message to edit"));
    }
  });

  it("turns <tg-time> and tg://time links into date_time entities", async () => {
    const { api } = await setup();
    const send = (text, parse_mode) =>
      api("sendMessage", { chat_id: GROUP, text, parse_mode });
    expect(
      (
        await send(
          '<tg-time unix="1647531900" format="wDT">22:45 tomorrow</tg-time>',
          "HTML",
        )
      ).result.entities,
    ).toEqual([
      {
        type: "date_time",
        offset: 0,
        length: 14,
        unix_time: 1647531900,
        date_time_format: "wDT",
      },
    ]);
    // The format comes back in Telegram's order; without one it is empty.
    expect(
      (
        await send(
          "![22:45](tg://time?unix=1647531900&format=Tw) ![now](tg://time?unix=1647531900)",
          "MarkdownV2",
        )
      ).result.entities,
    ).toEqual([
      {
        type: "date_time",
        offset: 0,
        length: 5,
        unix_time: 1647531900,
        date_time_format: "wT",
      },
      {
        type: "date_time",
        offset: 6,
        length: 3,
        unix_time: 1647531900,
        date_time_format: "",
      },
    ]);
    // A format that names both precisions gets the shorter one.
    expect(
      (
        await send(
          '<tg-time unix="1647531900" format="tTdD">22:45</tg-time>',
          "HTML",
        )
      ).result.entities[0].date_time_format,
    ).toBe("dt");
    expect(
      await send(
        '<tg-time unix="1647531900" format="x">22:45</tg-time>',
        "HTML",
      ),
    ).toMatchObject({
      status: 400,
      description:
        "Bad Request: can't parse entities: Invalid date format used",
    });
    expect(
      await send("![22:45](tg://time?unix=0)", "MarkdownV2"),
    ).toMatchObject({
      status: 400,
      description:
        "Bad Request: can't parse entities: Invalid tg://emoji or tg://time URL specified",
    });
  });

  it("reads explicit entities as the Bot API does", async () => {
    const { api } = await setup();
    const at = { offset: 0, length: 5 };
    const send = (entity) =>
      api("sendMessage", {
        chat_id: GROUP,
        text: "hello",
        entities: [{ ...at, ...entity }],
      });
    // Telegram finds these by itself and ignores them when given.
    for (const type of [
      "mention",
      "hashtag",
      "cashtag",
      "bot_command",
      "url",
      "email",
      "phone_number",
      "bank_card_number",
    ]) {
      expect((await send({ type })).result.entities).toBeUndefined();
    }
    const date = (fields) =>
      send({ type: "date_time", unix_time: 1647531900, ...fields });
    // The format comes back in Telegram's order, the last of t and T
    // winning; without one it is empty.
    expect((await date({ date_time_format: "Tw" })).result.entities).toEqual([
      {
        type: "date_time",
        ...at,
        unix_time: 1647531900,
        date_time_format: "wT",
      },
    ]);
    expect(
      (await date({ date_time_format: "tT" })).result.entities[0]
        .date_time_format,
    ).toBe("T");
    expect((await date({})).result.entities[0].date_time_format).toBe("");
    const refused = (description) => ({
      status: 400,
      description: `Bad Request: ${description}`,
    });
    const unparsable = (reason) =>
      refused(`can't parse MessageEntity: ${reason}`);
    expect(await send({ type: "nope" })).toMatchObject(
      unparsable("Unsupported type specified"),
    );
    expect(await send({ type: "" })).toMatchObject(
      unparsable("Type is not specified"),
    );
    expect(await send({})).toMatchObject(
      unparsable('Can\'t find field "type"'),
    );
    expect(await date({ date_time_format: "x" })).toMatchObject(
      unparsable("Invalid date-time format specified"),
    );
    expect(await send({ type: "date_time" })).toMatchObject(
      unparsable('Can\'t find field "unix_time"'),
    );
    expect(await date({ unix_time: 0 })).toMatchObject(
      refused("invalid date specified"),
    );
  });

  it("gives a text_mention the whole mentioned user", async () => {
    const { server, api } = await setup();
    const ann = await server.createUser({
      first_name: "Ann",
      username: "ann_x",
      language_code: "de",
    });
    const user = {
      id: ann,
      is_bot: false,
      first_name: "Ann",
      username: "ann_x",
      language_code: "de",
    };
    const html = await api("sendMessage", {
      chat_id: GROUP,
      text: `<a href="tg://user?id=${ann}">Ann</a>`,
      parse_mode: "HTML",
    });
    expect(html.result.entities).toEqual([
      { type: "text_mention", offset: 0, length: 3, user },
    ]);
    const explicit = await api("sendMessage", {
      chat_id: GROUP,
      text: "Ann",
      entities: [
        { type: "text_mention", offset: 0, length: 3, user: { id: ann } },
      ],
    });
    expect(explicit.result.entities).toEqual([
      { type: "text_mention", offset: 0, length: 3, user },
    ]);
    // A user the bot has never seen has no name to show.
    const unknown = await api("sendMessage", {
      chat_id: GROUP,
      text: '<a href="tg://user?id=42">x</a>',
      parse_mode: "HTML",
    });
    expect(unknown.result.entities[0].user).toEqual({
      id: 42,
      is_bot: false,
      first_name: "",
    });
  });

  it("answers reply_parameters and reply_to_message_id with reply_to_message", async () => {
    const { server, api } = await setup();
    const userId = await server.createUser();
    await server.join(GROUP, userId);
    const question = await server.post(GROUP, userId, "question");

    const reply = await api("sendMessage", {
      chat_id: GROUP,
      text: "answer",
      reply_parameters: { message_id: question },
    });
    expect(reply.result.reply_to_message).toMatchObject({
      message_id: question,
      text: "question",
    });
    const legacy = await api("sendMessage", {
      chat_id: GROUP,
      text: "again",
      reply_to_message_id: question,
    });
    expect(legacy.result.reply_to_message.message_id).toBe(question);

    expect(
      await api("sendMessage", {
        chat_id: GROUP,
        text: "x",
        reply_parameters: { message_id: 999999 },
      }),
    ).toMatchObject({
      status: 400,
      description: "Bad Request: message to be replied not found",
    });
    const without = await api("sendMessage", {
      chat_id: GROUP,
      text: "x",
      reply_parameters: {
        message_id: 999999,
        allow_sending_without_reply: true,
      },
    });
    expect(without.ok).toBe(true);
    expect(without.result.reply_to_message).toBeUndefined();
    // Message id 0, an ephemeral message's, names no message to reply to.
    for (const zero of [
      { reply_parameters: { message_id: 0 } },
      { reply_to_message_id: 0 },
    ]) {
      const plain = await api("sendMessage", {
        chat_id: GROUP,
        text: "x",
        ...zero,
      });
      expect(plain.ok).toBe(true);
      expect(plain.result.reply_to_message).toBeUndefined();
    }

    const stored = await server.getMessage(GROUP, reply.result.message_id);
    expect(stored.message.reply_to_message.message_id).toBe(question);
  });

  it("quotes part of the replied message, and refuses a quote it does not contain", async () => {
    const { server, api } = await setup();
    const userId = await server.createUser();
    await server.join(GROUP, userId);
    const question = await server.post(GROUP, userId, "the quick brown fox");
    const styled = await api("sendMessage", {
      chat_id: GROUP,
      text: "<b>quick</b> brown fox",
      parse_mode: "HTML",
    });
    const reply = (messageId, fields) =>
      api("sendMessage", {
        chat_id: GROUP,
        text: "yes",
        reply_parameters: { message_id: messageId, ...fields },
      });

    const quoted = await reply(question, {
      quote: "quick brown",
      quote_position: 4,
    });
    expect(quoted.result.reply_to_message.message_id).toBe(question);
    expect(quoted.result.quote).toEqual({
      text: "quick brown",
      position: 4,
      is_manual: true,
    });
    const bold = await reply(styled.result.message_id, {
      quote: "<b>quick</b> brown",
      quote_parse_mode: "HTML",
    });
    expect(bold.result.quote).toEqual({
      text: "quick brown",
      entities: [{ type: "bold", offset: 0, length: 5 }],
      position: 0,
      is_manual: true,
    });

    const invalid = {
      status: 400,
      description: "Bad Request: QUOTE_TEXT_INVALID",
    };
    expect(await reply(question, { quote: "slow fox" })).toMatchObject(invalid);
    expect(
      await reply(styled.result.message_id, { quote: "quick brown" }),
    ).toMatchObject(invalid);
  });

  it("moves a quote's position past the spaces cut from its start", async () => {
    const { api } = await setup();
    const original = await api("sendMessage", {
      chat_id: GROUP,
      text: "hello  world",
    });
    const quote = async (quote_position) =>
      (
        await api("sendMessage", {
          chat_id: GROUP,
          text: "yes",
          reply_parameters: {
            message_id: original.result.message_id,
            quote: "  world",
            quote_position,
          },
        })
      ).result.quote;
    expect(await quote(5)).toEqual({
      text: "world",
      position: 7,
      is_manual: true,
    });
    // A position out of range becomes 0.
    expect((await quote(-1)).position).toBe(0);
  });

  it("replies to a message in another chat with external_reply and an automatic quote", async () => {
    const { server, api } = await setup();
    const other = await server.createChat({ title: "Other", ownerId: OWNER });
    await server.setBotMembership(other, 123456);
    const ann = await server.createUser({ first_name: "Ann" });
    await server.join(other, ann);
    const photo = await server.post(other, ann, {
      photo: Buffer.from("jpeg-bytes"),
      caption: "look at this",
    });

    const reply = await api("sendMessage", {
      chat_id: GROUP,
      text: "seen it",
      reply_parameters: { chat_id: other, message_id: photo },
    });

    expect(reply.result).not.toHaveProperty("reply_to_message");
    expect(reply.result.external_reply).toMatchObject({
      origin: { type: "user", sender_user: { id: ann } },
      chat: { id: other, type: "supergroup" },
      message_id: photo,
      photo: expect.any(Array),
    });
    expect(reply.result.external_reply).not.toHaveProperty("caption");
    expect(reply.result.quote).toEqual({ text: "look at this", position: 0 });
    const said = await server.post(other, ann, "plain words");
    const toText = await api("sendMessage", {
      chat_id: GROUP,
      text: "agreed",
      reply_parameters: { chat_id: other, message_id: said },
    });
    expect(Object.keys(toText.result.external_reply).sort()).toEqual([
      "chat",
      "message_id",
      "origin",
    ]);
    expect(toText.result.quote).toEqual({ text: "plain words", position: 0 });
    // A live photo is shown as live_photo alone, without the photo the
    // message also carries for older bots.
    const still = (
      await api("sendPhoto", {
        chat_id: other,
        photo: "https://example.com/a.jpg",
      })
    ).result;
    const motion = (
      await api("sendVideo", {
        chat_id: other,
        video: "https://example.com/a.mp4",
      })
    ).result;
    const live = await api("editMessageMedia", {
      chat_id: other,
      message_id: still.message_id,
      media: {
        type: "live_photo",
        media: motion.video.file_id,
        photo: still.photo[0].file_id,
      },
    });
    const toLive = await api("sendMessage", {
      chat_id: GROUP,
      text: "nice",
      reply_parameters: { chat_id: other, message_id: still.message_id },
    });
    expect(toLive.result.external_reply.live_photo).toEqual(
      live.result.live_photo,
    );
    expect(toLive.result.external_reply).not.toHaveProperty("photo");

    const closed = await server.createChat({ title: "Closed", ownerId: OWNER });
    await server.join(closed, ann);
    const unseen = await server.post(closed, ann, "between us");
    expect(
      await api("sendMessage", {
        chat_id: GROUP,
        text: "x",
        reply_parameters: { chat_id: closed, message_id: unseen },
      }),
    ).toMatchObject({
      status: 400,
      description: "Bad Request: chat not found",
    });
    expect(
      await api("sendMessage", {
        chat_id: GROUP,
        text: "x",
        reply_parameters: { chat_id: -1009999999999, message_id: 1 },
      }),
    ).toMatchObject({
      status: 400,
      description: "Bad Request: chat not found",
    });
  });

  it("shows link preview options that differ from the defaults", async () => {
    const { api } = await setup();
    const send = (text, options) =>
      api("sendMessage", {
        chat_id: GROUP,
        text,
        link_preview_options: options,
      });

    const disabled = await send("see https://example.com/a", {
      is_disabled: true,
    });
    expect(disabled.result.link_preview_options).toEqual({ is_disabled: true });
    const chosen = await send("read this", {
      url: "https://example.com/b",
      prefer_large_media: true,
      show_above_text: true,
    });
    expect(chosen.result.link_preview_options).toEqual({
      url: "https://example.com/b",
      prefer_large_media: true,
      show_above_text: true,
    });
    for (const unchanged of [
      await send("no link here", { is_disabled: true }),
      await send("see https://example.com/c", { prefer_small_media: true }),
    ]) {
      expect(unchanged.result).not.toHaveProperty("link_preview_options");
    }
    const legacy = await api("sendMessage", {
      chat_id: GROUP,
      text: "see https://example.com/e",
      disable_web_page_preview: true,
    });
    expect(legacy.result.link_preview_options).toEqual({ is_disabled: true });

    const edited = await api("editMessageText", {
      chat_id: GROUP,
      message_id: chosen.result.message_id,
      text: "read https://example.com/d",
      link_preview_options: { is_disabled: true },
    });
    expect(edited.result.link_preview_options).toEqual({ is_disabled: true });
    // An edit without link_preview_options goes back to the defaults.
    const reset = await api("editMessageText", {
      chat_id: GROUP,
      message_id: chosen.result.message_id,
      text: "read https://example.com/f",
    });
    expect(reset.result).not.toHaveProperty("link_preview_options");
  });

  it("replies to a forum topic's creation message by default", async () => {
    const { server, api } = await setup();
    const forum = await server.createChat({ ownerId: OWNER, isForum: true });
    await server.setBotMembership(forum, 123456);
    const thread = await server.createTopic(forum, "Ideas");
    const sent = await api("sendMessage", {
      chat_id: forum,
      text: "in topic",
      message_thread_id: thread,
    });
    expect(sent.result).toMatchObject({
      message_thread_id: thread,
      is_topic_message: true,
      reply_to_message: {
        message_id: thread,
        forum_topic_created: { name: "Ideas" },
      },
    });
  });

  it("keeps an uploaded document's file name and type", async () => {
    const { server, api } = await setup();
    const form = new FormData();
    form.append("chat_id", String(GROUP));
    form.append("caption", "_report_");
    form.append("parse_mode", "Markdown");
    form.append(
      "document",
      new Blob(["a,b\n1,2"], { type: "text/csv; charset=utf-8" }),
      "report.csv",
    );
    const response = await fetch(`${server.origin}/bot${TOKEN}/sendDocument`, {
      method: "POST",
      body: form,
    });
    const { result } = await response.json();
    expect(result).toMatchObject({
      document: {
        file_name: "report.csv",
        mime_type: "text/csv",
        file_size: 7,
      },
      caption: "report",
      caption_entities: [{ type: "italic", offset: 0, length: 6 }],
    });

    const resent = await api("sendDocument", {
      chat_id: GROUP,
      document: result.document.file_id,
    });
    expect(resent.result.document).toMatchObject({
      file_name: "report.csv",
      mime_type: "text/csv",
    });

    const untyped = new FormData();
    untyped.append("chat_id", String(GROUP));
    untyped.append("document", new Blob(["%PDF"]), "a.pdf");
    const pdf = await (
      await fetch(`${server.origin}/bot${TOKEN}/sendDocument`, {
        method: "POST",
        body: untyped,
      })
    ).json();
    expect(pdf.result.document).toMatchObject({
      file_name: "a.pdf",
      mime_type: "application/pdf",
    });
  });
});

describe("formatting contract regressions", () => {
  it.each([
    ["negative offset", "abc", -1, 1],
    ["negative length", "abc", 0, -1],
    ["start after text", "abc", 4, 1],
    ["end after text", "abc", 0, 4],
    ["start inside surrogate", "😀x", 1, 1],
    ["end inside surrogate", "😀x", 0, 1],
  ])(
    "rejects %s before storing a message",
    async (_name, text, offset, length) => {
      const { server, api } = await setup();
      const before = await server.getMessages(GROUP);
      expect(
        await api("sendMessage", {
          chat_id: GROUP,
          text,
          entities: [{ type: "bold", offset, length }],
        }),
      ).toMatchObject({ status: 400, ok: false });
      expect(await server.getMessages(GROUP)).toEqual(before);
    },
  );

  it("normalizes styles around code and overlapping blockquotes like TDLib", async () => {
    const { api } = await setup();
    const code = await api("sendMessage", {
      chat_id: GROUP,
      text: "<b>a<code>x</code>b</b>",
      parse_mode: "HTML",
    });
    expect(code.result).toMatchObject({
      text: "axb",
      entities: [
        { type: "bold", offset: 0, length: 1 },
        { type: "code", offset: 1, length: 1 },
        { type: "bold", offset: 2, length: 1 },
      ],
    });
    const quote = await api("sendMessage", {
      chat_id: GROUP,
      text: "<blockquote>a<blockquote>x</blockquote>b</blockquote>",
      parse_mode: "HTML",
    });
    expect(quote.result.entities).toEqual([
      { type: "blockquote", offset: 0, length: 3 },
    ]);
    // A date_time keeps styles out, as code does.
    const date = await api("sendMessage", {
      chat_id: GROUP,
      text: '<b>a<tg-time unix="5">bc</tg-time>d</b>',
      parse_mode: "HTML",
    });
    expect(date.result.entities).toEqual([
      { type: "bold", offset: 0, length: 1 },
      {
        type: "date_time",
        offset: 1,
        length: 2,
        unix_time: 5,
        date_time_format: "",
      },
      { type: "bold", offset: 3, length: 1 },
    ]);
  });

  it("rejects crossed Markdown delimiters without posting", async () => {
    const { server, api } = await setup();
    const before = await server.getMessages(GROUP);
    for (const text of ["*a _b* c_", "[a *b](https://e.com)*"]) {
      expect(
        await api("sendMessage", {
          chat_id: GROUP,
          text,
          parse_mode: "MarkdownV2",
        }),
      ).toMatchObject({ status: 400, ok: false });
    }
    expect(await server.getMessages(GROUP)).toEqual(before);
  });

  it("detects links inside styles but suppresses detection inside code and explicit links", async () => {
    const { api } = await setup();
    const bold = await api("sendMessage", {
      chat_id: GROUP,
      text: "<b>https://e.com</b>",
      parse_mode: "HTML",
    });
    expect(bold.result.entities).toEqual([
      { type: "url", offset: 0, length: 13 },
      { type: "bold", offset: 0, length: 13 },
    ]);
    for (const text of [
      "<code>https://e.com</code>",
      '<a href="https://target.com">https://e.com</a>',
    ]) {
      const sent = await api("sendMessage", {
        chat_id: GROUP,
        text,
        parse_mode: "HTML",
      });
      expect(sent.result.entities).toHaveLength(1);
      expect(sent.result.entities[0].type).not.toBe("url");
    }
  });

  it("finds short mentions, $1INCH, tg:// links and mailto: emails, and drops what overlaps an earlier match", async () => {
    const { server, api } = await setup();
    const found = (text, entities = []) =>
      entities.map((entity) => [
        entity.type,
        text.slice(entity.offset, entity.offset + entity.length),
      ]);
    const sent = async (text) =>
      found(
        text,
        (await api("sendMessage", { chat_id: GROUP, text })).result.entities,
      );
    // A username under four characters is a mention only for a few bots.
    expect(await sent("@ya @gif @vid @pic @cap @bing")).toEqual([
      ["mention", "@gif"],
      ["mention", "@vid"],
      ["mention", "@pic"],
      ["mention", "@bing"],
    ]);
    expect(await sent("$1INCH $1INCHA $USD")).toEqual([
      ["cashtag", "$1INCH"],
      ["cashtag", "$USD"],
    ]);
    expect(await sent("tg://resolve?domain=a ton://site")).toEqual([
      ["url", "tg://resolve?domain=a"],
      ["url", "ton://site"],
    ]);
    expect(await sent("Look mailto:test@example.com")).toEqual([
      ["email", "test@example.com"],
    ]);
    // A hashtag inside a link is not one of its own.
    const ann = await server.createUser();
    await server.join(GROUP, ann);
    const text = "https://e.com/#tag";
    const reply = await server.postGuestBotReply(GROUP, ann, "guide_bot", text);
    expect(
      found(text, (await server.getMessage(GROUP, reply)).message.entities),
    ).toEqual([["url", text]]);
  });

  it("formats album captions and replaces stale entities on media edits", async () => {
    const { server, api } = await setup();
    const form = new FormData();
    form.append("chat_id", String(GROUP));
    form.append("photo", new Blob(["photo"]), "photo.jpg");
    form.append("caption", "<b>old</b>");
    form.append("parse_mode", "HTML");
    const sent = await (
      await fetch(`${server.origin}/bot${TOKEN}/sendPhoto`, {
        method: "POST",
        body: form,
      })
    ).json();
    const file = sent.result.photo[0].file_id;
    const album = await api("sendMediaGroup", {
      chat_id: GROUP,
      media: [
        {
          type: "photo",
          media: file,
          caption: "<i>first</i>",
          parse_mode: "HTML",
        },
        {
          type: "photo",
          media: file,
          caption: "second",
          caption_entities: [{ type: "bold", offset: 0, length: 6 }],
        },
      ],
    });
    expect(album.result[0]).toMatchObject({
      caption: "first",
      caption_entities: [{ type: "italic", offset: 0, length: 5 }],
    });
    expect(album.result[1].caption_entities).toEqual([
      { type: "bold", offset: 0, length: 6 },
    ]);
    const before = await server.getMessages(GROUP);
    expect(
      await api("sendMediaGroup", {
        chat_id: GROUP,
        media: [
          { type: "photo", media: file, caption: "valid" },
          {
            type: "photo",
            media: file,
            caption: "<b>open",
            parse_mode: "HTML",
          },
        ],
      }),
    ).toMatchObject({ status: 400, ok: false });
    expect(await server.getMessages(GROUP)).toEqual(before);
    const edited = await api("editMessageMedia", {
      chat_id: GROUP,
      message_id: sent.result.message_id,
      media: {
        type: "photo",
        media: file,
        caption: "<i>new</i>",
        parse_mode: "HTML",
      },
    });
    expect(edited.result).toMatchObject({
      caption: "new",
      caption_entities: [{ type: "italic", offset: 0, length: 3 }],
    });
    const plain = await api("editMessageMedia", {
      chat_id: GROUP,
      message_id: sent.result.message_id,
      media: { type: "photo", media: file, caption: "plain" },
    });
    expect(plain.result.caption).toBe("plain");
    expect(plain.result.caption_entities).toBeUndefined();
  });
});

it("formats business sends and rejects invalid formatting without storing a reply", async () => {
  const { server, api } = await setup();
  const owner = await server.createUser();
  const person = await server.createUser();
  const { connection } = await server.connectBusiness({
    ownerId: owner,
    rights: { can_reply: true },
  });
  await server.sayInBusinessChat(connection.id, person, "person", "hello");
  const sent = await api("sendMessage", {
    business_connection_id: connection.id,
    chat_id: person,
    text: "<b>https://e.com</b>",
    parse_mode: "HTML",
  });
  expect(sent.result).toMatchObject({
    text: "https://e.com",
    entities: [
      { type: "url", offset: 0, length: 13 },
      { type: "bold", offset: 0, length: 13 },
    ],
  });
  const before = await server.getBusinessChat(connection.id, person);
  expect(
    await api("sendMessage", {
      business_connection_id: connection.id,
      chat_id: person,
      text: "<b>open",
      parse_mode: "HTML",
    }),
  ).toMatchObject({ status: 400, ok: false });
  expect(await server.getBusinessChat(connection.id, person)).toEqual(before);
});
