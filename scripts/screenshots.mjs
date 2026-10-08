// Regenerates the README screenshots in docs/images: a small grammY moderation
// bot looks after a book club while the script plays its members, and
// Playwright photographs the viewer.
//
// Needs Playwright and its Chromium, which this package does not depend on.
// Point PLAYWRIGHT at an installed playwright package, or leave it unset to
// import "playwright" from wherever Node finds it:
//   PLAYWRIGHT=/path/to/node_modules/playwright node scripts/screenshots.mjs
import http from "node:http";
import { mkdir, stat } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Bot, GrammyError, InlineKeyboard, webhookCallback } from "grammy";
import { startTestServer } from "../src/index.js";
import { startWatch } from "../src/watch.js";

// Only this script's servers appear on the watch page.
const WATCH_DIR = mkdtempSync(path.join(tmpdir(), "screenshots-watch-"));
process.env.TELEGRAM_TEST_SERVER_WATCH_DIR = WATCH_DIR;

const { chromium } = await import(
  process.env.PLAYWRIGHT
    ? pathToFileURL(`${process.env.PLAYWRIGHT.replace(/\/+$/, "")}/index.mjs`)
        .href
    : "playwright"
);

const IMAGES = fileURLToPath(new URL("../docs/images/", import.meta.url));
const TOKEN = "7349051862:shelf-guard";
const CLUB = -1001873462190;
const LOG = -1001873462191;
const ANN = 418273655;
const MINUTE = 60 * 1000;
// Friday, October 2, 2026, 17:20 UTC: a fixed start, so every run reads
// alike. Only advanceTime moves this clock, and the story keeps to one
// evening, so the chat list's times read newest first.
const START = Date.UTC(2026, 9, 2, 17, 20);

const server = await startTestServer({
  botToken: TOKEN,
  botUsername: "shelfguard_bot",
  botName: "Shelf Guard",
  chats: [
    { id: CLUB, title: "Book Club", ownerId: ANN, ownerName: "Ann" },
    { id: LOG, title: "Book Club Log", ownerId: ANN, ownerName: "Ann" },
  ],
  clock: { now: START },
  ui: true,
  name: "Book Club",
});
const later = (minutes) => server.advanceTime(minutes * MINUTE);

// ── The bot ───────────────────────────────────────────────────────────

const bot = new Bot(TOKEN, { client: { apiRoot: server.origin } });
const RULES =
  "Be kind. Mark spoilers. No ads or links to shops. Happy reading!";

bot.command("start", (ctx) =>
  ctx.reply(
    `Hi ${ctx.from.first_name}! I look after Book Club: I let people in, welcome them and ` +
      "remove links. Everything I do goes to Book Club Log.",
  ),
);

bot.on("chat_join_request", async (ctx) => {
  await ctx.approveChatJoinRequest(ctx.from.id);
  await ctx.api.sendMessage(LOG, `✅ Let ${ctx.from.first_name} in`);
});

bot.on("message:new_chat_members", async (ctx) => {
  for (const member of ctx.message.new_chat_members) {
    if (member.is_bot) continue;
    await ctx.reply(
      `Welcome to the Book Club, ${member.first_name}! 📚 Please read the rules before you post.`,
      { reply_markup: new InlineKeyboard().text("Rules", "rules") },
    );
  }
});

bot.callbackQuery("rules", (ctx) =>
  ctx.answerCallbackQuery({ text: RULES, show_alert: true }),
);

// The owner makes a member an administrator: /promote <title>, as a reply.
bot.command("promote", async (ctx) => {
  const target = ctx.message.reply_to_message?.from;
  if (ctx.from.id !== ANN || !target) return;
  await ctx.promoteChatMember(target.id, {
    can_delete_messages: true,
    can_pin_messages: true,
    can_invite_users: true,
  });
  await ctx.setChatAdministratorCustomTitle(target.id, ctx.match || "Admin");
});

// A link: mute its author for an hour, then remove it. Telegram refuses to
// mute an administrator, and then the link stays.
bot.on("message::url", async (ctx) => {
  if (ctx.chat.id !== CLUB) return;
  const name = ctx.from.first_name;
  try {
    await ctx.restrictAuthor(
      { can_send_messages: false },
      { until_date: ctx.message.date + 60 * 60 },
    );
  } catch (error) {
    if (!(error instanceof GrammyError)) throw error;
    await ctx.api.sendMessage(LOG, `ℹ️ Kept a link from ${name}, an admin`);
    return;
  }
  await ctx.deleteMessage();
  await ctx.api.sendMessage(
    LOG,
    `🔇 Removed a link from ${name}, who can post again in an hour`,
  );
});

bot.catch((error) => console.error(error.error ?? error));

