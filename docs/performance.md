# Package performance and regression evidence — 0.10.0

Measurements below are local synthetic package measurements, not downstream E2E
or production conclusions. Source baseline: release commit `384c837` (0.9.2).
Candidate: the 0.10.0 source measured before its release commit. Both use the same
installed dependencies and `pnpm-lock.yaml`; no dependency versions changed.

## Repeatable workload

Node v24.19.0, macOS arm64, Apple M5 Pro. No Telegram accounts, database, Redis,
application manager, jobs, model service or external enforcement is included.
The receiver is disposable local HTTP. The host was not CPU-isolated; medians and
p95 values describe these runs, not a throughput guarantee. Final fixture, API
and delivery phase medians were higher than baseline; earlier runs varied. No
speed improvement is claimed for those phases, and these mixed runs do not
isolate the cost of any individual diagnostic change.

`bench/server.mjs` runs two excluded warmups then 20 measured server lifecycles.
Each creates the same 20 users/joins/inbound messages, performs 20 HTTP member
reads, delivers 20 webhook messages, answers five callbacks asynchronously after
acknowledging delivery, and tears down both servers. Every request/answer is
checked. The callback receiver never silently discards errors. All source-owned
resources close in `finally`, including a failed benchmark.

| Phase                                      | 0.9.2 median / p95 ms | 0.10.0 median / p95 ms |
| ------------------------------------------ | --------------------: | ---------------------: |
| Startup (without Login)                    |       36.822 / 57.164 |          0.375 / 0.442 |
| 20 in-process fixture users/joins/messages |         0.467 / 0.677 |          0.769 / 1.123 |
| 20 HTTP getChatMember calls                |       26.748 / 30.144 |        28.971 / 33.507 |
| 20 webhook deliveries                      |       80.346 / 86.744 |        89.904 / 94.532 |
| 5 asynchronously answered callbacks        |     518.508 / 522.115 |        14.602 / 16.654 |
| Fake and receiver teardown                 |         0.361 / 0.503 |          0.215 / 0.236 |

Startup removes the unconditional per-server RSA-2048 generation from bot-only
runs. Key generation remains per instance, on the first Login signing/JWKS use.
A separate 10-sample/two-warmup Login run measured first-JWKS median 1.198 ms
before versus 19.456 ms after: the candidate moves crypto work to first use,
rather than claiming the cryptography became faster. Random key-generation time
varies. The retained Login tests verify discovery, JWKS and signed tokens.

Callback waiting previously checked for answers every 100 ms. It now subscribes
to exact query-answer state, preserving the existing bounded ten-second fake
policy and rejecting another bot's answer without consuming the rightful query.
This timing improvement measures the fake helper and local HTTP receiver only.

## Repeated fixtures

`bench/reuse.mjs` alternates restart/restore order across ten measured rounds,
with one excluded warmup round. Each strategy runs 20 cases against the same
0.10.0 implementation, dependencies and manual time. Fixtures contain 20 users,
joins, inbound messages and formatted HTTP sends. Each case verifies a real
HTTP ban and physical membership. (Since 0.11.0 a ban keeps the user's messages,
as on Telegram, so the case deletes them with `deleteMessages` and checks that.) Restore also
verifies the member is admitted again before the next case. Initial fixture
creation, snapshot capture/release and all teardown are included.

Twenty cases: restart median **648.027 ms**, p95 658.773 ms; restore median **75.142 ms**, p95 77.290 ms.

400 measured cases passed (200 per strategy), plus 40 warmup cases. There were
zero failed or skipped benchmark cases. This compares two fixture strategies in
the same candidate; it is not a claim about a consuming application's speed.
Each server-lifecycle benchmark completed 20 measured iterations plus two warmups;
the Login variants completed ten plus two. All completed with zero failed/skipped
iterations. Raw samples:

- [Before](../bench/results/2026-10-05-before.json)
- [After](../bench/results/2026-10-05-after.json)
- [Reuse](../bench/results/2026-10-05-reuse.json)
- [Login before](../bench/results/2026-10-05-login-before.json)
- [Login after](../bench/results/2026-10-05-login-after.json)

## Second review: long histories and concurrent observers

