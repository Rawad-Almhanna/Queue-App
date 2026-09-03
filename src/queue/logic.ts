/**
 * Queue state transitions — pure functions over `QueueState`.
 *
 * Nothing here reads a clock, touches a record room, or knows about React:
 * every function takes the state it needs plus `now`, and answers with a
 * `QueuePlan` (the writes to perform) or a typed refusal. The server actions
 * and the cron task both call these, so the rules exist once.
 *
 * Owner checks live here too, so "a member cannot advance the queue" is a unit
 * test rather than a hidden button. The *enforcement* boundary is still the
 * server action that calls these functions with a JWT-verified caller id.
 */

import type {
  QueueEntry,
  QueueErrorCode,
  QueueEvent,
  QueuePlan,
  QueueResult,
  QueueRoom,
  QueueRoomData,
  QueueState,
  TurnPhase,
} from './types'

export function isRoomOwner(room: QueueRoom, userId: string): boolean {
  return Boolean(room.createdBy) && room.createdBy === userId
}

export function phaseOf(room: QueueRoom): TurnPhase {
  if (!room.data.holderUserId) return 'idle'
  return room.data.turnStartedAt > 0 ? 'active' : 'assigned'
}

/** ms epoch by which an assigned holder must press Start, or 0 when N/A. */
export function graceDeadline(room: QueueRoom): number {
  if (phaseOf(room) !== 'assigned') return 0
  return room.data.turnAssignedAt + room.data.graceSeconds * 1000
}

/** ms epoch at which an active turn is reclaimed, or 0 when N/A. */
export function turnDeadline(room: QueueRoom): number {
  if (phaseOf(room) !== 'active') return 0
  return room.data.turnStartedAt + room.data.turnSeconds * 1000
}

/** The waiting list in display order. Ties break deterministically. */
export function waitingList(state: QueueState): QueueEntry[] {
  return [...state.entries]
    .filter((entry) => entry.data.roomId === state.room.recordId)
    .sort(
      (a, b) =>
        a.data.position - b.data.position ||
        a.data.joinedAt - b.data.joinedAt ||
        a.recordId.localeCompare(b.recordId),
    )
}

/** 1-based place in line, or 0 when the user is not waiting. */
export function positionOf(state: QueueState, userId: string): number {
  const index = waitingList(state).findIndex((entry) => entry.data.userId === userId)
  return index + 1
}

export function isPlanEmpty(plan: QueuePlan): boolean {
  return (
    Object.keys(plan.roomPatch).length === 0 &&
    plan.createEntries.length === 0 &&
    plan.updateEntries.length === 0 &&
    plan.deleteEntries.length === 0
  )
}

function newPlan(room: QueueRoom, event: QueueEvent): QueuePlan {
  return {
    event,
    expectedTurnSeq: room.data.turnSeq,
    roomPatch: {},
    createEntries: [],
    updateEntries: [],
    deleteEntries: [],
  }
}

function ok(plan: QueuePlan): QueueResult {
  return { ok: true, plan }
}

function fail(code: QueueErrorCode, error: string): QueueResult {
  return { ok: false, code, error }
}

/** Rewrites `position` to 1..n for the given order, skipping unchanged rows. */
function renumber(plan: QueuePlan, waiting: QueueEntry[]): void {
  waiting.forEach((entry, index) => {
    const position = index + 1
    if (entry.data.position !== position) {
      plan.updateEntries.push({ recordId: entry.recordId, patch: { position } })
    }
  })
}

/**
 * Releases the current holder and hands the turn to the head of `waiting`.
 * `waiting` must already exclude anyone this plan is deleting.
 */
function handOff(plan: QueuePlan, room: QueueRoomData, waiting: QueueEntry[], now: number): void {
  const next = waiting[0]
  const turnSeq = room.turnSeq + 1

  if (!next) {
    plan.roomPatch = {
      ...plan.roomPatch,
      holderUserId: '',
      holderName: '',
      turnAssignedAt: 0,
      turnStartedAt: 0,
      turnSeq,
    }
    return
  }

  plan.deleteEntries.push(next.recordId)
  plan.roomPatch = {
    ...plan.roomPatch,
    holderUserId: next.data.userId,
    holderName: next.data.displayName,
    turnAssignedAt: now,
    turnStartedAt: 0,
    turnSeq,
  }
  renumber(plan, waiting.slice(1))
}

export interface ActorInput {
  userId: string
  now: number
}

export function join(
  state: QueueState,
  { userId, displayName, now }: ActorInput & { displayName: string },
): QueueResult {
  const name = displayName.trim()
  if (!name) return fail('invalid_name', 'Enter a display name to join.')
  if (state.room.data.holderUserId === userId) {
    return fail('already_queued', 'You already have the turn.')
  }

  const waiting = waitingList(state)
  if (waiting.some((entry) => entry.data.userId === userId)) {
    return fail('already_queued', 'You are already in this queue.')
  }

  const plan = newPlan(state.room, 'joined')

  // Free resource and nobody ahead: skip the list and take the turn.
  if (!state.room.data.holderUserId && waiting.length === 0) {
    plan.roomPatch = {
      holderUserId: userId,
      holderName: name,
      turnAssignedAt: now,
      turnStartedAt: 0,
      turnSeq: state.room.data.turnSeq + 1,
    }
    return ok(plan)
  }

  plan.createEntries.push({
    roomId: state.room.recordId,
    userId,
    displayName: name,
    position: waiting.length + 1,
    joinedAt: now,
  })
  return ok(plan)
}

