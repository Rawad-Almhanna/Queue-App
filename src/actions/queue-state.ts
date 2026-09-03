/**
 * Reading and writing queue state from a server action.
 *
 * `loadQueueState` assembles the `QueueState` the pure transitions in
 * src/queue/logic.ts expect; `applyPlan` performs the writes one of those
 * transitions asked for. Keeping both here means every queue action is the
 * same three steps — load, decide, apply — and the deciding is always the
 * unit-tested pure function.
 */

import type { ActionResult, ActionTools } from 'deepspace/worker'
import { expireIfDue, graceDeadline, isPlanEmpty, phaseOf, turnDeadline } from '../queue/logic'
import { isValidRoomCode, normalizeRoomCode } from '../queue/room'
import type {
  QueueEntry,
  QueueEntryData,
  QueueEvent,
  QueuePlan,
  QueueResult,
  QueueRoom,
  QueueRoomData,
  QueueState,
} from '../queue/types'

/** A queue that outgrows this is past the point of being a queue. */
const MAX_ENTRIES_PER_ROOM = 200

/**
 * The record operations the queue needs.
 *
 * Narrowed from `ActionTools` so the cron can satisfy it too: `CronContext`
 * exposes a different, smaller records API, and adapting it to this shape lets
 * a scheduled sweep and a user action run the *same* code rather than two
 * implementations of the same rules that can drift apart.
 */
export type QueueTools = Pick<ActionTools, 'get' | 'query' | 'create' | 'update' | 'remove'>

export type LoadResult = { ok: true; state: QueueState } | { ok: false; error: string }
export type ApplyResult = { ok: true } | { ok: false; error: string }

export async function loadQueueState(tools: QueueTools, code: string): Promise<LoadResult> {
  const roomResult = await tools.get<QueueRoomData>('queue_rooms', code)
  if (!roomResult.success) return { ok: false, error: 'No queue found with that code.' }

  const entriesResult = await tools.query<QueueEntryData>('queue_entries', {
    where: { roomId: code },
    orderBy: 'position',
    orderDir: 'asc',
    limit: MAX_ENTRIES_PER_ROOM,
  })
  if (!entriesResult.success) return { ok: false, error: entriesResult.error }

  return {
    ok: true,
    state: {
      room: {
        recordId: code,
        data: roomResult.data.record.data,
        createdBy: roomResult.data.record.createdBy,
      },
      entries: entriesResult.data.records.map((record) => ({
        recordId: record.recordId,
        data: record.data,
      })),
    },
  }
}

/**
 * Executes a plan's writes.
 *
 * The tools API has no transaction, so the order is chosen for the least
 * damaging partial failure: the room goes first, because a hand-off that
 * stops halfway then leaves someone listed as both holder and waiter — which
 * `waitingList` already hides and the next hand-off clears — rather than
 * dropping them from the queue entirely.
 *
 * Before any turn-changing write, the room is re-read and its `turnSeq`
 * compared against the value the plan was computed from. That closes the
 * realistic race (a user starts their turn while a scheduled expiry is being
 * computed); it narrows rather than eliminates the window, since the records
 * API offers no compare-and-swap.
 */
export async function applyPlan(
  tools: QueueTools,
  code: string,
  plan: QueuePlan,
): Promise<ApplyResult> {
  if (isPlanEmpty(plan)) return { ok: true }

  if (plan.roomPatch.turnSeq !== undefined) {
    const current = await tools.get<QueueRoomData>('queue_rooms', code)
    if (!current.success) return { ok: false, error: 'That queue no longer exists.' }
    if (current.data.record.data.turnSeq !== plan.expectedTurnSeq) {
      return { ok: false, error: 'The queue just changed. Try that again.' }
    }
  }

  if (Object.keys(plan.roomPatch).length > 0) {
    const updated = await tools.update<QueueRoomData>('queue_rooms', code, plan.roomPatch)
    if (!updated.success) return { ok: false, error: updated.error }
  }

  for (const recordId of plan.deleteEntries) {
    const removed = await tools.remove('queue_entries', recordId)
    if (!removed.success) return { ok: false, error: removed.error }
  }

  for (const data of plan.createEntries) {
    const created = await tools.create<QueueEntryData>('queue_entries', data)
    if (!created.success) {
      // The schema's uniqueOn refused a duplicate join that raced past the
      // in-memory check. Say what happened rather than leaking the SQL text.
      if (created.error?.startsWith('Duplicate:')) {
        return { ok: false, error: 'You are already in this queue.' }
      }
      return { ok: false, error: created.error }
    }
  }

  for (const { recordId, patch } of plan.updateEntries) {
    const updated = await tools.update<QueueEntryData>('queue_entries', recordId, patch)
    if (!updated.success) return { ok: false, error: updated.error }
  }

  return { ok: true }
}

