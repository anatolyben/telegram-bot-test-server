import { createHash, createPublicKey, randomBytes, verify } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

import { startTestServer } from "../src/index.js";

const TOKEN = "123456:TEST-TOKEN";
const SECRET = "test-login-secret";
const REDIRECT = "https://app.example/auth/callback";

const cleanups = [];
afterEach(async () => {
  vi.useRealTimers();
  while (cleanups.length) await cleanups.pop()();
});

async function setup() {
  const fake = await startTestServer({
    botToken: TOKEN,
    botName: "Example App",
    loginClientSecret: SECRET,
  });
  cleanups.push(() => fake.stop());
  const user = await fake.createUser({
    first_name: "Ann",
    last_name: "Lee",
    username: "annlee",
  });
  await fake.addProfilePhoto(user, Buffer.from("face"));
  return { fake, user };
}

/** An authorization request as a relying party builds it, with PKCE. */
function authorization(fake, overrides = {}) {
  const verifier = randomBytes(32).toString("base64url");
  const url = new URL("/auth", fake.origin);
  url.search = new URLSearchParams({
    client_id: "123456",
    redirect_uri: REDIRECT,
    response_type: "code",
    scope: "openid profile",
    state: "state-1",
    nonce: "nonce-1",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    ...overrides,
  });
  return { url: url.toString(), verifier };
}

function exchange(fake, fields, { secret = SECRET, clientId = "123456" } = {}) {
  return fetch(new URL("/token", fake.origin), {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${Buffer.from(`${clientId}:${secret}`).toString("base64")}`,
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      redirect_uri: REDIRECT,
      client_id: clientId,
      ...fields,
    }),
  });
}

/** Verify an ID token against the server's published keys; returns its claims. */
async function verifyIdToken(fake, idToken) {
  const discovery = await (
    await fetch(new URL("/.well-known/openid-configuration", fake.origin))
  ).json();
  const { keys } = await (await fetch(discovery.jwks_uri)).json();
  const [header, payload, signature] = idToken.split(".");
  const { kid, alg } = JSON.parse(Buffer.from(header, "base64url"));
  const jwk = keys.find((key) => key.kid === kid);
  expect(alg).toBe("RS256");
  expect(
    verify(
      "sha256",
      Buffer.from(`${header}.${payload}`),
      createPublicKey({ key: jwk, format: "jwk" }),
      Buffer.from(signature, "base64url"),
    ),
  ).toBe(true);
  return JSON.parse(Buffer.from(payload, "base64url"));
}

async function codeFor(fake, user, overrides) {
  const request = authorization(fake, overrides);
  const redirect = new URL(await fake.approveLogin(request.url, user));
  return { code: redirect.searchParams.get("code"), redirect, ...request };
}

describe("the Telegram Login code flow", () => {
  it("logs in through the page and returns an ID token that verifies against the JWKS", async () => {
    const { fake, user } = await setup();
    const { url, verifier } = authorization(fake);

    const page = await (await fetch(url)).text();
    expect(page).toContain("Log in as Ann Lee");
    const form = page.match(
      /<form method="post" action="([^"]+)"><input type="hidden" name="user_id" value="(\d+)">/,
    );
    const approved = await fetch(
      new URL(form[1].replaceAll("&amp;", "&"), fake.origin),
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ user_id: form[2] }),
        redirect: "manual",
      },
    );
    expect(approved.status).toBe(302);
    const back = new URL(approved.headers.get("location"));
    expect(back.origin + back.pathname).toBe(REDIRECT);
    expect(back.searchParams.get("state")).toBe("state-1");

    const tokens = await (
      await exchange(fake, {
        code: back.searchParams.get("code"),
        code_verifier: verifier,
      })
    ).json();
    expect(tokens).toMatchObject({
      token_type: "Bearer",
      expires_in: 3600,
      access_token: expect.any(String),
    });
    const claims = await verifyIdToken(fake, tokens.id_token);
    expect(claims).toMatchObject({
      iss: "https://oauth.telegram.org",
      aud: "123456",
      nonce: "nonce-1",
      id: user,
      name: "Ann Lee",
      given_name: "Ann",
      family_name: "Lee",
      preferred_username: "annlee",
      picture: expect.stringContaining(`/userpic/${user}.jpg`),
    });
    expect(claims.sub).toEqual(expect.any(String));
    expect(claims.exp - claims.iat).toBe(3600);
    const photo = await fetch(claims.picture);
    expect(Buffer.from(await photo.arrayBuffer())).toEqual(Buffer.from("face"));
  });

  it("returns only the openid claims without the profile scope", async () => {
    const { fake, user } = await setup();
    const { code, verifier } = await codeFor(fake, user, { scope: "openid" });
    const tokens = await (
      await exchange(fake, { code, code_verifier: verifier })
    ).json();
    const claims = await verifyIdToken(fake, tokens.id_token);
    expect(Object.keys(claims).sort()).toEqual(
      ["aud", "exp", "iat", "iss", "nonce", "sub"].sort(),
    );
  });

  it("gives a user the same sub every login", async () => {
    const { fake, user } = await setup();
    const subs = [];
    for (let round = 0; round < 2; round += 1) {
      const { code, verifier } = await codeFor(fake, user);
      const tokens = await (
        await exchange(fake, { code, code_verifier: verifier })
      ).json();
      subs.push((await verifyIdToken(fake, tokens.id_token)).sub);
    }
    expect(subs[0]).toBe(subs[1]);
  });

  it("redirects a cancelled login with access_denied and the state", async () => {
    const { fake } = await setup();
    const back = new URL(await fake.cancelLogin(authorization(fake).url));
    expect(Object.fromEntries(back.searchParams)).toEqual({
      error: "access_denied",
      state: "state-1",
    });
  });

  it("lets the bot message the user after a telegram:bot_access login", async () => {
    const { fake, user } = await setup();
    const shop = await fake.addBot({
      token: "777:SHOP-TOKEN",
      username: "shop_bot",
    });
    const bots = await (
      await fetch(new URL("/_fake/bots", fake.origin))
    ).json();
    const shopSecret = bots.find(
      (bot) => bot.id === shop.id,
    ).login_client_secret;
    const send = () =>
      fetch(`${fake.origin}/bot777:SHOP-TOKEN/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: user, text: "Welcome" }),
      });
    expect((await send()).status).toBe(403);
    const { code, verifier } = await codeFor(fake, user, {
      client_id: String(shop.id),
      scope: "openid profile telegram:bot_access",
    });
    const tokens = await exchange(
      fake,
      { code, code_verifier: verifier, client_id: String(shop.id) },
      { secret: shopSecret, clientId: String(shop.id) },
    );
    expect(tokens.status).toBe(200);
    expect((await send()).status).toBe(200);
  });
});

