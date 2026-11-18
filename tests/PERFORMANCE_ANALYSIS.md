# Performance Analysis

Performance audit updated on 2026-11-19.

- **Sidebar subscriptions.** With 32 viewers and 128 private streams, the
  scoped query reduced uncached executions from 1,277 to 40 and documents
  read from 165,353 to 100. Subscription p95 fell from 483 to 62 ms
  across 40 samples. Chromium with one foreground and 31 background
  viewers measured 81 ms p95 to the visible indicator across 20 samples.
  Keep stream subscriptions scoped to the visible session IDs. The suite
  also checks membership revocation and reconnects in shared sessions.
  [Suite instructions](README.md#sidebar-performance)
- **Workspace checkpoints.** The sidecar now coordinates checkpoint operations
  by canonical root and capture group, with up to four simultaneous scans.
  With four independent turns and 100 × 1 KiB files per workspace, p95 `begin`
  fell from 174 ms at one scan slot to 56 ms at four. With eight turns, p95
  batch completion fell from 512 ms to 159 ms. The local benchmark uses the
  same code and fixtures for both scan limits and verifies that disjoint
  captures can progress independently. [Suite instructions](README.md#workspace-checkpoint-performance)
- **Shared-session sends.** The send mutation reuses the membership list for
  activity and delivery. The retention index excludes protected requests from
  ordinary inbox pruning. With four members and 500 protected requests per
  recipient, reads dropped from 1,829 to 325 documents per send and p95
  acknowledgement dropped from 219 ms to 151 ms. With zero, 100, or 500
  protected requests, the optimized run read 325 documents. Moving from four
  to 16 members with full ordinary inboxes still raised reads from 325 to
  1,573. Four concurrent sends to one session triggered 61 transaction retries
  across 48 measured sends. The same load across four independent sessions
  triggered zero retries. Evaluate durable,
  idempotent notification batches alongside the per-member activity updates
  if large shared sessions need lower latency. [Suite instructions](README.md#shared-session-send-performance)

  The follow-up replaces the full-inbox scan with a per-recipient ordinary
  unread count and an indexed lookup for the oldest entry. Existing inboxes
  initialize their count on first ordinary delivery. Reads, removals, and
  delivery maintain it in the transaction that changes the inbox. The first
  four-member full-inbox send still reads 325 documents while initializing
  counts. Steady-state reads per committed send fell from 327 to 30 at four
  members and from 1,575 to 90 at 16 members. Mean bytes read fell by about
  93% and 96%, respectively. Full-inbox write counts stayed at 14 and 50.
  With empty inboxes, the count added three reads and three writes per
  four-member send.

  | Four concurrent sends                     | Sender acknowledgement p95 | Recipient delivery p95 | Transaction retries |
  | ----------------------------------------- | -------------------------: | ---------------------: | ------------------: |
  | One shared chat                           |               563 → 496 ms |           595 → 540 ms |             56 → 52 |
  | Independent chats, distinct recipients    |               210 → 190 ms |           258 → 227 ms |               0 → 0 |
  | Independent chats, overlapping recipients |               639 → 465 ms |           670 → 495 ms |             56 → 52 |

  Each concurrent scenario measured 48 sends and 144 inbox deliveries
  per build. Single-sender p95 varied, including slower results in the
  four-member full-inbox case. The overlapping-inbox result shows that
  contention persists across different chat IDs when sends mutate the same
  inboxes. The count comparison used `test-results/perf/shared-sends-baseline.json`
  and the report now saved as `test-results/perf/shared-sends-before-contention-audit.json`.

  The contention follow-up repeated four simultaneous silent sends across
  four chats, with 48 measured sends and 144 deliveries per case in each
  of two runs. Shallow inboxes started every round with 16 ordinary unread
  items. Convex reported the following retry counts and conflict tables.

  | Recipients  | Inbox depth | Retries per run | Conflict table             |
  | ----------- | ----------: | --------------: | -------------------------- |
  | Distinct    |          16 |               0 | —                          |
  | Distinct    |         100 |               0 | —                          |
  | Overlapping |          16 |           48–52 | `notificationUnreadCounts` |
  | Overlapping |         100 |           52–54 | `notifications`            |

  Below capacity, competing sends update the same recipient count. At
  capacity they try to evict the same oldest row. With full inboxes,
  sharing recipients reduced send throughput from 19.6–21.5 to 8.8–9.3
  sends per second and raised sender acknowledgement p95 from 203–246 ms
  to 485–498 ms. Each batch settled before the next began.

  In the shared-chat comparison, the second disposable deployment skipped
  only the per-member `lastMessageAt` patches. Each variant measured 48
  sends per chat size, with 144 deliveries at four members and 720 at 16.

  | Members | Documents written per send | Sender acknowledgement p95, run 1 | Sender acknowledgement p95, run 2 | Retries per run |
  | ------: | -------------------------: | --------------------------------: | --------------------------------: | --------------: |
  |       4 |                    14 → 11 |                      597 → 483 ms |                      479 → 413 ms |   53–57 → 52–56 |
  |      16 |                    50 → 35 |                      853 → 720 ms |                    1,122 → 753 ms |   60–61 → 53–55 |

  Removing the patches reduced write work and lowered p95 acknowledgement in
  both local runs. The remaining retries were on `sessions` in one run and
  `notifications` in the other. Convex reports a conflict per retry even if
  the transaction could also conflict on other rows. Keep the activity
  projection in production because sidebar ordering uses it. Local reports are
  `test-results/perf/shared-sends-contention-repeat.json`
  and `test-results/perf/shared-sends-contention-first.json`.

- **Scheduled ordinary notifications.** An isolated Convex deployment
  queued one durable batch per human text send. A scheduled mutation
  checked that the message, session, and original recipient memberships
  were still present. It reused the ordinary retention code and consumed
  the batch in the same transaction as delivery. An injected failure
  rolled back the batch and its writes. Two subsequent concurrent replays
  delivered exactly once to the remaining member and skipped a recipient
  who had left and rejoined.

  Four independent chats sent concurrently. Each row compares synchronous
  delivery with scheduled delivery over 48 sends and 144 recipient
  observations per variant. Recipients were measured at the unread-list
  subscription. Settled throughput includes the time to observe the final
  recipient in each batch.

  | Recipients  | Unread |   Sender p95 | Recipient p95 | Settled sends/sec | Retries                     |
  | ----------- | -----: | -----------: | ------------: | ----------------: | --------------------------- |
  | Distinct    |     16 | 171 → 170 ms |  203 → 261 ms |       20.2 → 17.8 | 0 → 0                       |
  | Distinct    |    100 | 207 → 182 ms |  270 → 293 ms |       17.2 → 15.2 | 0 → 0                       |
  | Overlapping |     16 | 471 → 151 ms |  496 → 471 ms |         8.7 → 9.7 | 57 on send → 48 on delivery |
  | Overlapping |    100 | 463 → 180 ms |  491 → 518 ms |         9.1 → 8.4 | 51 on send → 46 on delivery |

  The first run also showed much faster acknowledgement for overlapping
  recipients and slower delivery for distinct recipients. Full overlapping
  inboxes settled at roughly nine sends per second in both versions across
  the two runs. At 16 unread, worker retries still conflicted on
  `notificationUnreadCounts`. At 100, they still conflicted on
  `notifications`. With full inboxes, send and worker attempts combined
  read 62 → 52 documents per send for overlapping recipients and
  30 → 37 for distinct recipients. The additional batch insert and delete
  raised writes from 14 to 16. Unread-list subscription reads were
  identical in the comparison. Local reports are
  `test-results/perf/shared-sends-notification-batches.json` and
  `test-results/perf/shared-sends-notification-batches-initial.json`.

- **Recipient-batched notifications.** The three-way comparison ran each
  variant on its own disposable deployment in forward and reverse order.
  It used real silent text sends and the unread-list and summary
  subscriptions. Each run measured 12 single-send trials, 48 sends per
  four-chat burst case, and 30-second sustained workloads at 4, 8, and 16
  offered sends/sec. The worker staged ordinary human notifications with
  the message, drained up to 16 entries per inbox transaction, and used one
  count and retention update. Queue depth and age come from completion
  logs. A 20-second HTTP deadline records stalled requests as rejections.
  [Suite instructions](README.md#shared-session-send-performance)

  Keep synchronous delivery. Recipient batching missed the adoption
  thresholds in both runs. Each range spans the two run orders.

  | Workload                                       | Metric                         | Synchronous | Job per message | Worker per recipient |
  | ---------------------------------------------- | ------------------------------ | ----------: | --------------: | -------------------: |
  | Idle inbox                                     | Recipient p95                  |  143–144 ms |      159–166 ms |           173–174 ms |
  | Full distinct inboxes, burst                   | Recipient p95                  |  274–276 ms |      303–312 ms |           342–354 ms |
  | Full overlapping inboxes, burst                | Recipient p95                  |  531–567 ms |      516–542 ms |           819–911 ms |
  | Full overlapping inboxes, burst                | Settled sends/sec              |     7.5–7.8 |             8.0 |              5.0–5.3 |
  | Full overlapping inboxes, 8 sends/sec offered  | Rejected sends out of 240      |           0 |               0 |                34–43 |
  | Full overlapping inboxes, 16 sends/sec offered | Rejected sends out of 480      |     394–400 |               0 |              225–269 |
  | Full overlapping inboxes, 16 sends/sec offered | Recipient observations missing |           0 |         615–645 |                    0 |

  Idle delivery used 17,977 → 20,954 database bytes per notification
  (+17%) with the recipient worker. In full overlapping bursts all 144
  drain transactions per run handled one entry each. The drain marker
  accounted for all 72–75 send retries. Batches reached 16 entries under
  sustained overload and improved settled throughput from 1.6–1.7 to
  6.6–8.0 sends/sec in the 16/sec overlapping case. Both variants
  delivered every acknowledged send to its recipients. About half the
  offered sends still failed with the recipient worker.
  The per-message queue ended the observation window with 612–642 entries
  still pending. Its recipient percentiles cover observed deliveries only,
  and a late worker from an earlier workload contributed to a later log
  window. These are local fixture limits for four repeatedly written
  sessions. The full report is
  `test-results/perf/shared-sends-recipient-batches.json`.

  The focused backend checks passed for concurrent read and discard
  operations, protected approvals, membership changes, stale workers, and
  scheduler recovery after a partial transaction failure. Chromium exposed
  a behavior change. With the source chat focused at send time, synchronous
  delivery was discarded without a toast. Holding delivery until the
  viewer navigated away produced a toast and an unread entry. The prototype
  also bounds inline reconciliation at 256 pending entries per inbox.

  In each synchronous full overlapping burst the unread-list and summary
  subscriptions each read 14,544 documents and 5.48 MB. The entire
  summary accounted for about 45% of the measured database bytes.

  The summary now reads only protected requests. The client derives
  ordinary IDs and counts from the unread list and waits for both
  subscriptions before closing settled desktop banners. In the follow-up
  comparison the summary did no database work during the measured
  ordinary sends after initial subscription. Total bytes per observed
  delivery fell by 35% for idle sends and by 45–46% for full-inbox bursts.
  With overlapping recipients, bytes per delivery fell from 84.4 to
  46.6 kB and recipient p95 went from 477 to 465 ms across 144 observations
  per variant. Chromium verified that marking ordinary activity read
  updates the badge and closes its desktop banner while a pending approval
  stays actionable. The local report is
  `test-results/perf/notification-summary.json`.

  Analyze contention on session activity and session history revisions
  separately from inbox delivery. Sidebar ordering still depends on the
  indexed member activity updates.

- **Tool-heavy turns.** [Provider setup](../packages/convex/src/actions/stream/engine.ts)
  reuses completed history within a stream action. A transactionally updated
  per-session revision invalidates the snapshot after a completed transcript
  write. The processing output and anchored notes are read on every setup.
  The action keeps up to 2 MiB of serialized completed rows and uses a full
  read for larger histories. The six-step benchmark with 512 prior messages
  reads 1.44 MB of history, down from 8.53 MB. Follow-ups read four history
  documents at every tested transcript length. Deferring the active-media
  scan to request-size errors cuts stream context reads from 3,197 to 119
  documents over that turn. Shared sends use two additional reads and one
  additional write. Four independent sessions still complete without retries.
  [Suite instructions](README.md#tool-turn-provider-setup-performance)
- **Active streaming.** The local comparison used the previous 100 ms
  implementation at `a828085e` and the 200 ms implementation at `beada7b3`
  with the same browser instrumentation. The 200 ms implementation includes
  an immediate first-text patch, a timer that flushes during silence, and
  an updated SmoothText animation. Both runs passed all 16 cases and reached
  the requested concurrency in every measured batch.

  At eight fast streams, 16,000 chunks produced 1,563 → 840 partial
  patches and 7.58 → 3.94 MB in partial writes over 160 active
  stream-seconds. Mutable message-tail reads fell from 8,622 to 5,013
  documents. The p95 subscription gap grew from 122 to 211 ms while
  the p95 visible gap fell from 51 to 25 ms (831 and 1,082 visible
  update gaps). Chromium p95 from the first slow chunk to visible text
  fell from 488 to 216 ms with seven background streams (five turns each).

  At eight streams, quiet Stop p95 to provider disconnect was 374 →
  371 ms (40 stops per run) and fast Stop was 588 → 293 ms (five stops).
  The single-stream Chromium Stop p95 rose from 169 to 260 ms (five
  stops). Keep the 200 ms patch interval and 250 ms watchdog. Quiet
  polling used 0.86 database document reads per active stream-second at
  both cadences. The local reports are
  `test-results/perf/active-streaming-100ms.json` and
  `test-results/perf/active-streaming-200ms.json`.
  [Suite instructions](README.md#active-streaming-performance)

- **Live transport experiment.** After moving authorization preparation
  ahead of opening SSE, the disposable backend admitted all eight viewers
  and reached eight simultaneous publishers. In one integrated Chromium
  probe, the first chunk rendered after 80 ms and reached the durable
  subscription after 580 ms. The 500 ms checkpoint and relay remain in
  the experiment worktree. The main branch's measured 200 ms path retains
  immediate first text, timed flushing during provider silence, and
  SmoothText. Revisit live transport if sustained load shows a need for
  further write reduction and the extra connections and relay failure
  modes justify a production design.
- **Memory usage.** A single Chromium tab opened a new chat, streamed through
  the composer with three independent background streams, and returned to the
  draft in each of 12 measured cycles. The sidecar also captured and sealed
  four synthetic workspaces per cycle. All cycles reached four concurrent
  streams. The profile sampled process-tree RSS every 250 ms while work ran,
  then measured again after the tab had been idle for longer than the default
  five-minute query-cache lifetime.

  | Memory in MiB             | After warm-up | Sampled peak | After five minutes idle |
  | ------------------------- | ------------: | -----------: | ----------------------: |
  | Convex process tree RSS   |         1,330 |        1,451 |                   1,189 |
  | Sidecar process tree RSS  |           146 |          178 |                     124 |
  | Chromium process tree RSS |           598 |          708 |                     597 |
  | Tab JavaScript heap       |          30.6 |         62.2 |                    38.9 |

  The process trees returned to their warm levels or lower. After tab garbage
  collection, documents returned to one and the listener count stabilized
  when the recents list filled. The tab still retained about 8 MiB more than
  after warm-up. Its settled heap grew by about 0.4 MiB per cycle across the
  final four transitions. Each cycle also added persistent session data. A
  fixed set of sessions and two heap snapshots would distinguish retained chat
  objects from growth in the fixture data or caches. The local report is
  `test-results/perf/memory.json`.
  [Suite instructions](README.md#session-memory-profile)
