// The chat viewer's pure renderer (src/ui/render.js): escaping, entities,
// what a member may see, the view in the URL and the combined stream.
import { describe, expect, it } from "vitest";

import {
  chatListEntries,
  chatStream,
  columnsFor,
  makeContext,
  memberEntries,
  parseView,
  renderEvent,
  renderMessage,
  renderPaneHeader,
  renderText,
  renderToolbar,
  serviceLinks,
  streamEntries,
  viewToSearch,
} from "../src/ui/render.js";

const GROUP = -1001000000001;
const CHANNEL = -1001800000002;
const BOT = {
  id: 123456,
  is_bot: true,
  first_name: "Example Bot",
  username: "example_bot",
};
const SECOND = {
  id: 654321,
  is_bot: true,
  first_name: "Second Bot",
  username: "second_bot",
};
const OLGA = { id: 5000000001, is_bot: false, first_name: "Olga" };
const ANN = {
  id: 8800000000,
  is_bot: false,
  first_name: "Ann",
  last_name: "Lee",
  username: "ann",
};
const EVE = {
  id: 8800000002,
  is_bot: false,
  first_name: "Eve <img src=x onerror=alert(1)>",
  username: "eve_spam",
};
const CHAT = {
  id: GROUP,
  title: "Test Group & Friends <i>",
  type: "supergroup",
};
const HOSTILE = [
  EVE.first_name,
  'cheap followers <script>alert("x")</script>',
  "<b>bad</b>",
  '"><script>alert(1)</script>',
  CHAT.title,
  "report <final>.pdf",
  "Ads <b>",
  "Admin <u>",
];
const escaped = (text) =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

let seq = 0;
function message(fields, item = {}) {
  seq += 1;
  return {
    kind: "message",
    seq,
    at: 1_800_000_000_000 + seq * 1000,
    after_request: 1,
    request_id: null,
    author: fields.from?.id ?? null,
    deleted: false,
    deleted_by: null,
    ephemeral: false,
    reply_deleted: false,
    pinned_deleted: false,
    ...item,
    message: {
      message_id: 100000000 + seq,
      chat: CHAT,
      date: 1_800_000_000 + seq,
      ...fields,
    },
  };
}

function pageOf(items, extra = {}) {
  return {
    chat: {
      key: String(GROUP),
      id: GROUP,
      type: "supergroup",
      title: CHAT.title,
      is_forum: false,
      topics: [],
      permissions: { can_send_messages: true, can_send_polls: false },
    },
    items,
    as: null,
    members: [],
    members_total: 0,
    join_requests: [],
    bots: [
      {
        id: BOT.id,
        username: BOT.username,
        first_name: BOT.first_name,
        first: true,
        index: 0,
      },
      {
        id: SECOND.id,
        username: SECOND.username,
        first_name: SECOND.first_name,
        first: false,
        index: 1,
      },
    ],
    users: Object.fromEntries(
      [BOT, SECOND, OLGA, ANN, EVE].map((user) => [user.id, user]),
    ),
    files: {},
    ...extra,
  };
}

/** Every "<" starts a well-formed tag with quoted, escaped attributes; nothing runs. */
function expectSafe(html) {
  const tags = html.match(/<[^>]*>?/g) ?? [];
  for (const tag of tags) {
    expect(tag).toMatch(
      /^<\/?[a-z][a-z0-9]*(?:\s+[a-z][a-z-]*(?:="[^"<>]*")?)*\s*>$/,
    );
    const name = tag.match(/^<\/?([a-z0-9]+)/)[1];
    expect([
      "script",
      "iframe",
      "object",
      "embed",
      "style",
      "link",
      "meta",
      "base",
      "form",
    ]).not.toContain(name);
    expect(tag).not.toMatch(/\son[a-z]+=|\sstyle=|\ssrcdoc=/);
    const href = tag.match(/\shref="([^"]*)"/)?.[1];
    if (href && !href.startsWith("?"))
      expect(href).toMatch(/^(https?:|mailto:|tg:)/);
    const src = tag.match(/\ssrc="([^"]*)"/)?.[1];
    if (src) expect(src).toMatch(/^(\/_fake\/ui\/files\/|data:image\/)/);
  }
  for (const value of HOSTILE) expect(html).not.toContain(value);
}

