import { AccountScope } from '@/hooks/account-scope'
import { api } from '@cv/convex/_generated/api'
import { useConvexAuth, useMutation } from 'convex/react'
import { useEffect, useState } from 'react'

/**
 * Ensures the authenticated user's Convex `users` row exists before any
 * `authQuery` runs. Queries throw `Profile not initialized` (409) when the row
 * is missing; only a mutation creates it lazily, so we run `ensureProfile` once
 * on mount and render children only after it resolves.
 */
export function ProfileGate({
  subject,
  children,
}: {
  subject: string
  children: React.ReactNode
}) {
  const { isAuthenticated } = useConvexAuth()
  const ensureProfile = useMutation(api.users.ensureProfile)
  const [userId, setUserId] = useState<string>()

  useEffect(() => {
    if (!isAuthenticated) return
    let active = true
    ensureProfile()
      .then((profile) => {
        if (active && profile?.subject === subject) setUserId(profile._id)
      })
      .catch(console.error)
    return () => {
      active = false
    }
  }, [ensureProfile, isAuthenticated, subject])

  if (!isAuthenticated || !userId) return null
  return <AccountScope userId={userId}>{children}</AccountScope>
}
