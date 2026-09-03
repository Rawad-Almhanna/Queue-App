/**
 * Reading and writing queue state from a server action.
 *
 * `loadQueueState` assembles the `QueueState` the pure transitions in
 * src/queue/logic.ts expect; `applyPlan` performs the writes one of those
 * transitions asked for. Keeping both here means every queue action is the
 * same three steps — load, decide, apply — and the deciding is always the
 * unit-tested pure function.
 */

import type { ActionTools } from 'deepspace/worker'
import { isPlanEmpty } from '../queue/logic'
import type { QueueEntryData, QueuePlan, QueueRoomData, QueueState } from '../queue/types'

/** A queue that outgrows this is past the point of being a queue. */
const MAX_ENTRIES_PER_ROOM = 200

export type LoadResult = { ok: true; state: QueueState } | { ok: false; error: string }
export type ApplyResult = { ok: true } | { ok: false; error: string }

export async function loadQueueState(tools: ActionTools, code: string): Promise<LoadResult> {
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
  tools: ActionTools,
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
