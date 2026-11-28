import { Avatar, type AvatarProps } from '@/components/ui/avatar'
import { useAvatarThumbnail } from '@/hooks/chat/avatars'
import { useStableValue } from '@/hooks/stable-value'
import type { Id } from '@cv/convex/_generated/dataModel'
import { BotIcon } from 'lucide-react'

type SessionAvatarProps = AvatarProps & {
  avatarId?: Id<'avatars'>
}

export function SessionAvatar({
  avatarId,
  fallbackIcon,
  ...props
}: SessionAvatarProps) {
  const src = useAvatarThumbnail(avatarId)
  const stableSrc = useStableValue(src, Boolean(avatarId && !src))
  return (
    <Avatar
      size="md"
      src={stableSrc}
      fallbackIcon={fallbackIcon ?? <BotIcon />}
      {...props}
    />
  )
}
