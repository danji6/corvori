import { cn } from '@/lib/utils'
import { useContext, useEffect } from 'react'
import {
  DateFieldStateContext,
  DateInput,
  DateSegment,
  TimeFieldStateContext,
} from 'react-aria-components'

export const segmentedInputSurface =
  'border-input bg-m3-surface-container-low focus-within:border-m3-primary data-invalid:border-destructive h-11 min-w-0 rounded-full border pl-4 shadow-xs data-disabled:opacity-50'

type SegmentedInputProps = {
  className?: string
  onIncompleteChange: (incomplete: boolean) => void
}

export function SegmentedInput({
  className,
  onIncompleteChange,
}: SegmentedInputProps) {
  return (
    <DateInput
      className={cn(
        'flex items-center text-base font-normal tabular-nums',
        className,
      )}
    >
      {(segment) => (
        <>
          <DateSegment
            segment={segment}
            className="data-placeholder:text-m3-on-surface-variant focus:bg-m3-primary-container focus:text-m3-on-primary-container rounded-sm px-px outline-none"
          />
          {(segment.type === 'day' || segment.type === 'hour') && (
            <SegmentCompleteness onIncompleteChange={onIncompleteChange} />
          )}
        </>
      )}
    </DateInput>
  )
}

function SegmentCompleteness({
  onIncompleteChange,
}: Pick<SegmentedInputProps, 'onIncompleteChange'>) {
  const dateField = useContext(DateFieldStateContext)
  const timeField = useContext(TimeFieldStateContext)
  const field = dateField ?? timeField
  const segments = field?.segments.filter((segment) => segment.isEditable) ?? []
  const hasEntry = segments.some((segment) => !segment.isPlaceholder)
  const incomplete =
    hasEntry && segments.some((segment) => segment.isPlaceholder)

  // React Aria retains the last committed value while a segment is missing.
  useEffect(
    () => onIncompleteChange(incomplete),
    [incomplete, onIncompleteChange],
  )

  return null
}
