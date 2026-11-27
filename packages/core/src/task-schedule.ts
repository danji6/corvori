import moment from 'moment-timezone'

export type TaskSchedule = {
  startDate: string
  time: string
  zone: string
  repeat:
    | { kind: 'once' }
    | { kind: 'daily'; every: number }
    | { kind: 'weekly'; every: number; weekdays: number[] }
    | { kind: 'monthly'; every: number; pattern: 'date' | 'weekday' }
}

const dateFormat = 'YYYY-MM-DD'
const localFormat = 'YYYY-MM-DD HH:mm'
export const weekdayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

/** Checks a calendar rule before it is saved or previewed. */
export function scheduleError(rule: TaskSchedule): string | undefined {
  if (!moment.utc(rule.startDate, dateFormat, true).isValid())
    return 'Choose a valid start date.'
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(rule.time))
    return 'Choose a valid time.'
  if (!moment.tz.zone(rule.zone)) return 'Choose a valid time zone.'
  const repeat = rule.repeat
  if (repeat.kind === 'once') return
  if (
    !Number.isInteger(repeat.every) ||
    repeat.every < 1 ||
    repeat.every > 365
  ) {
    return 'Choose an interval between 1 and 365.'
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
  if (resolved.format(localFormat) === local) return resolved.valueOf()
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

type Repeat = Exclude<TaskSchedule['repeat'], { kind: 'once' }>

function periodDays(
  base: moment.Moment,
  anchor: moment.Moment,
  rule: Repeat,
  index: number,
) {
  const offset = index * rule.every
  if (rule.kind === 'daily') return [base.clone().add(offset, 'days')]
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

/** Finds the adjacent occurrence directly from the reference calendar period, even after a long outage. */
export function occurrence(
  rule: TaskSchedule,
  reference: number,
  direction: 'next' | 'latest',
): number | undefined {
  const anchor = moment.utc(rule.startDate, dateFormat, true)
  const matches = (at: number) =>
    direction === 'next' ? at > reference : at <= reference
  const repeat = rule.repeat
  if (repeat.kind === 'once') {
    const at = atLocalTime(anchor, rule)
    return matches(at) ? at : undefined
  }
  const unit =
    repeat.kind === 'daily'
      ? 'day'
      : repeat.kind === 'weekly'
        ? 'isoWeek'
        : 'month'
  const base = anchor.clone().startOf(unit)
  const local = moment.tz(reference, rule.zone)
  const today = moment.utc([local.year(), local.month(), local.date()])
  const distance = today
    .startOf(unit)
    .diff(base, unit === 'isoWeek' ? 'week' : unit)
  let index = Math.max(0, Math.floor(distance / repeat.every))
  const step = direction === 'next' ? 1 : -1
  while (index >= 0) {
    const days = periodDays(base, anchor, repeat, index)
    if (step < 0) days.reverse()
    for (const day of days) {
      if (day.isBefore(anchor)) continue
      const at = atLocalTime(day, rule)
      if (matches(at)) return at
    }
    index += step
  }
}

export function scheduleLabel(rule: TaskSchedule) {
  const { repeat, time } = rule
  if (repeat.kind === 'once') return rule.startDate + ' at ' + time
  const unit =
    repeat.kind === 'daily'
      ? 'day'
      : repeat.kind === 'weekly'
        ? 'week'
        : 'month'
  const interval =
    repeat.every === 1
      ? 'Every ' + unit
      : 'Every ' + repeat.every + ' ' + unit + 's'
  let days = ''
  if (repeat.kind === 'weekly')
    days =
      ' · ' +
      [...repeat.weekdays]
        .sort((a, b) => a - b)
        .map((day) => weekdayNames[day - 1])
        .join(', ')
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
