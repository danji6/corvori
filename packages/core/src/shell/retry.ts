export const shellRetryAccess = ['filesystem', 'network', 'both'] as const
export type ShellRetryAccess = (typeof shellRetryAccess)[number]

export type ShellRetry = { jobId: string; access: ShellRetryAccess }

export function shellRetry(input: unknown): ShellRetry | undefined {
  const retry = (input as { retry?: Partial<ShellRetry> } | null)?.retry
  if (typeof retry?.jobId !== 'string' || !retry.access) return
  if (shellRetryAccess.includes(retry.access)) return retry as ShellRetry
}

export const retryLabels: Record<ShellRetryAccess, string> = {
  filesystem: 'Run once outside filesystem sandbox',
  network: 'Retry once with network',
  both: 'Run once outside filesystem sandbox with network',
}
