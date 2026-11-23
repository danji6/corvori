import { AvatarPicker } from '@/components/chat/entities/avatar-picker'
import { Dialog, Input, Label, RippleButton } from '@/components/ui'
import { useHttpAction } from '@/hooks/http'
import {
  type AvatarUploadResult,
  sessionAvatarUploadForm,
} from '@/lib/chat/avatar'
import { toastError } from '@/lib/notifications'
import { api } from '@cv/convex/_generated/api'
import type { SessionProfileTarget } from '@cv/convex/validators/sessionAuthors'
import { useMutation, useQuery } from 'convex/react'
import type { FunctionReturnType } from 'convex/server'
import { useState } from 'react'

type ProfileDialogProps = {
  target: SessionProfileTarget
  onClose: () => void
}

export function EditSessionProfile({ target, onClose }: ProfileDialogProps) {
  const profile = useQuery(api.sessions.editableAuthorProfile, target)
  const [busy, setBusy] = useState(false)

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <Dialog.Content>
        <Dialog.Header>
          <Dialog.Title>Edit session profile</Dialog.Title>
        </Dialog.Header>
        {profile === null && (
          <p className="text-sm">This profile can no longer be edited.</p>
        )}
        {profile && (
          <ProfileForm
            target={target}
            profile={profile}
            busy={busy}
            setBusy={setBusy}
            onClose={onClose}
          />
        )}
      </Dialog.Content>
    </Dialog>
  )
}

type ProfileFormProps = ProfileDialogProps & {
  profile: NonNullable<
    FunctionReturnType<typeof api.sessions.editableAuthorProfile>
  >
  busy: boolean
  setBusy: (busy: boolean) => void
}

function ProfileForm({
  target,
  profile,
  busy,
  setBusy,
  onClose,
}: ProfileFormProps) {
  const update = useMutation(api.sessions.updateAuthorProfile)
  const { call: upload } = useHttpAction<FormData, AvatarUploadResult>(
    '/io/avatar/upload',
  )
  const [name, setName] = useState<string>()
  const [pendingAvatar, setPendingAvatar] = useState<File | null>(null)
  const [resetAvatar, setResetAvatar] = useState(false)
  const isImported = target.sender.type === 'archived'
  const canSave = name !== undefined || pendingAvatar || resetAvatar

  async function save(event: React.SyntheticEvent) {
    event.preventDefault()
    if (busy || !canSave) return
    setBusy(true)
    try {
      if (pendingAvatar) {
        await upload(await sessionAvatarUploadForm(target, pendingAvatar, name))
      } else {
        await update({ ...target, name, resetAvatar })
      }
      onClose()
    } catch (err) {
      toastError(err, 'Could not save session profile')
    } finally {
      setBusy(false)
    }
  }

  const nameValue = name ?? profile.name ?? ''
  const avatarId = resetAvatar
    ? profile.inherited?.avatarId
    : (profile.avatarId ?? profile.inherited?.avatarId)

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => void save(event)}
    >
      <fieldset className="flex items-center gap-3" disabled={busy}>
        <AvatarPicker
          avatarId={avatarId}
          pendingAvatar={pendingAvatar}
          avatarCleared={resetAvatar && !avatarId}
          clearLabel={isImported ? 'Remove avatar' : 'Use profile avatar'}
          canClear={Boolean(profile.avatarId) && !resetAvatar}
          onStageAvatar={setPendingAvatar}
          onClearAvatar={() => setResetAvatar(true)}
        />
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <Label htmlFor="session-profile-name">Name</Label>
          <Input
            id="session-profile-name"
            autoFocus
            value={nameValue}
            placeholder={
              profile.inherited?.name ??
              (isImported ? 'Display name' : 'Use profile name')
            }
            onValueChange={setName}
          />
          {!isImported && nameValue && (
            <RippleButton
              type="button"
              variant="stealth"
              size="sm"
              className="self-start"
              onClick={() => setName('')}
            >
              Use profile name
            </RippleButton>
          )}
        </div>
      </fieldset>
      <Dialog.Footer>
        <RippleButton
          type="button"
          variant="stealth"
          disabled={busy}
          onClick={onClose}
        >
          Cancel
        </RippleButton>
        <RippleButton type="submit" disabled={busy || !canSave}>
          Save
        </RippleButton>
      </Dialog.Footer>
    </form>
  )
}
