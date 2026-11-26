import { ContextMenu, DropdownMenu, RippleButton } from '@/components/ui'
import {
  FolderDownIcon,
  FolderInputIcon,
  FolderTreeIcon,
  FolderUpIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PinIcon,
  PinOffIcon,
  TrashIcon,
} from 'lucide-react'

export type FolderMenuActions = {
  edit: () => void
  remove: () => void
  reorder: (direction: -1 | 1) => void
  createChild: () => void
  move: () => void
  pin: () => void
}

type FolderMenuProps = FolderMenuActions & {
  pinned?: boolean
  pending: boolean
}

type FolderMenuItemsProps = FolderMenuProps & { dropdown?: boolean }

/** Shares folder actions between the context menu and the options button. */
function FolderMenuItems({
  dropdown,
  pending,
  pinned,
  ...actions
}: FolderMenuItemsProps) {
  const Item = dropdown ? DropdownMenu.Item : ContextMenu.Item
  const Separator = dropdown ? DropdownMenu.Separator : ContextMenu.Separator
  const select = (action: () => void) =>
    dropdown ? { onClick: action } : { onSelect: action }

  return (
    <>
      <Item disabled={pending} {...select(actions.pin)}>
        {pinned ? <PinOffIcon /> : <PinIcon />}
        {pinned ? 'Unpin' : 'Pin'}
      </Item>
      <Item disabled={pending} {...select(actions.edit)}>
        <PencilIcon /> Edit…
      </Item>
      <Item disabled={pending} {...select(actions.createChild)}>
        <FolderTreeIcon /> New subfolder…
      </Item>
      <Separator />
      <Item disabled={pending} {...select(actions.move)}>
        <FolderInputIcon /> Move to…
      </Item>
      <Item disabled={pending} {...select(() => actions.reorder(-1))}>
        <FolderUpIcon /> Move up
      </Item>
      <Item disabled={pending} {...select(() => actions.reorder(1))}>
        <FolderDownIcon /> Move down
      </Item>
      <Separator />
      <Item
        disabled={pending}
        variant="destructive"
        {...select(actions.remove)}
      >
        <TrashIcon /> Delete
      </Item>
    </>
  )
}

export function FolderContextMenu(props: FolderMenuProps) {
  return (
    <ContextMenu.Content>
      <FolderMenuItems {...props} />
    </ContextMenu.Content>
  )
}

export function FolderOptionsMenu({
  name,
  ...props
}: FolderMenuProps & { name: string }) {
  return (
    <DropdownMenu>
      <DropdownMenu.Trigger
        render={
          <RippleButton
            variant="stealth"
            size="icon"
            className="text-muted-foreground hover:text-foreground focus-visible:text-foreground size-8 shrink-0"
            aria-label={`Options for ${name}`}
            title="Folder options"
          >
            <MoreHorizontalIcon />
          </RippleButton>
        }
      />
      <DropdownMenu.Content align="end" className="w-48">
        <FolderMenuItems {...props} dropdown />
      </DropdownMenu.Content>
    </DropdownMenu>
  )
}
