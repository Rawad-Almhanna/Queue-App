import { describe, expect, it } from 'vitest'
import {
  advanceQueue,
  expireIfDue,
  finishTurn,
  graceDeadline,
  isRoomOwner,
  join,
  leave,
  phaseOf,
  positionOf,
  removeParticipant,
  reorderEntry,
  startTurn,
  turnDeadline,
  waitingList,
} from './logic'
import type { QueueEntry, QueuePlan, QueueResult, QueueState } from './types'

const OWNER = 'user-owner'
const ALICE = 'user-alice'
const BOB = 'user-bob'
const CARA = 'user-cara'
const T0 = 1_700_000_000_000

const SECOND = 1000

function makeState(
  room: Partial<QueueState['room']['data']> = {},
  entries: Array<{ userId: string; displayName?: string; position: number; joinedAt?: number }> = [],
): QueueState {
  return {
    room: {
      recordId: 'ABC234',
      createdBy: OWNER,
      data: {
        name: 'Dryer 3',
        location: 'Basement',
        turnSeconds: 60,
        graceSeconds: 30,
        holderUserId: '',
        holderName: '',
        turnAssignedAt: 0,
        turnStartedAt: 0,
        turnSeq: 0,
        ...room,
      },
    },
    entries: entries.map((entry, index) => ({
      recordId: `entry-${entry.userId}`,
      data: {
        roomId: 'ABC234',
        userId: entry.userId,
        displayName: entry.displayName ?? entry.userId,
        position: entry.position,
        joinedAt: entry.joinedAt ?? T0 + index,
      },
    })),
  }
}

/** Stands in for the record room: applies a plan and enforces the seq guard. */
function apply(state: QueueState, plan: QueuePlan): QueueState {
  if (plan.expectedTurnSeq !== state.room.data.turnSeq) {
    throw new Error(`stale plan: expected turnSeq ${plan.expectedTurnSeq}`)
  }

  const entries: QueueEntry[] = state.entries
    .filter((entry) => !plan.deleteEntries.includes(entry.recordId))
    .map((entry) => {
      const update = plan.updateEntries.find((candidate) => candidate.recordId === entry.recordId)
      return update ? { ...entry, data: { ...entry.data, ...update.patch } } : entry
    })

  plan.createEntries.forEach((data, index) => {
    entries.push({ recordId: `entry-${data.userId}-${index}`, data })
  })

  return {
    room: { ...state.room, data: { ...state.room.data, ...plan.roomPatch } },
    entries,
  }
}

function expectOk(result: QueueResult): QueuePlan {
  if (!result.ok) throw new Error(`expected ok, got ${result.code}: ${result.error}`)
  return result.plan
}

function names(state: QueueState): string[] {
  return waitingList(state).map((entry) => entry.data.userId)
}

describe('turn phases', () => {
  it('reports idle, assigned, and active from the room row alone', () => {
    expect(phaseOf(makeState().room)).toBe('idle')
    expect(phaseOf(makeState({ holderUserId: ALICE, turnAssignedAt: T0 }).room)).toBe('assigned')
    expect(
      phaseOf(makeState({ holderUserId: ALICE, turnAssignedAt: T0, turnStartedAt: T0 }).room),
    ).toBe('active')
  })

  it('computes each deadline only for the phase it applies to', () => {
    const assigned = makeState({ holderUserId: ALICE, turnAssignedAt: T0 })
    expect(graceDeadline(assigned.room)).toBe(T0 + 30 * SECOND)
    expect(turnDeadline(assigned.room)).toBe(0)

    const active = makeState({ holderUserId: ALICE, turnAssignedAt: T0, turnStartedAt: T0 })
    expect(turnDeadline(active.room)).toBe(T0 + 60 * SECOND)
    expect(graceDeadline(active.room)).toBe(0)
  })
})

