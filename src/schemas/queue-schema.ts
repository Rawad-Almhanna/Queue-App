/**
 * Queue collections — the record shapes described in src/queue/types.ts.
 *
 * Permissions here are deliberately read-only for everyone below admin. Turn
 * state is a consensus value (who holds the resource, when their clock
 * started), so letting a client patch the room directly would let anyone name
 * themselves the holder. Every write instead goes through a server action in
 * src/actions/, which validates the transition against the current state and
 * the caller's verified id before touching a row.
 *
 * The Durable Object is what enforces that: a direct `useMutations().put` from
 * a member is refused with CREATE/UPDATE DENIED, not merely absent from the UI.
 */

import type { CollectionSchema } from 'deepspace/schema'

/** One row per shared resource. Its recordId is the room code. */
export const queueRoomsSchema: CollectionSchema = {
  name: 'queue_rooms',
  columns: [
    { name: 'name', storage: 'text', interpretation: 'plain', required: true },
    { name: 'location', storage: 'text', interpretation: 'plain' },
    { name: 'turnSeconds', storage: 'number', interpretation: 'plain' },
    { name: 'graceSeconds', storage: 'number', interpretation: 'plain' },
    { name: 'holderUserId', storage: 'text', interpretation: 'plain' },
    { name: 'holderName', storage: 'text', interpretation: 'plain' },
    { name: 'turnAssignedAt', storage: 'number', interpretation: 'plain' },
    { name: 'turnStartedAt', storage: 'number', interpretation: 'plain' },
    { name: 'turnSeq', storage: 'number', interpretation: 'plain' },
  ],
  permissions: {
    // Signed-in users read any room so they can open one by code; nobody
    // writes except through an action. Anonymous sockets get nothing.
    '*': { read: false, create: false, update: false, delete: false },
    viewer: { read: true, create: false, update: false, delete: false },
    member: { read: true, create: false, update: false, delete: false },
    admin: { read: true, create: true, update: true, delete: true },
  },
}

/** One row per person waiting. The current holder is on the room, not here. */
export const queueEntriesSchema: CollectionSchema = {
  name: 'queue_entries',
  columns: [
    { name: 'roomId', storage: 'text', interpretation: 'plain', required: true },
    // userBound makes the room overwrite this with the caller's verified id on
    // create, so a forged request cannot enqueue somebody else.
    { name: 'userId', storage: 'text', interpretation: 'plain', userBound: true, immutable: true },
    { name: 'displayName', storage: 'text', interpretation: 'plain' },
    { name: 'position', storage: 'number', interpretation: 'plain' },
    { name: 'joinedAt', storage: 'number', interpretation: 'plain' },
  ],
  // Server-enforced "one place in line per person per room" — holds against a
  // replayed or forged join, not just against a well-behaved UI.
  uniqueOn: ['roomId', 'userId'],
  ownerField: 'userId',
  permissions: {
    '*': { read: false, create: false, update: false, delete: false },
    viewer: { read: true, create: false, update: false, delete: false },
    member: { read: true, create: false, update: false, delete: false },
    admin: { read: true, create: true, update: true, delete: true },
  },
}
