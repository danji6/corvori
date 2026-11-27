import { DatePicker } from '@/components/ui/date-picker'
import { Input } from '@/components/ui/input'
import { LabeledCheckbox } from '@/components/ui/labeled-checkbox'
import { TimeField } from '@/components/ui/time-field'
import {
  type TaskSchedule,
  occurrence,
  scheduleError,
  scheduleLabel,
  taskIntervalLimit,
  taskIntervalUnits,
  weekdayNames,
} from '@cv/core/task-schedule'
import moment from 'moment-timezone'
import { useEffect, useState } from 'react'

import {
  ScheduleSelect,
  TimeZoneField,
  fieldStyle,
} from './task-schedule-fields'

const repeatItems = [
  { value: 'once', label: 'Once' },
  { value: 'minutes', label: 'Minute interval' },
  { value: 'hours', label: 'Hour interval' },
  { value: 'daily', label: 'Daily' },
  { value: 'weekdays', label: 'Weekdays' },
  { value: 'weekly', label: 'Selected weekdays' },
  { value: 'monthly', label: 'Monthly' },
] as const

const monthlyItems = [
  { value: 'date', label: 'Day of month from start date' },
  { value: 'weekday', label: 'Weekday position from start date' },
] as const

type RepeatPreset = (typeof repeatItems)[number]['value']

export function defaultSchedule(): TaskSchedule {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  return {
    zone,
    startDate: moment.tz(zone).format('YYYY-MM-DD'),
    time: '09:00',
    repeat: { kind: 'daily', every: 1 },
  }
}

export function localDate(at: number, zone: string) {
  return moment.tz(at, zone).format('MMM D, YYYY · HH:mm z')
}

type Props = { rule: TaskSchedule; onChange: (rule: TaskSchedule) => void }

function initialPreset(repeat: TaskSchedule['repeat']): RepeatPreset {
  if (repeat.kind === 'once') return 'once'
  if (repeat.kind === 'daily' && repeat.every === 1) return 'daily'
  if (
    repeat.kind === 'weekly' &&
    repeat.every === 1 &&
    repeat.weekdays.join(',') === '1,2,3,4,5'
  )
    return 'weekdays'
  return repeat.kind
}

export function RecurrenceEditor({ rule, onChange }: Props) {
  const [preset, setPreset] = useState(() => initialPreset(rule.repeat))
  const change = (patch: Partial<TaskSchedule>) =>
    onChange({ ...rule, ...patch })
  const repeat = rule.repeat
  const elapsedInterval = repeat.kind === 'minutes' || repeat.kind === 'hours'
  function select(kind: RepeatPreset) {
    setPreset(kind)
    if (kind === 'once') change({ repeat: { kind } })
    if (kind === 'daily' || kind === 'minutes' || kind === 'hours') {
      change({ repeat: { kind, every: 1 } })
    }
    if (kind === 'monthly')
      change({ repeat: { kind, every: 1, pattern: 'date' } })
    if (kind === 'weekly' || kind === 'weekdays')
      change({
        repeat: {
          kind: 'weekly',
          every: 1,
          weekdays:
            kind === 'weekdays'
              ? [1, 2, 3, 4, 5]
              : [moment.utc(rule.startDate).isoWeekday()],
        },
      })
  }
  const preview: number[] = []
  const invalid = scheduleError(rule)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(timer)
  }, [])
  let reference = now
  while (!invalid && preview.length < 3) {
    const at = occurrence(rule, reference, 'next')
    if (at === undefined) break
    preview.push(at)
    reference = at
  }
  return (
    <fieldset className="grid gap-4">
      <legend className="mb-3 text-lg font-semibold">Schedule</legend>
      <div className="grid gap-3 sm:grid-cols-2">
        <ScheduleSelect
          label="Repeat"
          items={repeatItems}
          value={preset}
          onChange={select}
        />
        <DatePicker
          label={preset === 'once' ? 'Date' : 'Starting on'}
          name="startDate"
          required
          value={rule.startDate}
          onChange={(startDate) => change({ startDate })}
        />
        <TimeField
          label={elapsedInterval ? 'Start time' : 'Time'}
          name="time"
          required
          value={rule.time}
          onChange={(time) => change({ time })}
        />
        <TimeZoneField
          value={rule.zone}
          onChange={(zone) => change({ zone })}
        />
        {repeat.kind !== 'once' && preset !== 'weekdays' && (
          <label className={fieldStyle}>
            Interval ({taskIntervalUnits[repeat.kind]}s)
            <Input
              type="number"
              min={1}
              max={taskIntervalLimit(repeat.kind)}
              required
              value={repeat.every || ''}
              onChange={(e) =>
                change({ repeat: { ...repeat, every: Number(e.target.value) } })
              }
            />
          </label>
        )}
        {repeat.kind === 'monthly' && (
          <ScheduleSelect
            label="Monthly pattern"
            items={monthlyItems}
            value={repeat.pattern}
            onChange={(pattern) => change({ repeat: { ...repeat, pattern } })}
          />
        )}
      </div>
      {preset === 'weekly' && repeat.kind === 'weekly' && (
        <div className="flex flex-wrap gap-3">
          {weekdayNames.map((name, i) => (
            <LabeledCheckbox
              key={name}
              checked={repeat.weekdays.includes(i + 1)}
              onCheckedChange={(checked) =>
                change({
                  repeat: {
                    ...repeat,
                    weekdays: checked
                      ? [...repeat.weekdays, i + 1].sort((a, b) => a - b)
                      : repeat.weekdays.filter((d) => d !== i + 1),
                  },
                })
              }
            >
              {name}
            </LabeledCheckbox>
          ))}
        </div>
      )}
      <div
        className="bg-m3-surface-container rounded-xl p-4 text-sm"
        aria-live="polite"
      >
        {invalid ||
          (preview.length ? (
            <>
              <strong>{scheduleLabel(rule)}</strong>
              <ul className="text-muted-foreground mt-1">
                {preview.map((at) => (
                  <li key={at}>{localDate(at, rule.zone)}</li>
                ))}
              </ul>
            </>
          ) : (
            'Choose a future time.'
          ))}
      </div>
    </fieldset>
  )
}
