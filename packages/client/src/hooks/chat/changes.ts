import { normalizeBrowserUrl } from '@/lib/auth/site-url'
import { readTextPreview } from '@/lib/text-file-preview'
import { api } from '@cv/convex/_generated/api'
import type { Id } from '@cv/convex/_generated/dataModel'
import {
  useQuery as useCachedQuery,
  usePaginatedQuery,
} from 'convex-helpers/react/cache/hooks'
import { useAction, useMutation, useQuery } from 'convex/react'
import { useEffect, useState } from 'react'

const diffCache = new Map<string, string>()
type DiffResult = { key: string; text?: string; error?: string }

/** Retains reactive summaries and file pages through virtualized row remounts. */
export function useTurnChanges(messageId: string, version: number) {
  const summary = useCachedQuery(api.chat.changeSummary, {
    messageId: messageId as Id<'messages'>,
    version,
  })

  const filePage = usePaginatedQuery(
    api.chat.changeFiles,
    summary?.phase === 'ready' ||
      summary?.phase === 'restoring' ||
      summary?.phase === 'stale'
      ? { changeSetId: summary._id }
      : 'skip',
    { initialNumItems: 5 },
  )

  const restore = useMutation(api.chat.restoreChanges)
  const [error, setError] = useState<string>()
  const location = useCheckpointLocation(summary?._id, summary?.locationKey)
  const stale = summary?.phase === 'stale' || location?.stale === true
  const checkingLocation = !!summary?.locationKey && !location

  const act = async () => {
    if (!summary?.canRestore || stale || checkingLocation) return
    setError(undefined)
    try {
      await restore({
        changeSetId: summary._id,
        revision: summary.revision,
        direction: summary.state === 'applied' ? 'revert' : 'reapply',
      })
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error))
    }
  }

  return {
    summary,
    files: filePage.results,
    loadMore: filePage.loadMore,
    fileStatus: filePage.status,
    act,
    error,
    stale,
    checkingLocation,
  }
}

function useCheckpointLocation(
  changeSetId?: Id<'changeSets'>,
  locationKey?: string,
) {
  const check = useAction(api.actions.workspaces.checkpointStatus)
  const [result, setResult] = useState<{ key: string; stale: boolean }>()
  const key = locationKey && `${changeSetId}:${locationKey}`

  useEffect(() => {
    if (!changeSetId || !key) return
    const id = changeSetId
    const checkedKey = key
    let active = true
    let checking = false
    async function refresh() {
      if (checking) return
      checking = true
      try {
        const { stale } = await check({ changeSetId: id })
        if (active) setResult({ key: checkedKey, stale })
      } catch {
        // The restore route checks again before any write.
        if (active) setResult({ key: checkedKey, stale: false })
      } finally {
        checking = false
      }
    }
    void refresh()
    window.addEventListener('focus', refresh)
    return () => {
      active = false
      window.removeEventListener('focus', refresh)
    }
  }, [changeSetId, check, key])

  return result?.key === key ? result : undefined
}

/** Loads immutable previews on demand, cancelling stale requests on row changes. */
export function useChangeDiff(
  changeSetId: Id<'changeSets'>,
  fileKey: string,
  active: boolean,
) {
  const key = `${changeSetId}:${fileKey}`
  const [result, setResult] = useState<DiffResult>()
  const cached = diffCache.get(key)
  const storageUrl = useQuery(
    api.chat.changeDiff,
    active && cached === undefined ? { changeSetId, fileKey } : 'skip',
  )
  const url = storageUrl ? normalizeBrowserUrl(storageUrl) : storageUrl
  useEffect(() => {
    if (!active || cached !== undefined || !url) return
    const controller = new AbortController()
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(30_000),
    ])
    void readTextPreview(url, signal, 512 * 1024).then(
      ({ text }) => {
        if (signal.aborted) return
        if (diffCache.size >= 40)
          diffCache.delete(diffCache.keys().next().value!)
        diffCache.set(key, text)
        setResult({ key, text })
      },
      () => {
        if (!controller.signal.aborted)
          setResult({ key, error: 'Could not load this diff.' })
      },
    )
    return () => controller.abort()
  }, [active, cached, key, url])
  return {
    text: cached ?? (result?.key === key ? result.text : undefined),
    error:
      result?.key === key
        ? result.error
        : active && url === null
          ? 'Diff is unavailable.'
          : undefined,
  }
}
