export type PresenceEvent = 'joined' | 'left'

/** The transcript line for a participant joining or leaving a session. */
export function presenceText(name: string, event: PresenceEvent) {
  return `${name} has ${event} the session`
}
