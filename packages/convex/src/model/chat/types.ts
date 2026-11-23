import type { ReasoningUIPart } from 'ai'
import type { Infer } from 'convex/values'

import type { commandExtraValidator } from '../../validators/commands'
import type {
  modeExtraValidator,
  presenceExtraValidator,
  reminderExtraValidator,
  skillsExtraValidator,
  workspaceExtraValidator,
} from '../../validators/messages'

/**
 * Payloads carried by the `messages.extra` field, keyed by the message `type`
 * that owns them.
 */
export type MessageExtra = {
  capabilities: Infer<typeof skillsExtraValidator>
  mcp: Infer<typeof skillsExtraValidator>
  skills: Infer<typeof skillsExtraValidator>
  /** Snapshot of the reminder prompt that produced an injected message. */
  reminder: Infer<typeof reminderExtraValidator>
  /** Label of the workspace bound by the change, absent when unbound. */
  workspace: Infer<typeof workspaceExtraValidator>
  /** The announced session mode change. */
  mode: Infer<typeof modeExtraValidator>
  /** A participant who joined or left the session. */
  presence: Infer<typeof presenceExtraValidator>
  /** The announced invoked command, and how far it got. */
  command: Infer<typeof commandExtraValidator>
}

/** Reasoning parts persist how long the model spent thinking, in ms. */
export type ReasoningPart = ReasoningUIPart & { duration?: number }
