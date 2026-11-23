import type {
  SessionListItem as CoreSessionListItem,
  SessionMember as CoreSessionMember,
  SessionParticipant as CoreSessionParticipant,
} from '@cv/core/types/sessions'
import type { Infer } from 'convex/values'

import type { Doc, Id } from '../../_generated/dataModel'
import type { workspaceRefValidator } from '../../validators/workspaces'

export type SessionMember = CoreSessionMember<
  Doc<'userSessions'>,
  Id<'avatars'>
>

export type SessionParticipant = CoreSessionParticipant<
  Id<'users'>,
  Id<'agents'>,
  Id<'avatars'>
>

/** The projection the sidebar renders. */
export type SessionSummary = Pick<
  Doc<'sessions'>,
  | '_id'
  | '_creationTime'
  | 'title'
  | 'activeAgentId'
  | 'lastMessageAt'
  | 'lastMessagePreview'
  | 'firstMessagePreview'
>

export type SessionListItem = CoreSessionListItem<
  SessionSummary,
  Id<'users'>,
  Id<'agents'>,
  Id<'avatars'>
>

export type FolderView = Doc<'sessionFolders'> & {
  workspace: Session['workspace']
  ancestorIds: string[]
  folderPath: string
}

/** A session with its folder-owned filesystem context resolved for this request. */
export type Session = Doc<'sessions'> & {
  workspace?: Infer<typeof workspaceRefValidator>
}