describe('joining', () => {
  it('hands the turn straight to the first person on a free resource', () => {
    const next = apply(makeState(), expectOk(join(makeState(), { userId: ALICE, displayName: 'Alice', now: T0 })))

    expect(next.room.data.holderUserId).toBe(ALICE)
    expect(next.room.data.holderName).toBe('Alice')
    expect(next.room.data.turnAssignedAt).toBe(T0)
    expect(next.room.data.turnStartedAt).toBe(0)
    expect(phaseOf(next.room)).toBe('assigned')
    expect(names(next)).toEqual([])
  })

  it('appends later joiners to the waiting list in order', () => {
    let state = makeState()
    state = apply(state, expectOk(join(state, { userId: ALICE, displayName: 'Alice', now: T0 })))
    state = apply(state, expectOk(join(state, { userId: BOB, displayName: 'Bob', now: T0 + 1 })))
    state = apply(state, expectOk(join(state, { userId: CARA, displayName: 'Cara', now: T0 + 2 })))

    expect(state.room.data.holderUserId).toBe(ALICE)
    expect(names(state)).toEqual([BOB, CARA])
    expect(positionOf(state, BOB)).toBe(1)
    expect(positionOf(state, CARA)).toBe(2)
    expect(positionOf(state, ALICE)).toBe(0)
  })

  it('refuses a blank display name', () => {
    const result = join(makeState(), { userId: ALICE, displayName: '   ', now: T0 })
    expect(result).toMatchObject({ ok: false, code: 'invalid_name' })
  })

  it('refuses a second entry for the same person, holder or waiting', () => {
    const state = makeState({ holderUserId: ALICE }, [{ userId: BOB, position: 1 }])

    expect(join(state, { userId: ALICE, displayName: 'Alice', now: T0 })).toMatchObject({
      ok: false,
      code: 'already_queued',
    })
    expect(join(state, { userId: BOB, displayName: 'Bob', now: T0 })).toMatchObject({
      ok: false,
      code: 'already_queued',
    })
  })
})

describe('starting and finishing a turn', () => {
  it('lets the holder start, and bumps turnSeq so a pending expiry goes stale', () => {
    const state = makeState({ holderUserId: ALICE, turnAssignedAt: T0, turnSeq: 4 })
    const next = apply(state, expectOk(startTurn(state, { userId: ALICE, now: T0 + 5 * SECOND })))

    expect(next.room.data.turnStartedAt).toBe(T0 + 5 * SECOND)
    expect(next.room.data.turnSeq).toBe(5)
    expect(phaseOf(next.room)).toBe('active')
  })

  it('refuses a start from anyone but the holder, and a double start', () => {
    const assigned = makeState({ holderUserId: ALICE, turnAssignedAt: T0 }, [
      { userId: BOB, position: 1 },
    ])
    expect(startTurn(assigned, { userId: BOB, now: T0 })).toMatchObject({
      ok: false,
      code: 'not_holder',
    })

    const active = makeState({ holderUserId: ALICE, turnAssignedAt: T0, turnStartedAt: T0 })
    expect(startTurn(active, { userId: ALICE, now: T0 + SECOND })).toMatchObject({
      ok: false,
      code: 'already_started',
    })
  })

  it('hands the turn to the next person on finish and renumbers the rest', () => {
    const state = makeState({ holderUserId: ALICE, turnStartedAt: T0, turnAssignedAt: T0 }, [
      { userId: BOB, position: 1 },
      { userId: CARA, position: 2 },
    ])
    const next = apply(state, expectOk(finishTurn(state, { userId: ALICE, now: T0 + 10 * SECOND })))

    expect(next.room.data.holderUserId).toBe(BOB)
    expect(next.room.data.turnAssignedAt).toBe(T0 + 10 * SECOND)
    expect(next.room.data.turnStartedAt).toBe(0)
    expect(names(next)).toEqual([CARA])
    expect(positionOf(next, CARA)).toBe(1)
  })

  it('frees the resource when the last person finishes', () => {
    const state = makeState({ holderUserId: ALICE, turnStartedAt: T0, turnAssignedAt: T0 })
    const next = apply(state, expectOk(finishTurn(state, { userId: ALICE, now: T0 + SECOND })))

    expect(phaseOf(next.room)).toBe('idle')
    expect(next.room.data.holderUserId).toBe('')
    expect(next.room.data.holderName).toBe('')
  })

  it('refuses a finish from someone who does not hold the turn', () => {
    const state = makeState({ holderUserId: ALICE }, [{ userId: BOB, position: 1 }])
    expect(finishTurn(state, { userId: BOB, now: T0 })).toMatchObject({
      ok: false,
      code: 'not_holder',
    })
  })
})

