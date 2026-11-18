# Testing

Run the smallest set that exercises the behavior you changed:

```sh
bun test                           # Critical smoke checks
bun run tests toolkits         # Feature coverage, including its smoke cases
bun run tests runtime -t 'claim'    # Filter a feature by test name
bun run test:all                   # All Bun tests, including smoke
bun run test:browser skills        # Only this feature's browser tests
bun run test:browser               # All Chromium and WebKit tests
bun run tests --help               # List available suites
```

`scripts/test.ts` is a thin dispatcher to native Bun and Playwright commands.
It discovers feature directories automatically; adding a suite needs no package
script. `bun run tests smoke`, `bun run tests all`, and `bun run tests browser`
also work. Full Bun runs use a fresh process per feature and stop on failure.
Native flags pass through to each selected suite, including during `all` runs.
Use separate output paths for per-suite reports to avoid overwriting them.
When filtering `all` or `ui` by name, add `--pass-with-no-tests` to allow suites
or files without matches.

For one file, explicitly enable feature discovery:

```sh
bun test --path-ignore-patterns '**/browser/**' ./tests/features/toolkits/configuration.test.ts
```

Bun combines positional file filters with **OR**, so appending a filename to a
feature command does not narrow it. Use the direct-file command above, or pass
`-t` to filter test names.

## Ownership

Tests belong to their primary feature, across client, backend, and sidecar code.
An import of another feature does not require its entire suite. Shared fixtures
live in `helpers/`, `setup/`, and `fixtures/`; browser fixtures stay in `browser/`.

| Suite           | Behavior                                                                 | Browser command              |
| --------------- | ------------------------------------------------------------------------ | ---------------------------- |
| `runtime`       | Streams, retries, history, tools, approvals, subagents, commands         | `test:browser runtime`       |
| `toolkits`      | Manifest discovery, activation, credentials, linked context              | `test:browser toolkits`      |
| `mcp`           | Protocol, transports, catalogs, brokers, durable operations              | `test:browser mcp`           |
| `skills`        | Skill libraries, imports, verification, agent homes, file transitions    | `test:browser skills`        |
| `shell`         | Command policy, terminal output, jobs, watchers, streaming               | —                            |
| `providers`     | Connections, model discovery, SDK request adaptation, cache usage        | `test:browser providers`     |
| `sessions`      | Agents, folders, search, message projections, navigation                 | `test:browser sessions`      |
| `editor`        | Markdown, completion, source editing, interpreter, evaluation workers    | `test:browser editor`        |
| `notifications` | Delivery, queues, approvals, service worker                              | `test:browser notifications` |
| `auth`          | Authentication, account security, origins, rate limits                   | `test:browser auth`          |
| `updates`       | Installation, upgrades, rollback, migration deployment, runtime bundling | —                            |
| `ui`            | Shared primitives, scrolling, appearance, reusable forms                 | `test:browser ui`            |
| `core`          | Shared path authorization, attachments, bounded reads, errors            | —                            |

Use `bun run tests <suite>` for every suite in the table. Each command selects only
its `features/<suite>/` directory and its existing `smoke/<suite>.test.ts`, if any.
Smoke cases have one owner and run once in `test:all`.

## Adding and maintaining tests

Follow the risk-based policy in [AGENTS.md](../AGENTS.md). Reuse or extend existing
cases before adding new ones. Keep distinct authorization, data integrity,
concurrency, lifecycle, and regression checks. Avoid tests that only freeze CSS,
copy, constants, or a library's behavior.

Default discovery excludes `features/` and `browser/`. Put new comprehensive
tests in their feature directory; new features do not automatically expand smoke.
The full command runs features in fresh Bun processes to avoid dependencies on
cross-feature module state. The UI suite runs each file in a fresh process to
isolate its module mocks without Bun 1.3's unstable `--isolate` realm swaps. All
suites preserve the evaluator preload without reloading its WASM dependencies
between isolated files. Keep DOM setup scoped to files that need it; evaluator
initialization remains unchanged.

Prefer readiness signals to fixed sleeps. Real process, HTTP, timer, and browser
checks remain useful when they exercise additional behavior. Keep them in the
appropriate opt-in suite, using local fixtures instead of deployment credentials.
The five existing REA conformance cases require `CORVORI_REA_ROOT` pointing to
a local toolkit; otherwise they remain explicitly skipped.

## Sidebar performance

