import { cn } from '@/lib/utils'
import { useThemeScope } from '@/providers/theme-scope'
import { parseDate } from '@internationalized/date'
import {
  CalendarDaysIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
} from 'lucide-react'
import { useMemo, useState } from 'react'
import {
  Button,
  Calendar,
  CalendarCell,
  CalendarGrid,
  CalendarGridBody,
  CalendarGridHeader,
  CalendarHeaderCell,
  DatePicker as DatePickerPrimitive,
  Dialog,
  FieldError,
  Group,
  Heading,
  Label,
  Popover,
} from 'react-aria-components'

import { SegmentedInput, segmentedInputSurface } from './segmented-input'

const iconButton =
  'text-m3-on-surface-variant hover:bg-m3-on-surface/8 focus-visible:outline-m3-primary inline-grid size-9 shrink-0 cursor-pointer place-items-center rounded-full outline-offset-2 focus-visible:outline-2 disabled:cursor-default disabled:opacity-38'

export type DatePickerProps = {
  label: string
  /** A date in YYYY-MM-DD format, or an empty string. */
  value: string
  onChange: (date: string) => void
  name?: string
  required?: boolean
  disabled?: boolean
  className?: string
}

export function DatePicker({
  label,
  value,
  onChange,
  name,
  required,
  disabled,
  className,
}: DatePickerProps) {
  const themeScope = useThemeScope()
  const [incomplete, setIncomplete] = useState(false)
  // Keep React Aria's in-progress edits across rerenders.
  const date = useMemo(() => (value ? parseDate(value) : null), [value])

  return (
    <DatePickerPrimitive
      className={cn('grid gap-1.5 text-sm font-medium', className)}
      name={name}
      isRequired={required}
      isDisabled={disabled}
      isInvalid={incomplete || undefined}
      validationBehavior="native"
      value={date}
      onChange={(nextDate) => onChange(nextDate?.toString() ?? '')}
    >
      <Label>{label}</Label>
      <Group
        className={cn(
          segmentedInputSurface,
          'flex items-center justify-between pr-1',
        )}
      >
        <SegmentedInput onIncompleteChange={setIncomplete} />
        <Button className={iconButton}>
          <CalendarDaysIcon className="size-5" aria-hidden="true" />
        </Button>
      </Group>
      <FieldError className="text-m3-error text-xs">
        Choose a complete date.
      </FieldError>
      <Popover
        placement="bottom start"
        offset={8}
        className={cn(
          'bg-m3-surface-container-high text-m3-on-surface z-55 w-80 max-w-[calc(100dvw-1rem)] overflow-auto rounded-[28px] p-3 shadow-lg',
          themeScope,
        )}
      >
        <PickerCalendar />
      </Popover>
    </DatePickerPrimitive>
  )
}

function PickerCalendar() {
  return (
    <Dialog className="outline-hidden">
      <Calendar className="grid gap-2">
        <header className="flex items-center justify-between gap-2 px-2">
          <Heading className="text-sm font-medium" />
          <div className="flex">
            <Button slot="previous" className={iconButton}>
              <ChevronLeftIcon
                className="size-5 rtl:rotate-180"
                aria-hidden="true"
              />
            </Button>
            <Button slot="next" className={iconButton}>
              <ChevronRightIcon
                className="size-5 rtl:rotate-180"
                aria-hidden="true"
              />
            </Button>
          </div>
        </header>
        <CalendarGrid className="w-full table-fixed border-collapse">
          <CalendarGridHeader>
            {(day) => (
              <CalendarHeaderCell className="text-m3-on-surface-variant h-8 text-xs font-medium">
                {day}
              </CalendarHeaderCell>
            )}
          </CalendarGridHeader>
          <CalendarGridBody>
            {(date) => (
              <CalendarCell
                date={date}
                className="data-hovered:not-data-selected:bg-m3-on-surface/8 data-today:border-m3-primary data-today:not-data-selected:text-m3-primary data-selected:border-m3-primary data-selected:bg-m3-primary data-selected:text-m3-on-primary data-focus-visible:outline-m3-primary mx-auto grid aspect-square w-full max-w-10 cursor-pointer place-items-center rounded-full border border-transparent text-sm outline-offset-2 select-none data-disabled:cursor-default data-disabled:opacity-38 data-focus-visible:outline-2 data-outside-month:invisible"
              />
            )}
          </CalendarGridBody>
        </CalendarGrid>
      </Calendar>
    </Dialog>
  )
}
