import { Sidebar } from '@/components/ui'
import { api } from '@cv/convex/_generated/api'
import type { Id } from '@cv/convex/_generated/dataModel'
import { useQuery } from 'convex/react'
import { BotIcon, UserIcon } from 'lucide-react'

import { ParticipantList } from './participant-list'
import { ParticipantRow } from './participant-row'

export function ImportedAuthors({
  sessionId,
  canEdit,
}: {
  sessionId: Id<'sessions'>
  canEdit: boolean
}) {
  const authors = useQuery(api.sessions.importedAuthors, { sessionId })?.filter(
    (author) => author.kind !== 'system',
  )
  if (!authors?.length) return null

  return (
    <Sidebar.Section label="Imported authors">
      <ParticipantList
        items={authors}
        getKey={(author) => author._id}
        getSearchText={(author) => author.name ?? ''}
        emptyLabel="No imported authors."
        renderItem={(author) => {
          const fromAgent = author.kind === 'agent'
          const name = author.name ?? (fromAgent ? 'Assistant' : 'User')
          const Icon = fromAgent ? BotIcon : UserIcon
          return (
            <ParticipantRow
              name={name}
              avatarId={author.avatarId}
              fallbackIcon={<Icon className="size-full" />}
              editSender={
                canEdit ? { type: 'archived', id: author._id } : undefined
              }
            />
          )
        }}
      />
    </Sidebar.Section>
  )
}
