import { describe, expect, it } from 'vitest'
import { generateRoomCode, isValidRoomCode, normalizeRoomCode, validateCreateRoom } from './room'
import { ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH } from './types'

describe('room codes', () => {
  it('generates a code of the right length from the unambiguous alphabet', () => {
    for (let i = 0; i < 200; i += 1) {
      const code = generateRoomCode()
      expect(code).toHaveLength(ROOM_CODE_LENGTH)
      expect([...code].every((character) => ROOM_CODE_ALPHABET.includes(character))).toBe(true)
    }
  })

  it('never emits characters that are easy to misread', () => {
    const codes = Array.from({ length: 500 }, () => generateRoomCode()).join('')
    for (const confusable of ['0', 'O', '1', 'I', 'L']) {
      expect(codes).not.toContain(confusable)
    }
  })

  it('is deterministic for a pinned random source', () => {
    expect(generateRoomCode(() => 0)).toBe('A'.repeat(ROOM_CODE_LENGTH))
  })

  it('accepts a code typed in any case or with stray spacing', () => {
    expect(normalizeRoomCode('  abc234 ')).toBe('ABC234')
    expect(isValidRoomCode(' abc234 ')).toBe(true)
  })

  it('rejects codes of the wrong length or with confusable characters', () => {
    expect(isValidRoomCode('ABC23')).toBe(false)
    expect(isValidRoomCode('ABC2345')).toBe(false)
    expect(isValidRoomCode('ABC01O')).toBe(false)
    expect(isValidRoomCode('')).toBe(false)
  })
})

describe('room creation input', () => {
  it('accepts a full valid room and trims the text fields', () => {
    const result = validateCreateRoom({
      name: '  Dryer 3  ',
      location: '  Basement ',
      turnSeconds: 60,
      graceSeconds: 30,
    })

    expect(result).toMatchObject({
      ok: true,
      data: { name: 'Dryer 3', location: 'Basement', turnSeconds: 60, graceSeconds: 30 },
    })
  })

  it('starts every room idle at turnSeq zero', () => {
    const result = validateCreateRoom({ name: 'Grill' })
    if (!result.ok) throw new Error(result.error)

    expect(result.data).toMatchObject({
      holderUserId: '',
      holderName: '',
      turnAssignedAt: 0,
      turnStartedAt: 0,
      turnSeq: 0,
    })
  })

  it('defaults the durations when they are omitted or blank', () => {
    expect(validateCreateRoom({ name: 'Grill' })).toMatchObject({
      ok: true,
      data: { turnSeconds: 60, graceSeconds: 30, location: '' },
    })
    expect(validateCreateRoom({ name: 'Grill', turnSeconds: '' })).toMatchObject({
      ok: true,
      data: { turnSeconds: 60 },
    })
  })

  it('accepts numeric strings from a form field', () => {
    expect(validateCreateRoom({ name: 'Grill', turnSeconds: '120' })).toMatchObject({
      ok: true,
      data: { turnSeconds: 120 },
    })
  })

  it('requires a resource name', () => {
    expect(validateCreateRoom({ name: '   ' })).toMatchObject({ ok: false, field: 'name' })
    expect(validateCreateRoom({})).toMatchObject({ ok: false, field: 'name' })
  })

  it('rejects names and locations that are too long', () => {
    expect(validateCreateRoom({ name: 'x'.repeat(81) })).toMatchObject({ ok: false, field: 'name' })
    expect(validateCreateRoom({ name: 'Grill', location: 'x'.repeat(81) })).toMatchObject({
      ok: false,
      field: 'location',
    })
  })

  it('rejects turn durations outside the supported range', () => {
    for (const turnSeconds of [0, -60, 14, 7201, 'soon', Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(validateCreateRoom({ name: 'Grill', turnSeconds })).toMatchObject({
        ok: false,
        field: 'turnSeconds',
      })
    }
  })

  it('rejects grace periods outside the supported range', () => {
    for (const graceSeconds of [0, 9, 601, 'later']) {
      expect(validateCreateRoom({ name: 'Grill', graceSeconds })).toMatchObject({
        ok: false,
        field: 'graceSeconds',
      })
    }
  })
})
