/**
 * The scheduled sweep, with nobody watching.
 *
 * The room page nudges the server when its own countdown hits zero, which is
 * what makes expiry feel instant — but it also means the other expiry tests
 * would still pass if the cron task were broken. This one deliberately keeps
 * every browser away from the room, so the only thing that can rescue the
 * queue is the every-minute alarm in AppCronRoom.
 *
 * It is slow on purpose: one minute is the finest interval the DO offers.
 */

import { test, expect, loadAllTestAccounts } from 'deepspace/testing'
import { callAction, createTestRoom, joinRoom, testRoomName } from './helpers/queue'

test.describe('Scheduled expiration', () => {
  test.skip(loadAllTestAccounts().length < 2, 'Needs 2 usable test accounts.')
  test.setTimeout(210_000)

  test('the cron task advances an abandoned queue with no client on the page', async ({
    users,
  }) => {
    const [alice, bob] = await users(2)

    // Both browsers stay on /home for the whole test. Nothing here ever opens
    // /q/:code, so no countdown runs and no nudge is ever sent.
    await alice.page.goto('/home')
    await bob.page.goto('/home')

    const { code } = await createTestRoom(alice.page, {
      name: testRoomName('Cron sweep'),
      turnSeconds: 15,
      graceSeconds: 10,
    })
    await joinRoom(alice.page, code, 'Alice')
    await joinRoom(bob.page, code, 'Bob')

    // Alice holds an unstarted turn whose grace period lapses in 10 seconds.
    const before = await callAction<{ room: { holderName: string } }>(alice.page, 'getRoom', {
      code,
    })
    expect(before.success).toBe(true)
    if (before.success) expect(before.data.room.holderName).toBe('Alice')

    // Poll read-only until the alarm does its work. `getRoom` only reads — it
    // cannot itself advance the queue — so a pass here is the cron's doing.
    await expect
      .poll(
        async () => {
          const result = await callAction<{ room: { holderName: string } }>(
            alice.page,
            'getRoom',
            { code },
          )
          return result.success ? result.data.room.holderName : null
        },
        {
          message: 'the cron task should have handed the turn to Bob',
          timeout: 180_000,
          intervals: [5_000],
        },
      )
      .toBe('Bob')
  })
})
