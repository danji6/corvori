import type { TextUIPart } from 'ai'

import { EditableText } from './editor/editable-text'
import { useMessageEdit } from './editor/message-edit-context'
import { LinkPreviews } from './link-previews'
import { useMessage } from './message-context'
import { SmoothText } from './smooth-text'

const fontStyle = {
  fontFamily: 'var(--chat-font-family)',
  fontSize: 'var(--chat-font-size)',
}

export type TextBlockProps = {
  part: TextUIPart
  segmentIndex?: number
  index?: number
}

export function TextBlock({ part, segmentIndex, index }: TextBlockProps) {
  const message = useMessage()
  const editCtx = useMessageEdit()
  const isEditing = message != null && editCtx?.editingMessageId === message.id
  const showPreviews = !isEditing && part.state !== 'streaming'

  if (!part.text) return null

  return (
    <>
      <EditableText
        data-slot="text-block"
        part={part}
        segmentIndex={segmentIndex}
        index={index}
        style={fontStyle}
      >
        <SmoothText part={part} />
      </EditableText>
      {showPreviews && <LinkPreviews text={part.text} />}
    </>
  )
}