describe('leaving', () => {
  it('closes the gap when someone leaves the middle of the line', () => {
    const state = makeState({ holderUserId: ALICE }, [
      { userId: BOB, position: 1 },
      { userId: CARA, position: 2 },
    ])
    const next = apply(state, expectOk(leave(state, { userId: BOB, now: T0 })))

    expect(names(next)).toEqual([CARA])
    expect(positionOf(next, CARA)).toBe(1)
    expect(next.room.data.holderUserId).toBe(ALICE)
  })

  it('advances the queue when the holder leaves', () => {
    const state = makeState({ holderUserId: ALICE, turnStartedAt: T0 }, [
      { userId: BOB, position: 1 },
    ])
    const next = apply(state, expectOk(leave(state, { userId: ALICE, now: T0 + SECOND })))

    expect(next.room.data.holderUserId).toBe(BOB)
    expect(names(next)).toEqual([])
  })

  it('refuses a leave from someone who was never in the room', () => {
    expect(leave(makeState(), { userId: CARA, now: T0 })).toMatchObject({
      ok: false,
      code: 'not_in_queue',
    })
  })
})

describe('owner-only actions', () => {
  const staffed = () =>
    makeState({ holderUserId: ALICE, turnStartedAt: T0 }, [
      { userId: BOB, position: 1 },
      { userId: CARA, position: 2 },
    ])

  it('identifies the owner from the record envelope', () => {
    expect(isRoomOwner(staffed().room, OWNER)).toBe(true)
    expect(isRoomOwner(staffed().room, ALICE)).toBe(false)
  })

  it('lets the owner advance past the current holder', () => {
    const state = staffed()
    const next = apply(state, expectOk(advanceQueue(state, { actorUserId: OWNER, now: T0 + SECOND })))

    expect(next.room.data.holderUserId).toBe(BOB)
    expect(names(next)).toEqual([CARA])
  })

  it('answers a no-op advance on an empty room without writing anything', () => {
    const plan = expectOk(advanceQueue(makeState(), { actorUserId: OWNER, now: T0 }))
    expect(plan.event).toBe('noop')
    expect(plan.roomPatch).toEqual({})
    expect(plan.deleteEntries).toEqual([])
  })

  it('lets the owner remove a waiting participant and the active holder', () => {
    const state = staffed()

    const removedWaiter = apply(
      state,
      expectOk(removeParticipant(state, { actorUserId: OWNER, targetUserId: BOB, now: T0 })),
    )
    expect(names(removedWaiter)).toEqual([CARA])
    expect(positionOf(removedWaiter, CARA)).toBe(1)

    const removedHolder = apply(
      state,
      expectOk(removeParticipant(state, { actorUserId: OWNER, targetUserId: ALICE, now: T0 })),
    )
    expect(removedHolder.room.data.holderUserId).toBe(BOB)
  })

  it('lets the owner move a waiting entry up and down', () => {
    const state = staffed()

    const movedUp = apply(
      state,
      expectOk(reorderEntry(state, { actorUserId: OWNER, recordId: 'entry-user-cara', direction: 'up' })),
    )
    expect(names(movedUp)).toEqual([CARA, BOB])

    const movedDown = apply(
      state,
      expectOk(reorderEntry(state, { actorUserId: OWNER, recordId: 'entry-user-bob', direction: 'down' })),
    )
    expect(names(movedDown)).toEqual([CARA, BOB])
  })

  it('refuses to move an entry past the end of the list', () => {
    expect(
      reorderEntry(staffed(), {
        actorUserId: OWNER,
        recordId: 'entry-user-bob',
        direction: 'up',
      }),
    ).toMatchObject({ ok: false, code: 'cannot_move' })
  })

  it('rejects every owner action for a regular participant', () => {
    const state = staffed()
    const forbidden: QueueResult[] = [
      advanceQueue(state, { actorUserId: BOB, now: T0 }),
      removeParticipant(state, { actorUserId: BOB, targetUserId: CARA, now: T0 }),
      reorderEntry(state, { actorUserId: BOB, recordId: 'entry-user-cara', direction: 'up' }),
    ]

    for (const result of forbidden) {
      expect(result).toMatchObject({ ok: false, code: 'not_owner' })
    }
  })
})

