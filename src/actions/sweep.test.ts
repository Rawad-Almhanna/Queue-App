/**
 * Scheduled expiration, tested against an in-memory record store.
 *
 * A fake `QueueTools` lets these run in milliseconds and, more usefully, lets
 * them count writes — which is how "idempotent" is checked here. Re-running a
 * sweep that has nothing to do must not merely produce the same state, it must
 * not touch the store at all.
 */

import { describe, expect, it } from 'vitest'
import { sweepAllRooms, sweepRoom, type QueueTools } from './queue-state'
import type { QueueEntryData, QueueRoomData } from '../queue/types'

const T0 = 1_700_000_000_000

function room(overrides: Partial<QueueRoomData> = {}): QueueRoomData {
  return {
    name: 'Dryer',
    location: '',
    turnSeconds: 60,
    graceSeconds: 30,
    holderUserId: '',
    holderName: '',
    turnAssignedAt: 0,
    turnStartedAt: 0,
    turnSeq: 0,
    ...overrides,
  }
}

function entry(overrides: Partial<QueueEntryData> = {}): QueueEntryData {
  return {
    roomId: 'AAA111',
    userId: 'u-bob',
    displayName: 'Bob',
    position: 1,
    joinedAt: T0,
    ...overrides,
  }
}

/** Minimal stand-in for the record room, with write accounting. */
function fakeTools() {
  const rooms = new Map<string, { data: QueueRoomData; createdBy: string }>()
  const entries = new Map<string, { data: QueueEntryData }>()
  const writes = { create: 0, update: 0, remove: 0 }
  let nextId = 1

  const tools = {
    async get(collection: string, recordId: string) {
      if (collection === 'queue_rooms') {
        const found = rooms.get(recordId)
        if (!found) return { success: false, error: 'Not found' }
        return { success: true, data: { record: { recordId, ...found } } }
      }
      const found = entries.get(recordId)
      if (!found) return { success: false, error: 'Not found' }
      return { success: true, data: { record: { recordId, ...found } } }
    },

    async query(collection: string, options?: { where?: Record<string, unknown> }) {
      const source =
        collection === 'queue_rooms'
          ? [...rooms].map(([recordId, value]) => ({ recordId, ...value }))
          : [...entries].map(([recordId, value]) => ({ recordId, ...value }))

      const where = options?.where ?? {}
      const records = source.filter((record) =>
        Object.entries(where).every(([field, value]) =>
          field === 'recordId'
            ? record.recordId === value
            : (record.data as Record<string, unknown>)[field] === value,
        ),
      )
      return { success: true, data: { records, count: records.length } }
    },

    async create(collection: string, data: Record<string, unknown>, recordId?: string) {
      writes.create += 1
      const id = recordId ?? `r${nextId++}`
      if (collection === 'queue_rooms') {
        rooms.set(id, { data: data as QueueRoomData, createdBy: 'u-owner' })
      } else {
        entries.set(id, { data: data as QueueEntryData })
      }
      return { success: true, data: { recordId: id } }
    },

    async update(collection: string, recordId: string, patch: Record<string, unknown>) {
      writes.update += 1
      if (collection === 'queue_rooms') {
        const existing = rooms.get(recordId)
        if (!existing) return { success: false, error: 'Not found' }
        rooms.set(recordId, { ...existing, data: { ...existing.data, ...patch } })
      } else {
        const existing = entries.get(recordId)
        if (!existing) return { success: false, error: 'Not found' }
        entries.set(recordId, { data: { ...existing.data, ...patch } as QueueEntryData })
      }
      return { success: true, data: { recordId } }
    },

    async remove(collection: string, recordId: string) {
      writes.remove += 1
      if (collection === 'queue_rooms') rooms.delete(recordId)
      else entries.delete(recordId)
      return { success: true, data: { recordId } }
    },
  }

  return {
    tools: tools as unknown as QueueTools,
    rooms,
    entries,
    writes,
    totalWrites: () => writes.create + writes.update + writes.remove,
    seedRoom(code: string, data: QueueRoomData, createdBy = 'u-owner') {
      rooms.set(code, { data, createdBy })
    },
    seedEntry(recordId: string, data: QueueEntryData) {
      entries.set(recordId, { data })
    },
  }
}

