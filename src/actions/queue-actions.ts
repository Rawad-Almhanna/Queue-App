/**
 * Queue server actions.
 *
 * These are the ONLY writers to `queue_rooms` and `queue_entries` — the
 * collections deny writes to every role below admin, so this file is the
 * app's authorization boundary for the queue. `userId` here is the verified
 * JWT subject supplied by registerActionRoutes; never trust an id from
 * `params` for authorization.
 */

import type { ActionHandler } from 'deepspace/worker'
import type { Env } from '../../worker'
import { generateRoomCode, isValidRoomCode, normalizeRoomCode, validateCreateRoom } from '../queue/room'
import type { QueueRoomData } from '../queue/types'

/** Collision odds on a 31^6 space are tiny; a few retries make them nil. */
const ROOM_CODE_ATTEMPTS = 6

/**
 * Creates a room and returns its code.
 *
 * The code IS the record id, so there is no second lookup table and no way for
 * a room and its code to disagree. `tools.create` writes `_created_by` from
 * the calling user, which is what later marks this caller as the room owner.
 */
export const createRoom: ActionHandler<Env> = async ({ userId, params, tools }) => {
  const validation = validateCreateRoom(params)
  if (!validation.ok) return { success: false, error: validation.error }

  for (let attempt = 0; attempt < ROOM_CODE_ATTEMPTS; attempt += 1) {
    const code = generateRoomCode()

    // A successful read means the code is taken — try another.
    const existing = await tools.get('queue_rooms', code)
    if (existing.success) continue

    const created = await tools.create<QueueRoomData>('queue_rooms', validation.data, code)
    if (!created.success) return { success: false, error: created.error }

    return { success: true, data: { code, ownerUserId: userId, room: validation.data } }
  }

  return { success: false, error: 'Could not allocate a room code. Please try again.' }
}

/**
 * Resolves a room code before the client navigates to it, so a typo answers
 * "no queue with that code" instead of an empty room screen. Read-only, and
 * every signed-in user may read rooms, so there is nothing further to gate.
 */
export const getRoom: ActionHandler<Env> = async ({ params, tools }) => {
  const code = normalizeRoomCode(String(params.code ?? ''))
  if (!isValidRoomCode(code)) {
    return { success: false, error: 'That is not a valid room code.' }
  }

  const result = await tools.get<QueueRoomData>('queue_rooms', code)
  if (!result.success) return { success: false, error: 'No queue found with that code.' }

  const { record } = result.data
  return {
    success: true,
    data: { code, room: record.data, ownerUserId: record.createdBy ?? '' },
  }
}