The comparison baseline is a preserved copy of the pre-review 0.10.0 candidate's
`src/index.js`, not a different server.
Both runs use `node --expose-gc bench/scaling.mjs`, the same Node/dependencies,
one excluded warmup and ten measured rounds. Each fixture has 3,000 real HTTP
getMe receipts, 1,000 inbound messages and 100 exact future ban-call observers.
It snapshots/restores the complete fixture, issues 20 unrelated getMe calls,
then confirms all observers match the exact successful ban receipt and checks
physical membership and full journal length. Cleanup runs in finally.

| Phase                                 | Pre-review median / p95 ms | Final median / p95 ms |
| ------------------------------------- | -------------------------: | --------------------: |
| Snapshot                              |              7.349 / 7.585 |         9.618 / 9.982 |
| Restore                               |              7.702 / 7.820 |        9.718 / 10.166 |
| Register 100 observers                |              5.835 / 7.582 |         0.176 / 0.204 |
| 20 unrelated API calls with observers |          537.058 / 543.429 |       30.607 / 31.138 |
| Resolve observers with exact ban      |            33.061 / 34.218 |         2.147 / 2.218 |

All 1,000 measured observer resolutions per source passed (plus 100 warmup).
Derived per-bot/method indexes and ordered sequence bounds avoid scanning unrelated
journals. They reference original receipts, preserve all evidence and rebuild on
restore. Richer phase evidence costs more to clone: snapshot and restore medians
increased. Sampled process JS heap after GC was **22.38 MiB before / 23.53 MiB
after**; GC occurred outside timing phases. This includes runtime heap, is not
RSS/total memory, and is not a leak or production-capacity test. Journals remain
unbounded by design to preserve replay. Release unused snapshots and stop/reset
fixtures at the test owner's lifecycle boundary; evidence is never silently trimmed.

Raw results: [before](../bench/results/2026-10-05-review-scaling-before.json),
[after](../bench/results/2026-10-05-review-scaling-after.json).

The explicit larger contract run used 150,000 HTTP receipts, no extra inbound
fixture messages, one observer and one measured round plus one warmup:

```sh
BENCH_HISTORY=150000 BENCH_MESSAGES=0 BENCH_OBSERVERS=1 BENCH_ROUNDS=1 node --expose-gc bench/scaling.mjs
```

The pre-review source failed its first restore with `RangeError: Maximum call
stack size exceeded` at argument-spread journal replacement. The final source
completed **two restores/cases**, preserving all 150,000 receipts, matching the
new receipt and confirming physical ban state. Iterative copying removes that
engine argument-limit failure across all restored journal arrays. This is a
successful contract reproduction, not a statistical speed/capacity guarantee.
Its one measured snapshot/restore was 351.612/374.464 ms and sampled JS heap was
423.12 MiB. [Raw sample](../bench/results/2026-10-05-large-restore.json).

## Validation and test admission

Initial untouched 0.9.2: `npm test` — 199 passed, zero failed/skipped, 12 files,
1.34 s. The final same-suite red/green comparison uses all 228 cases:

| Source                                | Executed | Passed |          Failed | Skipped | Elapsed |
| ------------------------------------- | -------: | -----: | --------------: | ------: | ------: |
| 0.9.2 plus the new owning regressions |      228 |    199 | 29 expected red |       0 |  1.59 s |
| 0.10.0 candidate                      |      228 |    228 |               0 |       0 | 0.904 s |

No unhandled errors occurred. Red/green suite elapsed times are not controlled
speed comparisons: missing-capability cases execute different paths before and
after implementation. Use the successful, identical-workload benchmarks above
for performance evidence. All original assertions and all 199 existing cases are retained. The
startgroup fixture now temporarily admits an administrator for its permissions
setup, explicitly asserts success, and removes that bot before the original
checks. The former unauthorized setup and swallowed error were invalid after
enforcing Telegram’s documented right. Formatting, UTF-16 entities, permission and expiry boundaries, mute
history, ban revocation, membership/join handling, callbacks, edits/deletions,
replay, scoped fault outcomes, SDK integration and multi-bot isolation retained
their existing owning coverage.

