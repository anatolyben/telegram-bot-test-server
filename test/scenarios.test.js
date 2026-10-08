// Scenario reports a test runner sends: progress, results, failure evidence
// and labels, which the viewer and recordings show. Test-only controls, apart
// from Telegram's behavior.
import { afterEach, expect, it } from "vitest";

import { startTestServer } from "../src/index.js";
import {
  makeContext,
  renderScenario,
  scenarioShown,
} from "../src/ui/render.js";

const TOKEN = "123456:SCENARIO-SECRET";
const CHAT = -1001000000001;
const OTHER = -1001000000002;
const OWNER = 5000000001;
const cleanups = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()();
});

async function setup() {
  const fake = await startTestServer({
    botToken: TOKEN,
    chats: [
      { id: CHAT, title: "Shop", ownerId: OWNER },
      { id: OTHER, title: "Log", ownerId: OWNER },
    ],
    ui: true,
  });
  cleanups.push(() => fake.stop());
  const api = async (method, params = {}) => {
    const response = await fetch(`${fake.origin}/bot${TOKEN}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(params),
    });
    return { status: response.status, ...(await response.json()) };
  };
  const control = async (method, path, body) => {
    const response = await fetch(`${fake.origin}/_fake/${path}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: await response.json() };
  };
  const page = async (ref) => {
    const response = await fetch(
      `${fake.viewerUrl}/api/chats/${encodeURIComponent(ref)}`,
    );
    expect(response.status).toBe(200);
    return response.json();
  };
  const ann = await fake.createUser({ first_name: "Ann" });
  await fake.join(CHAT, ann);
  return { fake, api, control, page, ann };
}

/** A page's scenario marks as "<run> <scenario> <phase> <status> <result>". */
const marks = (page) =>
  page.items
    .filter((item) => item.kind === "scenario")
    .map(
      (item) =>
        `${item.run_id} ${item.scenario_id} ${item.phase} ${item.status} ${item.result}`,
    );

it("keeps overlapping runs apart, also when they share a scenario id", async () => {
  const { fake, control, page, ann } = await setup();
  await fake.startScenario({ runId: "a", scenarioId: "spam", chats: [CHAT] });
  // The second run's start goes over HTTP.
  expect(
    await control("POST", "scenarios/start", {
      run_id: "b",
      scenario_id: "spam",
      chats: [OTHER],
    }),
  ).toMatchObject({
    status: 200,
    body: { run_id: "b", scenario_id: "spam", status: "running" },
  });
  await expect(
    fake.startScenario({ runId: "a", scenarioId: "spam" }),
  ).rejects.toThrow("scenario spam of run a is already reported");
  await fake.post(CHAT, ann, "in run a");
  await fake.finishScenario({
    runId: "b",
    scenarioId: "spam",
    result: "failed",
  });
  await fake.finishScenario({
    runId: "a",
    scenarioId: "spam",
    result: "passed",
  });

  expect(
    (await fake.getScenarios({ runId: "a" })).scenarios.map((each) => [
      each.run_id,
      each.status,
      each.result,
    ]),
  ).toEqual([["a", "finished", "passed"]]);
  expect(
    (await control("GET", "scenarios?run_id=b")).body.scenarios,
  ).toMatchObject([{ run_id: "b", result: "failed" }]);
  // Each chat shows the run that named it; the Activity feed shows both.
  expect(marks(await page(CHAT))).toEqual([
    "a spam start finished passed",
    "a spam finish finished passed",
  ]);
  expect(marks(await page(OTHER))).toEqual([
    "b spam start finished failed",
    "b spam finish finished failed",
  ]);
  expect(marks(await page("all"))).toEqual([
    "a spam start finished passed",
    "b spam start finished failed",
    "b spam finish finished failed",
    "a spam finish finished passed",
  ]);
  const state = await (await fetch(`${fake.viewerUrl}/api/state`)).json();
  expect(state.runs.map((run) => run.run_id)).toEqual(["a", "b"]);
  // The run filter keeps one run's marks and everything else.
  const kept = (await page("all")).items.filter((item) =>
    scenarioShown(item, { runs: ["b"] }),
  );
  expect(marks({ items: kept })).toEqual([
    "b spam start finished failed",
    "b spam finish finished failed",
  ]);
  expect(kept.some((item) => item.kind === "message")).toBe(true);
});

