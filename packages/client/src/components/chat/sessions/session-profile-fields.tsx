import { AvatarPicker } from '@/components/chat/entities/avatar-picker'
import { Input, Label } from '@/components/ui'
import type { Id } from '@cv/convex/_generated/dataModel'
import type { SessionProfileChanges } from '@cv/convex/validators/sessionAuthors'
import { FALLBACK_DISPLAY_NAME } from '@cv/core/const'
import { useId } from 'react'

export type SessionProfileDraft = {
  name?: string
  avatar?: SessionProfileChanges['avatar']
  file?: File | null
}

export type EditableSessionProfile = {
  name?: string
  avatarId?: Id<'avatars'> | null
  inherited?: { name?: string; avatarId?: Id<'avatars'> }
}

type SessionProfileFieldsProps = {
  profile: EditableSessionProfile
  draft: SessionProfileDraft
  setDraft: (draft: SessionProfileDraft) => void
  disabled?: boolean
  autoFocus?: boolean
}

export function SessionProfileFields({
  profile,
  draft,
  setDraft,
  disabled,
  autoFocus,
}: SessionProfileFieldsProps) {
  const nameId = useId()
  const { inherited } = profile
  let avatarOverride = profile.avatarId
  if (draft.avatar === 'inherit') avatarOverride = undefined
  if (draft.avatar === 'clear') avatarOverride = null
  const cleared = avatarOverride === null
  const avatarId = cleared ? undefined : (avatarOverride ?? inherited?.avatarId)
  const name = draft.name ?? profile.name ?? inherited?.name ?? ''
  const canResetAvatar = inherited !== undefined && avatarOverride !== undefined

  return (
    <fieldset className="flex items-start gap-3" disabled={disabled}>
      <AvatarPicker
        avatarId={avatarId}
        pendingAvatar={draft.file ?? null}
        avatarCleared={cleared}
        canClear={Boolean(avatarId)}
        onStageAvatar={(file) => setDraft({ ...draft, file })}
        onClearAvatar={() => setDraft({ ...draft, avatar: 'clear' })}
        onResetAvatar={
          canResetAvatar
            ? () => setDraft({ ...draft, avatar: 'inherit', file: null })
            : undefined
        }
        disabled={disabled}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <Label htmlFor={nameId}>Name</Label>
        <Input
          id={nameId}
          autoFocus={autoFocus}
          value={name}
          placeholder={FALLBACK_DISPLAY_NAME}
          onValueChange={(value) => setDraft({ ...draft, name: value })}
        />
      </div>
    </fieldset>
  )
}
