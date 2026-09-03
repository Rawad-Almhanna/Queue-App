/**
 * Room creation rules — code generation and input validation.
 *
 * Separate from logic.ts because these run once, at creation, and the server
 * action needs them before any `QueueState` exists. `generateRoomCode` takes a
 * random source so tests can pin it.
 */

import {
  DEFAULT_GRACE_SECONDS,
  DEFAULT_TURN_SECONDS,
  MAX_GRACE_SECONDS,
  MAX_LOCATION_LENGTH,
  MAX_NAME_LENGTH,
  MAX_TURN_SECONDS,
  MIN_GRACE_SECONDS,
  MIN_TURN_SECONDS,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  type QueueRoomData,
} from './types'

export interface CreateRoomInput {
  name?: unknown
  location?: unknown
  turnSeconds?: unknown
  graceSeconds?: unknown
}

export type CreateRoomValidation =
  | { ok: true; data: Omit<QueueRoomData, 'turnSeq'> & { turnSeq: number } }
  | { ok: false; field: 'name' | 'location' | 'turnSeconds' | 'graceSeconds'; error: string }

/**
 * Six characters from an unambiguous alphabet — short enough to read aloud,
 * wide enough (~887M combinations) that a collision retry is rare.
 */
export function generateRoomCode(random: () => number = Math.random): string {
  let code = ''
  for (let i = 0; i < ROOM_CODE_LENGTH; i += 1) {
    code += ROOM_CODE_ALPHABET[Math.floor(random() * ROOM_CODE_ALPHABET.length)]
  }
  return code
}

/** Accepts user input in any case/spacing and answers the canonical code. */
export function normalizeRoomCode(input: string): string {
  return input.trim().toUpperCase()
}

export function isValidRoomCode(input: string): boolean {
  const code = normalizeRoomCode(input)
  if (code.length !== ROOM_CODE_LENGTH) return false
  return [...code].every((character) => ROOM_CODE_ALPHABET.includes(character))
}

function asSeconds(value: unknown, fallback: number): number | null {
  if (value === undefined || value === null || value === '') return fallback
  const parsed = typeof value === 'string' ? Number(value) : value
  if (typeof parsed !== 'number' || !Number.isFinite(parsed)) return null
  return Math.trunc(parsed)
}

/**
 * The single gate on room input. The server action calls this, so a forged
 * request cannot create a room with a zero-second turn that the cron would
 * then advance on every tick.
 */
export function validateCreateRoom(input: CreateRoomInput): CreateRoomValidation {
  const name = typeof input.name === 'string' ? input.name.trim() : ''
  if (!name) return { ok: false, field: 'name', error: 'Give the resource a name.' }
  if (name.length > MAX_NAME_LENGTH) {
    return { ok: false, field: 'name', error: `Keep the name under ${MAX_NAME_LENGTH} characters.` }
  }

  const location = typeof input.location === 'string' ? input.location.trim() : ''
  if (location.length > MAX_LOCATION_LENGTH) {
    return {
      ok: false,
      field: 'location',
      error: `Keep the location under ${MAX_LOCATION_LENGTH} characters.`,
    }
  }

  const turnSeconds = asSeconds(input.turnSeconds, DEFAULT_TURN_SECONDS)
  if (turnSeconds === null || turnSeconds < MIN_TURN_SECONDS || turnSeconds > MAX_TURN_SECONDS) {
    return {
      ok: false,
      field: 'turnSeconds',
      error: `Turn length must be between ${MIN_TURN_SECONDS} and ${MAX_TURN_SECONDS} seconds.`,
    }
  }

  const graceSeconds = asSeconds(input.graceSeconds, DEFAULT_GRACE_SECONDS)
  if (
    graceSeconds === null ||
    graceSeconds < MIN_GRACE_SECONDS ||
    graceSeconds > MAX_GRACE_SECONDS
  ) {
    return {
      ok: false,
      field: 'graceSeconds',
      error: `Grace period must be between ${MIN_GRACE_SECONDS} and ${MAX_GRACE_SECONDS} seconds.`,
    }
  }

  return {
    ok: true,
    data: {
      name,
      location,
      turnSeconds,
      graceSeconds,
      holderUserId: '',
      holderName: '',
      turnAssignedAt: 0,
      turnStartedAt: 0,
      turnSeq: 0,
    },
  }
}
