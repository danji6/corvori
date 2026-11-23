import { Avatar } from '@/components/ui'
import { DropZone, type DropZoneHandle } from '@/components/ui/file-picker'
import { useAvatarThumbnail } from '@/hooks/chat'
import { cn } from '@/lib/utils'
import type { Id } from '@cv/convex/_generated/dataModel'
import { RotateCcwIcon, XIcon } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'

export type AvatarPickerProps = {
  avatarId?: Id<'avatars'>
  pendingAvatar: File | null
  avatarCleared: boolean
  onStageAvatar: (file: File | null) => void
  onClearAvatar: () => void
  onResetAvatar?: () => void
  clearLabel?: string
  canClear?: boolean
  disabled?: boolean
}

const avatarActionClassName =
  'bg-m3-surface-container-highest text-muted-foreground hover:text-foreground focus-visible:border-ring focus-visible:ring-ring absolute -right-1 flex size-5 items-center justify-center rounded-full border shadow-sm outline-0 transition-colors focus-visible:ring-1'

export function AvatarPicker({
  avatarId,
  pendingAvatar,
  avatarCleared,
  onStageAvatar,
  onClearAvatar,
  onResetAvatar,
  clearLabel = 'Remove avatar',
  canClear = true,
  disabled,
}: AvatarPickerProps) {
  const dropZoneRef = useRef<DropZoneHandle | null>(null)
  const savedAvatarUrl = useAvatarThumbnail(avatarId)

  const [preview, setPreview] = useState<string | null>(null)
  const previewUrlRef = useRef<string | null>(null)
  const urlRef = useRef<string | null>(null)

  const setPreviewUrl = useCallback((url: string | null) => {
    if (previewUrlRef.current && previewUrlRef.current !== url) {
      URL.revokeObjectURL(previewUrlRef.current)
    }
    previewUrlRef.current = url
    setPreview(url)
  }, [])

  useEffect(() => {
    if (pendingAvatar) urlRef.current = savedAvatarUrl
  }, [pendingAvatar, savedAvatarUrl])

  useEffect(() => {
    if (pendingAvatar || !previewUrlRef.current) return
    if (!savedAvatarUrl || savedAvatarUrl === urlRef.current) return

    let cancelled = false
    const img = new Image()
    img.onload = img.onerror = () => {
      if (!cancelled) setPreviewUrl(null)
    }
    img.src = savedAvatarUrl
    return () => {
      cancelled = true
    }
  }, [pendingAvatar, savedAvatarUrl, setPreviewUrl])

  useEffect(
    () => () => {
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current)
    },
    [],
  )

  const avatarUrl = preview ?? (avatarCleared ? null : savedAvatarUrl)
  const hasAvatar = Boolean(avatarUrl)

  function handleDrop(file: File) {
    setPreviewUrl(URL.createObjectURL(file))
    onStageAvatar(file)
  }

  function handleRemove() {
    if (pendingAvatar) {
      setPreviewUrl(null)
      onStageAvatar(null)
    } else {
      onClearAvatar()
    }
  }

  return (
    <div className="relative shrink-0">
      <DropZone
        ref={dropZoneRef}
        onDrop={(files) => !disabled && files[0] && handleDrop(files[0])}
        accept={{ 'image/*': [] }}
        maxFiles={1}
        noFocus
        noInputEvents
        className="contents"
      >
        <Avatar
          src={avatarUrl}
          size="md"
          onClick={disabled ? undefined : () => dropZoneRef.current?.open()}
          label="Choose avatar"
        />
      </DropZone>
      {hasAvatar && (pendingAvatar || canClear) && (
        <button
          type="button"
          disabled={disabled}
          className={cn(avatarActionClassName, '-top-1')}
          onClick={handleRemove}
          title={pendingAvatar ? 'Cancel avatar change' : clearLabel}
        >
          <XIcon className="size-3" />
        </button>
      )}
      {onResetAvatar && (
        <button
          type="button"
          disabled={disabled}
          className={cn(avatarActionClassName, '-bottom-1')}
          onClick={() => {
            setPreviewUrl(null)
            onResetAvatar()
          }}
          title="Reset to profile avatar"
        >
          <RotateCcwIcon className="size-3" />
        </button>
      )}
    </div>
  )
}
