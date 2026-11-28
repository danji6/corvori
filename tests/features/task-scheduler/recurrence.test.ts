import {
  type TaskSchedule,
  occurrence,
  scheduleError,
  scheduleLabel,
} from '@cv/core/task-schedule'
import { expect, test } from 'bun:test'

const daily: TaskSchedule = {
  startDate: '2020-01-01',
  time: '09:00',
  zone: 'Europe/Rome',
  repeat: { kind: 'daily', every: 1 },
}
function adjacent(
  rule: TaskSchedule,
  at: string,
  dir: 'latest' | 'next' = 'next',
) {
  return occurrence(rule, Date.parse(at + 'Z'), dir)
}

test('minute intervals begin at the start time and find the latest slot directly', () => {
  const rule: TaskSchedule = {
    ...daily,
    repeat: { kind: 'minutes', every: 15 },
  }
  expect(adjacent(rule, '2020-01-01T07:59', 'latest')).toBeUndefined()
  expect(adjacent(rule, '2020-01-01T07:59')).toBe(
    Date.parse('2020-01-01T08:00Z'),
  )
  expect(adjacent(rule, '2026-03-29T07:17', 'latest')).toBe(
    Date.parse('2026-03-29T07:15Z'),
  )
  expect(adjacent(rule, '2026-03-29T07:15')).toBe(
    Date.parse('2026-03-29T07:30Z'),
  )
  expect(scheduleLabel(rule)).toBe('Every 15 minutes')
})

test('hour intervals keep their elapsed cadence across a time change', () => {
  const rule: TaskSchedule = {
    ...daily,
    startDate: '2026-03-29',
    time: '00:30',
    repeat: { kind: 'hours', every: 2 },
  }
  expect(adjacent(rule, '2026-03-28T23:30', 'latest')).toBe(
    Date.parse('2026-03-28T23:30Z'),
  )
  expect(adjacent(rule, '2026-03-28T23:30')).toBe(
    Date.parse('2026-03-29T01:30Z'),
  )
  expect(scheduleLabel(rule)).toBe('Every 2 hours')
})

test('daily catch-up selects the latest due instant even after years, then returns to local 9 AM', () => {
  const at = '2026-03-29T07:17'
  expect(adjacent(daily, at, 'latest')).toBe(Date.parse('2026-03-29T07:00Z'))
  expect(adjacent(daily, at)).toBe(Date.parse('2026-03-30T07:00Z'))
  expect(adjacent(daily, '2026-03-29T06:59', 'latest')).toBe(
    Date.parse('2026-03-28T08:00Z'),
  )
})

test('one-time schedules retain missed deadlines and have no future occurrence after firing', () => {
  const rule: TaskSchedule = {
    ...daily,
    startDate: '2026-01-02',
    repeat: { kind: 'once' },
  }
  expect(adjacent(rule, '2026-01-02T08:00')).toBeUndefined()
  expect(adjacent(rule, '2026-07-01T00:00', 'latest')).toBe(
    Date.parse('2026-01-02T08:00Z'),
  )
})

test('a spring gap resolves to its first valid minute and the autumn overlap runs once', () => {
  const rule = { ...daily, time: '02:30' }
  expect(adjacent(rule, '2026-03-29T00:00')).toBe(
    Date.parse('2026-03-29T01:00Z'),
  )
  expect(adjacent(rule, '2026-10-25T00:00')).toBe(
    Date.parse('2026-10-25T00:30Z'),
  )
  expect(adjacent(rule, '2026-10-25T00:30')).toBe(
    Date.parse('2026-10-26T01:30Z'),
  )
})

test('selected days respect the anchor week and effective start date', () => {
  const rule: TaskSchedule = {
    ...daily,
    startDate: '2026-11-04',
    repeat: { kind: 'weekly', every: 2, weekdays: [5, 1] },
  }
  expect(adjacent(rule, '2025-01-01T00:00', 'latest')).toBeUndefined()
  expect(adjacent(rule, '2025-01-01T00:00')).toBe(
    Date.parse('2026-11-06T08:00Z'),
  )
  expect(adjacent(rule, '2026-11-06T08:00')).toBe(
    Date.parse('2026-11-16T08:00Z'),
  )
})

test('monthly calendar dates skip short months and weekday patterns preserve position', () => {
  const rule: TaskSchedule = {
    ...daily,
    startDate: '2026-01-31',
    repeat: { kind: 'monthly', every: 1, pattern: 'date' },
  }
  expect(adjacent(rule, '2026-02-01T12:00')).toBe(
    Date.parse('2026-03-31T07:00Z'),
  )
  const firstMonday: TaskSchedule = {
    ...rule,
    startDate: '2026-01-05',
    repeat: { kind: 'monthly', every: 1, pattern: 'weekday' },
  }
  expect(adjacent(firstMonday, '2026-01-05T08:00')).toBe(
    Date.parse('2026-02-02T08:00Z'),
  )
  expect(
    adjacent({ ...firstMonday, startDate: '2026-01-30' }, '2026-02-01T00:00'),
  ).toBe(Date.parse('2026-02-27T08:00Z'))
})

test('rejects malformed dates, zones and rules without a reachable next occurrence', () => {
  expect(scheduleError({ ...daily, startDate: '2026-02-30' })).toBeTruthy()
  expect(scheduleError({ ...daily, zone: 'Planet/Moon' })).toBeTruthy()
  expect(
    scheduleError({
      ...daily,
      repeat: { kind: 'weekly', every: 1, weekdays: [] },
    }),
  ).toBeTruthy()
  expect(
    scheduleError({ ...daily, repeat: { kind: 'daily', every: 0 } }),
  ).toBeTruthy()
  expect(
    scheduleError({ ...daily, repeat: { kind: 'minutes', every: 1.5 } }),
  ).toBeTruthy()
  expect(
    scheduleError({ ...daily, repeat: { kind: 'hours', every: 9000 } }),
  ).toBeTruthy()
})