The new `test/controls.test.js` contains 26 package-owned HTTP/state regression
cases (four are parameterized metadata operations). Missing public APIs and
concrete defects were observed red before implementation. During implementation,
separate red runs also caught journal corruption, migrated rejection evidence,
unmodelled setters, backwards clock advancement, shutdown transport
misclassification, unauthenticated wait contamination and missing deletion-author
selection and negative message IDs at manual epoch zero. The second review also
reproduced false owner pending/shutdown outcomes, physical application hidden
behind webhook completion, and an applied mutation erased by a later handler
failure. Default-permission denials are owned by three new cases in
`test/fidelity.test.js`. The restored-receipt case was also proved by removing
index rebuilding: it failed on a stale receipt, then passed after source restore.
The table describes current behavior, not source-token guards:

| Cases | Behavior protected and why existing coverage missed it                                                                                                                                                                        |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | Exact message creation/deletion wait, plain text/entities, detached observation and bounded redacted failure; existing suites had no event wait API.                                                                          |
| 1     | Manual finite restriction expiry wakes an observer without another read/global clock patch; old expiry checks drove global time/read paths.                                                                                   |
| 1     | Pending versus approved/declined join observation and truthful physical membership; old coverage had no decision observation journal.                                                                                         |
| 1     | Rejection/delay/lost-response stages, original HTML parameters, fault identity and busy snapshot denial; old receipts lacked phase barriers.                                                                                  |
| 1     | Repeatable detached restore of IDs, memberships, messages, queued updates, requests and unused faults; no snapshot existed.                                                                                                   |
| 1     | Media download bytes, owner nested state and exact saved webhook bytes survive restore; those domains were previously only tested without restoration.                                                                        |
| 1     | Exact physical state can resolve before delivery drains; timeout/busy checks preserve held work and duplicate attempts; no public drain existed.                                                                              |
| 1     | Restore/stop cancel prior waits; HTTP control behaves like the JS API; these lifecycle controls were new.                                                                                                                     |
| 1     | Wrong bot cannot answer/consume another bot's callback; old multi-bot tests checked routing but not hostile answering.                                                                                                        |
| 1     | Returned nested call parameters/timelines cannot rewrite original evidence; old recording tests did not mutate returned records.                                                                                              |
| 1     | Concurrent bot/chat operations cannot consume another target's fault; pre-injection attempt correlation is preserved.                                                                                                         |
| 1     | Stop cancels queued webhook attempts/manual response delay, clears scheduled work, and journals response loss truthfully; old shutdown test did not inspect this combined state.                                              |
| 1     | Migrated-chat rejection receives the normal identity/timeline; old migration assertions checked response/membership, not phased evidence.                                                                                     |
| 1     | Malformed/unauthorized requests have separate rejection evidence without changing authenticated-call counts or storing URL tokens.                                                                                            |
| 4     | Unmodelled description/short-description/menu/default-rights writes explicitly fail in strict mode; old accepted no-op setters had no owning checks.                                                                          |
| 1     | Concurrent manual advances cannot rewind time when one resolves a due response; this race belongs to the new clock.                                                                                                           |
| 1     | An unauthorized request sharing the numeric bot prefix cannot satisfy an authenticated call wait; early-rejection recording is new.                                                                                           |
| 1     | Deletion-author selectors remain stable after deletion without rewriting original parameters; receipts previously lacked a captured target.                                                                                   |
| 1     | Configured and dynamically created chats allocate positive sequential stored message IDs at manual epoch zero; the old allocator derived IDs from a recent wall-clock epoch and had no manual-time coverage.                  |
| 1     | Owner fake-time receipts are detached, remain pending during delay and become cancelled on shutdown; old owner tests only checked completed calls.                                                                            |
| 1     | Repeated restore retains authenticated/rejected receipt identity and removes later receipts and sequences; proven with a stale-index mutation.                                                                                |
| 1     | Physical membership application is journaled before a held webhook returns, separately from successful handler completion; old receipts hid the applied state behind delivery.                                                |
| 1     | Handler failure after physical application retains the applied marker and records failed_after_apply; a deliberately failing logger exercises that partial-failure path and its exact shutdown error.                         |
| 3     | Default-permission changes deny a regular bot, an administrator without can_restrict_members, and a channel; default permissions and physical membership stay unchanged. Existing coverage only exercised authorized success. |

