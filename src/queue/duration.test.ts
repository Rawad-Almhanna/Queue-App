import { describe, expect, it } from 'vitest'
import {
  formatClock,
  formatDuration,
  isDurationUnit,
  splitDuration,
  toSeconds,
} from './duration'

describe('toSeconds', () => {
  it('converts each unit into whole seconds', () => {
    expect(toSeconds(45, 'seconds')).toBe(45)
    expect(toSeconds(2, 'minutes')).toBe(120)
    expect(toSeconds(1, 'hours')).toBe(3600)
  })

  it('accepts the string values a form field produces', () => {
    expect(toSeconds('90', 'seconds')).toBe(90)
    expect(toSeconds(' 5 ', 'minutes')).toBe(300)
  })

  it('rounds fractional input to whole seconds', () => {
    expect(toSeconds(1.5, 'minutes')).toBe(90)
    expect(toSeconds(0.5, 'hours')).toBe(1800)
  })

  it('answers null for anything that is not a number', () => {
    for (const value of ['', '   ', 'soon', null, undefined, Number.NaN, Infinity]) {
      expect(toSeconds(value, 'minutes')).toBeNull()
    }
  })
})

describe('splitDuration', () => {
  it('chooses the largest unit that divides evenly', () => {
    expect(splitDuration(3600)).toEqual({ value: 1, unit: 'hours' })
    expect(splitDuration(7200)).toEqual({ value: 2, unit: 'hours' })
    expect(splitDuration(120)).toEqual({ value: 2, unit: 'minutes' })
    expect(splitDuration(60)).toEqual({ value: 1, unit: 'minutes' })
    expect(splitDuration(90)).toEqual({ value: 90, unit: 'seconds' })
    expect(splitDuration(15)).toEqual({ value: 15, unit: 'seconds' })
  })

  it('round-trips through toSeconds', () => {
    for (const seconds of [15, 30, 60, 90, 300, 3600, 5400, 7200]) {
      const { value, unit } = splitDuration(seconds)
      expect(toSeconds(value, unit)).toBe(seconds)
    }
  })

  it('treats zero as seconds rather than dividing by a bigger unit', () => {
    expect(splitDuration(0)).toEqual({ value: 0, unit: 'seconds' })
  })
})

describe('formatDuration', () => {
  it('labels sub-minute durations in seconds', () => {
    expect(formatDuration(15)).toBe('15 sec')
    expect(formatDuration(59)).toBe('59 sec')
  })

  it('labels minutes, with seconds only when there is a remainder', () => {
    expect(formatDuration(60)).toBe('1 min')
    expect(formatDuration(120)).toBe('2 min')
    expect(formatDuration(90)).toBe('1 min 30 sec')
  })

  it('labels hours, with minutes only when there is a remainder', () => {
    expect(formatDuration(3600)).toBe('1 hr')
    expect(formatDuration(7200)).toBe('2 hr')
    expect(formatDuration(5400)).toBe('1 hr 30 min')
  })

  it('never renders a negative or nonsense duration', () => {
    expect(formatDuration(0)).toBe('0 sec')
    expect(formatDuration(-30)).toBe('0 sec')
    expect(formatDuration(Number.NaN)).toBe('0 sec')
  })
})

describe('formatClock', () => {
  it('renders a countdown as m:ss until an hour', () => {
    expect(formatClock(59)).toBe('0:59')
    expect(formatClock(60)).toBe('1:00')
    expect(formatClock(605)).toBe('10:05')
  })

  it('renders h:mm:ss past an hour', () => {
    expect(formatClock(3600)).toBe('1:00:00')
    expect(formatClock(3661)).toBe('1:01:01')
  })

  it('floors at zero so an expired turn never shows a negative clock', () => {
    expect(formatClock(0)).toBe('0:00')
    expect(formatClock(-10)).toBe('0:00')
  })
})

describe('isDurationUnit', () => {
  it('accepts only the supported units', () => {
    expect(isDurationUnit('minutes')).toBe(true)
    expect(isDurationUnit('days')).toBe(false)
    expect(isDurationUnit(60)).toBe(false)
  })
})
