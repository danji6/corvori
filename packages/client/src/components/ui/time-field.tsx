import { cn } from '@/lib/utils'
import { parseTime } from '@internationalized/date'
import { useMemo, useState } from 'react'
import {
  FieldError,
  Label,
  TimeField as TimeFieldPrimitive,
} from 'react-aria-components'

import { SegmentedInput, segmentedInputSurface } from './segmented-input'

export type TimeFieldProps = {
  label: string
  /** A local time in HH:mm format, or an empty string. */
  value: string
  onChange: (time: string) => void
  name?: string
  required?: boolean
  disabled?: boolean
  className?: string
}

export function TimeField({
  label,
  value,
  onChange,
  name,
  required,
  disabled,
  className,
}: TimeFieldProps) {
  const [incomplete, setIncomplete] = useState(false)
  // Keep React Aria's in-progress edits across rerenders.
  const time = useMemo(() => (value ? parseTime(value) : null), [value])

  return (
    <TimeFieldPrimitive
      className={cn('grid gap-1.5 text-sm font-medium', className)}
      granularity="minute"
      isRequired={required}
      isDisabled={disabled}
      isInvalid={incomplete || undefined}
      validationBehavior="native"
      value={time}
      onChange={(nextTime) => onChange(nextTime?.toString().slice(0, 5) ?? '')}
    >
      <Label>{label}</Label>
      <SegmentedInput
        className={cn(segmentedInputSurface, 'pr-4')}
        onIncompleteChange={setIncomplete}
      />
      <FieldError className="text-m3-error text-xs">
        Enter a complete time.
      </FieldError>
      {/* Submit HH:mm while React Aria handles native validation. */}
      {name && (
        <input type="hidden" name={name} value={value} disabled={disabled} />
      )}
    </TimeFieldPrimitive>
  )
}
