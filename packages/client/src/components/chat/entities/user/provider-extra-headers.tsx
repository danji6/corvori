import { md } from '@/components/markdown'
import { CodeEditor, HelpPopoverLabel } from '@/components/ui'
import { parseProviderExtraHeaders } from '@cv/core/provider-headers'
import { PROVIDER_PLACEHOLDERS } from '@cv/core/provider-placeholders'

const placeholderList = Object.entries(PROVIDER_PLACEHOLDERS)
  .map(([name, description]) => `- \`{{${name}}}\` — ${description}`)
  .join('\n')
export const PLACEHOLDERS_GUIDE = `\n\n**Supported placeholders**\n\n${placeholderList}`

export function ProviderExtraHeaders({
  editorId,
  value,
  onChange,
}: {
  editorId: string
  value: string
  onChange: (value: string) => void
}) {
  let error: string | undefined
  try {
    parseProviderExtraHeaders(value)
  } catch (cause) {
    error = cause instanceof Error ? cause.message : 'Invalid JSON'
  }

  return (
    <div className="flex flex-col gap-1.5">
      <HelpPopoverLabel
        className="text-muted-foreground text-sm"
        help={md`Extra parameters merged into the request headers.${PLACEHOLDERS_GUIDE}`}
      >
        Extra headers <span className="opacity-60">(optional)</span>
      </HelpPopoverLabel>
      <CodeEditor
        value={value}
        onChange={onChange}
        fullscreenId={`provider-extra-headers-${editorId}`}
        language="json"
        placeholder={'{\n  "HTTP-Referer": "https://example.com"\n}'}
        className="h-28 flex-none"
      />
      {error && <p className="text-destructive text-xs">{error}</p>}
    </div>
  )
}
