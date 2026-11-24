import { useLinkPreviews } from '@/hooks/chat/link-previews'
import { PlayIcon } from 'lucide-react'

export function LinkPreviews({ text }: { text: string }) {
  const previews = useLinkPreviews(text)
  if (!previews.length) return null

  return (
    <div className="mt-2 grid gap-2">
      {previews.map(({ url, title, description, image, kind }) => (
        <a
          key={url}
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="border-m3-outline-variant bg-m3-surface-container hover:bg-m3-surface-container-high flex w-fit max-w-[min(100%,20rem)] flex-col gap-2.5 overflow-hidden rounded-lg border p-3 transition-[background]"
        >
          {image && (
            <img
              src={image}
              alt=""
              loading="lazy"
              className="max-h-44 max-w-full self-center rounded-md object-contain"
            />
          )}
          <div className="flex gap-2 text-sm">
            {(kind === 'video' || kind === 'audio') && (
              <PlayIcon className="mt-0.5 size-4 shrink-0" />
            )}
            <div className="min-w-0">
              <div className="truncate font-medium">{title}</div>
              {description && <p className="line-clamp-2">{description}</p>}
            </div>
          </div>
        </a>
      ))}
    </div>
  )
}