const receiver = http.createServer(webhookCallback(bot, "http"));
await new Promise((resolve) => receiver.listen(0, "127.0.0.1", resolve));
await bot.init();
await bot.api.setWebhook(`http://127.0.0.1:${receiver.address().port}/`);

// ── The story ─────────────────────────────────────────────────────────

const quiet = () => server.waitFor({ kind: "quiet", ms: 100 });
const bob = await server.createUser({ first_name: "Bob" });
const carol = await server.createUser({ first_name: "Carol" });
const dave = await server.createUser({ first_name: "Dave" });

// Ann sets the bot up, Bob and Dave join, and Ann makes Dave the club's
// librarian.
await server.sendDirectMessage(ANN, "/start");
await server.setBotMembership(CLUB, bot.botInfo.id, {
  rights: {
    can_manage_chat: true,
    can_change_info: true,
    can_delete_messages: true,
    can_invite_users: true,
    can_restrict_members: true,
    can_pin_messages: true,
    can_promote_members: true,
  },
});
const invite = await bot.api.createChatInviteLink(CLUB, {
  name: "Website",
  creates_join_request: true,
});
await later(4);
await server.join(CLUB, bob);
await later(9);
await server.join(CLUB, dave);
const hello = await server.post(CLUB, dave, "Hi all! Happy to be here.");
await later(2);
await server.post(CLUB, ANN, { text: "/promote Librarian", replyTo: hello });
await quiet();

// Later that evening Carol asks to join through the website's link.
await later(17);
await server.joinByLink(invite.invite_link, carol);
await quiet();
const welcome = await server.waitFor({
  kind: "message",
  chatId: CLUB,
  contains: "Carol",
  buttonText: "Rules",
});
await later(1);
await server.pressButton(CLUB, welcome.message.message_id, carol, "rules");
await later(2);
const pick = await server.post(
  CLUB,
  ANN,
  "Welcome, Carol! This month we're reading Pride and Prejudice 📖 We meet next Friday at 7 pm.",
);
await later(1);
const thanks = await server.post(CLUB, carol, {
  text: "Thank you! I just finished chapter 3. Mr. Darcy, really? 😄",
  replyTo: pick,
});
await later(2);
await server.post(
  CLUB,
  bob,
  "Every bestseller free, no signup 👉 free-ebooks.example.net",
);
await quiet();
await later(1);
const schedule = await server.post(
  CLUB,
  dave,
  "Our reading schedule: https://bookclub.example.org/schedule",
);
await quiet();
await server.react(CLUB, pick, carol, "❤");
await server.react(CLUB, pick, dave, "❤");
await server.react(CLUB, pick, bob, "👍");
await server.react(CLUB, thanks, ANN, "😁");
await server.react(CLUB, thanks, dave, "😁");
await server.react(CLUB, schedule, carol, "🙏");
await server.react(CLUB, schedule, ANN, "🔥");
await quiet();

// ── Four more servers, as parallel test workers would run them ────────

