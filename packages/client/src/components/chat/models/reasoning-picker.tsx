import { Select, type SelectTriggerProps } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { useBreakpoint } from '@/hooks/breakpoint'
import type { ReasoningEffort, UIModel } from '@/lib/chat'
import { cn } from '@/lib/utils'
import {
  defaultModelReasoning,
  normalizeReasoningEffort,
} from '@cv/core/model-reasoning'
import { BrainIcon } from 'lucide-react'

const REASONING_OPTIONS: { value: ReasoningEffort; label: string }[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'none', label: 'None' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'XHigh' },
  { value: 'max', label: 'Max' },
]

export type ReasoningPickerProps = SelectTriggerProps & {
  value: ReasoningEffort | undefined
  onValueChange: (value: ReasoningEffort) => void
  model: UIModel | null
  onInherit?: () => void
  placeholder?: string
  /** Hide the label on mobile. */
  compactMobile?: boolean
}

export function ReasoningPicker({
  disabled,
  className,
  value,
  onValueChange,
  model,
  compactMobile,
  onInherit,
  placeholder,
  ...props
}: ReasoningPickerProps) {
  const isMobile = useBreakpoint('sm') && !!compactMobile
  const showFormSelect = !!onInherit || placeholder !== undefined

  const reasoning =
    onInherit && !model
      ? (value ?? 'auto')
      : normalizeReasoningEffort(
          value,
          model?.reasoning ?? defaultModelReasoning(),
        )
  const inherited = !!onInherit && value === undefined

  const supported =
    model?.reasoning?.type === 'effort'
      ? new Set(model.reasoning.efforts)
      : new Set(['low', 'medium', 'high'])
  const options = REASONING_OPTIONS.filter(
    (option) =>
      option.value === 'auto' ||
      option.value === 'none' ||
      supported.has(option.value),
  )
  const formOptions =
    model?.reasoning?.type === 'none'
      ? [{ value: 'none', label: 'None' }]
      : model?.reasoning?.type === 'binary'
        ? [
            { value: 'auto', label: 'On' },
            { value: 'none', label: 'Off' },
          ]
        : !model
          ? REASONING_OPTIONS
          : options
  const items = onInherit
    ? [{ value: '__inherit__', label: 'Inherit' }, ...formOptions]
    : showFormSelect
      ? formOptions
      : options
  const selected = inherited
    ? '__inherit__'
    : placeholder === undefined
      ? reasoning
      : value
  const selectedItem = items.find((option) => option.value === selected)

  if (!showFormSelect && model?.reasoning?.type === 'none') return null

  if (!showFormSelect && model?.reasoning?.type === 'binary') {
    const checked = reasoning !== 'none'
    return (
      <div className="flex h-10 w-full items-center">
        <Switch
          checked={checked}
          disabled={disabled}
          onCheckedChange={(next) => onValueChange(next ? 'auto' : 'none')}
          aria-label="Enable reasoning"
        />
      </div>
    )
  }

  return (
    <Select
      items={items}
      value={selectedItem?.value ?? null}
      onValueChange={(value) => {
        if (value === '__inherit__') onInherit?.()
        else if (value) onValueChange(value as ReasoningEffort)
      }}
      disabled={disabled}
    >
      <Select.Trigger
        variant="input"
        size={isMobile ? 'icon' : 'default'}
        className={cn('text-muted-foreground', className)}
        aria-label="Select reasoning effort"
        {...props}
      >
        <BrainIcon />
        {!isMobile && (selectedItem?.label ?? placeholder)}
      </Select.Trigger>
      <Select.Content
        alignItemWithTrigger={false}
        className={
          showFormSelect
            ? 'w-72 max-w-[calc(100dvw-2rem)]'
            : 'w-[calc(min(fit-content,100%,120px))]'
        }
      >
        <Select.Group>
          <Select.Label>Reasoning effort</Select.Label>
          {items.map((item) => (
            <Select.Item key={item.value} value={item.value}>
              {item.label}
            </Select.Item>
          ))}
        </Select.Group>
      </Select.Content>
    </Select>
  )
}
