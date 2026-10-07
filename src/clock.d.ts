/**
 * The time an app under test should use: the test server's clock when
 * TELEGRAM_FAKE_CLOCK_URL names one (its origin or its /_fake/clock URL),
 * Date.now() otherwise. Synchronous: it reads a cache that refreshFakeClock
 * fills and clockWebhook pushes keep current. With the variable set, it
 * throws until refreshFakeClock has read that server's clock once.
 */
export function fakeClockNow(): number;
/** Read GET /_fake/clock now; caches and returns its time (Date.now() when the variable is unset). */
export function refreshFakeClock(): Promise<number>;
/** Take a clockWebhook push ({ now, mode }) into the cache. */
export function receiveFakeClock(body: {
  now: number;
  mode: "manual" | "real";
}): void;
/**
 * What fakeClockHandler reads of a request: a Node IncomingMessage, or
 * anything with its method and body events. Typed here, so the types need
 * no Node type definitions.
 */
export interface FakeClockRequest {
  method?: string;
  on(event: "data", listener: (chunk: Uint8Array) => void): unknown;
  on(event: "end", listener: () => void): unknown;
}
/** What fakeClockHandler writes of a response: a Node ServerResponse, or anything with writeHead(...).end(). */
export interface FakeClockResponse {
  writeHead(
    statusCode: number,
    headers?: Record<string, string>,
  ): { end(): unknown };
}
/**
 * A Node (request, response) handler to mount at the clockWebhook URL: reads
 * the JSON body, receiveFakeClock, answers 204.
 */
export function fakeClockHandler(
  request: FakeClockRequest,
  response: FakeClockResponse,
): void;
