export const MESSAGE_MENU_TRIGGER_CLASS = 'message-context-menu-trigger'
export const MESSAGE_MENU_TRIGGER = `.${MESSAGE_MENU_TRIGGER_CLASS}`

export function forwardMessageMenuMouse(
  event: React.MouseEvent<HTMLDivElement>,
  findTrigger: () => Element | null,
) {
  if (event.defaultPrevented || event.shiftKey) return
  if (event.type === 'mousedown' && event.button !== 2) return

  const trigger = findTrigger()
  if (!trigger) return
  const forwarded = new MouseEvent(event.type, event.nativeEvent)
  if (!trigger.dispatchEvent(forwarded)) event.preventDefault()
}
