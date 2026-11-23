import { Dialog, RippleButton } from '@/components/ui'
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

import {
  type SessionProfileDraft,
  SessionProfileFields,
} from './session-profile-fields'

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
  const [draft, setDraft] = useState<SessionProfileDraft>({})
  const { name, avatar, file } = draft
  const canSave = name !== undefined || file || avatar

  async function save(event: React.SyntheticEvent) {
    event.preventDefault()
    if (busy || !canSave) return
    setBusy(true)
    try {
      if (file) {
        await upload(await sessionAvatarUploadForm(target, file, name))
      } else {
        await update({ ...target, name, avatar })
      }
      onClose()
    } catch (err) {
      toastError(err, 'Could not save session profile')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => void save(event)}
    >
      <SessionProfileFields
        profile={profile}
        draft={draft}
        setDraft={setDraft}
        disabled={busy}
        autoFocus
      />
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