describe('sweepRoom — an expired active turn', () => {
  it('hands the resource to the next person in line', async () => {
    const store = fakeTools()
    store.seedRoom(
      'AAA111',
      room({
        holderUserId: 'u-alice',
        holderName: 'Alice',
        turnAssignedAt: T0,
        turnStartedAt: T0,
        turnSeq: 1,
      }),
    )
    store.seedEntry('e1', entry())

    const result = await sweepRoom(store.tools, 'AAA111', T0 + 61_000)

    expect(result).toEqual({ ok: true, event: 'turn_expired' })
    expect(store.rooms.get('AAA111')?.data.holderUserId).toBe('u-bob')
    expect(store.rooms.get('AAA111')?.data.holderName).toBe('Bob')
    // The new holder is no longer waiting, and their clock restarts unstarted.
    expect(store.entries.has('e1')).toBe(false)
    expect(store.rooms.get('AAA111')?.data.turnStartedAt).toBe(0)
    expect(store.rooms.get('AAA111')?.data.turnAssignedAt).toBe(T0 + 61_000)
  })

  it('does nothing at all while the turn still has time left', async () => {
    const store = fakeTools()
    store.seedRoom(
      'AAA111',
      room({
        holderUserId: 'u-alice',
        holderName: 'Alice',
        turnAssignedAt: T0,
        turnStartedAt: T0,
        turnSeq: 1,
      }),
    )
    store.seedEntry('e1', entry())

    const result = await sweepRoom(store.tools, 'AAA111', T0 + 59_000)

    expect(result).toEqual({ ok: true, event: null })
    expect(store.totalWrites()).toBe(0)
    expect(store.rooms.get('AAA111')?.data.holderUserId).toBe('u-alice')
  })
})

describe('sweepRoom — an assigned turn nobody started', () => {
  it('moves on once the grace period lapses', async () => {
    const store = fakeTools()
    store.seedRoom(
      'AAA111',
      room({
        holderUserId: 'u-alice',
        holderName: 'Alice',
        turnAssignedAt: T0,
        turnStartedAt: 0,
        turnSeq: 1,
      }),
    )
    store.seedEntry('e1', entry())

    const result = await sweepRoom(store.tools, 'AAA111', T0 + 31_000)

    expect(result).toEqual({ ok: true, event: 'grace_expired' })
    expect(store.rooms.get('AAA111')?.data.holderUserId).toBe('u-bob')
  })

  it('leaves an assigned turn alone inside the grace period', async () => {
    const store = fakeTools()
    store.seedRoom(
      'AAA111',
      room({ holderUserId: 'u-alice', holderName: 'Alice', turnAssignedAt: T0, turnSeq: 1 }),
    )

    expect(await sweepRoom(store.tools, 'AAA111', T0 + 29_000)).toEqual({ ok: true, event: null })
    expect(store.totalWrites()).toBe(0)
  })
})

describe('sweepRoom — an empty queue', () => {
  it('frees the resource when the turn expires with nobody waiting', async () => {
    const store = fakeTools()
    store.seedRoom(
      'AAA111',
      room({
        holderUserId: 'u-alice',
        holderName: 'Alice',
        turnAssignedAt: T0,
        turnStartedAt: T0,
        turnSeq: 1,
      }),
    )

    const result = await sweepRoom(store.tools, 'AAA111', T0 + 61_000)

    expect(result).toEqual({ ok: true, event: 'turn_expired' })
    const after = store.rooms.get('AAA111')?.data
    expect(after?.holderUserId).toBe('')
    expect(after?.holderName).toBe('')
    expect(after?.turnAssignedAt).toBe(0)
    expect(after?.turnStartedAt).toBe(0)
  })

  it('is a no-op on an idle room with nobody in it', async () => {
    const store = fakeTools()
    store.seedRoom('AAA111', room())

    expect(await sweepRoom(store.tools, 'AAA111', T0 + 999_000)).toEqual({ ok: true, event: null })
    expect(store.totalWrites()).toBe(0)
  })

  it('reports a room code that does not exist', async () => {
    const store = fakeTools()
    const result = await sweepRoom(store.tools, 'ZZZZZZ', T0)
    expect(result.ok).toBe(false)
  })
})

