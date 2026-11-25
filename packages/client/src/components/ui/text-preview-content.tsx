import { VList } from 'virtua'

import { CopyButton } from './copy-button'

export type PreviewLine = { text: string; html?: string }

type TextPreviewContentProps = {
  lines: PreviewLine[]
  chunks: string[]
  loading: boolean
  truncated: boolean
}

export function TextPreviewContent({
  lines,
  chunks,
  loading,
  truncated,
}: TextPreviewContentProps) {
  if (chunks.length === 1 && !chunks[0]) {
    return (
      <p className="text-muted-foreground row-start-2 flex items-center justify-center text-sm">
        This file is empty.
      </p>
    )
  }

  const digits = Math.max(2, String(lines.length).length)
  return (
    <div className="bg-m3-surface-container-lowest relative row-start-2 grid min-h-0">
      <VList
        data={lines}
        itemSize={18}
        aria-busy={loading}
        aria-label="Attachment text"
        tabIndex={0}
        style={{ '--preview-line-digits': digits } as React.CSSProperties}
        className="min-w-0 overflow-x-auto font-mono text-xs leading-[18px] select-text"
      >
        {(line, index) => (
          <NumberedPreviewLine
            line={line}
            index={index}
            truncated={truncated && index === lines.length - 1}
          />
        )}
      </VList>
      <CopyButton
        aria-label="Copy preview text"
        className="absolute top-2 right-4"
        tooltip="Copy preview text"
        value={() => chunks.join('')}
      />
    </div>
  )
}

function NumberedPreviewLine({
  line,
  index,
  truncated,
}: {
  line: PreviewLine
  index: number
  truncated: boolean
}) {
  return (
    <div className="flex h-4.5 w-max min-w-full pr-14">
      <span
        aria-hidden="true"
        data-slot="attachment-preview-line-number"
        className="bg-m3-surface-container-lowest border-border text-muted-foreground sticky left-0 z-10 w-[calc(var(--preview-line-digits)*1ch+1.75rem+1px)] shrink-0 border-r pr-3 text-right select-none"
      >
        {index + 1}
      </span>
      {line.html ? (
        <code
          className="pl-3 whitespace-pre"
          // Shiki escapes the source text before generating token spans.
          dangerouslySetInnerHTML={{ __html: line.html }}
        />
      ) : (
        <code className="pl-3 whitespace-pre">{line.text}</code>
      )}
      {truncated && (
        <span className="text-muted-foreground whitespace-nowrap select-none">
          ... [truncated]
        </span>
      )}
    </div>
  )
}
