/**
 * Queue data model — the shapes stored as DeepSpace records, plus the plan
 * shape every state transition produces.
 *
 * Two collections, both in the app's single RecordScope:
 *
 *   queue_rooms    one row per shared resource. Its recordId IS the room code.
 *   queue_entries  one row per person waiting, ordered by `position`.
 *
 * The person currently holding the turn is NOT an entry row — they live on the
 * room as `holderUserId`. That keeps "the waiting list" literally the waiting
 * list, and makes the whole turn state a single row to read and patch.
 */

/** Room codes are typed by hand, so the alphabet drops 0/O/1/I/L. */
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
export const ROOM_CODE_LENGTH = 6

export const MIN_TURN_SECONDS = 15
export const MAX_TURN_SECONDS = 7200
export const MIN_GRACE_SECONDS = 10
export const MAX_GRACE_SECONDS = 600

/** 60s so a turn can expire inside a demo. */
export const DEFAULT_TURN_SECONDS = 60
export const DEFAULT_GRACE_SECONDS = 30

export const MAX_NAME_LENGTH = 80
export const MAX_LOCATION_LENGTH = 80

// Declared as object types rather than interfaces so they satisfy the
// `Record<string, unknown>` constraint on `tools.create` / `tools.update`.
export type QueueRoomData = {
  /** Resource being shared, e.g. "Dryer 3". */
  name: string
  /** Optional free text, e.g. "Basement". Empty string when unset. */
  location: string
  /** How long an active turn may run before the cron reclaims it. */
  turnSeconds: number
  /** How long an assigned holder has to press Start before losing the turn. */
  graceSeconds: number
  /** Who holds the turn right now. Empty string means the resource is free. */
  holderUserId: string
  /** Display name snapshot, so rendering the turn needs no directory lookup. */
  holderName: string
  /** ms epoch the holder was handed the turn — the grace clock. 0 when idle. */
  turnAssignedAt: number
  /** ms epoch the holder pressed Start — the turn clock. 0 when not started. */
  turnStartedAt: number
  /**
   * Version of the turn state, incremented by every transition that changes
   * the holder or starts a turn. A writer guards on the value it read, so a
   * scheduled advance can never land on a turn that moved underneath it.
   */
  turnSeq: number
}

export type QueueEntryData = {
  /** Room code this entry belongs to; also the `where` filter for queries. */
  roomId: string
  /** Participant. Declared `userBound` so a client cannot claim another id. */
  userId: string
  displayName: string
  /** 1-based rank in the waiting list. Rewritten on every list change. */
  position: number
  joinedAt: number
}

/** A record as it arrives from `useQuery` / `tools.query`: fields under `data`. */
export interface Envelope<T> {
  recordId: string
  data: T
  /** Envelope field set by the room at create time — the room's owner. */
  createdBy?: string
}

export type QueueRoom = Envelope<QueueRoomData>
export type QueueEntry = Envelope<QueueEntryData>

/** Everything a transition needs to decide. Entries may be in any order. */
export interface QueueState {
  room: QueueRoom
  entries: QueueEntry[]
}

/** `idle` nobody holds it · `assigned` handed over, not started · `active` running. */
export type TurnPhase = 'idle' | 'assigned' | 'active'

export type QueueEvent =
  | 'joined'
  | 'left'
  | 'turn_started'
  | 'turn_finished'
  | 'advanced'
  | 'removed'
  | 'reordered'
  | 'grace_expired'
  | 'turn_expired'
  | 'stalled_repaired'
  | 'noop'

export type QueueErrorCode =
  | 'invalid_name'
  | 'already_queued'
  | 'not_in_queue'
  | 'not_holder'
  | 'already_started'
  | 'not_owner'
  | 'cannot_move'

export interface EntryPatch {
  recordId: string
  patch: Partial<QueueEntryData>
}

/**
 * The writes a transition wants performed. Deliberately data, not effects:
 * a server action executes it with `tools.*`, the cron task with
 * `ctx.records.*`, and a unit test with a plain in-memory apply.
 */
export interface QueuePlan {
  event: QueueEvent
  /** The `turnSeq` this plan was computed against. Refuse the write if it moved. */
  expectedTurnSeq: number
  roomPatch: Partial<QueueRoomData>
  createEntries: QueueEntryData[]
  updateEntries: EntryPatch[]
  deleteEntries: string[]
}

export type QueueResult =
  | { ok: true; plan: QueuePlan }
  | { ok: false; code: QueueErrorCode; error: string }