All cases live at the package's owning integration tier: real local HTTP and
physical in-memory state. There are no consumer-runner tests or downstream
implementation changes. No original test was removed, skipped or weakened. Permission, owner-shutdown
and held-webhook regressions were observed red before their associated fixes.
The partial-handler case was added after checkpoint instrumentation and verified
red against the preserved pre-review source. Capacity restoration was reproduced
red through the public API before replacing the argument spread.
The package declaration was also checked using a strict NodeNext TypeScript
consumer covering options, every wait overload, snapshot/restore, clock and drain.
`npm pack --dry-run --json` includes all ten intended package files, including
`src/test-controls.js`; no benchmark artifacts or test secrets enter the tarball.

## Reproduction

Use two checkouts with the same installed dependencies. The baseline is the
existing release, not an alternate fake implementation. `BENCH_SOURCE` loads
that exact index module into the same benchmark script:

```sh
npm test
BENCH_SOURCE=file:///absolute/path/to/0.9.2/src/index.js npm run bench
npm run bench
node bench/reuse.mjs
node --expose-gc bench/scaling.mjs
BENCH_LOGIN=1 BENCH_ITERATIONS=10 BENCH_SOURCE=file:///absolute/path/to/0.9.2/src/index.js npm run bench
BENCH_LOGIN=1 BENCH_ITERATIONS=10 npm run bench
npm pack --dry-run --json
```

The baseline test checkout for these runs was an archive of release commit
`384c837`, using the same installed dependencies. `npm test` there produced the
red result after copying the current owning controls and fidelity files plus the corrected startgroup
fixture there. No original unique assertion was removed. The candidate ran
`npm test` in the package repository. Benchmark raw JSON was emitted by
`node bench/server.mjs` and `node bench/reuse.mjs`; npm's wrapper only adds its
normal command banner. Timings exclude dependency installation.

## Compatibility, limits and integration

Release version: **0.10.0**. These measurements were made before publication,
against the released **0.9.2** baseline. Consumers can pin
`telegram-bot-test-server@0.10.0` and regenerate their own lockfile. Package dependencies, its pnpm lockfile, exports,
Node minimum and CLI invocation remain unchanged. Strict mode now rejects the four formerly successful no-op metadata setters
and unauthorized/channel default-permission changes. Correct any consumer
fixture that relied on those wrong successful responses. Owner diagnostics add
pending/cancelled outcomes; Bot API diagnostics add handler_completed and
failed_after_apply, and may reveal application before handler return. Consumers
should wait on response_sent or an exact physical state for their intended barrier. The inherited explicit `unimplemented: "ok"` escape hatch is
retained for compatibility and is not an accurate Telegram mode.

Snapshot restore supports idle fixtures, not in-flight execution or external
application state. It retains pending fault rules and queued update/webhook
settings; it rejects active network work/delays/long polls rather than partially
capturing them. Real time cannot be rewound. Manual time advances only this
instance's timestamps, finite membership expiry and response-fault scheduling.
Network/long-poll/diagnostic safety deadlines stay real. Automatic expiry updates
physical state without inventing unverified Telegram expiry update deliveries.
A delivery drain proves the fake's attempts settled, not successful enforcement.
Shared message/membership mutation paths checkpoint known application before
awaited delivery; other handlers and reads/no-ops checkpoint on completion.
handler_completed denotes successful return. Validation/application markers
do not instrument every intermediate mutation or establish a transaction;
timestamps use fake time.
Owner RPCs keep their existing ledger rather than pretending to expose Bot API
phases. Request/update evidence remains unbounded and explicit-restoration-owned;
only each timeline and rendered failure diagnostic is bounded.

The fake remains a documented Telegram subset. Complete methods/parameters,
rate limits, automatic Telegram retry policies and exact callback expiry timing
are not claimed. The existing owner client remains a fixture model of its stated
API subset. Supported formatting/membership contracts are referenced in the
[README](../README.md#how-closely-it-matches-telegram); all new test controls are
package design choices rather than Telegram platform guarantees. No downstream
E2E acceleration was measured or claimed.

Changed package files: `src/index.js`, `src/owner.js`, `src/index.d.ts`, new
`src/test-controls.js`; new `test/controls.test.js`, additions to
`test/fidelity.test.js` and the corrected fixture in `test/groups.test.js`;
`README.md`, this report, `bench/server.mjs`, `bench/reuse.mjs`,
`bench/scaling.mjs`, and eight raw result files. `package.json` sets version 0.10.0
and adds the bench command. No dependency or `pnpm-lock.yaml` change is required.
