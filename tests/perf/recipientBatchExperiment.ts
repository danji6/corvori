import { isDeepStrictEqual } from 'node:util'
import { versions } from '~/scripts/runner/config'

import { withAccounts } from './clients'
import { withDeployment } from './deployment'
import { verifyNotificationNavigation } from './recipientBatchBrowser'
import { verifyRecipientBatches } from './recipientBatchChecks'
import {
  installMeasuredMessageBatches,
  installRecipientBatches,
} from './recipientBatchInstall'
import { createMembers, measureWorkload, workloads } from './recipientBatchLoad'
import type { Variant } from './recipientBatchReport'
import { createReport } from './report'

type Result = Awaited<ReturnType<typeof measureWorkload>>
type Run = Awaited<ReturnType<typeof runComparison>>

function compare(baseline: Result, candidate: Result) {
  const perSecond =
    (candidate.settledSendsPerSecond ?? 0) /
    (baseline.settledSendsPerSecond ?? 0)
  const recipientP95 =
    ('p95Ms' in candidate.recipientVisibility
      ? candidate.recipientVisibility.p95Ms
      : Infinity) /
    ('p95Ms' in baseline.recipientVisibility
      ? baseline.recipientVisibility.p95Ms
      : 0)
  const senderP95 =
    ('p95Ms' in candidate.senderAcknowledgement
      ? candidate.senderAcknowledgement.p95Ms
      : Infinity) /
    ('p95Ms' in baseline.senderAcknowledgement
      ? baseline.senderAcknowledgement.p95Ms
      : 0)
  const bytesPerDelivery =
    (candidate.totalDatabaseBytesPerDelivery ?? Infinity) /
    (baseline.totalDatabaseBytesPerDelivery ?? 0)
  return {
    scenario: baseline.scenario,
    perSecond,
    recipientP95,
    senderP95,
    bytesPerDelivery,
  }
}

function assess(runs: Run[]) {
  return runs.map(({ results, checks, browser }) => {
    const comparisons = results.synchronous.map((baseline, index) =>
      compare(baseline, results['per-recipient'][index]),
    )
    const fullOverlap = comparisons.filter(
      ({ scenario }) =>
        scenario === 'burst-overlap-100' || scenario === 'sustained-overlap-16',
    )
    const ordinary = comparisons.filter(
      ({ scenario }) => scenario === 'idle' || scenario.includes('distinct'),
    )
    const busyInboxPass = fullOverlap.every(
      ({ perSecond, recipientP95 }) => perSecond >= 1.2 && recipientP95 <= 1.1,
    )
    const ordinaryTrafficPass = ordinary.every(
      ({ recipientP95, senderP95, bytesPerDelivery }) =>
        Math.max(recipientP95, senderP95, bytesPerDelivery) <= 1.1,
    )
    const navigationParity = isDeepStrictEqual(
      browser.synchronous,
      browser['per-recipient'],
    )
    const correctnessPass =
      [...results.synchronous, ...results['per-recipient']].every(
        ({ correctnessErrors }) => correctnessErrors.length === 0,
      ) &&
      navigationParity &&
      !Object.values(checks).some((result) => 'error' in result)
    return {
      comparisons,
      busyInboxPass,
      ordinaryTrafficPass,
      navigationParity,
      correctnessPass,
    }
  })
}

async function runComparison(
  order: Variant[],
  repeat: number,
  record: ReturnType<typeof createReport>['record'],
) {
  const results: Record<Variant, Result[]> = {
    synchronous: [],
    'per-message': [],
    'per-recipient': [],
  }
  const checks: Partial<Record<Variant, Record<string, unknown>>> = {}
  const browser: Partial<Record<Variant, Record<string, unknown>>> = {}
  for (const variant of order) {
    await withDeployment(
      async (deployment) => {
        await withAccounts(deployment, 16, async (accounts) => {
          const members = await createMembers(deployment, accounts)
          for (const workload of workloads) {
            const result = await measureWorkload(
              deployment,
              members,
              variant,
              workload,
            )
            results[variant].push(result)
            record({ repeat, ...result })
          }
          if (variant !== 'per-message') {
            const batched = variant === 'per-recipient'
            const check = async (run: () => Promise<Record<string, unknown>>) =>
              run().catch((error) => ({
                error: error instanceof Error ? error.message : String(error),
              }))
            checks[variant] = await check(() =>
              verifyRecipientBatches(deployment, members, batched),
            )
            browser[variant] = await check(() =>
              verifyNotificationNavigation(deployment, members, batched),
            )
            record({
              repeat,
              variant,
              scenario: 'correctness-probes',
              checks: checks[variant],
              browser: browser[variant],
            })
          }
        })
      },
      'sharedSendsFixture',
      variant === 'per-recipient'
        ? installRecipientBatches
        : variant === 'per-message'
          ? installMeasuredMessageBatches
          : undefined,
    )
  }
  return { results, checks, browser }
}

export async function runRecipientBatches() {
  const { record, writeReport } = createReport(
    'shared-sends-recipient-batches',
    {
      convex: versions.convexBackend,
    },
  )
  try {
    const order: Variant[] = ['per-message', 'per-recipient', 'synchronous']
    const first = await runComparison(order, 1, record)
    const second = await runComparison([...order].reverse(), 2, record)
    const repeats = assess([first, second])
    const adoptionPass = repeats.every(
      (result) =>
        result.busyInboxPass &&
        result.ordinaryTrafficPass &&
        result.correctnessPass,
    )
    record({ scenario: 'adoption-decision', adoptionPass, repeats })
    await writeReport()
  } catch (error) {
    await writeReport(error)
    throw error
  }
}
