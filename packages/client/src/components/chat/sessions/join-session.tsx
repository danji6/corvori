import { Dialog, Input, QuickTooltip, RippleButton } from '@/components/ui'
import type { RippleButtonProps } from '@/components/ui'
import { useRedeemToken } from '@/hooks/chat/sharing'
import { useHttpAction } from '@/hooks/http'
import { joinAvatarUploadForm } from '@/lib/chat/avatar'
import { extractErrorMessage } from '@/lib/errors'
import { cn } from '@/lib/utils'
import { api } from '@cv/convex/_generated/api'
import type { Id } from '@cv/convex/_generated/dataModel'
import { useQuery } from 'convex/react'
import { ConvexError } from 'convex/values'
import { Loader2Icon, LogInIcon } from 'lucide-react'
import { useRef, useState } from 'react'
import { useLocation } from 'wouter'

import {
  type EditableSessionProfile,
  type SessionProfileDraft,
  SessionProfileFields,
} from './session-profile-fields'

type JoinSessionButtonProps = RippleButtonProps & {
  collapsed?: boolean
}

export function JoinSessionButton({
  collapsed,
  className,
  onClick,
  ...props
}: JoinSessionButtonProps) {
  const [open, setOpen] = useState(false)

  const button = (
    <RippleButton
      {...props}
      variant={collapsed ? 'stealth' : 'outline'}
      size="icon"
      aria-label="Join session"
      onClick={(e) => {
        onClick?.(e)
        setOpen(true)
      }}
      className={cn(
        collapsed ? 'text-muted-foreground' : 'h-11 w-full justify-center',
        className,
      )}
    >
      <LogInIcon />
    </RippleButton>
  )

  return (
    <>
      {collapsed ? (
        button
      ) : (
        <QuickTooltip text="Join Session">{button}</QuickTooltip>
      )}
      {open && <JoinSession onClose={() => setOpen(false)} />}
    </>
  )
}

const INVALID_INVITE = 'The invite token is invalid or has been revoked.'

const UNCONFIRMED_JOIN =
  'Could not confirm whether you joined. Try again to open the session or finish joining.'

function JoinSession({ onClose }: { onClose: () => void }) {
  const [, navigate] = useLocation()
  const redeem = useRedeemToken()
  const [token, setToken] = useState('')
  const [draft, setDraft] = useState<SessionProfileDraft>({})
  const [submittedProfile, setSubmittedProfile] = useState<EditableSessionProfile>() // prettier-ignore
  const [problem, setProblem] = useState<string>()
  const [isJoining, setIsJoining] = useState(false)
  const joining = useRef(false)
  const trimmed = token.trim()
  const invite = useQuery(
    api.sessionShares.preview,
    trimmed ? { token: trimmed } : 'skip',
  )
  const profile = invite?.isMember
    ? undefined
    : (invite?.profile ?? submittedProfile)

  const { call: uploadAndJoin } = useHttpAction<
    FormData,
    { sessionId: Id<'sessions'> }
  >('/io/avatar/upload')

  async function submitJoin() {
    if (!invite || joining.current) return
    joining.current = true
    setIsJoining(true)
    setProblem(undefined)
    if (!invite.isMember) setSubmittedProfile(invite.profile)
    try {
      const sessionId = invite.isMember
        ? invite.sessionId
        : await joinWithDraft()
      if (!sessionId) {
        setProblem(INVALID_INVITE)
        return
      }
      onClose()
      navigate(`/?id=${sessionId}`, { replace: true })
    } catch (error) {
      setProblem(
        error instanceof ConvexError
          ? extractErrorMessage(error, 'Could not join the session.')
          : UNCONFIRMED_JOIN,
      )
    } finally {
      joining.current = false
      setIsJoining(false)
    }
  }

  async function joinWithDraft() {
    const { name, avatar, file } = draft
    if (!file) return redeem(trimmed, { name, avatar })
    let form: FormData
    try {
      form = await joinAvatarUploadForm(trimmed, file, name)
    } catch {
      throw new ConvexError(
        'Could not read that image. Choose another image or try again.',
      )
    }
    const result = await uploadAndJoin(form)
    if (!result) throw new Error(UNCONFIRMED_JOIN)
    return result.sessionId
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && !joining.current && onClose()}
    >
      <Dialog.Content showCloseButton={false}>
        <Dialog.Header>
          <Dialog.Title>Join a session</Dialog.Title>
          <Dialog.Description className="text-muted-foreground">
            Paste an invite token to join another user's session.
          </Dialog.Description>
        </Dialog.Header>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault()
            void submitJoin()
          }}
        >
          <Input
            autoFocus
            value={token}
            onChange={(e) => {
              const value = e.target.value
              if (value.trim() !== trimmed) {
                setDraft({})
                setSubmittedProfile(undefined)
                setProblem(undefined)
              }
              setToken(value)
            }}
            aria-label="Invite token"
            placeholder="Invite token"
            disabled={isJoining}
            size="sm"
            className="font-mono text-xs"
          />
          {profile && (
            <section aria-labelledby="join-as" className="flex flex-col gap-2">
              <h3 id="join-as" className="text-sm font-medium">
                Join as
              </h3>
              <SessionProfileFields
                key={trimmed}
                profile={profile}
                draft={draft}
                setDraft={setDraft}
                disabled={isJoining || !invite}
              />
            </section>
          )}
          {(problem || invite === null) && (
            <p role="alert" className="text-destructive text-sm">
              {problem ?? INVALID_INVITE}
            </p>
          )}
          <Dialog.Footer>
            <RippleButton
              type="button"
              variant="surface"
              onClick={onClose}
              disabled={isJoining}
            >
              Cancel
            </RippleButton>
            <RippleButton
              type="submit"
              variant="primary"
              aria-label={isJoining ? 'Joining session' : undefined}
              disabled={isJoining || !invite}
            >
              {isJoining ? (
                <Loader2Icon className="size-4 animate-spin" />
              ) : invite?.isMember ? (
                'Open session'
              ) : (
                'Join'
              )}
            </RippleButton>
          </Dialog.Footer>
        </form>
      </Dialog.Content>
    </Dialog>
  )
}