describe("what the login refuses", () => {
  it("refuses an unknown client_id, a bad response_type and a scope without openid", async () => {
    const { fake } = await setup();
    for (const overrides of [
      { client_id: "999" },
      { response_type: "token" },
      { scope: "profile" },
    ]) {
      const response = await fetch(authorization(fake, overrides).url, {
        redirect: "manual",
      });
      expect(response.status).toBe(400);
      await expect(
        fake.approveLogin(authorization(fake, overrides).url, 1),
      ).rejects.toThrow();
    }
  });

  it("answers invalid_client for a wrong secret", async () => {
    const { fake, user } = await setup();
    const { code, verifier } = await codeFor(fake, user);
    const response = await exchange(
      fake,
      { code, code_verifier: verifier },
      { secret: "wrong" },
    );
    expect(response.status).toBe(401);
    expect((await response.json()).error).toBe("invalid_client");
  });

  it("answers invalid_grant for an unknown, used or expired code", async () => {
    const { fake, user } = await setup();
    const unknown = await exchange(fake, { code: "nope", code_verifier: "x" });
    expect((await unknown.json()).error).toBe("invalid_grant");

    const first = await codeFor(fake, user);
    const ok = await exchange(fake, {
      code: first.code,
      code_verifier: first.verifier,
    });
    expect(ok.status).toBe(200);
    const reused = await exchange(fake, {
      code: first.code,
      code_verifier: first.verifier,
    });
    expect(reused.status).toBe(400);
    expect((await reused.json()).error).toBe("invalid_grant");

    const late = await codeFor(fake, user);
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 10 * 60_000 });
    const expired = await exchange(fake, {
      code: late.code,
      code_verifier: late.verifier,
    });
    expect((await expired.json()).error).toBe("invalid_grant");
  });

  it("answers invalid_grant for a different redirect_uri or a wrong code_verifier", async () => {
    const { fake, user } = await setup();
    const moved = await codeFor(fake, user);
    const otherRedirect = await exchange(fake, {
      code: moved.code,
      code_verifier: moved.verifier,
      redirect_uri: "https://app.example/elsewhere",
    });
    expect(otherRedirect.status).toBe(400);
    expect((await otherRedirect.json()).error).toBe("invalid_grant");

    const guessed = await codeFor(fake, user);
    const wrongVerifier = await exchange(fake, {
      code: guessed.code,
      code_verifier: "not-the-verifier",
    });
    expect((await wrongVerifier.json()).error).toBe("invalid_grant");
  });
});

describe("client secrets", () => {
  it("shows each bot's secret on the control API", async () => {
    const { fake } = await setup();
    await fake.addBot({ token: "777:OTHER", username: "other" });
    const bot = await (await fetch(new URL("/_fake/bot", fake.origin))).json();
    const bots = await (
      await fetch(new URL("/_fake/bots", fake.origin))
    ).json();
    expect(bot.login_client_secret).toBe(SECRET);
    expect(bots[1].login_client_secret).toEqual(expect.any(String));
    expect(bots[1].login_client_secret).not.toBe(SECRET);
  });
});