describe("render", () => {
  it("escapes every user-controlled string in text and attributes", () => {
    const welcome = message({
      from: BOT,
      text: "Rules and a bad link",
      entities: [
        {
          type: "text_link",
          offset: 10,
          length: 10,
          url: 'javascript:alert("x")',
        },
      ],
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "<b>bad</b>",
              callback_data: '"><script>alert(1)</script>',
            },
          ],
          [{ text: "Site", url: 'https://example.com/"><script>' }],
        ],
      },
    });
    const spam = message({
      from: EVE,
      text: 'cheap followers <script>alert("x")</script>',
    });
    const reply = message({
      from: ANN,
      text: "Is this legit?",
      reply_to_message: spam.message,
      quote: { text: "<b>bad</b>", position: 0 },
    });
    const file = message({
      from: ANN,
      document: {
        file_id: "a",
        file_unique_id: "b",
        file_name: "report <final>.pdf",
        mime_type: 'text/"html"',
      },
      caption: "<b>bad</b>",
    });
    const poll = message(
      {
        from: BOT,
        poll: {
          id: "1",
          question: "<b>bad</b>",
          options: [{ text: "Admin <u>", voter_count: 1 }],
          total_voter_count: 1,
          is_closed: false,
          is_anonymous: false,
          type: "regular",
        },
      },
      { votes: { [EVE.id]: [0] } },
    );
    const forward = message({
      from: ANN,
      text: "fwd",
      forward_origin: {
        type: "hidden_user",
        sender_user_name: "<b>bad</b>",
        date: 1,
      },
    });
    const title = message({ from: OLGA, new_chat_title: CHAT.title });
    const pin = message({ from: OLGA, pinned_message: spam.message });
    const joined = message({ from: EVE, new_chat_members: [EVE] });
    const request = {
      kind: "event",
      seq: 90,
      at: 1,
      type: "join_request",
      user_id: EVE.id,
      state: "pending",
      bot_id: null,
      invite_link: "https://t.me/+x",
      invite_link_name: "Ads <b>",
    };
    const member = {
      kind: "event",
      seq: 91,
      at: 1,
      type: "member",
      user_id: EVE.id,
      actor_id: BOT.id,
      reason: "change",
      old: { status: "left" },
      new: { status: "member" },
      invite_link: "https://t.me/+x",
      invite_link_name: "Ads <b>",
      via_join_request: true,
      service_seq: joined.seq,
    };
    const promoted = {
      kind: "event",
      seq: 92,
      at: 1,
      type: "member",
      user_id: ANN.id,
      actor_id: OLGA.id,
      reason: "change",
      old: {
        status: "administrator",
        can_delete_messages: true,
        custom_title: "x",
      },
      new: {
        status: "administrator",
        can_delete_messages: true,
        custom_title: "Admin <u>",
      },
    };
    const items = [
      welcome,
      spam,
      reply,
      file,
      poll,
      forward,
      title,
      pin,
      joined,
      request,
      member,
      promoted,
    ];
    const page = pageOf(items, {
      members: [
        {
          user_id: EVE.id,
          member: {
            status: "restricted",
            is_member: true,
            until_date: 0,
            can_send_messages: false,
          },
        },
        {
          user_id: ANN.id,
          member: {
            status: "administrator",
            custom_title: "Admin <u>",
            can_delete_messages: true,
          },
        },
      ],
      members_total: 2,
      join_requests: [
        {
          user_id: EVE.id,
          date: 1_800_000_000,
          invite_link: "https://t.me/+x",
          invite_link_name: "Ads <b>",
        },
      ],
    });
    const ctx = makeContext(page, { links: serviceLinks(items) });
    const html = [
      ...streamEntries(chatStream(items, ctx), ctx).map((entry) => entry.html),
      ...items
        .filter((item) => item.kind === "event")
        .map((item) => renderEvent(item, ctx)),
      ...memberEntries(page, ctx).map((entry) => entry.html),
      ...chatListEntries(
        {
          bots: page.bots,
          chats: [
            {
              key: String(GROUP),
              id: GROUP,
              type: "supergroup",
              title: CHAT.title,
              last: {
                kind: "message",
                seq: 1,
                at: 1,
                author: EVE.id,
                preview: HOSTILE[1],
                media: null,
                deleted: false,
                ephemeral: false,
              },
            },
          ],
        },
        { view: parseView(""), users: page.users },
      ).map((entry) => entry.html),
      renderPaneHeader(
        { id: `chat:${GROUP}`, panel: "chat", ref: String(GROUP) },
        { page, ctx, openAlone: "?chat=1&show=chat" },
      ),
      renderToolbar(parseView(""), {
        people: [{ id: String(EVE.id), name: EVE.first_name }],
      }),
    ].join("\n");
    expectSafe(html);
    for (const value of [
      EVE.first_name,
      CHAT.title,
      "report <final>.pdf",
      "Ads <b>",
      "<b>bad</b>",
      '"><script>alert(1)</script>',
    ])
      expect(html).toContain(escaped(value));
  });

  it("opens only http, https, mailto and tg links", () => {
    const html = renderText("bad good mail", [
      { type: "text_link", offset: 0, length: 3, url: "javascript:alert(1)" },
      {
        type: "text_link",
        offset: 4,
        length: 4,
        url: "https://example.com/docs",
      },
      { type: "email", offset: 9, length: 4 },
    ]);
    expect(html).toContain('href="https://example.com/docs"');
    expect(html).toContain('href="mailto:mail"');
    expect(html).not.toContain('href="javascript');
    expect(html.match(/href=/g)).toHaveLength(2);
    expect(html).toContain('title="javascript:alert(1)">bad</span>');
  });

  it("places entities by UTF-16 offset and nests them", () => {
    expect(
      renderText("😀 bold", [{ type: "bold", offset: 3, length: 4 }]),
    ).toBe("😀 <strong>bold</strong>");
    expect(
      renderText("bold both x", [
        { type: "italic", offset: 5, length: 4 },
        { type: "bold", offset: 0, length: 9 },
      ]),
    ).toBe("<strong>bold <em>both</em></strong> x");
    expect(renderText("a<b", [{ type: "code", offset: 0, length: 3 }])).toBe(
      '<code class="tv-code">a&lt;b</code>',
    );
  });

  it("reads the view from the URL and writes it back", () => {
    expect(parseView("")).toEqual({
      chats: [],
      show: ["list", "chat", "calls", "events", "members"],
      layout: "combined",
      as: null,
      bots: null,
      methods: null,
      topic: null,
      theme: null,
    });
    const view = parseView(
      `?chat=1&chats=${GROUP},${GROUP},8800000000:123456&show=bogus,calls,list,chat&layout=split&as=8800000000&bots=123456&methods=deleteMessage,banChatMember&topic=general&theme=dark`,
    );
    expect(view).toEqual({
      chats: [String(GROUP), "8800000000:123456"],
      show: ["list", "chat", "calls"],
      layout: "split",
      as: 8800000000,
      bots: [123456],
      methods: ["deleteMessage", "banChatMember"],
      topic: "general",
      theme: "dark",
    });
    expect(parseView(viewToSearch(view))).toEqual(view);
    expect(viewToSearch(view)).toBe(
      `?chats=${GROUP},8800000000:123456&show=list,chat,calls&layout=split&as=8800000000&bots=123456&methods=deleteMessage,banChatMember&topic=general&theme=dark`,
    );
    expect(viewToSearch(parseView(`?chat=${GROUP}`))).toBe(`?chat=${GROUP}`);
    expect(
      parseView("?chat=x&layout=nonsense&as=-5&topic=0&theme=blue&show="),
    ).toEqual(parseView(""));
    expect(parseView("?chats=1,2,3,4,5").chats).toEqual(["1", "2", "3", "4"]);

    const columns = (search) =>
      columnsFor(parseView(search)).map((column) => column.id);
    expect(columns(`?chat=${GROUP}`)).toEqual([
      "list",
      `chat:${GROUP}`,
      `members:${GROUP}`,
    ]);
    expect(columns(`?chat=${GROUP}&layout=split`)).toEqual([
      "list",
      `chat:${GROUP}`,
      `calls:${GROUP}`,
      `events:${GROUP}`,
      `members:${GROUP}`,
    ]);
    expect(columns(`?chat=${GROUP}&show=calls`)).toEqual([`calls:${GROUP}`]);
    expect(columns(`?chats=${GROUP},${CHANNEL}&show=chat`)).toEqual([
      `chat:${GROUP}`,
      `chat:${CHANNEL}`,
    ]);
    expect(columns(`?chat=${GROUP}&layout=split&as=8800000000`)).toEqual([
      "list",
      `chat:${GROUP}`,
    ]);
    expect(columns("?chat=calls")).toEqual(["list", "calls:calls"]);
  });

  it("shows a member nothing they could not see", () => {
    const spam = message({ from: EVE, text: "the spam text" });
    const reply = message(
      { from: ANN, text: "Is this legit?", reply_to_message: spam.message },
      { reply_deleted: true },
    );
    const pin = message(
      { from: OLGA, pinned_message: spam.message },
      { pinned_deleted: true },
    );
    const post = {
      ...message({
        sender_chat: { id: CHANNEL, title: "News", type: "channel" },
        text: "First post",
      }),
      author: OLGA.id,
    };
    const poll = message(
      {
        from: BOT,
        poll: {
          id: "1",
          question: "Capital?",
          type: "quiz",
          is_closed: false,
          is_anonymous: false,
          total_voter_count: 7,
          correct_option_ids: [1],
          options: [
            { text: "Lyon", voter_count: 3 },
            { text: "Paris", voter_count: 4 },
          ],
        },
      },
      { votes: { [EVE.id]: [1] } },
    );
    const asAnn = (item, chat) =>
      renderMessage(
        item,
        makeContext(pageOf([item], chat ? { chat } : {}), { as: ANN.id }),
      );
    const testView = (item, chat) =>
      renderMessage(item, makeContext(pageOf([item], chat ? { chat } : {})));

    expect(asAnn(reply)).toContain("Deleted message");
    expect(asAnn(reply)).not.toContain("the spam text");
    expect(testView(reply)).toContain("the spam text");
    expect(asAnn(pin)).toContain("pinned a deleted message");
    expect(asAnn(pin)).not.toContain("the spam text");
    const channel = {
      key: String(CHANNEL),
      id: CHANNEL,
      type: "channel",
      title: "News",
      is_forum: false,
      topics: [],
    };
    expect(testView(post, channel)).toContain("posted by Olga");
    expect(asAnn(post, channel)).not.toContain("Olga");
    expect(asAnn(poll)).not.toMatch(/tv-poll-count|correct|Eve/);
    expect(testView(poll)).toContain("correct");
    expect(
      renderMessage(poll, makeContext(pageOf([poll]), { as: EVE.id })),
    ).toContain('data-correct="true"');
    expect(
      asAnn(
        message(
          { from: EVE, text: "gone" },
          {
            deleted: true,
            deleted_by: { bot_id: BOT.id, method: "deleteMessage", at: 1 },
          },
        ),
      ),
    ).toBe("");
  });

  it("draws a member change once, on its service message when that is drawn", () => {
    const joined = message({ from: ANN, new_chat_members: [ANN] });
    const event = {
      kind: "event",
      seq: joined.seq - 0.5,
      at: joined.at,
      after_request: 1,
      request_id: null,
      type: "member",
      user_id: ANN.id,
      actor_id: BOT.id,
      reason: "change",
      old: { status: "left" },
      new: { status: "member" },
      invite_link: "https://t.me/+x",
      invite_link_name: "Ads",
      via_join_request: true,
      service_seq: joined.seq,
    };
    const items = [event, joined];
    const ctx = makeContext(pageOf(items), { links: serviceLinks(items) });
    const html = streamEntries(chatStream(items, ctx), ctx)
      .map((entry) => entry.html)
      .join("");
    expect(html.match(/Ann Lee/g)).toHaveLength(1);
    expect(html).not.toContain('data-kind="event"');
    expect(html).toContain("by request");
    expect(html).toContain("via “Ads”");

    const alone = streamEntries(chatStream([event], ctx), ctx)
      .map((entry) => entry.html)
      .join("");
    expect(alone).toContain(`data-event-id="${event.seq}"`);
    expect(alone).toContain("Ann Lee");
  });

  it("marks messages, buttons and members with the data attributes tests select by", () => {
    const deleted = message(
      { from: EVE, text: "buy now" },
      {
        deleted: true,
        deleted_by: {
          seq: 9,
          bot_id: SECOND.id,
          method: "deleteMessages",
          request_id: "i:0:4",
          at: 1,
        },
      },
    );
    const ephemeral = message(
      {
        message_id: 0,
        ephemeral_message_id: 1,
        from: BOT,
        receiver_user: ANN,
        text: "Only you",
        reply_markup: {
          inline_keyboard: [
            [
              { text: "OK", callback_data: "ack" },
              { text: "Site", url: "https://example.com" },
            ],
          ],
        },
      },
      { ephemeral: true, request_id: "i:0:6" },
    );
    const edited = message({
      from: SECOND,
      text: "edited text",
      edit_date: 1_800_000_100,
    });
    const guest = message({
      from: {
        id: 8800000006,
        is_bot: true,
        first_name: "weather_bot",
        username: "weather_bot",
      },
      text: "Sunny",
      guest_bot_caller_user: ANN,
    });
    const ctx = makeContext(pageOf([]));

    const deletedHtml = renderMessage(deleted, ctx);
    expect(deletedHtml).toContain('data-deleted="true"');
    expect(deletedHtml).toContain(`data-deleted-by="${SECOND.id}"`);
    expect(deletedHtml).toContain("@second_bot");
    expect(deletedHtml).toContain('data-author-kind="user"');

    const ephemeralHtml = renderMessage(ephemeral, ctx);
    expect(ephemeralHtml).toContain('data-ephemeral-id="1"');
    expect(ephemeralHtml).toContain(`data-receiver-id="${ANN.id}"`);
    expect(ephemeralHtml).not.toContain("data-message-id");
    expect(ephemeralHtml).toContain("only Ann Lee sees this");
    expect(ephemeralHtml).toContain('data-author-kind="first-bot"');
    expect(ephemeralHtml).toContain('data-request-id="i:0:6"');
    expect(ephemeralHtml).toContain(
      'data-button-text="OK" data-button-data="ack" data-button-row="0" data-button-col="0"',
    );
    expect(ephemeralHtml).toContain('title="callback_data: ack"');
    expect(ephemeralHtml).toContain(
      'data-button-url="https://example.com" data-button-row="0" data-button-col="1"',
    );
    expect(ephemeralHtml).not.toContain("<button");

    const editedHtml = renderMessage(edited, ctx);
    expect(editedHtml).toContain('data-edited="true"');
    expect(editedHtml).toContain("edited");
    expect(editedHtml).toContain('data-author-kind="added-bot"');
    expect(editedHtml).toContain(
      `data-message-id="${edited.message.message_id}"`,
    );

    const guestHtml = renderMessage(guest, ctx);
    expect(guestHtml).toContain('data-author-kind="guest-bot"');
    expect(guestHtml).toContain("for Ann Lee");

    const members = memberEntries(
      pageOf([], {
        members: [
          {
            user_id: EVE.id,
            member: {
              status: "restricted",
              is_member: false,
              until_date: 1_800_003_600,
              can_send_messages: false,
            },
          },
          {
            user_id: SECOND.id,
            member: {
              status: "administrator",
              can_delete_messages: true,
              can_restrict_members: false,
            },
          },
        ],
        members_total: 5,
      }),
      ctx,
    )
      .map((entry) => entry.html)
      .join("");
    expect(members).toContain(
      `data-member-id="${EVE.id}" data-member-status="restricted" data-member-in-chat="false"`,
    );
    expect(members).toContain(
      "restricted until 15 Jan 2027 09:00 UTC · not in the chat",
    );
    expect(members).toContain(
      `data-member-id="${SECOND.id}" data-member-status="administrator" data-member-in-chat="true" data-member-bot="true"`,
    );
    expect(members).toContain("delete messages");
    expect(members).not.toContain("restrict members");
    expect(members).toContain("3 more members");
  });
});