describe('sweepRoom — repeated executions', () => {
  it('is idempotent: the second sweep changes nothing and writes nothing', async () => {
    const store = fakeTools()
    store.seedRoom(
      'AAA111',
      room({
        holderUserId: 'u-alice',
        holderName: 'Alice',
        turnAssignedAt: T0,
        turnStartedAt: T0,
        turnSeq: 1,
      }),
    )
    store.seedEntry('e1', entry())

    const first = await sweepRoom(store.tools, 'AAA111', T0 + 61_000)
    expect(first).toEqual({ ok: true, event: 'turn_expired' })

    const stateAfterFirst = { ...store.rooms.get('AAA111')!.data }
    const writesAfterFirst = store.totalWrites()

    // Same instant, run again — as a retried alarm or a second client's nudge.
    const second = await sweepRoom(store.tools, 'AAA111', T0 + 61_000)
    expect(second).toEqual({ ok: true, event: null })
    expect(store.rooms.get('AAA111')?.data).toEqual(stateAfterFirst)
    expect(store.totalWrites()).toBe(writesAfterFirst)
  })

  it('advances one step per due deadline, not several at once', async () => {
    const store = fakeTools()
    store.seedRoom(
      'AAA111',
      room({
        holderUserId: 'u-alice',
        holderName: 'Alice',
        turnAssignedAt: T0,
        turnStartedAt: T0,
        turnSeq: 1,
      }),
    )
    store.seedEntry('e1', entry({ userId: 'u-bob', displayName: 'Bob', position: 1 }))
    store.seedEntry('e2', entry({ userId: 'u-cara', displayName: 'Cara', position: 2 }))

    // Long past both deadlines, but one sweep only moves the queue one place.
    await sweepRoom(store.tools, 'AAA111', T0 + 600_000)
    expect(store.rooms.get('AAA111')?.data.holderUserId).toBe('u-bob')

    // Bob is now assigned; his grace period has not begun to run at this
    // instant, so the queue rests until it lapses.
    await sweepRoom(store.tools, 'AAA111', T0 + 600_000)
    expect(store.rooms.get('AAA111')?.data.holderUserId).toBe('u-bob')

    // Once it does, Cara is up.
    await sweepRoom(store.tools, 'AAA111', T0 + 600_000 + 31_000)
    expect(store.rooms.get('AAA111')?.data.holderUserId).toBe('u-cara')
  })

  it('bumps turnSeq on every advance so a stale writer is refused', async () => {
    const store = fakeTools()
    store.seedRoom(
      'AAA111',
      room({
        holderUserId: 'u-alice',
        holderName: 'Alice',
        turnAssignedAt: T0,
        turnStartedAt: T0,
        turnSeq: 7,
      }),
    )
    store.seedEntry('e1', entry())

    await sweepRoom(store.tools, 'AAA111', T0 + 61_000)
    expect(store.rooms.get('AAA111')?.data.turnSeq).toBe(8)
  })
})

