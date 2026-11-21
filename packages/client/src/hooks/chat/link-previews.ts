import { api } from '@cv/convex/_generated/api'
import type { LinkPreview } from '@cv/convex/model/linkPreviews/preview'
import { markdownHttpLinks } from '@cv/core/utils/markdown-links'
import { useAction } from 'convex/react'
import { useEffect, useMemo, useState } from 'react'

type PreviewEntry = LinkPreview & { url: string }

const MAX_LINKS = 4

export function useLinkPreviews(text: string) {
  const previewLink = useAction(api.actions.attachments.previewLink)

  const urls = useMemo(() => {
    const links = markdownHttpLinks(text)
    return [...new Set(links.map(({ url }) => url))].slice(0, MAX_LINKS)
  }, [text])

  const [loaded, setLoaded] = useState<{
    urls: string[]
    previews: PreviewEntry[]
  }>()

  useEffect(() => {
    if (!urls.length) return
    let active = true
    void Promise.all(
      urls.map(async (url) => {
        const preview = await previewLink({ url }).catch(() => null)
        return preview ? { ...preview, url } : null
      }),
    ).then((results) => {
      if (active) {
        setLoaded({ urls, previews: results.filter((entry) => entry !== null) })
      }
    })
    return () => {
      active = false
    }
  }, [previewLink, urls])

  return loaded?.urls === urls ? loaded.previews : []
}
