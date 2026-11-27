import { shellRetryAccess } from '@cv/core/shell/retry'
import { z } from 'zod'

const JOB_NUMBER = /^[1-9][0-9]*$/

const shellJobIdField = z
  .string()
  .regex(JOB_NUMBER)
  .describe('Job ID returned by shell, as a string.')

export const shellFields = {
  cwd: z
    .string()
    .optional()
    .describe(
      'Working directory. session://, workspace:// and agent:// are accepted when available.',
    ),
  command: z.string().describe('Shell command to execute'),
  description: z
    .string()
    .optional()
    .describe('Short one-line summary of what the command does.'),
  wait_seconds: z
    .number()
    .optional()
    .describe(
      'Maximum seconds to wait for exit (default 60, maximum 600). Set to 0 to start in the background and return the job ID immediately.',
    ),
} as const

export const shellRetryField = z
  .strictObject({
    jobId: shellJobIdField,
    access: z.enum(shellRetryAccess),
  })
  .describe(
    'Request one retry of a failed sandboxed job. Repeat its exact command and cwd. Explain why this access is needed in description. The user must approve before the command starts again.',
  )
  .optional()

export const shellOutputFields = {
  jobId: shellJobIdField,
  wait_seconds: z
    .number()
    .optional()
    .describe(
      'Maximum seconds to wait for exit (default 60, maximum 600). Use 0 for the next unread page immediately. An explicit offset also replays immediately.',
    ),
  offset: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe(
      'Omit for automatic reads. Set it to 0 to replay from the oldest retained output, then use the returned next offset to continue replay. An explicit offset leaves the automatic read position unchanged.',
    ),
} as const

export const killShellFields = {
  jobId: shellJobIdField,
} as const