See [Performance Analysis](PERFORMANCE_ANALYSIS.md) for benchmark results and
the optimizations they informed.

Install Chromium once with `bun x playwright install chromium`, then run
`bun run test:perf sidebar`. The suite uses the repository's pinned Convex
backend, a disposable database, synthetic accounts, and the built client.
It deploys a fixture to the temporary backend to control stream timing without
contacting a model provider. The function-log checks count uncached query
executions and database reads.

The JSON report is written to `test-results/perf/sidebar.json`, including
completed scenarios if a later scenario fails. Compare the original global
query with the scoped query under each private-session load. Chromium reports
the delay to the sidebar indicator separately. Timing is report-only. Incorrect
streaming status, timeouts, or excessive query work fail the run.

## Workspace checkpoint performance

Run `bun run test:perf checkpoints` to exercise the sidecar's checkpoint
manager with temporary workspaces and real snapshots, file edits, and
checkpoint records. It compares one and four scan slots for batches of 1, 4,
and 8 independent turns with 100 files per workspace.

The report at `test-results/perf/checkpoints.json` includes scan-slot wait,
scan duration, p50 and p95 for begin, finish, and batch completion, and turn
throughput. Timing is report-only. The suite fails if independent captures
cannot overlap, conflicting captures are admitted, the scan cap is breached,
or a checkpoint records the wrong changes.

## Shared-session send performance

Run `bun run test:perf shared-sends` against a disposable local Convex
deployment. Synthetic users send silent text through the authenticated chat
mutation. The suite varies member count, ordinary inbox depth, and protected
request depth. It runs four concurrent sends in one chat and across four
chats with distinct or overlapping recipients. The separate-chat cases run
at capacity and with 16 ordinary unread items per inbox. Shallow inboxes
return to the seeded depth between rounds. Authenticated inbox subscriptions
start before each workload. Setup and inbox verification run outside the
measured latency.

For the activity comparison, the suite runs four concurrent sends in a
four-member chat and a 16-member chat with full inboxes. It repeats both in
a second disposable deployment whose function copy skips the per-member
`lastMessageAt` patch. The fixture checks the member and session activity
fields in both variants. Notification delivery and the rest of the send
transaction use the same code in both runs.

The report at `test-results/perf/shared-sends.json` includes p50 and p95
acknowledgement and recipient delivery latency with sample counts, send
throughput, database documents and bytes per committed send, and transaction
retries by the conflict table Convex reports. The first warm-up batch reports
work separately to capture lazy count initialization. Timing is report-only.
The suite checks sender exclusion, activity updates, exact retention, bounded
steady-state reads, and sends that race a read or discard mutation.

Run `bun run test:perf shared-sends --notification-batches` to compare
synchronous delivery with a scheduled mutation in a second disposable
deployment. The comparison runs four independent chats with distinct or
overlapping recipients at 16 and 100 ordinary unread items. Each variant
uses two warm-up batches and twelve measured batches per case. The prototype
queues a durable batch with the message and consumes it atomically with
delivery. It rechecks the original recipient memberships and uses the same
inbox retention as the synchronous path. An out-of-band probe checks
rollback, concurrent replay, and a recipient who leaves and rejoins.

The comparison writes `test-results/perf/shared-sends-notification-batches.json`.
It adds recipient latency after sender acknowledgement, throughput until
both send and delivery settle, worker retries by conflict table, and
database work in send and delivery attempts. Subscription work is reported
separately for the unread-list subscription. Seeding, warm-ups, and fixture
resets are excluded. Recipients are observed at subscription delivery,
before toast or desktop rendering. The prototype has no automatic recovery
for permanently failed jobs.

Run `bun run test:perf shared-sends --recipient-batches` with Chromium installed
to compare synchronous delivery, a scheduled batch per message, and a bounded
worker per recipient. The suite runs twice in reverse variant order on disposable
deployments. It measures single sends, four-chat bursts, and 30-second workloads
at 4, 8, and 16 sends per second. Expect a local run to take at least 18 minutes.
It records actual dispatch and acknowledgement rates, unread subscription
delivery, time to drain, worker batch sizes, queue age and depth from completion
logs, retries by table, and database work for mutations, the unread list, and
the notification summary. Queue peaks describe observed completion order.