/** Drops `userId` from the room, whether they hold the turn or are waiting. */
function release(state: QueueState, userId: string, now: number, event: QueueEvent): QueueResult {
  const waiting = waitingList(state)

  if (state.room.data.holderUserId === userId) {
    const plan = newPlan(state.room, event)
    handOff(plan, state.room.data, waiting, now)
    return ok(plan)
  }

  const entry = waiting.find((candidate) => candidate.data.userId === userId)
  if (!entry) return fail('not_in_queue', 'That person is not in this queue.')

  const plan = newPlan(state.room, event)
  plan.deleteEntries.push(entry.recordId)
  renumber(
    plan,
    waiting.filter((candidate) => candidate.recordId !== entry.recordId),
  )
  return ok(plan)
}

export function leave(state: QueueState, { userId, now }: ActorInput): QueueResult {
  return release(state, userId, now, 'left')
}

export function startTurn(state: QueueState, { userId, now }: ActorInput): QueueResult {
  if (state.room.data.holderUserId !== userId) {
    return fail('not_holder', 'It is not your turn yet.')
  }
  if (state.room.data.turnStartedAt > 0) {
    return fail('already_started', 'Your turn is already running.')
  }

  const plan = newPlan(state.room, 'turn_started')
  // Bumping turnSeq here is what stops an in-flight grace-period expiry from
  // reclaiming a turn the holder just started.
  plan.roomPatch = { turnStartedAt: now, turnSeq: state.room.data.turnSeq + 1 }
  return ok(plan)
}

export function finishTurn(state: QueueState, { userId, now }: ActorInput): QueueResult {
  if (state.room.data.holderUserId !== userId) {
    return fail('not_holder', 'You do not have the turn.')
  }
  const plan = newPlan(state.room, 'turn_finished')
  handOff(plan, state.room.data, waitingList(state), now)
  return ok(plan)
}

export interface OwnerInput {
  actorUserId: string
  now: number
}

export function advanceQueue(state: QueueState, { actorUserId, now }: OwnerInput): QueueResult {
  if (!isRoomOwner(state.room, actorUserId)) {
    return fail('not_owner', 'Only the room owner can advance the queue.')
  }

  const waiting = waitingList(state)
  if (!state.room.data.holderUserId && waiting.length === 0) {
    return ok(newPlan(state.room, 'noop'))
  }

  const plan = newPlan(state.room, 'advanced')
  handOff(plan, state.room.data, waiting, now)
  return ok(plan)
}

export function removeParticipant(
  state: QueueState,
  { actorUserId, targetUserId, now }: OwnerInput & { targetUserId: string },
): QueueResult {
  if (!isRoomOwner(state.room, actorUserId)) {
    return fail('not_owner', 'Only the room owner can remove people.')
  }
  return release(state, targetUserId, now, 'removed')
}

export function reorderEntry(
  state: QueueState,
  {
    actorUserId,
    recordId,
    direction,
  }: { actorUserId: string; recordId: string; direction: 'up' | 'down' },
): QueueResult {
  if (!isRoomOwner(state.room, actorUserId)) {
    return fail('not_owner', 'Only the room owner can reorder the queue.')
  }

  const waiting = waitingList(state)
  const index = waiting.findIndex((entry) => entry.recordId === recordId)
  if (index === -1) return fail('not_in_queue', 'That person is not in this queue.')

  const target = direction === 'up' ? index - 1 : index + 1
  if (target < 0 || target >= waiting.length) {
    return fail('cannot_move', 'That person is already at the end of the queue.')
  }

  const reordered = [...waiting]
  ;[reordered[index], reordered[target]] = [reordered[target], reordered[index]]

  const plan = newPlan(state.room, 'reordered')
  renumber(plan, reordered)
  return ok(plan)
}

/**
 * The scheduled check. Answers null when nothing is due, so the cron task can
 * skip the room entirely.
 *
 * Idempotent by construction: every plan it returns rewrites the very
 * timestamps the deadline was computed from, so re-running against the applied
 * state answers null. `expectedTurnSeq` guards the concurrent case, where a
 * user acted between the read and the write.
 */
export function expireIfDue(state: QueueState, now: number): QueuePlan | null {
  const waiting = waitingList(state)
  const phase = phaseOf(state.room)

  if (phase === 'idle') {
    // A free resource with people waiting is a stalled room, not an expiry.
    if (waiting.length === 0) return null
    const plan = newPlan(state.room, 'stalled_repaired')
    handOff(plan, state.room.data, waiting, now)
    return plan
  }

  const deadline = phase === 'assigned' ? graceDeadline(state.room) : turnDeadline(state.room)
  if (now < deadline) return null

  const plan = newPlan(state.room, phase === 'assigned' ? 'grace_expired' : 'turn_expired')
  handOff(plan, state.room.data, waiting, now)
  return plan
}