it("shows failed and skipped as the runner reported them, and never infers a result", async () => {
  const { fake, page } = await setup();
  await fake.startScenario({
    runId: "r",
    scenarioId: "checkout",
    title: "Checkout <works>",
  });
  await fake.startScenario({ runId: "r", scenarioId: "still-going" });
  await fake.finishScenario({
    runId: "r",
    scenarioId: "checkout",
    result: "failed",
    failure: { message: "expected a receipt" },
  });
  // A skipped scenario need not have started.
  await fake.finishScenario({
    runId: "r",
    scenarioId: "later",
    result: "skipped",
  });
  await expect(
    fake.finishScenario({ runId: "r", scenarioId: "still-going" }),
  ).rejects.toThrow('result must be "passed", "failed" or "skipped"');
  await expect(
    fake.finishScenario({
      runId: "r",
      scenarioId: "still-going",
      result: "passed",
      failure: { message: "no" },
    }),
  ).rejects.toThrow("only a failed scenario has a failure");

  const { scenarios } = await fake.getScenarios();
  expect(
    scenarios.map((each) => [each.scenario_id, each.status, each.result]),
  ).toEqual([
    ["checkout", "finished", "failed"],
    ["still-going", "running", null],
    ["later", "finished", "skipped"],
  ]);
  const items = (await page("all")).items.filter(
    (item) => item.kind === "scenario",
  );
  const ctx = makeContext({ chat: { key: "all" }, bots: [], users: {} });
  const html = items.map((item) => renderScenario(item, ctx)).join("");
  expect(html).toContain('data-scenario-result="failed"');
  expect(html).toContain('data-scenario-result="skipped"');
  expect(html).toContain('data-scenario-status="running"');
  expect(html).not.toContain('data-scenario-result="passed"');
  expect(html).toContain("expected a receipt");
  expect(html).toContain("Checkout &lt;works&gt;");
});

it("points a failure at messages, calls and events that exist, and refuses any other", async () => {
  const { fake, api, page, ann } = await setup();
  await fake.startScenario({ runId: "r", scenarioId: "ban" });
  await fake.post(CHAT, ann, "buy followers");
  const [spam] = (await fake.getMessageLog(CHAT)).messages.slice(-1);
  await api("banChatMember", { chat_id: CHAT, user_id: ann });
  const { calls } = await fake.getCalls();
  const ban = calls.at(-1);
  const event = (await page(CHAT)).items.findLast(
    (item) => item.kind === "event",
  );
  await expect(
    fake.finishScenario({
      runId: "r",
      scenarioId: "ban",
      result: "failed",
      failure: { message: "x", evidence: [{ kind: "message", seq: 999999 }] },
    }),
  ).rejects.toThrow("evidence message seq 999999 is not in the message log");
  await fake.finishScenario({
    runId: "r",
    scenarioId: "ban",
    result: "failed",
    failure: {
      message: "the bot banned instead of warning",
      evidence: [
        { kind: "message", seq: spam.seq, labels: { role: "trigger" } },
        { kind: "call", requestId: ban.request_id },
        { kind: "event", eventId: event.seq },
      ],
    },
  });

  const chat = await page(CHAT);
  const finish = chat.items.find(
    (item) => item.kind === "scenario" && item.phase === "finish",
  );
  expect(finish.failure.evidence).toMatchObject([
    {
      kind: "message",
      seq: spam.seq,
      chat_ref: String(CHAT),
      chat_label: "Shop",
      labels: { role: "trigger" },
      subject: { seq: spam.seq, author: ann },
    },
    {
      kind: "call",
      request_id: ban.request_id,
      chat_ref: String(CHAT),
      labels: {},
      subject: { method: "banChatMember", outcome: "succeeded" },
    },
    {
      kind: "event",
      event_id: event.seq,
      chat_ref: String(CHAT),
      labels: {},
      subject: { seq: event.seq, user_id: ann },
    },
  ]);
  // Each piece of evidence is on the chat's page.
  expect(chat.items.some((item) => item.seq === spam.seq)).toBe(true);
  expect(chat.items.some((item) => item.seq === event.seq)).toBe(true);
  expect(chat.calls.some((call) => call.request_id === ban.request_id)).toBe(
    true,
  );
  // The marker names it for the page's highlight, and says what each is
  // with the names the page carries.
  const html = renderScenario(finish, makeContext(chat));
  expect(html).toContain(`data-evidence-seqs="${spam.seq} ${event.seq}"`);
  expect(html).toContain(`data-evidence-requests="${ban.request_id}"`);
  const words = [...html.matchAll(/<li class="tv-evidence">(.*?)<\/li>/g)].map(
    ([, item]) => item.replace(/<[^>]+>/g, ""),
  );
  expect(words).toEqual([
    "Ann: “buy followers” in Shop role: trigger",
    "Example Bot called banChatMember: succeeded",
    "Ann banned forever by Example Bot",
  ]);
});

