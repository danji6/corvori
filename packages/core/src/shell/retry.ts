export const shellRetryAccess = ['network', 'both'] as const
export type ShellRetryAccess = (typeof shellRetryAccess)[number]

export type ShellDenial = {
  access: 'filesystem' | 'network'
  operation: string
  target?: string
}

export function describeShellDenial(denial: ShellDenial) {
  return [denial.operation, denial.target].filter(Boolean).join(' ')
}

export type ShellRetry = { jobId: string; access: ShellRetryAccess }

type RecordedRetryAccess = ShellRetryAccess | 'filesystem'

/** Recognize historical filesystem-only approvals without offering them for new jobs. */
export function shellRetry(
  input: unknown,
): { access: RecordedRetryAccess; jobId: string } | undefined {
  const retry = (
    input as { retry?: { jobId?: unknown; access?: unknown } } | null
  )?.retry
  if (typeof retry?.jobId !== 'string') return
  const { access, jobId } = retry
  if (access === 'filesystem' || access === 'network' || access === 'both')
    return { access, jobId }
}

export const retryLabels: Record<RecordedRetryAccess, string> = {
  filesystem: 'Run once outside filesystem sandbox',
  network: 'Retry once with network',
  both: 'Run once outside the sandbox',
}

export const retryScope: Record<RecordedRetryAccess, string> = {
  filesystem: 'This retry grants filesystem access only.',
  network: 'This retry allows network access inside the filesystem sandbox.',
  both: 'This retry grants your user account’s filesystem and network access.',
}
