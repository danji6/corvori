import moment from 'moment-timezone'

export type TaskSchedule = {
  startDate: string
  time: string
  zone: string
  repeat:
    | { kind: 'once' }
    | { kind: 'minutes'; every: number }
    | { kind: 'hours'; every: number }
    | { kind: 'daily'; every: number }
    | { kind: 'weekly'; every: number; weekdays: number[] }
    | { kind: 'monthly'; every: number; pattern: 'date' | 'weekday' }
}

const dateFormat = 'YYYY-MM-DD'
const localFormat = 'YYYY-MM-DD HH:mm'
const minuteMs = 60_000
type RepeatKind = Exclude<TaskSchedule['repeat']['kind'], 'once'>

export const taskIntervalUnits = {
  minutes: 'minute',
  hours: 'hour',
  daily: 'day',
  weekly: 'week',
  monthly: 'month',
} satisfies Record<RepeatKind, string>

export function taskIntervalLimit(kind: RepeatKind) {
  if (kind === 'minutes') return 365 * 24 * 60
  if (kind === 'hours') return 365 * 24
  return 365
}

export const weekdayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

/** Checks a schedule before it is saved or previewed. */
export function scheduleError(rule: TaskSchedule): string | undefined {
  if (!moment.utc(rule.startDate, dateFormat, true).isValid()) {
    return 'Choose a valid start date.'
  }
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(rule.time)) {
    return 'Choose a valid time.'
  }
  if (!moment.tz.zone(rule.zone)) {
    return 'Choose a valid time zone.'
  }

  const repeat = rule.repeat
  if (repeat.kind === 'once') return

  const limit = taskIntervalLimit(repeat.kind)
  if (
    !Number.isInteger(repeat.every) ||
    repeat.every < 1 ||
    repeat.every > limit
  ) {
    return `Choose a whole-number interval between 1 and ${limit}.`
  }

  if (repeat.kind === 'weekly') {
    const days = new Set(repeat.weekdays)
    if (
      !days.size ||
      days.size !== repeat.weekdays.length ||
      [...days].some((day) => !Number.isInteger(day) || day < 1 || day > 7)
    ) {
      return 'Choose at least one weekday, without duplicates.'
    }
  }
}

/** Resolves a skipped wall time to the transition, and a repeated time to its first instant. */
function atLocalTime(day: moment.Moment, rule: TaskSchedule) {
  const local = day.format(dateFormat) + ' ' + rule.time
  const [hour, minute] = rule.time.split(':').map(Number)

  const resolved = moment.tz(
    [day.year(), day.month(), day.date(), hour, minute],
    rule.zone,
  )
  if (resolved.format(localFormat) === local) {
    return resolved.valueOf()
  }

  const zone = moment.tz.zone(rule.zone)!
  const transition = zone.untils
    .filter((until) => until <= resolved.valueOf())
    .at(-1)

  return transition ?? resolved.valueOf()
}

function monthlyDay(
  month: moment.Moment,
  anchor: moment.Moment,
  pattern: 'date' | 'weekday',
) {
  if (pattern === 'date') {
    return month.daysInMonth() >= anchor.date()
      ? month.date(anchor.date())
      : undefined
  }

  const ordinal = Math.floor((anchor.date() - 1) / 7)
  if (ordinal === 4) {
    const end = month.endOf('month').startOf('day')
    return end.subtract(
      (end.isoWeekday() - anchor.isoWeekday() + 7) % 7,
      'days',
    )
  }

  const offset = (anchor.isoWeekday() - month.isoWeekday() + 7) % 7
  return month.add(ordinal * 7 + offset, 'days')
}

type CalendarRepeat = Exclude<
  TaskSchedule['repeat'],
  { kind: 'once' | 'minutes' | 'hours' }
>

