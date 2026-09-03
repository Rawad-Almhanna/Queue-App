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
import {
  advanceQueue as advance,
  finishTurn as finish,
  join,
  leave,
  removeParticipant as removePerson,
  reorderEntry as reorder,
  startTurn as start,
} from '../queue/logic'
import { generateRoomCode, isValidRoomCode, normalizeRoomCode, validateCreateRoom } from '../queue/room'
import { MAX_NAME_LENGTH, type QueueRoomData } from '../queue/types'
import { applyPlan, loadQueueState, runTransition, sweepRoom as sweep } from './queue-state'

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

/**
 * Takes a place in line — or the turn itself, when the resource is free.
 *
 * The caller's id comes from the verified JWT, never from `params`, and the
 * `userBound` column on queue_entries makes the room enforce that too. All
 * this handler decides is the display name; `join` decides everything else.
 */
export const joinQueue: ActionHandler<Env> = async ({ userId, params, tools }) => {
  const code = normalizeRoomCode(String(params.code ?? ''))
  if (!isValidRoomCode(code)) return { success: false, error: 'That is not a valid room code.' }

  const displayName = String(params.displayName ?? '')
    .trim()
    .slice(0, MAX_NAME_LENGTH)

  const loaded = await loadQueueState(tools, code)
  if (!loaded.ok) return { success: false, error: loaded.error }

  const decision = join(loaded.state, { userId, displayName, now: Date.now() })
  if (!decision.ok) return { success: false, error: decision.error }

  const applied = await applyPlan(tools, code, decision.plan)
  if (!applied.ok) return { success: false, error: applied.error }

  return { success: true, data: { code, hasTurn: Boolean(decision.plan.roomPatch.holderUserId) } }
}

// ---- Actions on your own place in the queue -------------------------------
//
// Each of these acts on the caller and nobody else. `userId` comes from the
// verified JWT, and the transitions refuse anyone who is not the holder, so
// there is no way to spend or surrender someone else's turn.

/** Begins the turn you were handed, which starts the turn clock running. */
export const startTurn: ActionHandler<Env> = async ({ userId, params, tools }) =>
  runTransition(tools, params.code, (state, now) => start(state, { userId, now }))

/** Ends your turn early and hands the resource to whoever is next. */
export const finishTurn: ActionHandler<Env> = async ({ userId, params, tools }) =>
  runTransition(tools, params.code, (state, now) => finish(state, { userId, now }))

/** Gives up your place, whether you were holding the turn or waiting for it. */
export const leaveQueue: ActionHandler<Env> = async ({ userId, params, tools }) =>
  runTransition(tools, params.code, (state, now) => leave(state, { userId, now }))

// ---- Owner-only actions ---------------------------------------------------
//
// These read as ordinary handlers because the owner check is inside the
// transition, compared against the room's `createdBy`. A non-owner calling
// these directly over HTTP gets the same refusal a hidden button would imply.

/** Ends the current turn on the holder's behalf and moves the queue along. */
export const advanceQueue: ActionHandler<Env> = async ({ userId, params, tools }) =>
  runTransition(tools, params.code, (state, now) => advance(state, { actorUserId: userId, now }))

/** Drops someone from the room entirely, whether holding or waiting. */
export const removeParticipant: ActionHandler<Env> = async ({ userId, params, tools }) => {
  const targetUserId = String(params.targetUserId ?? '')
  if (!targetUserId) return { success: false, error: 'Missing the person to remove.' }

  return runTransition(tools, params.code, (state, now) =>
    removePerson(state, { actorUserId: userId, targetUserId, now }),
  )
}

/** Moves one waiting entry a single place up or down. */
export const reorderEntry: ActionHandler<Env> = async ({ userId, params, tools }) => {
  const recordId = String(params.recordId ?? '')
  const direction = params.direction
  if (!recordId) return { success: false, error: 'Missing the entry to move.' }
  if (direction !== 'up' && direction !== 'down') {
    return { success: false, error: 'Direction must be "up" or "down".' }
  }

  return runTransition(tools, params.code, (state) =>
    reorder(state, { actorUserId: userId, recordId, direction }),
  )
}

/**
 * Asks the server to reclaim this room's turn if its time is up.
 *
 * Deliberately open to any signed-in caller, including someone not in the
 * queue. It carries no actor and applies only the clock rule, so the worst a
 * hostile client can do is ask a question whose answer is usually "nothing to
 * do". What it cannot do is expire a turn early — the deadline comes from
 * stored timestamps, not from the caller.
 *
 * The room page calls this the moment its countdown reaches zero, which is
 * what makes expiry feel instant; the every-minute cron task is what makes it
 * reliable when nobody has the page open.
 */
export const sweepRoom: ActionHandler<Env> = async ({ params, tools }) => {
  const code = normalizeRoomCode(String(params.code ?? ''))
  if (!isValidRoomCode(code)) return { success: false, error: 'That is not a valid room code.' }

  const result = await sweep(tools, code)
  if (!result.ok) return { success: false, error: result.error }

  return { success: true, data: { code, event: result.event } }
}
