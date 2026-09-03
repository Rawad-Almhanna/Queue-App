import type { ActionHandler } from 'deepspace/worker'
import type { Env } from '../../worker'
import {
  advanceQueue,
  createRoom,
  finishTurn,
  getRoom,
  joinQueue,
  leaveQueue,
  removeParticipant,
  reorderEntry,
  startTurn,
  sweepRoom,
} from './queue-actions'

/**
 * Every write to the queue goes through one of these.
 *
 * The collections themselves are read-only to members (see queue-schema.ts),
 * so this map is the whole write surface: there is no client mutation that can
 * reorder a queue or hand someone a turn.
 */
export const actions: Record<string, ActionHandler<Env>> = {
  createRoom,
  getRoom,
  joinQueue,
  startTurn,
  finishTurn,
  leaveQueue,
  advanceQueue,
  removeParticipant,
  reorderEntry,
  sweepRoom,
}
