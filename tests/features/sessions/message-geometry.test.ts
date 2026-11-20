/// <reference types="bun-types" />
import { AVATAR_MAX, AVATAR_MIN, avatarVars } from '@/lib/chat'
import { describe, expect, test } from 'bun:test'

const steps = Array.from(
  { length: (AVATAR_MAX - AVATAR_MIN) / 2 + 1 },
  (_, i) => AVATAR_MIN + i * 2,
)

describe('avatar geometry', () => {
  // A negative drop would push the avatar above the header line, out of its own
  // row and into the message above, instead of centring it below the header.
  // This is the invariant AVATAR_MAX exists to hold, and it breaks first if
  // someone raises the cap.
  test('no size drops upwards', () => {
    for (const size of steps) {
      expect(Number(avatarVars(size)['--avatar-drop'])).toBeGreaterThanOrEqual(
        0,
      )
    }
  })

  test('sizes outside the range are clamped, odd ones snapped', () => {
    expect(avatarVars(8)['--avatar-size']).toBe(`${AVATAR_MIN}px`)
    expect(avatarVars(200)['--avatar-size']).toBe(`${AVATAR_MAX}px`)
    expect(avatarVars(41)['--avatar-size']).toBe('42px')
    expect(avatarVars(38.5)['--avatar-size']).toBe('38px')
  })
})