function periodDays(
  base: moment.Moment,
  anchor: moment.Moment,
  rule: CalendarRepeat,
  index: number,
) {
  const offset = index * rule.every

  if (rule.kind === 'daily') {
    return [base.clone().add(offset, 'days')]
  }
  if (rule.kind === 'monthly') {
    const day = monthlyDay(
      base.clone().add(offset, 'months'),
      anchor,
      rule.pattern,
    )
    return day ? [day] : []
  }

  const monday = base.clone().add(offset, 'weeks')
  return [...rule.weekdays]
    .sort((a, b) => a - b)
    .map((day) => monday.clone().add(day - 1, 'days'))
}

function calendarUnit(kind: CalendarRepeat['kind']) {
  if (kind === 'daily') return 'day'
  if (kind === 'weekly') return 'isoWeek'
  return 'month'
}

type Direction = 'next' | 'latest'

function intervalOccurrence(
  start: number,
  duration: number,
  reference: number,
  direction: Direction,
) {
  const index = Math.floor((reference - start) / duration)
  if (direction === 'next') return start + Math.max(0, index + 1) * duration
  if (index >= 0) return start + index * duration
}

function calendarOccurrence(
  rule: TaskSchedule,
  repeat: CalendarRepeat,
  anchor: moment.Moment,
  reference: number,
  direction: Direction,
) {
  const unit = calendarUnit(repeat.kind)
  const base = anchor.clone().startOf(unit)
  const local = moment.tz(reference, rule.zone)
  const today = moment.utc([local.year(), local.month(), local.date()])
  const distance = today.startOf(unit).diff(base, unit === 'isoWeek' ? 'week' : unit) // prettier-ignore
  const step = direction === 'next' ? 1 : -1
  let index = Math.max(0, Math.floor(distance / repeat.every))

  while (index >= 0) {
    const days = periodDays(base, anchor, repeat, index)
    if (step < 0) days.reverse()
    for (const day of days) {
      if (day.isBefore(anchor)) continue
      const at = atLocalTime(day, rule)
      const matches = direction === 'next' ? at > reference : at <= reference
      if (matches) return at
    }
    index += step
  }
}

/** Finds the adjacent occurrence without replaying earlier periods. */
export function occurrence(
  rule: TaskSchedule,
  reference: number,
  direction: Direction,
): number | undefined {
  const anchor = moment.utc(rule.startDate, dateFormat, true)
  const repeat = rule.repeat

  switch (repeat.kind) {
    case 'once': {
      const at = atLocalTime(anchor, rule)
      const matches = direction === 'next' ? at > reference : at <= reference
      return matches ? at : undefined
    }
    case 'minutes':
    case 'hours': {
      const start = atLocalTime(anchor, rule)
      const duration =
        repeat.every * minuteMs * (repeat.kind === 'hours' ? 60 : 1)
      return intervalOccurrence(start, duration, reference, direction)
    }
    default:
      return calendarOccurrence(rule, repeat, anchor, reference, direction)
  }
}

export function scheduleLabel(rule: TaskSchedule) {
  const { repeat, time } = rule

  if (repeat.kind === 'once') {
    return rule.startDate + ' at ' + time
  }

  const unit = taskIntervalUnits[repeat.kind]
  const interval =
    repeat.every === 1
      ? 'Every ' + unit
      : 'Every ' + repeat.every + ' ' + unit + 's'

  if (repeat.kind === 'minutes' || repeat.kind === 'hours') {
    return interval
  }

  let days = ''
  if (repeat.kind === 'weekly') {
    days =
      ' · ' +
      [...repeat.weekdays]
        .sort((a, b) => a - b)
        .map((day) => weekdayNames[day - 1])
        .join(', ')
  }
  if (repeat.kind === 'monthly') {
    const start = moment.utc(rule.startDate, dateFormat)
    const ordinal = ['first', 'second', 'third', 'fourth', 'last'][
      Math.floor((start.date() - 1) / 7)
    ]
    days =
      repeat.pattern === 'date'
        ? ' · day ' + start.date()
        : ' · ' + ordinal + ' ' + weekdayNames[start.isoWeekday() - 1]
  }

  return interval + days + ' at ' + time
}
