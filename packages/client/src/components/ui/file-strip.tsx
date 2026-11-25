import {
  type FileItem,
  type FilePreview,
  isTextFileItem,
  useFilePreviews,
} from '@/hooks/file-previews'
import { downloadAttachment } from '@/lib/chat/attachment-download'
import { writeClipboardText } from '@/lib/clipboard'
import {
  ACCEPTED_IMAGE_TYPES,
  ACCEPTED_VIDEO_TYPES,
  isDisplayableUrl,
} from '@/lib/io'
import { toast, toastError } from '@/lib/notifications'
import { cn } from '@/lib/utils'
import { formatByteLength } from '@cv/core/utils/size'
import {
  DownloadIcon,
  FileIcon,
  LinkIcon,
  TextCursorInputIcon,
  VideoIcon,
  XIcon,
} from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useState } from 'react'

import { FilterableList, RippleButton, Skeleton } from '../ui'
import type { FilterableListProps } from '../ui'
import { type LightboxEntry, useLightbox } from './lightbox'
import { TextFileViewer } from './text-file-viewer'

const DEFAULT_SIZE = 120
const NO_ITEM_ANIMATION = {
  layout: false,
  initial: false as const,
  exit: { opacity: 1, transition: { duration: 0 } },
}
const ANIMATED_ITEM_PROPS = {
  initial: { scale: 0.8, opacity: 0 },
  animate: { scale: 1, opacity: 1 },
  exit: { scale: 0.5, opacity: 0 },
}

export type FileStripProps = Omit<
  FilterableListProps<FileItem>,
  'items' | 'keys' | 'empty' | 'placeholder' | 'render'
> & {
  files: FileItem[]
  onRemove?: (id: string) => void
  onInsertInline?: (id: string) => void
  actionsInContextMenu?: boolean
  size?: number
  noAnimation?: boolean
}

export function FileStrip(props: FileStripProps) {
  const {
    className,
    files,
    onRemove,
    onInsertInline,
    actionsInContextMenu = false,
    size = DEFAULT_SIZE,
    noAnimation = false,
    ...rest
  } = props
  const previews = useFilePreviews(files)
  const lightbox = useLightbox()
  const previewsById = new Map(
    files.map((item, index) => {
      const preview = previews[index]
      return [item.id, { index, preview, ...describePreview(item, preview) }]
    }),
  )
  const gallery = [...previewsById.values()].flatMap(({ media }) =>
    media ? [media] : [],
  )
  const list = files.length > 0 && (
    <FilterableList<FileItem>
      data-slot="file-strip"
      items={files}
      keys={(item) => item.id}
      empty={() => null}
      placeholder={null}
      className={cn(
        'flex w-full min-w-0 flex-wrap items-start gap-4 p-4',
        className,
      )}
      itemProps={noAnimation ? NO_ITEM_ANIMATION : ANIMATED_ITEM_PROPS}
      render={(item) => {
        const description = previewsById.get(item.id)!
        return (
          <FileStripItem
            item={item}
            {...description}
            size={size}
            actionsInContextMenu={actionsInContextMenu}
            onRemove={onRemove}
            onInsertInline={onInsertInline}
            onOpen={
              lightbox
                ? (trigger) => lightbox.openGallery(gallery, item.id, trigger)
                : undefined
            }
          />
        )
      }}
      {...rest}
    />
  )

  if (noAnimation) return list || null
  return (
    <AnimatePresence mode="wait">
      {list && (
        <motion.div
          className="w-full shrink-0 overflow-hidden"
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: 'auto', opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{ duration: 0.2, ease: 'easeInOut' }}
        >
          {list}
        </motion.div>
      )}
    </AnimatePresence>
  )
}

type FileStripItemProps = {
  item: FileItem
  index: number
  size: number
  preview: FilePreview
  media: LightboxEntry | null
  awaitingMedia: boolean
  actionsInContextMenu: boolean
  onRemove?: (id: string) => void
  onInsertInline?: (id: string) => void
  onOpen?: MediaThumbnailProps['onOpen']
}