describe('sweepAllRooms — the scheduled tick', () => {
  it('advances only the rooms that are due', async () => {
    const store = fakeTools()

    // Due: started a minute ago with a 60s turn.
    store.seedRoom(
      'DUE001',
      room({
        holderUserId: 'u-alice',
        holderName: 'Alice',
        turnAssignedAt: T0,
        turnStartedAt: T0,
        turnSeq: 1,
      }),
    )
    store.seedEntry('e1', entry({ roomId: 'DUE001' }))

    // Not due: same setup but a much longer turn.
    store.seedRoom(
      'FRESH1',
      room({
        turnSeconds: 3600,
        holderUserId: 'u-dave',
        holderName: 'Dave',
        turnAssignedAt: T0,
        turnStartedAt: T0,
        turnSeq: 1,
      }),
    )
    store.seedEntry('e2', entry({ roomId: 'FRESH1', userId: 'u-eve', displayName: 'Eve' }))

    // Idle and empty: nothing to do.
    store.seedRoom('EMPTY1', room())

    const report = await sweepAllRooms(store.tools, T0 + 61_000)

    expect(report.scanned).toBe(3)
    expect(report.advanced).toBe(1)
    expect(report.errors).toEqual([])
    expect(store.rooms.get('DUE001')?.data.holderUserId).toBe('u-bob')
    expect(store.rooms.get('FRESH1')?.data.holderUserId).toBe('u-dave')
  })

  it('costs no writes when nothing is due', async () => {
    const store = fakeTools()
    store.seedRoom('EMPTY1', room())
    store.seedRoom(
      'FRESH1',
      room({
        turnSeconds: 3600,
        holderUserId: 'u-dave',
        holderName: 'Dave',
        turnAssignedAt: T0,
        turnStartedAt: T0,
        turnSeq: 1,
      }),
    )

    const report = await sweepAllRooms(store.tools, T0 + 1000)

    expect(report.advanced).toBe(0)
    expect(store.totalWrites()).toBe(0)
  })

  it('runs repeatedly without drifting', async () => {
    const store = fakeTools()
    store.seedRoom(
      'AAA111',
      room({
        holderUserId: 'u-alice',
        holderName: 'Alice',
        turnAssignedAt: T0,
        turnStartedAt: T0,
        turnSeq: 1,
      }),
    )
    store.seedEntry('e1', entry())

    const now = T0 + 61_000
    const first = await sweepAllRooms(store.tools, now)
    expect(first.advanced).toBe(1)

    const writesAfterFirst = store.totalWrites()
    const stateAfterFirst = { ...store.rooms.get('AAA111')!.data }

    // Four more ticks at the same instant must all be no-ops.
    for (let tick = 0; tick < 4; tick += 1) {
      const report = await sweepAllRooms(store.tools, now)
      expect(report.advanced).toBe(0)
      expect(report.errors).toEqual([])
    }

    expect(store.totalWrites()).toBe(writesAfterFirst)
    expect(store.rooms.get('AAA111')?.data).toEqual(stateAfterFirst)
  })

  it('repairs a stalled room where the resource is free but people are waiting', async () => {
    const store = fakeTools()
    store.seedRoom('AAA111', room({ turnSeq: 3 }))
    store.seedEntry('e1', entry({ userId: 'u-bob', displayName: 'Bob', position: 1 }))

    const report = await sweepAllRooms(store.tools, T0 + 1000)

    expect(report.advanced).toBe(1)
    expect(store.rooms.get('AAA111')?.data.holderUserId).toBe('u-bob')
    expect(store.entries.has('e1')).toBe(false)
  })

  it('treats an entry that vanished mid-plan as done, and still renumbers', async () => {
    const store = fakeTools()
    store.seedRoom(
      'AAA111',
      room({
        holderUserId: 'u-alice',
        holderName: 'Alice',
        turnAssignedAt: T0,
        turnStartedAt: T0,
        turnSeq: 1,
      }),
    )
    store.seedEntry('e1', entry({ userId: 'u-bob', displayName: 'Bob', position: 1 }))
    store.seedEntry('e2', entry({ userId: 'u-cara', displayName: 'Cara', position: 2 }))
    store.seedEntry('e3', entry({ userId: 'u-dan', displayName: 'Dan', position: 3 }))

    // Bob's row disappears between the read and the write — a concurrent leave,
    // or a second sweeper that got there first.
    const racing = {
      ...(store.tools as unknown as Record<string, unknown>),
      remove: async (collection: string, recordId: string) => {
        if (recordId === 'e1') return { success: false, error: 'Record not found' }
        return (store.tools as unknown as { remove: Function }).remove(collection, recordId)
      },
    } as unknown as QueueTools

    const report = await sweepAllRooms(racing, T0 + 61_000)

    // The hand-off is not abandoned, and — the actual bug — the survivors are
    // still renumbered rather than left holding their old positions.
    expect(report.advanced).toBe(1)
    expect(report.errors).toEqual([])
    expect(store.rooms.get('AAA111')?.data.holderUserId).toBe('u-bob')
    expect(store.entries.get('e2')?.data.position).toBe(1)
    expect(store.entries.get('e3')?.data.position).toBe(2)
  })

  it('counts a lost race as skipped, not as an error', async () => {
    const store = fakeTools()
    store.seedRoom(
      'AAA111',
      room({
        holderUserId: 'u-alice',
        holderName: 'Alice',
        turnAssignedAt: T0,
        turnStartedAt: T0,
        turnSeq: 1,
      }),
    )
    store.seedEntry('e1', entry())

    // Between the read and the write, somebody else advances the turn — which
    // is exactly what the room page's nudge does under a cron tick.
    const racing = {
      ...(store.tools as unknown as Record<string, unknown>),
      get: async (collection: string, recordId: string) => {
        const result = await (
          store.tools as unknown as { get: Function }
        ).get(collection, recordId)
        if (collection === 'queue_rooms' && result.success) {
          return {
            success: true,
            data: {
              record: {
                ...result.data.record,
                data: { ...result.data.record.data, turnSeq: 99 },
              },
            },
          }
        }
        return result
      },
    } as unknown as QueueTools

    const report = await sweepAllRooms(racing, T0 + 61_000)

    expect(report.errors).toEqual([])
    expect(report.skipped).toBe(1)
    expect(report.advanced).toBe(0)
  })

  it('still reports a genuine write failure', async () => {
    const store = fakeTools()
    store.seedRoom(
      'AAA111',
      room({
        holderUserId: 'u-alice',
        holderName: 'Alice',
        turnAssignedAt: T0,
        turnStartedAt: T0,
        turnSeq: 1,
      }),
    )
    store.seedEntry('e1', entry())

    const failing = {
      ...(store.tools as unknown as Record<string, unknown>),
      remove: async () => ({ success: false, error: 'room unreachable' }),
    } as unknown as QueueTools

    const report = await sweepAllRooms(failing, T0 + 61_000)
    expect(report.advanced).toBe(0)
    expect(report.errors).toEqual(['AAA111: room unreachable'])
  })

  it('keeps going when one room fails, and reports it', async () => {
    const store = fakeTools()
    store.seedRoom(
      'GOOD01',
      room({
        holderUserId: 'u-alice',
        holderName: 'Alice',
        turnAssignedAt: T0,
        turnStartedAt: T0,
        turnSeq: 1,
      }),
    )

    const failing = {
      ...(store.tools as unknown as Record<string, unknown>),
      update: async () => ({ success: false, error: 'room unreachable' }),
    } as unknown as QueueTools

    const report = await sweepAllRooms(failing, T0 + 61_000)

    expect(report.advanced).toBe(0)
    expect(report.errors).toEqual(['GOOD01: room unreachable'])
  })
})
