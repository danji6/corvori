import { Input } from '@/components/ui/input'
import { RippleButton } from '@/components/ui/ripple-button'
import { SettingsList } from '@/components/ui/settings-list'
import { PlusIcon, XIcon } from 'lucide-react'
import { type ReactNode, useId, useState } from 'react'

type ApprovalListProps = {
  values: string[]
  onChange: (values: string[]) => void
  placeholder: string
  label: string
  title: string
  description: ReactNode
  className?: string
  validate?: (values: string[]) => string | null
}

type ApprovalFieldProps = Omit<
  ApprovalListProps,
  'label' | 'title' | 'description'
>

export function ShellApprovalList(props: ApprovalFieldProps) {
  return (
    <ApprovalList
      {...props}
      title="Shell commands"
      label="Command prefix"
      description={
        <>
          Command prefixes the agent may run without approval, such as{' '}
          <code>find</code> or <code>git checkout</code>.
        </>
      }
    />
  )
}

type PathApprovalListProps = ApprovalFieldProps & { absoluteOnly?: boolean }

export function PathApprovalList({
  absoluteOnly,
  ...props
}: PathApprovalListProps) {
  const pathHint = absoluteOnly
    ? 'Enter an absolute path.'
    : 'Enter an absolute or workspace-relative path.'

  return (
    <ApprovalList
      {...props}
      title="Paths"
      label="Path"
      description={`Files and directories the agent may read or edit without approval. ${pathHint}`}
    />
  )
}

/** Entry editor shared by shell and path approvals. */
function ApprovalList({
  values,
  onChange,
  placeholder,
  label,
  title,
  description,
  className,
  validate,
}: ApprovalListProps) {
  const descriptionId = useId()
  const [input, setInput] = useState('')
  const value = input.trim()
  const next = [...values, value]
  const error = value ? validate?.(next) : null
  const disabled = !value || values.includes(value) || Boolean(error)

  function add() {
    if (disabled) return
    onChange(next)
    setInput('')
  }

  return (
    <SettingsList.Item
      className={className}
      label={title}
      description={<span id={descriptionId}>{description}</span>}
      orientation="vertical"
      unclickable
      unhoverable
    >
      <div className="flex gap-2">
        <Input
          value={input}
          onChange={(event) => setInput(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return
            event.preventDefault()
            add()
          }}
          placeholder={placeholder}
          aria-label={label}
          aria-describedby={descriptionId}
          aria-invalid={Boolean(error)}
          size="sm"
          className="max-w-70 font-mono"
        />
        <RippleButton
          type="button"
          variant="surface"
          size="icon"
          aria-label={`Add ${label.toLowerCase()}`}
          disabled={disabled}
          onClick={add}
        >
          <PlusIcon />
        </RippleButton>
      </div>
      {error && (
        <p role="alert" className="text-destructive text-xs">
          {error}
        </p>
      )}
      {values.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {values.map((entry) => (
            <span
              key={entry}
              className="bg-m3-surface-container-high flex max-w-full items-center gap-1.5 rounded-full py-1 pr-2 pl-3 font-mono text-xs"
            >
              <span className="break-all">{entry}</span>
              <button
                type="button"
                aria-label={`Remove ${entry}`}
                className="text-muted-foreground hover:text-foreground flex shrink-0 items-center transition-colors"
                onClick={() =>
                  onChange(values.filter((item) => item !== entry))
                }
              >
                <XIcon className="size-3.5" />
              </button>
            </span>
          ))}
        </div>
      )}
    </SettingsList.Item>
  )
}
