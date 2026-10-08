# Performance measurements

## 0.13.0

0.13.0 makes pending message and update waits, `drainDeliveries` and `snapshot`/`restore` cheaper.
Answers, updates, receipts, their order and the message or update a wait resolves with are the same
as on 0.12.0, and the 0.12.0 test suite passes unchanged. The numbers below were measured on these
changes alone, before the rest of 0.13.0 was added.

- A message wait reads the chat once, then only the messages stored since its last read. An edit,
  a deletion or a restore makes it read the whole chat again.
- An update wait checks each update's type and chat once, then rechecks only the state of the
  updates that matched.
- `drainDeliveries` reads the server's counts of unsettled webhook attempts instead of filtering the
  whole delivery journal.
- A snapshot is kept serialized, with the serialization `structuredClone` uses, and a restore reads
  it back once: one copy each instead of two.

Node v24.21.0, macOS arm64, Apple M5 Pro (18 cores). Each run was its own process, and the two
versions alternated run by run: 6 runs per version for each workload below, 10 for the package
benches. The tables give the medians of the run totals in ms. The host was not idle (load average
1.6–4.1), but the 0.12.0 medians were within 6% of an earlier baseline of 5 runs per workload on
an idle host, for every workload measured in both except the latest-update reference (70.2 against
78.5 ms). The server listens on 127.0.0.1; the bot, the webhook receiver and the test run in one
process, as in a vitest suite, and every run checks that each wait, drain and restore gave the
right result.

**Message waits.** 1000 `sendMessage` calls in a group of 10,000 stored messages, while one
`waitFor` message wait is pending:

| Wait pending                                    | 0.12.0 | 0.13.0 |
| ----------------------------------------------- | -----: | -----: |
| none                                            |  56.75 |   57.6 |
| `botId` and `text`                              |  733.1 |  59.75 |
| five `botId` and `text` waits                   | 2255.2 |  61.05 |
| `since`                                         |  598.8 |  59.25 |
| `buttonText`                                    | 1825.6 |   58.1 |
| `contains`                                      | 2407.4 |   59.4 |
| `matches`                                       | 2682.1 |  59.45 |
| `botId` and `text`, 1,000 stored messages       |  155.3 |  65.25 |
| `botId` and `text`, each call `editMessageText` |  649.3 |  139.7 |
| `botId` and `text`, each call `deleteMessage`   |  626.2 |  135.9 |

**Reply loop.** One group; per step a member posts, a long-polling bot calls `getChatMember` and
replies, and the test waits for the reply with `waitFor`. The chat grows by 2 messages a step.

| Steps, wait                  | 0.12.0 | 0.13.0 | Last 500 steps, ms per step |
| ---------------------------- | -----: | -----: | --------------------------: |
| 300, `botId` and `text`      |  101.6 |  89.25 |                             |
| 300, `contains`              |  131.4 |  90.05 |                             |
| 1000, `botId` and `text`     |  335.0 |  231.6 |               0.330 → 0.193 |
| 3000, `botId` and `text`     | 1289.2 |  645.1 |               0.585 → 0.205 |
| 3000, `contains`             | 3473.4 |  781.8 |               1.959 → 0.287 |
| 3000, `since` read each step | 1002.8 |  695.2 |               0.395 → 0.231 |

**Update waits.** `sendMessage` calls while one update wait is pending, the bot having been sent
and confirmed 10,000 (or 1,000) message updates:

| Update wait pending                                   | 0.12.0 | 0.13.0 |
| ----------------------------------------------------- | -----: | -----: |
| none, 10k updates, 1000 calls                         |   73.7 |  69.65 |
| `edited_message`, 10k updates, 1000 calls             | 6688.9 |   72.5 |
| `edited_message`, 1k updates, 1000 calls              |  726.9 |  87.95 |
| `message` in state `dropped`, 10k updates, 100 calls  | 5895.3 |  10.25 |
| `message` in state `dropped`, 1k updates, 1000 calls  | 5542.6 |  84.75 |
| `edited_message` after the latest update, 10k updates |   70.2 |   72.6 |

**Drains.** A webhook bot that already got 20,000 (or 2,000) deliveries, then 1000 steps of
`post` and `drainDeliveries()`. The replying handler awaits `getChatMember` and `sendMessage`
before it answers; an overlapping drain starts while the post's delivery is in flight.

| Drain                                          | 0.12.0 | 0.13.0 |
| ---------------------------------------------- | -----: | -----: |
| after the post, webhook answers at once, 20k   |  130.0 |  55.15 |
| after the post, replying handler, 20k          |  254.8 |  179.0 |
| overlapping, webhook answers at once, 20k      |  268.8 |  55.15 |
| overlapping, replying handler, 20k             | 1464.9 |  180.0 |
| after the post, webhook answers at once, 2k    |  67.25 |   57.3 |
| after the post, replying handler, 2k           |  202.9 |  191.1 |

**Snapshot and restore.**

| Workload                                                      | 0.12.0 | 0.13.0 |
| ------------------------------------------------------------- | -----: | -----: |
| 2000 members, 12k messages, 10k receipts: snapshot (7 rounds) |   67.8 |   21.8 |
| the same: restore                                             |   72.6 |  56.05 |
| `bench/scaling.mjs` (`--expose-gc`, 10 rounds): snapshot      |  8.567 |  3.113 |
| the same: restore                                             |  9.161 |   5.58 |
| `bench/reuse.mjs`, restore strategy, 20 cases                 | 12.872 | 10.654 |
| `bench/reuse.mjs`, restart strategy, 20 cases                 | 59.867 | 59.551 |

The no-wait, latest-update and restart rows are references, and their differences are within
run-to-run noise; so is the 2k replying-handler drain. Every phase of `bench/server.mjs`, message
log reads, and call, member and quiet waits were also unchanged. Two small costs went up:
`bench/scaling.mjs`'s 20 `getMe` calls right after a restore, with 100 call waits pending, took
5.152 → 5.566 ms (+8%; a second 10-run comparison gave +11%), about 0.02 ms per call, with no
difference at 500 calls (76.9 → 76.1 ms); and its JS heap after a restore and GC grew
25.58 → 25.73 MiB (+0.6%).

What this means in a test suite:

- Message waits are the clear win once a chat holds about 1,000 messages or more: a pending wait no
  longer slows every Bot API request. A reply loop of 3000 steps on one group takes half the time
  with `botId` and `text` waits and under a quarter with `contains`; at 300 steps it saves 12%
  (`botId` and `text`) to 31% (`contains`).
- A drain right after a post saves about 0.075 ms at 20,000 deliveries and about 0.01 ms at 2,000.
  A drain that overlaps a delivery saved about 1.3 ms per step at 20,000.
- A restore runs once per test case: about 0.11 ms less per case in `bench/reuse.mjs`, and 16.5 ms
  less on the large fixture. A snapshot is taken once per fixture, so its gain is one-off.

The last of these changes, which makes a snapshot of a value that cannot be copied throw the same
`DataCloneError` as 0.12.0, was measured separately: snapshot and restore times did not change.