function FileStripItem(props: FileStripItemProps) {
  const { item, index, size, media, awaitingMedia, actionsInContextMenu } =
    props
  const square = !!media || awaitingMedia

  return (
    <div
      className={cn(
        'relative isolate max-w-full rounded-lg',
        square
          ? 'aspect-square'
          : 'bg-m3-surface-container-high/70 border-input flex w-72 flex-wrap items-center border',
      )}
      style={square ? { width: size } : undefined}
      data-attachment-index={actionsInContextMenu ? index : undefined}
      data-attachment-name={actionsInContextMenu ? item.file.name : undefined}
      data-attachment-url={actionsInContextMenu ? item.originalUrl : undefined}
      data-attachment-share-url={
        actionsInContextMenu ? item.shareUrl : undefined
      }
    >
      {square ? <SquarePreview {...props} /> : <FileCardPreview item={item} />}
      <FileStripItemActions {...props} square={square} />
    </div>
  )
}

function FileStripItemActions({
  item,
  square,
  actionsInContextMenu,
  onInsertInline,
  onRemove,
}: Pick<
  FileStripItemProps,
  'item' | 'actionsInContextMenu' | 'onInsertInline' | 'onRemove'
> & { square: boolean }) {
  if (actionsInContextMenu && !onRemove) return null

  return (
    <div className={square ? undefined : 'flex max-w-full flex-wrap gap-1 p-2'}>
      {!actionsInContextMenu && (
        <FileActions
          item={item}
          onInsertInline={onInsertInline}
          className={square ? 'absolute right-1 bottom-1' : undefined}
        />
      )}
      {onRemove && (
        <RippleButton
          size="icon"
          variant="surface"
          onClick={() => onRemove(item.id)}
          className={cn(
            'size-7 rounded-full',
            square && 'absolute -top-2 -right-2 size-8',
          )}
          aria-label={`Remove file ${item.file.name}`}
        >
          <XIcon className="size-3" />
        </RippleButton>
      )}
    </div>
  )
}

function FileActions({
  item,
  onInsertInline,
  className,
}: {
  item: FileItem
  onInsertInline?: (id: string) => void
  className?: string
}) {
  const [downloading, setDownloading] = useState(false)
  const downloadUrl = item.originalUrl
  const copyText = item.shareUrl
  if (!downloadUrl && !item.canInsertInline) return null

  return (
    <div className={cn('flex max-w-full flex-wrap gap-1', className)}>
      {item.canInsertInline && onInsertInline && (
        <RippleButton
          size="icon"
          variant="surface"
          className="size-7 rounded-full"
          aria-label={`Insert ${item.file.name} inline`}
          onClick={() => onInsertInline(item.id)}
        >
          <TextCursorInputIcon className="size-3" />
        </RippleButton>
      )}
      {copyText && (
        <RippleButton
          size="icon"
          variant="surface"
          className="size-7 rounded-full"
          aria-label={`Copy link to ${item.file.name}`}
          onClick={() => {
            void writeClipboardText(copyText)
              .then(() => toast.success('Attachment link copied'))
              .catch((error) =>
                toastError(error, 'Failed to copy attachment link'),
              )
          }}
        >
          <LinkIcon className="size-3" />
        </RippleButton>
      )}
      {downloadUrl && (
        <RippleButton
          size="icon"
          variant="surface"
          className="size-7 rounded-full"
          aria-label={`Download ${item.file.name}`}
          disabled={downloading}
          aria-busy={downloading}
          onClick={async () => {
            setDownloading(true)
            try {
              await downloadAttachment(downloadUrl, item.file.name)
            } finally {
              setDownloading(false)
            }
          }}
        >
          <DownloadIcon className="size-3" />
        </RippleButton>
      )}
    </div>
  )
}

function matchesMediaType(
  types: readonly { mime: string; extensions: readonly string[] }[],
  mime: string,
  filename: string,
) {
  const unknownType = !mime || mime === 'application/octet-stream'
  return types.some(({ mime: type, extensions }) => {
    return (
      mime === type ||
      (unknownType &&
        extensions.some((extension) => filename.endsWith(`.${extension}`)))
    )
  })
}

