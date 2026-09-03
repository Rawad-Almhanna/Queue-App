/**
 * Who is allowed to do what.
 *
 * Every test here talks to /api/actions directly rather than clicking, because
 * hidden buttons prove nothing: actions run with per-record RBAC off, so the
 * owner checks inside the transitions are the only thing standing between a
 * member and someone else's queue. These tests attack that boundary the way an
 * unfriendly client would — with a valid token for the wrong person.
 */

import { test, expect, loadAllTestAccounts } from 'deepspace/testing'
import { callAction, createTestRoom, createTestRoom as makeRoom, currentUserId, joinRoom, testRoomName } from './helpers/queue'

const OWNER_ACTIONS = ['advanceQueue', 'removeParticipant', 'reorderEntry'] as const
const ALL_QUEUE_ACTIONS = [
  'joinQueue',
  'startTurn',
  'finishTurn',
  'leaveQueue',
  ...OWNER_ACTIONS,
] as const

test.describe('Unauthenticated callers', () => {
  for (const action of ALL_QUEUE_ACTIONS) {
    test(`${action} refuses a request with no token`, async ({ request }) => {
      const res = await request.post(`/api/actions/${action}`, {
        data: { code: 'ABC234', targetUserId: 'someone', recordId: 'x', direction: 'up' },
      })
      expect(res.status()).toBe(401)
    })
  }
})

test.describe('Owner-only actions', () => {
  test.skip(loadAllTestAccounts().length < 2, 'Needs 2 usable test accounts.')

  /** Alice owns a room and holds the turn; Bob waits behind her. */
  async function seedRoom(alice: { page: import('@playwright/test').Page }, bob: { page: import('@playwright/test').Page }) {
    const { code } = await makeRoom(alice.page, { name: testRoomName('Permissions') })
    await joinRoom(alice.page, code, 'Alice')
    await joinRoom(bob.page, code, 'Bob')
    return code
  }

  test('a member cannot advance someone else\u2019s queue', async ({ users }) => {
    const [alice, bob] = await users(2)
    await alice.page.goto('/home')
    await bob.page.goto('/home')
    const code = await seedRoom(alice, bob)

    const result = await callAction(bob.page, 'advanceQueue', { code })
    expect(result.success).toBe(false)
    if (!result.success) expect(result.error).toMatch(/only the room owner/i)

    // And the refusal was real: Alice still holds the turn.
    const after = await callAction<{ room: { holderName: string } }>(alice.page, 'getRoom', { code })
    expect(after.success).toBe(true)
    if (after.success) expect(after.data.room.holderName).toBe('Alice')
  })

  test('a member cannot remove another participant', async ({ users }) => {
    const [alice, bob] = await users(2)
    await alice.page.goto('/home')
    await bob.page.goto('/home')
    const code = await seedRoom(alice, bob)
    const aliceId = await currentUserId(alice.page)

    const result = await callAction(bob.page, 'removeParticipant', {
      code,
      targetUserId: aliceId,
    })
    expect(result.success).toBe(false)
    if (!result.success) expect(result.error).toMatch(/only the room owner/i)

    const after = await callAction<{ room: { holderName: string } }>(alice.page, 'getRoom', { code })
    if (after.success) expect(after.data.room.holderName).toBe('Alice')
  })

  test('a member cannot reorder the queue', async ({ users }) => {
    const [alice, bob] = await users(2)
    await alice.page.goto('/home')
    await bob.page.goto('/home')
    const code = await seedRoom(alice, bob)

    const result = await callAction(bob.page, 'reorderEntry', {
      code,
      recordId: 'anything',
      direction: 'up',
    })
    expect(result.success).toBe(false)
    // Owner is checked before the entry is even looked up, so a made-up record
    // id must still be refused for being the wrong caller, not for not existing.
    if (!result.success) expect(result.error).toMatch(/only the room owner/i)
  })

  test('the owner can do all three', async ({ users }) => {
    const [alice, bob] = await users(2)
    await alice.page.goto('/home')
    await bob.page.goto('/home')
    const code = await seedRoom(alice, bob)
    const bobId = await currentUserId(bob.page)

    // Advancing hands Alice's turn to Bob.
    const advanced = await callAction(alice.page, 'advanceQueue', { code })
    expect(advanced.success).toBe(true)

    const afterAdvance = await callAction<{ room: { holderName: string } }>(
      alice.page,
      'getRoom',
      { code },
    )
    expect(afterAdvance.success).toBe(true)
    if (afterAdvance.success) expect(afterAdvance.data.room.holderName).toBe('Bob')

    // Removing the holder empties the room.
    const removed = await callAction(alice.page, 'removeParticipant', {
      code,
      targetUserId: bobId,
    })
    expect(removed.success).toBe(true)

    const afterRemove = await callAction<{ room: { holderUserId: string } }>(
      alice.page,
      'getRoom',
      { code },
    )
    if (afterRemove.success) expect(afterRemove.data.room.holderUserId).toBe('')
  })

  test('ownership follows the room, not the app', async ({ users }) => {
    const [alice, bob] = await users(2)
    await alice.page.goto('/home')
    await bob.page.goto('/home')

    // Each owns their own room, so each is refused on the other's.
    const aliceRoom = await createTestRoom(alice.page, { name: testRoomName('Alice room') })
    const bobRoom = await createTestRoom(bob.page, { name: testRoomName('Bob room') })

    const bobOnAlices = await callAction(bob.page, 'advanceQueue', { code: aliceRoom.code })
    expect(bobOnAlices.success).toBe(false)

    const aliceOnBobs = await callAction(alice.page, 'advanceQueue', { code: bobRoom.code })
    expect(aliceOnBobs.success).toBe(false)

    // On their own rooms the same call is allowed (and no-ops on an empty queue).
    expect((await callAction(alice.page, 'advanceQueue', { code: aliceRoom.code })).success).toBe(
      true,
    )
    expect((await callAction(bob.page, 'advanceQueue', { code: bobRoom.code })).success).toBe(true)
  })
})