it("finds a refused request named as evidence among the calls without a chat", async () => {
  const { fake, page } = await setup();
  await fake.startScenario({ runId: "r", scenarioId: "token" });
  await fetch(`${fake.origin}/bot999:WRONG/getMe`);
  const refused = (await fake.getCalls()).rejected_requests.at(-1);
  await fake.finishScenario({
    runId: "r",
    scenarioId: "token",
    result: "failed",
    failure: {
      message: "the bot used a revoked token",
      evidence: [{ kind: "call", requestId: refused.request_id }],
    },
  });

  const finish = (await page("all")).items.find(
    (item) => item.kind === "scenario" && item.phase === "finish",
  );
  expect(finish.failure.evidence).toMatchObject([
    {
      kind: "call",
      request_id: refused.request_id,
      chat_ref: "calls",
      subject: { method: "getMe", outcome: "rejected", status: 401 },
    },
  ]);
});

it("keeps a scenario's labels and evidence in an offline recording", async () => {
  const { fake, ann } = await setup();
  const evidence = await fake.post(CHAT, ann, "from before the recording");
  const [entry] = (await fake.getMessageLog(CHAT)).messages.filter(
    (each) => each.message.message_id === evidence,
  );
  await fake.startRecording("labeled");
  await fake.startScenario({
    runId: "r",
    scenarioId: "reply",
    labels: { model: "local", mode: "fixture" },
    chats: [CHAT],
  });
  await fake.post(CHAT, ann, "hello");
  await fake.finishScenario({
    runId: "r",
    scenarioId: "reply",
    result: "failed",
    labels: { failure: "injected" },
    failure: {
      message: "no answer",
      evidence: [{ kind: "message", seq: entry.seq }],
    },
  });
  const { json, html } = await fake.stopRecording("labeled");

  const scenario = json.pages[CHAT].items.filter(
    (item) => item.kind === "scenario",
  );
  expect(scenario.map((item) => [item.phase, item.labels])).toEqual([
    ["start", { model: "local", mode: "fixture", failure: "injected" }],
    ["finish", { model: "local", mode: "fixture", failure: "injected" }],
  ]);
  // The evidence from before the start comes along as context.
  expect(
    json.pages[CHAT].items.find((item) => item.seq === entry.seq),
  ).toMatchObject({ before_window: true });
  expect(json.state.runs).toEqual([
    expect.objectContaining({ run_id: "r", failed: 1 }),
  ]);
  expect(html).toContain('"model":"local"');
});

it("shows unknown for a label a scenario lacks, and for a scenario with none", async () => {
  const { fake, page } = await setup();
  await fake.startScenario({
    runId: "r",
    scenarioId: "one",
    labels: { model: "local" },
  });
  await fake.startScenario({ runId: "r", scenarioId: "two" });
  await fake.startScenario({ runId: "bare", scenarioId: "three" });

  const ctx = makeContext({ chat: { key: "all" }, bots: [], users: {} });
  const drawn = Object.fromEntries(
    (await page("all")).items
      .filter((item) => item.kind === "scenario")
      .map((item) => [item.scenario_id, renderScenario(item, ctx)]),
  );
  expect(drawn.one).toContain("model: local");
  expect(drawn.two).toContain("model: unknown");
  expect(drawn.three).toContain("labels: unknown");
  expect((await fake.getScenarios({ runId: "r" })).scenarios[1].labels).toEqual(
    {},
  );
});
