/**
 * Duration helpers.
 *
 * Durations are stored as whole seconds everywhere — the schema, the actions,
 * the expiry math. Units exist only at the edges: a picker converts into
 * seconds on the way in, and these formatters turn seconds back into something
 * readable on the way out.
 */

export const DURATION_UNITS = ['seconds', 'minutes', 'hours'] as const
export type DurationUnit = (typeof DURATION_UNITS)[number]

export const UNIT_SECONDS: Record<DurationUnit, number> = {
  seconds: 1,
  minutes: 60,
  hours: 3600,
}

export function isDurationUnit(value: unknown): value is DurationUnit {
  return typeof value === 'string' && (DURATION_UNITS as readonly string[]).includes(value)
}

/** Converts a picker value into whole seconds, or null when it isn't a number. */
export function toSeconds(value: unknown, unit: DurationUnit): number | null {
  const raw = typeof value === 'string' ? value.trim() : value
  if (raw === '' || raw === null || raw === undefined) return null

  const parsed = typeof raw === 'string' ? Number(raw) : raw
  if (typeof parsed !== 'number' || !Number.isFinite(parsed)) return null

  return Math.round(parsed * UNIT_SECONDS[unit])
}

/**
 * Picks the largest unit that divides evenly, so a stored 120 comes back as
 * "2 minutes" rather than "120 seconds" when it repopulates a form.
 */
export function splitDuration(seconds: number): { value: number; unit: DurationUnit } {
  if (seconds > 0 && seconds % UNIT_SECONDS.hours === 0) {
    return { value: seconds / UNIT_SECONDS.hours, unit: 'hours' }
  }
  if (seconds > 0 && seconds % UNIT_SECONDS.minutes === 0) {
    return { value: seconds / UNIT_SECONDS.minutes, unit: 'minutes' }
  }
  return { value: seconds, unit: 'seconds' }
}

/** Compact human label: `45 sec`, `2 min`, `1 hr 30 min`. */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0 sec'

  const whole = Math.round(seconds)
  if (whole < UNIT_SECONDS.minutes) return `${whole} sec`

  if (whole < UNIT_SECONDS.hours) {
    const minutes = Math.floor(whole / UNIT_SECONDS.minutes)
    const rest = whole % UNIT_SECONDS.minutes
    return rest ? `${minutes} min ${rest} sec` : `${minutes} min`
  }

  const hours = Math.floor(whole / UNIT_SECONDS.hours)
  const minutes = Math.round((whole % UNIT_SECONDS.hours) / UNIT_SECONDS.minutes)
  return minutes ? `${hours} hr ${minutes} min` : `${hours} hr`
}

/** `m:ss` / `h:mm:ss` for a live countdown. */
export function formatClock(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds))
  const hours = Math.floor(whole / UNIT_SECONDS.hours)
  const minutes = Math.floor((whole % UNIT_SECONDS.hours) / UNIT_SECONDS.minutes)
  const secs = whole % UNIT_SECONDS.minutes

  const pad = (n: number) => String(n).padStart(2, '0')
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(secs)}` : `${minutes}:${pad(secs)}`
}
