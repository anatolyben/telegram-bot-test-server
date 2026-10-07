// The chat viewer's pure renderer (src/ui/render.js): escaping, entities,
// what a member may see, the view in the URL and the combined stream.
import { describe, expect, it } from "vitest";

import {
  chatListEntries,
  chatStream,
  clockTime,
  columnsFor,
  identitySlot,
  makeContext,
  memberEntries,
  parseView,
  renderEvent,
  renderMessage,
  renderCall,
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
const NEWS = { id: CHANNEL, title: "News <i>", type: "channel" };
// The users Telegram puts in `from` of a post on behalf of a group or a channel.
const GROUP_BOT = {
  id: 1087968824,
  is_bot: true,
  first_name: "Group",
  username: "GroupAnonymousBot",
};
const CHANNEL_BOT = {
  id: 136817688,
  is_bot: true,
  first_name: "Channel",
  username: "Channel_Bot",
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
    // Starting together, the longer one is the outer.
    expect(
      renderText("bold italic", [
        { type: "italic", offset: 0, length: 4 },
        { type: "bold", offset: 0, length: 11 },
      ]),
    ).toBe("<strong><em>bold</em> italic</strong>");
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

    expect(asAnn(reply)).toContain('data-reply-deleted="true"');
    expect(asAnn(reply)).not.toContain("the spam text");
    expect(testView(reply)).toContain("the spam text");
    expect(asAnn(pin)).toContain('data-pinned-deleted="true"');
    expect(asAnn(pin)).not.toContain("the spam text");
    const channel = {
      key: String(CHANNEL),
      id: CHANNEL,
      type: "channel",
      title: "News",
      is_forum: false,
      topics: [],
    };
    expect(asAnn(post, channel)).not.toContain("Olga");
    expect(asAnn(poll)).not.toMatch(/tv-poll-count|correct|Eve/);
    expect(testView(poll)).toContain('data-correct="true"');
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
    expect(deletedHtml).toContain('data-author-kind="user"');

    const ephemeralHtml = renderMessage(ephemeral, ctx);
    expect(ephemeralHtml).toContain('data-ephemeral-id="1"');
    expect(ephemeralHtml).toContain(`data-receiver-id="${ANN.id}"`);
    expect(ephemeralHtml).not.toContain("data-message-id");
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
    expect(editedHtml).toContain('class="tv-edited"');
    expect(editedHtml).not.toContain("data-edit-hidden");
    expect(editedHtml).toContain('data-author-kind="added-bot"');
    expect(editedHtml).toContain(
      `data-message-id="${edited.message.message_id}"`,
    );

    // A bot's edit of only the keyboard keeps edit_date but shows no edit.
    const keyboardOnly = renderMessage({ ...edited, edit_hidden: true }, ctx);
    expect(keyboardOnly).toContain(
      'data-edited="true" data-edit-hidden="true"',
    );
    expect(keyboardOnly).not.toContain('class="tv-edited"');

    const guestHtml = renderMessage(guest, ctx);
    expect(guestHtml).toContain('data-author-kind="guest-bot"');

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
      `data-member-id="${SECOND.id}" data-member-status="administrator" data-member-in-chat="true" data-member-bot="true"`,
    );
    expect(members).toContain('data-role="more-members" data-count="3"');
  });

  it("draws a post on behalf of a group or a channel with that chat as the sender", () => {
    const anonymous = message(
      {
        from: GROUP_BOT,
        sender_chat: CHAT,
        author_signature: "Mods <b>",
        text: "Read the rules",
      },
      { author: ANN.id },
    );
    const asChannel = message(
      { from: CHANNEL_BOT, sender_chat: NEWS, text: "Follow us" },
      { author: OLGA.id },
    );
    const testView = (item) => renderMessage(item, makeContext(pageOf([item])));
    const asEve = (item) =>
      renderMessage(item, makeContext(pageOf([item]), { as: EVE.id }));
    const html = [anonymous, asChannel].flatMap((item) => [
      testView(item),
      asEve(item),
    ]);
    expectSafe(html.join("\n"));
    expect(html.join("\n")).not.toMatch(/Mods <b>|News <i>/);
    const [group, groupAsEve, channel, channelAsEve] = html;

    // The group is the sender: its name and initial, and the admin's title.
    expect(group).toContain('data-author-kind="channel"');
    expect(group).toContain(
      `tv-avatar tv-id-${identitySlot(GROUP)}" aria-hidden="true">T</span>`,
    );
    expect(group).toContain(
      `<span class="tv-sender-name">${escaped(CHAT.title)}</span>`,
    );
    expect(group).toContain(escaped("Mods <b>"));
    expect(group).toContain("posted by Ann Lee");
    expect(group).not.toContain("Group</span>");
    // A member sees the group and the title, never who posted.
    expect(groupAsEve).toContain(escaped(CHAT.title));
    expect(groupAsEve).toContain(escaped("Mods <b>"));
    expect(groupAsEve).not.toContain("Ann");

    expect(channel).toContain(
      `tv-avatar tv-id-${identitySlot(CHANNEL)}" aria-hidden="true">N</span>`,
    );
    expect(channel).toContain(
      `<span class="tv-sender-name">${escaped(NEWS.title)}</span>`,
    );
    expect(channel).toContain("posted by Olga");
    expect(channelAsEve).toContain(escaped(NEWS.title));
    expect(channelAsEve).not.toContain("Olga");

    // Two admins' posts in a row: a member tells them apart by the title.
    const untitled = message(
      { from: GROUP_BOT, sender_chat: CHAT, text: "First" },
      { author: OLGA.id },
    );
    const titled = message(
      {
        from: GROUP_BOT,
        sender_chat: CHAT,
        author_signature: "Mods <b>",
        text: "Second",
      },
      { author: ANN.id },
    );
    const eve = makeContext(pageOf([untitled, titled]), { as: EVE.id });
    const stream = streamEntries([untitled, titled], eve).map(
      (entry) => entry.html,
    );
    expect(
      stream.filter((html) => html.includes("tv-sender-name")),
    ).toHaveLength(2);
    expect(stream.at(-1)).toContain(
      `<span class="tv-sender-rank">${escaped("Mods <b>")}</span>`,
    );
  });

  it("names a forward's group and its signature", () => {
    const partners = {
      id: -1001000000009,
      title: "Partners <b>",
      type: "supergroup",
    };
    const signed = message({
      from: ANN,
      text: "seen there",
      forward_origin: {
        type: "chat",
        sender_chat: partners,
        author_signature: "Mods <i>",
        date: 1,
      },
    });
    const plain = message({
      from: ANN,
      text: "seen here",
      forward_origin: {
        type: "chat",
        sender_chat: { ...partners, title: "Partners" },
        date: 1,
      },
    });
    const ctx = makeContext(pageOf([signed, plain]));
    const html = [signed, plain].map((item) => renderMessage(item, ctx));
    expectSafe(html.join("\n"));
    expect(html[0]).toContain(
      "Forwarded from <strong>Partners &lt;b&gt; (Mods &lt;i&gt;)</strong>",
    );
    expect(html[1]).toContain("Forwarded from <strong>Partners</strong>");
  });

  it("draws a contact as a card with the contact's name and phone", () => {
    const linked = message({
      from: ANN,
      contact: {
        phone_number: "+1 555 <0100>",
        first_name: "Bob <b>",
        last_name: "Stone",
        user_id: OLGA.id,
      },
    });
    const bare = message({
      from: ANN,
      contact: { phone_number: "+15550101", first_name: "Cy" },
    });
    const ctx = makeContext(pageOf([linked, bare]));
    const [card, plain] = [linked, bare].map((item) =>
      renderMessage(item, ctx),
    );
    expectSafe(`${card}\n${plain}`);
    expect(card).not.toMatch(/Bob <b>|<0100>/);
    expect(card).toContain('data-media="contact"');
    expect(card).toContain(
      `tv-id-${identitySlot(OLGA.id)}" aria-hidden="true">B</span>`,
    );
    expect(card).toContain(
      `<strong class="tv-contact-name">${escaped("Bob <b> Stone")}</strong>`,
    );
    expect(card).toContain(
      `<span class="tv-contact-phone">${escaped("+1 555 <0100>")}</span>`,
    );
    expect(card).toContain(`user ${OLGA.id}`);
    expect(plain).toContain(
      '<strong class="tv-contact-name">Cy</strong><span class="tv-contact-phone">+15550101</span>',
    );
    expect(plain).not.toContain("user ");
  });

  it("draws a location as a card with its point, accuracy and live period", () => {
    const live = message({
      from: ANN,
      location: {
        latitude: 51.5,
        longitude: -0.12,
        horizontal_accuracy: 15,
        live_period: 5400,
        heading: 90,
        proximity_alert_radius: 500,
      },
    });
    const still = message({
      from: ANN,
      location: { latitude: -33.8688, longitude: 151.2093 },
    });
    const forever = message({
      from: ANN,
      location: { latitude: 0, longitude: 0, live_period: 0x7fffffff },
    });
    const ctx = makeContext(pageOf([live, still, forever]));
    const [liveHtml, stillHtml, foreverHtml] = [live, still, forever].map(
      (item) => renderMessage(item, ctx),
    );
    expectSafe([liveHtml, stillHtml, foreverHtml].join("\n"));
    expect(liveHtml).toContain('data-media="location" data-live="true"');
    expect(liveHtml).toContain("Live location");
    expect(liveHtml).toContain("51.5, -0.12");
    const ends = clockTime((live.message.date + 5400) * 1000);
    expect(liveHtml.replace(/<[^>]+>/g, "")).toContain(
      `± 15 m · live for 1 h 30 min, until ${ends} · heading 90° · alerts within 500 m`,
    );
    expect(stillHtml).toContain('data-media="location"');
    expect(stillHtml).not.toContain("data-live");
    expect(stillHtml).toContain("-33.8688, 151.2093");
    expect(stillHtml).not.toMatch(/live|±/i);
    expect(foreverHtml).toContain("0, 0");
    expect(foreverHtml).toContain("live until stopped");
  });

  it("draws the phone numbers, card numbers, text links and text mentions a test gives", () => {
    const text = "Call +1 212 555 0123, read the docs, ask Zed, pay 4242424242424242";
    const url = 'https://example.com/docs?a=1&b="2"';
    const zed = { id: 8800000009, is_bot: false, first_name: 'Zed "<b>"' };
    const item = message({
      from: ANN,
      text,
      entities: [
        { type: "phone_number", offset: 5, length: 15 },
        { type: "text_link", offset: text.indexOf("docs"), length: 4, url },
        {
          type: "text_mention",
          offset: text.indexOf("Zed"),
          length: 3,
          user: zed,
        },
        {
          type: "bank_card_number",
          offset: text.indexOf("4242"),
          length: 16,
        },
      ],
    });
    const html = renderMessage(item, makeContext(pageOf([item])));
    expectSafe(html);
    expect(html).toContain(
      '<span class="tv-entity" data-entity="phone_number">+1 212 555 0123</span>',
    );
    expect(html).toContain(
      '<span class="tv-entity" data-entity="bank_card_number">4242424242424242</span>',
    );
    expect(html).toContain(
      `<a class="tv-link" href="${escaped(url)}" target="_blank" rel="noopener noreferrer" title="${escaped(url)}">docs</a>`,
    );
    expect(html).toContain(
      `data-entity="text_mention" title="${escaped(`${zed.first_name} · user ${zed.id}`)}">Zed</span>`,
    );
    expect(html).not.toContain(zed.first_name);
  });

  it("draws a reposted file as it drew the original", () => {
    const sizes = [
      { file_id: "small", file_unique_id: "u1", width: 90, height: 60 },
      { file_id: "large", file_unique_id: "u2", width: 320, height: 240 },
    ];
    const report = {
      file_id: "doc",
      file_unique_id: "u3",
      file_name: "report <final>.pdf",
      mime_type: "application/pdf",
      file_size: 2048,
    };
    const items = [
      message({ from: ANN, photo: sizes, caption: "receipt" }),
      message({ from: EVE, photo: sizes, caption: "again" }),
      message({ from: ANN, document: report }),
      message({ from: EVE, document: report }),
    ];
    const ctx = makeContext(
      pageOf(items, {
        files: {
          large: { url: "/_fake/ui/files/large", width: 320, height: 240 },
        },
      }),
    );
    const media = items.map(
      (item) =>
        renderMessage(item, ctx).match(
          /<div class="tv-(?:media|file)".*?<\/div>/,
        )?.[0],
    );
    expectSafe(media.join("\n"));
    expect(media[0]).toContain('src="/_fake/ui/files/large"');
    expect(media[1]).toBe(media[0]);
    expect(media[2]).toContain(escaped("report <final>.pdf"));
    expect(media[3]).toBe(media[2]);
  });

  it("shows a person's promotion and demotion in the member panel and the event lines", () => {
    const admin = {
      status: "administrator",
      custom_title: "Mods <b>",
      is_anonymous: true,
      can_manage_chat: true,
      can_delete_messages: true,
      can_restrict_members: false,
    };
    const card = (member) =>
      memberEntries(
        pageOf([], {
          members: [{ user_id: ANN.id, member }],
          members_total: 1,
        }),
        makeContext(pageOf([])),
      )
        .map((entry) => entry.html)
        .join("");
    const promotedCard = card(admin);
    const demotedCard = card({ status: "member" });
    expectSafe(`${promotedCard}\n${demotedCard}`);
    expect(promotedCard).toContain(
      `data-member-id="${ANN.id}" data-member-status="administrator"`,
    );
    expect(promotedCard).toContain(
      "<dt>Rights</dt><dd>manage chat, delete messages</dd><dt>Anonymous</dt><dd>yes</dd>",
    );
    expect(promotedCard).toContain(
      `<dt>Title</dt><dd>${escaped("Mods <b>")}</dd>`,
    );
    expect(demotedCard).toContain('data-member-status="member"');
    expect(demotedCard).not.toMatch(/Rights|Anonymous|Title/);

    const change = (seq, old, now) => ({
      kind: "event",
      seq,
      at: 1,
      type: "member",
      user_id: ANN.id,
      actor_id: OLGA.id,
      request_id: null,
      reason: "change",
      old,
      new: now,
    });
    const ctx = makeContext(pageOf([]));
    expect(renderEvent(change(1, { status: "member" }, admin), ctx)).toContain(
      "Ann Lee promoted: manage chat, delete messages, anonymous by Olga",
    );
    expect(renderEvent(change(2, admin, { status: "member" }), ctx)).toContain(
      "Ann Lee demoted by Olga",
    );
  });

  it("labels a deleted bot as deleted wherever it names it", () => {
    const page = pageOf([], {
      bots: [
        { ...pageOf([]).bots[0] },
        { ...pageOf([]).bots[1], deleted: true },
      ],
      members: [{ user_id: SECOND.id, member: { status: "left" } }],
      members_total: 1,
    });
    const ctx = makeContext(page);
    const said = renderMessage(
      message({ from: SECOND, text: "answer 2+2" }),
      ctx,
    );
    const left = renderMessage(
      message({ from: SECOND, left_chat_member: SECOND }),
      ctx,
    );
    const removed = renderMessage(
      message(
        { from: EVE, text: "spam" },
        {
          deleted: true,
          deleted_by: {
            bot_id: SECOND.id,
            method: "deleteMessage",
            at: 1_800_000_000_000,
          },
        },
      ),
      ctx,
    );
    const event = renderEvent(
      {
        kind: "event",
        seq: 1,
        at: 1,
        type: "member",
        user_id: SECOND.id,
        actor_id: SECOND.id,
        reason: "change",
        old: { status: "administrator" },
        new: { status: "left" },
      },
      ctx,
    );
    const card = memberEntries(page, ctx)
      .map((entry) => entry.html)
      .join("");
    const call = renderCall(
      {
        journal: "rejected_requests",
        bot_id: SECOND.id,
        method: "getMe",
        outcome: "rejected",
        status: 401,
        description: "Unauthorized",
        request_number: 4,
        at: 1,
      },
      makeContext({ ...page, chat: null }, { key: "calls" }),
    );
    const row = chatListEntries(
      {
        bots: page.bots,
        users: page.users,
        chats: [
          {
            key: `${ANN.id}:${SECOND.id}`,
            id: ANN.id,
            type: "private",
            user_id: ANN.id,
            bot_id: SECOND.id,
            title: "Ann Lee",
            last: null,
          },
        ],
      },
      { view: parseView("") },
    )[0].html;
    const tag = '<span class="tv-tag">deleted bot</span>';
    expect(said).toContain(tag);
    expect(left).toContain(`Second Bot ${tag} left`);
    expect(event).toContain(`Second Bot ${tag} left`);
    expect(card).toContain(
      `@second_bot <span class="tv-tag">deleted bot</span>`,
    );
    expect(call).toContain(`Second Bot ${tag}`);
    expect(removed).toContain("Deleted · @second_bot (deleted bot)");
    expect(row).toContain("with @second_bot</span>");
    expect(row).toContain('<span class="tv-chip">deleted bot</span>');
  });

  it("names the chat list's last poster as the chat shows them", () => {
    const row = (last) =>
      chatListEntries(
        {
          bots: pageOf([]).bots,
          users: pageOf([]).users,
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
                preview: "hello",
                media: null,
                deleted: false,
                ephemeral: false,
                ...last,
              },
            },
          ],
        },
        { view: parseView("") },
      )[0].html;
    // An anonymous admin posts as the group itself: no name before the text.
    const anonymous = row({ author: ANN.id, sender_chat: CHAT });
    expect(anonymous).not.toContain("tv-list-author");
    expect(anonymous).not.toContain("Ann");
    const sentAs = row({ author: OLGA.id, sender_chat: NEWS });
    expect(sentAs).toContain(
      `<span class="tv-list-author">${escaped("News <i>")}:</span> hello`,
    );
    expect(sentAs).not.toContain("Olga");
    expect(row({ author: ANN.id })).toContain(
      '<span class="tv-list-author">Ann Lee:</span> hello',
    );
  });

  it("draws a message's reactions as chips, names who chose each, and marks a member's own", () => {
    // Each chip is one image to a screen reader, named by its emoji (or
    // custom emoji), its count, and who chose it or that it is the member's.
    const reactions = [
      {
        type: "emoji",
        emoji: "👍",
        total_count: 2,
        user_ids: [OLGA.id, EVE.id],
      },
      {
        type: "custom_emoji",
        custom_emoji_id: "5368324170671202286",
        total_count: 1,
        user_ids: [BOT.id],
      },
      {
        type: "emoji",
        emoji: "<b>bad</b>",
        total_count: 1,
        user_ids: [ANN.id],
      },
    ];
    const post = message({ from: ANN, text: "React to me" }, { reactions });
    const pinned = message(
      { from: OLGA, pinned_message: post.message },
      { reactions: reactions.slice(0, 1) },
    );
    const plain = message({ from: ANN, text: "No reactions" });
    // Each chip's attributes, in the order drawn.
    const chipsOf = (html) =>
      [...html.matchAll(/<span class="tv-reaction"([^>]*)>/g)].map(([, rest]) =>
        Object.fromEntries(
          [...rest.matchAll(/\s([a-z-]+)="([^"]*)"/g)].map(
            ([, name, value]) => [name, value],
          ),
        ),
      );
    const draw = (item, as) =>
      renderMessage(item, makeContext(pageOf([item]), { as }));

    const testView = draw(post);
    // Eve's name holds " onerror=", which expectSafe refuses even escaped in
    // an attribute: her name is checked escaped in the title instead.
    for (const value of HOSTILE) expect(testView).not.toContain(value);
    expect(chipsOf(testView)).toEqual([
      {
        "data-reaction-type": "emoji",
        "data-reaction-emoji": "👍",
        "data-reaction-count": "2",
        "data-reaction-user-ids": `${OLGA.id} ${EVE.id}`,
        title: escaped(`Olga, ${EVE.first_name}`),
        role: "img",
        "aria-label": escaped(`👍, 2: Olga, ${EVE.first_name}`),
      },
      {
        "data-reaction-type": "custom_emoji",
        "data-custom-emoji-id": "5368324170671202286",
        "data-reaction-count": "1",
        "data-reaction-user-ids": String(BOT.id),
        title: "custom emoji 5368324170671202286 · Example Bot",
        role: "img",
        "aria-label": "custom emoji 5368324170671202286, 1: Example Bot",
      },
      {
        "data-reaction-type": "emoji",
        "data-reaction-emoji": escaped("<b>bad</b>"),
        "data-reaction-count": "1",
        "data-reaction-user-ids": String(ANN.id),
        title: "Ann Lee",
        role: "img",
        "aria-label": escaped("<b>bad</b>, 1: Ann Lee"),
      },
    ]);
    expect(testView).toContain(
      '<span class="tv-reaction-emoji">👍</span><span class="tv-reaction-count">2</span>',
    );
    expect(chipsOf(draw(pinned))).toHaveLength(1);
    expect(draw(plain)).not.toContain("tv-reaction");

    // Seen as Eve: the counts, her own reaction marked, and nobody's name.
    const asEve = draw(post, EVE.id);
    expectSafe(asEve);
    expect(chipsOf(asEve)).toEqual([
      {
        "data-reaction-type": "emoji",
        "data-reaction-emoji": "👍",
        "data-reaction-count": "2",
        "data-reaction-mine": "true",
        title: "your reaction",
        role: "img",
        "aria-label": "👍, 2, your reaction",
      },
      {
        "data-reaction-type": "custom_emoji",
        "data-custom-emoji-id": "5368324170671202286",
        "data-reaction-count": "1",
        title: "custom emoji 5368324170671202286",
        role: "img",
        "aria-label": "custom emoji 5368324170671202286, 1",
      },
      {
        "data-reaction-type": "emoji",
        "data-reaction-emoji": escaped("<b>bad</b>"),
        "data-reaction-count": "1",
        role: "img",
        "aria-label": escaped("<b>bad</b>, 1"),
      },
    ]);
    expect(chipsOf(draw(post, OLGA.id))[0]["data-reaction-mine"]).toBe("true");
    expect(chipsOf(draw(post, ANN.id))[0]["data-reaction-mine"]).toBe(
      undefined,
    );
  });
});