/**
 * The shape every queue action has: resolve the code, load, decide, apply.
 *
 * `decide` is always one of the pure transitions, which is where the rules —
 * including every owner check — actually live. A handler's only job is to pass
 * it the JWT-verified caller id, so no action can accidentally trust `params`
 * for who is asking.
 */
export async function runTransition(
  tools: QueueTools,
  rawCode: unknown,
  decide: (state: QueueState, now: number) => QueueResult,
): Promise<ActionResult> {
  const code = normalizeRoomCode(String(rawCode ?? ''))
  if (!isValidRoomCode(code)) return { success: false, error: 'That is not a valid room code.' }

  const loaded = await loadQueueState(tools, code)
  if (!loaded.ok) return { success: false, error: loaded.error }

  const decision = decide(loaded.state, Date.now())
  if (!decision.ok) return { success: false, error: decision.error }

  const applied = await applyPlan(tools, code, decision.plan)
  if (!applied.ok) return { success: false, error: applied.error }

  return { success: true, data: { code, event: decision.plan.event } }
}

// ---- Expiry ---------------------------------------------------------------

export type SweepOutcome =
  | { ok: true; event: QueueEvent | null }
  | { ok: false; error: string }

/**
 * Reclaims one room's turn if the clock says it is due.
 *
 * Safe to call from anywhere, by anyone, as often as you like. It takes no
 * actor: `expireIfDue` decides purely from stored timestamps, so this cannot
 * do anything the clock does not already permit — which is why the matching
 * action needs no permission check. Calling it early is a no-op, and calling
 * it twice is a no-op the second time, because the plan rewrites the very
 * timestamps the deadline was read from.
 */
export async function sweepRoom(
  tools: QueueTools,
  code: string,
  now: number = Date.now(),
): Promise<SweepOutcome> {
  const loaded = await loadQueueState(tools, code)
  if (!loaded.ok) return { ok: false, error: loaded.error }

  const plan = expireIfDue(loaded.state, now)
  if (!plan) return { ok: true, event: null }

  const applied = await applyPlan(tools, code, plan)
  if (!applied.ok) return { ok: false, error: applied.error }

  return { ok: true, event: plan.event }
}

/** True when a room needs its entries loaded to decide anything. */
function mightBeDue(room: QueueRoom, now: number): boolean {
  const phase = phaseOf(room)
  // An idle room only matters if somebody is waiting in it, which the caller
  // determines from the entry list it already has.
  if (phase === 'idle') return true
  const deadline = phase === 'assigned' ? graceDeadline(room) : turnDeadline(room)
  return now >= deadline
}

export interface SweepReport {
  scanned: number
  advanced: number
  errors: string[]
}

/**
 * The scheduled sweep across every room.
 *
 * Reads all rooms and all entries in two queries rather than one pair per
 * room, then decides in memory and writes only where something is actually
 * due. A tick over an idle app therefore costs two reads and no writes.
 */
export async function sweepAllRooms(
  tools: QueueTools,
  now: number = Date.now(),
  limits: { rooms?: number; entries?: number } = {},
): Promise<SweepReport> {
  const report: SweepReport = { scanned: 0, advanced: 0, errors: [] }

  const roomsResult = await tools.query<QueueRoomData>('queue_rooms', {
    limit: limits.rooms ?? 500,
  })
  if (!roomsResult.success) {
    report.errors.push(`queue_rooms: ${roomsResult.error}`)
    return report
  }

  const entriesResult = await tools.query<QueueEntryData>('queue_entries', {
    limit: limits.entries ?? 2000,
  })
  if (!entriesResult.success) {
    report.errors.push(`queue_entries: ${entriesResult.error}`)
    return report
  }

  const byRoom = new Map<string, QueueEntry[]>()
  for (const record of entriesResult.data.records) {
    const list = byRoom.get(record.data.roomId)
    if (list) list.push({ recordId: record.recordId, data: record.data })
    else byRoom.set(record.data.roomId, [{ recordId: record.recordId, data: record.data }])
  }

  for (const record of roomsResult.data.records) {
    report.scanned += 1

    const room: QueueRoom = {
      recordId: record.recordId,
      data: record.data,
      createdBy: record.createdBy,
    }
    const entries = byRoom.get(record.recordId) ?? []

    // Skip the overwhelmingly common case — a running turn with time left, or
    // an empty idle room — without spending a write or another read.
    if (!mightBeDue(room, now)) continue
    if (phaseOf(room) === 'idle' && entries.length === 0) continue

    const plan = expireIfDue({ room, entries }, now)
    if (!plan) continue

    const applied = await applyPlan(tools, record.recordId, plan)
    if (!applied.ok) {
      report.errors.push(`${record.recordId}: ${applied.error}`)
      continue
    }
    report.advanced += 1
  }

  return report
}