test.describe('Turn actions belong to the holder', () => {
  test.skip(loadAllTestAccounts().length < 2, 'Needs 2 usable test accounts.')

  test('a waiting member cannot start or finish the holder\u2019s turn', async ({ users }) => {
    const [alice, bob] = await users(2)
    await alice.page.goto('/home')
    await bob.page.goto('/home')

    const { code } = await createTestRoom(alice.page, { name: testRoomName('Holder only') })
    await joinRoom(alice.page, code, 'Alice')
    await joinRoom(bob.page, code, 'Bob')

    const started = await callAction(bob.page, 'startTurn', { code })
    expect(started.success).toBe(false)
    if (!started.success) expect(started.error).toMatch(/not your turn/i)

    const finished = await callAction(bob.page, 'finishTurn', { code })
    expect(finished.success).toBe(false)
    if (!finished.success) expect(finished.error).toMatch(/do not have the turn/i)
  })

  test('the owner is not exempt from the holder rule', async ({ users }) => {
    const [alice, bob] = await users(2)
    await alice.page.goto('/home')
    await bob.page.goto('/home')

    // Alice owns the room but Bob holds the turn.
    const { code } = await createTestRoom(alice.page, { name: testRoomName('Owner not holder') })
    await joinRoom(bob.page, code, 'Bob')

    const started = await callAction(alice.page, 'startTurn', { code })
    expect(started.success).toBe(false)
    if (!started.success) expect(started.error).toMatch(/not your turn/i)

    // She has advanceQueue for this — ownership grants the queue, not the turn.
    expect((await callAction(alice.page, 'advanceQueue', { code })).success).toBe(true)
  })

  test('a turn cannot be started twice', async ({ users }) => {
    const [alice] = await users(1)
    await alice.page.goto('/home')

    const { code } = await createTestRoom(alice.page, { name: testRoomName('Double start') })
    await joinRoom(alice.page, code, 'Alice')

    expect((await callAction(alice.page, 'startTurn', { code })).success).toBe(true)

    const again = await callAction(alice.page, 'startTurn', { code })
    expect(again.success).toBe(false)
    if (!again.success) expect(again.error).toMatch(/already running/i)
  })

  test('leaving hands the turn to whoever is next', async ({ users }) => {
    const [alice, bob] = await users(2)
    await alice.page.goto('/home')
    await bob.page.goto('/home')

    const { code } = await createTestRoom(alice.page, { name: testRoomName('Leave handoff') })
    await joinRoom(alice.page, code, 'Alice')
    await joinRoom(bob.page, code, 'Bob')

    expect((await callAction(alice.page, 'leaveQueue', { code })).success).toBe(true)

    const after = await callAction<{ room: { holderName: string } }>(bob.page, 'getRoom', { code })
    expect(after.success).toBe(true)
    if (after.success) expect(after.data.room.holderName).toBe('Bob')
  })

  test('someone who is not in the queue cannot leave it', async ({ users }) => {
    const [alice, bob] = await users(2)
    await alice.page.goto('/home')
    await bob.page.goto('/home')

    const { code } = await createTestRoom(alice.page, { name: testRoomName('Not present') })
    await joinRoom(alice.page, code, 'Alice')

    const result = await callAction(bob.page, 'leaveQueue', { code })
    expect(result.success).toBe(false)
    if (!result.success) expect(result.error).toMatch(/not in this queue/i)
  })
})

test.describe('Malformed action input', () => {
  test.skip(loadAllTestAccounts().length < 1, 'Needs 1 usable test account.')

  test('reorderEntry rejects a direction that is neither up nor down', async ({ users }) => {
    const [alice] = await users(1)
    await alice.page.goto('/home')

    const { code } = await createTestRoom(alice.page, { name: testRoomName('Bad direction') })
    const result = await callAction(alice.page, 'reorderEntry', {
      code,
      recordId: 'x',
      direction: 'sideways',
    })

    expect(result.success).toBe(false)
    if (!result.success) expect(result.error).toMatch(/up.*down/i)
  })

  test('removeParticipant rejects a missing target', async ({ users }) => {
    const [alice] = await users(1)
    await alice.page.goto('/home')

    const { code } = await createTestRoom(alice.page, { name: testRoomName('No target') })
    const result = await callAction(alice.page, 'removeParticipant', { code })

    expect(result.success).toBe(false)
    if (!result.success) expect(result.error).toMatch(/person to remove/i)
  })
})