// Each has its own group and a bot that welcomes newcomers, removes a link
// and mutes its author, played directly through the Bot API.
const others = [];
for (const [index, story] of [
  {
    title: "Running Club",
    lines: ["Sunday long run: 8 am at the park gate 🏃", "Count me in!"],
  },
  {
    title: "Study Group",
    lines: ["Chapter 5 notes are up. Quiz on Thursday.", "Thanks! 🙏"],
  },
  {
    title: "Garden Swap",
    lines: ["Spare tomato seedlings, anyone? 🍅", "Yes please, two!"],
  },
  {
    title: "Chess Night",
    lines: ["Tonight 7 pm, bring a board ♟️", "I'll bring two."],
  },
].entries()) {
  const token = `70000000${index}:watch-${index}`;
  const chat = -1001900000000 - index;
  const owner = 500000000 + index;
  const other = await startTestServer({
    botToken: token,
    botUsername: `helper${index}_bot`,
    botName: "Helper",
    chats: [{ id: chat, title: story.title, ownerId: owner, ownerName: "Ann" }],
    clock: { now: START },
    ui: true,
    name: story.title,
  });
  others.push(other);
  const botId = Number(token.split(":")[0]);
  await other.setBotMembership(chat, botId, {
    rights: { can_delete_messages: true, can_restrict_members: true },
  });
  const api = (method, body) =>
    fetch(`${other.origin}/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).then((response) => response.json());
  const [first, second, spammer] = [
    await other.createUser({ first_name: "Mia" }),
    await other.createUser({ first_name: "Leo" }),
    await other.createUser({ first_name: "Max" }),
  ];
  for (const member of [first, second, spammer]) {
    await other.join(chat, member);
    await api("sendMessage", {
      chat_id: chat,
      text: `Welcome to ${story.title}! 👋`,
    });
  }
  await other.post(chat, first, story.lines[0]);
  await other.post(chat, second, story.lines[1]);
  const spam = await other.post(
    chat,
    spammer,
    "Easy money, click here 👉 earn-fast.example.net",
  );
  await api("restrictChatMember", {
    chat_id: chat,
    user_id: spammer,
    permissions: { can_send_messages: false },
  });
  await api("deleteMessage", { chat_id: chat, message_id: spam });
}

// ── The pictures ──────────────────────────────────────────────────────

await mkdir(IMAGES, { recursive: true });
const browser = await chromium.launch();
try {
  // GitHub and npm show the hero in a column 630 to 815 pixels wide. Drawn
  // 1600 pixels wide it stays sharp on high-density screens, and a window
  // this narrow keeps its text readable there. The chat wallpaper makes a
  // PNG large, so the hero is a JPEG. The chat list and the chat,
  // with its calls and events, share it; the members panel is left out, so
  // their rows have room.
  await shoot({
    file: "viewer-desktop.jpg",
    viewport: { width: 1180, height: 960 },
    scale: 1600 / 1180,
    query: `chat=all&show=list,chat,calls,events&theme=light`,
  });
  await shoot({
    file: "viewer-as-member.png",
    viewport: { width: 375, height: 667 },
    scale: 1.5,
    query: `chat=${CLUB}&as=${carol}&theme=light`,
  });
  await shootWatch("watch-five-servers.jpg");
} finally {
  await browser.close();
  await server.stop();
  for (const other of others) await other.stop();
  receiver.close();
  rmSync(WATCH_DIR, { recursive: true, force: true });
}

// The watch page with all five servers, each panel showing its own group.
async function shootWatch(file) {
  const watch = await startWatch({ port: 0 });
  try {
    const viewport = { width: 1800, height: 820 };
    const page = await browser.newPage({
      viewport,
      deviceScaleFactor: 1600 / 1800 > 1 ? 1600 / 1800 : 1,
    });
    await page.goto(watch.url);
    await page.waitForFunction(
      () => document.querySelectorAll(".pane iframe").length === 5,
    );
    // Every viewer has drawn its chat.
    for (const frame of page.frames().slice(1))
      await frame.waitForSelector("[data-kind]", { timeout: 10_000 });
    await page.waitForTimeout(800);
    const target = `${IMAGES}${file}`;
    await page.screenshot({ path: target, type: "jpeg", quality: 80 });
    await page.close();
    console.log(`${target}: ${Math.round((await stat(target)).size / 1024)} KB`);
  } finally {
    await watch.close();
  }
}

async function shoot({ file, viewport, scale, query }) {
  const page = await browser.newPage({ viewport, deviceScaleFactor: scale });
  await page.goto(`${server.viewerUrl}?${query}`);
  // The page keeps its event stream open, so wait for its version instead.
  const viewer = new URL(server.viewerUrl).origin;
  const { version } = await (
    await fetch(`${viewer}/_fake/ui/api/state`)
  ).json();
  await page.waitForFunction(
    (wanted) =>
      Number(document.body.dataset.version) >= wanted &&
      !document.body.hasAttribute("data-busy"),
    version,
  );
  await showTopWhole(page, viewport);
  // GitHub and npm draw no frame around an image, and the viewer's white
  // edges would run into their white page: draw one into the picture.
  await page.evaluate(() => {
    const frame = document.createElement("div");
    frame.style.cssText =
      "position:fixed;inset:0;border:1px solid #d0d7de;pointer-events:none;z-index:2147483647";
    document.documentElement.append(frame);
  });
  const path = `${IMAGES}${file}`;
  await page.screenshot(
    file.endsWith(".jpg") ? { path, type: "jpeg", quality: 80 } : { path },
  );
  await page.close();
  console.log(`${path}: ${Math.round((await stat(path)).size / 1024)} KB`);
}

// The chat shows its latest items, so its top edge may cut one in half.
// Make the window that much shorter or taller, whichever is less, and
// scroll back to the latest.
async function showTopWhole(page, viewport) {
  const chat = '[data-panel="chat"] [data-slot="scroll"]';
  const cut = await page.$eval(chat, (scroll) => {
    const top = scroll.getBoundingClientRect().top;
    const item = [...scroll.querySelectorAll("[data-kind]")].find(
      (each) => each.getBoundingClientRect().bottom > top,
    );
    const box = item?.getBoundingClientRect();
    return box && box.top < top
      ? { hidden: top - box.top, shown: box.bottom - top }
      : null;
  });
  if (cut) {
    const GAP = 6;
    const change =
      cut.shown < cut.hidden ? -(cut.shown + GAP) : cut.hidden + GAP;
    await page.setViewportSize({
      width: viewport.width,
      height: Math.round(viewport.height + change),
    });
    await page.$eval(chat, (scroll) => {
      scroll.scrollTop = scroll.scrollHeight;
    });
  }
  await page.waitForTimeout(300);
}