function describePreview(item: FileItem, preview: FilePreview) {
  const mime = item.file.type.split(';', 1)[0]
  const name = item.file.name.toLowerCase()
  const video = matchesMediaType(ACCEPTED_VIDEO_TYPES, mime, name)
  const hasImageType = mime.startsWith('image/')
  const knownMedia =
    video || hasImageType || matchesMediaType(ACCEPTED_IMAGE_TYPES, mime, name)

  return {
    media: galleryEntry(item, preview, mime, video),
    awaitingMedia: knownMedia && preview.isThumbnailable,
  }
}

function galleryEntry(
  item: FileItem,
  preview: FilePreview,
  mime: string,
  video: boolean,
): LightboxEntry | null {
  if (!isDisplayableUrl(preview.url) || isTextFileItem(item)) return null

  const { url: src, thumbnailUrl } = preview
  const entry = { id: item.id, src, alt: item.file.name }

  if (video) {
    const poster =
      thumbnailUrl !== item.url ? (thumbnailUrl ?? undefined) : undefined
    return { ...entry, kind: 'video', poster }
  }
  if (
    mime.startsWith('image/') ||
    (thumbnailUrl && !mime.startsWith('video/'))
  ) {
    const poster =
      thumbnailUrl ??
      (preview.previewUrl !== src ? preview.previewUrl : undefined)
    return { ...entry, kind: 'image', poster, dimensions: item.imageDimensions }
  }
  return null
}

function SquarePreview({ item, media, preview, onOpen }: FileStripItemProps) {
  if (!media) return <Skeleton className="size-full rounded-lg" />

  const { byteLength } = item
  return (
    <>
      <MediaThumbnail
        src={
          media.kind === 'video'
            ? media.poster
            : (preview.thumbnailUrl ?? undefined)
        }
        video={media.kind === 'video'}
        alt={item.file.name}
        onOpen={onOpen}
      />
      {byteLength !== undefined && byteLength > 0 && preview.thumbnailUrl && (
        <span className="bg-m3-surface-container/90 pointer-events-none absolute top-1 left-1 rounded-full px-2 py-0.5 text-[10px]">
          {formatByteLength(byteLength)}
        </span>
      )}
    </>
  )
}

type MediaThumbnailProps = {
  src?: string
  video: boolean
  alt: string
  onOpen?: (trigger: HTMLElement) => void
}

function MediaThumbnail({ src, video, alt, onOpen }: MediaThumbnailProps) {
  const content = src ? (
    <img src={src} alt={alt} className="size-full object-cover" />
  ) : video ? (
    <span className="bg-m3-surface-container-high flex size-full items-center justify-center">
      <VideoIcon />
    </span>
  ) : (
    <Skeleton className="size-full rounded-lg" />
  )

  if (!onOpen) return content
  return (
    <button
      type="button"
      aria-label={`Open ${alt}`}
      className="file-preview-focus border-input block size-full cursor-zoom-in overflow-hidden rounded-lg border"
      onClick={(event) => onOpen(event.currentTarget)}
    >
      {content}
    </button>
  )
}

function FileCardPreview({ item }: { item: FileItem }) {
  const { name } = item.file
  const details = <FileCardDetails name={name} byteLength={item.byteLength} />
  const link = item.shareUrl && item.originalUrl

  return (
    <div className="min-w-0 flex-[1_1_6rem]">
      {isTextFileItem(item) ? (
        <TextFileViewer item={item}>{details}</TextFileViewer>
      ) : link ? (
        <a
          className="file-preview-focus text-primary block rounded-lg"
          aria-label={`Open ${name}`}
          href={link}
          target="_blank"
          rel="noopener noreferrer"
        >
          {details}
        </a>
      ) : (
        details
      )}
    </div>
  )
}

function FileCardDetails({
  name,
  byteLength,
}: {
  name: string
  byteLength?: number
}) {
  return (
    <span className="flex min-h-15 items-center gap-2.5 px-3 py-2">
      <FileIcon
        className="text-m3-on-surface-variant size-7 shrink-0"
        aria-hidden
      />
      <span className="block min-w-0 flex-1">
        <span title={name} className="block truncate text-sm leading-5">
          {name}
        </span>
        <span className="text-m3-on-surface-variant block min-h-4 text-xs leading-4">
          {byteLength !== undefined && formatByteLength(byteLength)}
        </span>
      </span>
    </span>
  )
}