describe('scheduled expiration', () => {
  it('does nothing on an empty room', () => {
    expect(expireIfDue(makeState(), T0 + 3600 * SECOND)).toBeNull()
  })

  it('does nothing while the active turn still has time left', () => {
    const state = makeState({ holderUserId: ALICE, turnAssignedAt: T0, turnStartedAt: T0 }, [
      { userId: BOB, position: 1 },
    ])
    expect(expireIfDue(state, T0 + 59 * SECOND)).toBeNull()
  })

  it('reclaims an active turn once the duration is up', () => {
    const state = makeState({ holderUserId: ALICE, turnAssignedAt: T0, turnStartedAt: T0 }, [
      { userId: BOB, position: 1 },
    ])
    const plan = expireIfDue(state, T0 + 60 * SECOND)!

    expect(plan.event).toBe('turn_expired')
    const next = apply(state, plan)
    expect(next.room.data.holderUserId).toBe(BOB)
    expect(phaseOf(next.room)).toBe('assigned')
  })

  it('reclaims an assigned turn the holder never started', () => {
    const state = makeState({ holderUserId: ALICE, turnAssignedAt: T0 }, [
      { userId: BOB, position: 1 },
    ])
    expect(expireIfDue(state, T0 + 29 * SECOND)).toBeNull()

    const plan = expireIfDue(state, T0 + 30 * SECOND)!
    expect(plan.event).toBe('grace_expired')
    expect(apply(state, plan).room.data.holderUserId).toBe(BOB)
  })

  it('frees the resource when an expired turn has nobody waiting behind it', () => {
    const state = makeState({ holderUserId: ALICE, turnAssignedAt: T0, turnStartedAt: T0 })
    const next = apply(state, expireIfDue(state, T0 + 120 * SECOND)!)

    expect(phaseOf(next.room)).toBe('idle')
    expect(expireIfDue(next, T0 + 240 * SECOND)).toBeNull()
  })

  it('is idempotent across repeated runs — the second tick finds nothing to do', () => {
    let state = makeState({ holderUserId: ALICE, turnAssignedAt: T0, turnStartedAt: T0 }, [
      { userId: BOB, position: 1 },
      { userId: CARA, position: 2 },
    ])

    state = apply(state, expireIfDue(state, T0 + 60 * SECOND)!)
    expect(state.room.data.holderUserId).toBe(BOB)

    // Same wall clock, run again: the grace window restarted, so nothing is due.
    expect(expireIfDue(state, T0 + 60 * SECOND)).toBeNull()

    // Later ticks walk the queue forward one person at a time, never two.
    state = apply(state, expireIfDue(state, T0 + 90 * SECOND)!)
    expect(state.room.data.holderUserId).toBe(CARA)
    expect(names(state)).toEqual([])
  })

  it('refuses a stale plan when the holder started their turn mid-flight', () => {
    const state = makeState({ holderUserId: ALICE, turnAssignedAt: T0, turnSeq: 7 }, [
      { userId: BOB, position: 1 },
    ])

    // The cron reads the room and decides the grace period lapsed...
    const plan = expireIfDue(state, T0 + 30 * SECOND)!
    expect(plan.expectedTurnSeq).toBe(7)

    // ...but Alice pressed Start first.
    const started = apply(state, expectOk(startTurn(state, { userId: ALICE, now: T0 + 29 * SECOND })))

    expect(() => apply(started, plan)).toThrow(/stale plan/)
    expect(started.room.data.holderUserId).toBe(ALICE)
  })

  it('repairs a stalled room where nobody holds a free resource', () => {
    const state = makeState({}, [{ userId: BOB, position: 1 }])
    const plan = expireIfDue(state, T0)!

    expect(plan.event).toBe('stalled_repaired')
    expect(apply(state, plan).room.data.holderUserId).toBe(BOB)
  })
})
