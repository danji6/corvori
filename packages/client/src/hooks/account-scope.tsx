import { type ReactNode, createContext, useContext } from 'react'

const AccountContext = createContext<string | null>(null)

export function AccountScope({
  userId,
  children,
}: {
  userId: string
  children: ReactNode
}) {
  return (
    <AccountContext.Provider key={userId} value={userId}>
      {children}
    </AccountContext.Provider>
  )
}

export function useAccountId() {
  const userId = useContext(AccountContext)
  if (!userId) throw new Error('Account scope is required.')
  return userId
}