The suite writes `test-results/perf/shared-sends-recipient-batches.json`.
The report includes the latency and cost gates and results from the scheduler
recovery, pending inbox actions, and Chromium navigation probes. Missing
subscriber observations and navigation differences block adoption. The
prototype supports at most 256 pending entries in a synchronous inbox action.
Its schema, worker, and recovery cron run only on the disposable deployment.

To reproduce the pre-count baseline, copy `sharedSends.ts`,
`sharedSendsFixture.ts`, `sharedSendsReport.ts`, `notificationBatch*.ts`,
`clients.ts`, `deployment.ts`, and `report.ts` into the corresponding paths in
a worktree at the pre-count revision and run
`bun run test:perf shared-sends --baseline` there. The flag skips the activity
and scheduled variants and checks that require the unread count table. It writes
`test-results/perf/shared-sends-baseline.json`.

## Tool-turn provider setup performance

Run `bun run test:perf tool-turns` against a disposable local Convex
deployment. The suite runs production provider setup with 16, 128, and 512
completed messages, both for an initial request and for a request followed by
five synthetic tool results. Each turn runs in one Convex action. The fixture
inserts settled tool results between setup calls and checks that the provider
request retains the current input and all tool exchanges while trimming older
turns to the configured context budget. A separate verification turn in each
scenario compares every prepared provider message against a full history read.

The report at `test-results/perf/tool-turns.json` includes p50 and p95 setup
latency and document and byte counts for history and stream context queries.
It reports values per step and totals per turn. The suite checks that
follow-up history reads stay flat as the transcript grows and that the
512-message turn reads at least 75% fewer history bytes than six full reads.
Setup timing excludes fixture writes and provider calls and is report-only.

## Active streaming performance

Install Chromium with `bun x playwright install chromium`, then run
`bun run test:perf active-streaming`. The suite sends real chat turns through
a disposable Convex deployment and a loopback HTTP provider. It runs quiet
Stop, slow completion, fast completion, and Stop during fast output at 1, 4,
and 8 concurrent streams, with one warm-up and five measured batches per case.
Chromium measures first visible text and gaps between rendered updates for
fast completion and slow output stopped through the composer. Both cases use
one foreground chat and up to seven background clients.

The report at `test-results/perf/active-streaming.json` includes achieved
concurrency, p50 and p95 subscription and rendering latency, Stop
acknowledgement and provider disconnect, and Convex function-log counts.
It reports cache hits, transaction retries, and document and byte work per
function and per provider-active stream-second. Polling and successful
partial patches have their own rate, with terminal writes shown separately.
Timing is report-only. Incorrect or missing output, late changes to stopped
text, missing provider cancellation, and fast chunks that are not coalesced
fail the run. The full run takes several minutes and uses synthetic accounts
and credentials.

## Session memory profile

With Chromium installed, run `bun run test:perf memory` on Linux. Each cycle
opens a chat in the same Chromium tab, sends through the composer, and runs
three other authenticated streams in independent sessions. The disposable
sidecar captures and seals four disjoint fixture workspaces during the same
cycle. Each workspace starts with 100 files of 1 KiB and receives one edit.
The browser returns to a draft and the benchmark disconnects the observers
before sampling settled memory. Run this separately from latency benchmarks.

The report at `test-results/perf/memory.json` gives a warm baseline, 12
measured cycles with sampled peaks and settled values, and idle samples at
10 seconds and after the five-minute client query-cache expiry. RSS is
summed across each process tree, including Convex's executor and Chromium's
renderer. Shared pages can count more than once. Tab heap and DOM counts
come from Chromium, with a garbage collection before the idle samples.
Server processes use their normal garbage collection. The benchmark
keeps the generated sessions and checkpoint records during the run, so
retained process memory can include caches. Values are report-only.

## CI

PRs run smoke, lint, typecheck, and build. Manual CI dispatch selects a Bun suite
(`smoke`, a feature, or `all`) and can independently enable all browser tests.
Only browser runs install Chromium/WebKit dependencies. Tagged releases run
`test:all` before publishing.

On CachyOS and other Arch-based systems, run `bun run test:browser <feature>`
with a local Docker daemon accessible to your user. For headless runs that
include WebKit, the runner uses the Docker image matching the installed
Playwright version. Docker pulls the image on first use. Use `--project chromium`
to run Chromium locally and `bun x playwright install chromium` to install it.

On supported Linux distributions, install browsers and host dependencies with
`bun x playwright install --with-deps chromium webkit`. Browser flags pass through,
for example `bun run test:browser editor --project chromium --workers 2`.
