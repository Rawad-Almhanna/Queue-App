/**
 * API-surface tests: worker routes and server actions.
 *
 * `test` comes from 'deepspace/testing' rather than '@playwright/test' so the
 * signed-in `users` fixture is available here too. It is the base test plus
 * that fixture, so `page` and `request` still work exactly as before — and one
 * test instance per file is a Playwright requirement.
 */

import { test, expect, loadAllTestAccounts } from 'deepspace/testing'
import { authToken, callAction, createTestRoom, postAction, testRoomName } from './helpers/queue'
import { ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH } from '../src/queue/types'

test.describe('API tests', () => {
  test('auth proxy forwards to auth worker', async ({ request }) => {
    const res = await request.get('/api/auth/ok')
    expect(res.ok()).toBeTruthy()
  })

  test('WebSocket endpoint exists', async ({ page }) => {
    // /home is a dynamic page (under src/pages/(app)/), so mounting it boots
    // the providers and auto-connects the records WebSocket. The static
    // landing at '/' deliberately does neither — see smoke.spec.ts.
    await page.goto('/home')
    // Wait for the app to connect its WebSocket (it auto-connects on mount)
    await page.waitForSelector('[data-testid="app-navigation"]', { timeout: 15000 })
    // If the app loaded and connected, the WS endpoint works
  })
})

test.describe('createRoom action', () => {
  test('refuses a caller with no bearer token', async ({ request }) => {
    const res = await request.post('/api/actions/createRoom', {
      data: { name: testRoomName(), turnSeconds: 60 },
    })
    expect(res.status()).toBe(401)
  })

  test('refuses a caller with a forged bearer token', async ({ request }) => {
    const res = await request.post('/api/actions/createRoom', {
      headers: { Authorization: 'Bearer not-a-real-jwt' },
      data: { name: testRoomName(), turnSeconds: 60 },
    })
    expect(res.status()).toBe(401)
  })
})

test.describe('createRoom action (signed in)', () => {
  test.skip(
    loadAllTestAccounts().length < 1,
    'Needs 1 usable test account. Create one with ' +
      '`npx deepspace test accounts create --email <name>@deepspace.test --name "<name>" --password-stdin`.',
  )

  test('creates a room and assigns it a shareable code', async ({ users }) => {
    const [alice] = await users(1)
    await alice.page.goto('/home')

    const name = testRoomName('Dryer 3')
    const result = await callAction<{ code: string; ownerUserId: string }>(
      alice.page,
      'createRoom',
      { name, location: 'Basement', turnSeconds: 60, graceSeconds: 30 },
    )

    expect(result.success).toBe(true)
    if (!result.success) return

    expect(result.data.code).toHaveLength(ROOM_CODE_LENGTH)
    expect([...result.data.code].every((c) => ROOM_CODE_ALPHABET.includes(c))).toBe(true)
  })

  test('records the creating user as the room owner', async ({ users }) => {
    const [alice] = await users(1)
    await alice.page.goto('/home')

    const created = await callAction<{ code: string; ownerUserId: string }>(
      alice.page,
      'createRoom',
      { name: testRoomName('Owner check'), turnSeconds: 60, graceSeconds: 30 },
    )
    expect(created.success).toBe(true)
    if (!created.success) return

    // The action reports the caller it ran as; the record's `createdBy`
    // envelope field is what `isRoomOwner` reads, so they must agree.
    const token = await authToken(alice.page)
    const claims = JSON.parse(
      Buffer.from(token.split('.')[1], 'base64').toString('utf8'),
    ) as { sub?: string }

    expect(created.data.ownerUserId).toBe(claims.sub)
  })

  test('hands out a different code to each room', async ({ users }) => {
    const [alice] = await users(1)
    await alice.page.goto('/home')

    const codes = new Set<string>()
    for (let i = 0; i < 3; i += 1) {
      const result = await callAction<{ code: string }>(alice.page, 'createRoom', {
        name: testRoomName(`Unique ${i}`),
        turnSeconds: 60,
      })
      expect(result.success).toBe(true)
      if (result.success) codes.add(result.data.code)
    }

    expect(codes.size).toBe(3)
  })

  test('stores the room so it can be read back by its code', async ({ users }) => {
    const [alice] = await users(1)
    await alice.page.goto('/home')

    const name = testRoomName('Readback')
    const created = await callAction<{ code: string }>(alice.page, 'createRoom', {
      name,
      location: 'Basement',
      turnSeconds: 90,
      graceSeconds: 45,
    })
    expect(created.success).toBe(true)
    if (!created.success) return

    const room = await callAction<{ room: Record<string, unknown> }>(alice.page, 'getRoom', {
      code: created.data.code,
    })
    expect(room.success).toBe(true)
    if (!room.success) return

    expect(room.data.room).toMatchObject({
      name,
      location: 'Basement',
      turnSeconds: 90,
      graceSeconds: 45,
      holderUserId: '',
      turnSeq: 0,
    })
  })

  test('rejects invalid turn and grace durations server-side', async ({ users }) => {
    const [alice] = await users(1)
    await alice.page.goto('/home')
    const token = await authToken(alice.page)

    const invalid = [
      { turnSeconds: 0 },
      { turnSeconds: -60 },
      { turnSeconds: 5 },
      { turnSeconds: 99999 },
      { turnSeconds: 'soon' },
      { graceSeconds: 0 },
      { graceSeconds: 9999 },
    ]

    for (const override of invalid) {
      const res = await postAction(
        alice.page,
        'createRoom',
        { name: testRoomName('Invalid'), turnSeconds: 60, graceSeconds: 30, ...override },
        token,
      )
      const body = (await res.json()) as { success: boolean; error?: string }

      expect(body.success, `expected ${JSON.stringify(override)} to be refused`).toBe(false)
      expect(body.error).toMatch(/must be between/)
    }
  })

  test('rejects a room with no name', async ({ users }) => {
    const [alice] = await users(1)
    await alice.page.goto('/home')

    const result = await callAction(alice.page, 'createRoom', { name: '   ', turnSeconds: 60 })
    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.error).toMatch(/name/i)
  })
})

test.describe('joinQueue action', () => {
  test('refuses a caller with no bearer token', async ({ request }) => {
    const res = await request.post('/api/actions/joinQueue', {
      data: { code: 'ABC234', displayName: 'Nobody' },
    })
    expect(res.status()).toBe(401)
  })

  test.describe('signed in', () => {
    test.skip(loadAllTestAccounts().length < 1, 'Needs 1 usable test account.')

    test('refuses a malformed room code', async ({ users }) => {
      const [alice] = await users(1)
      await alice.page.goto('/home')

      const result = await callAction(alice.page, 'joinQueue', { code: 'nope', displayName: 'A' })
      expect(result.success).toBe(false)
      if (!result.success) expect(result.error).toMatch(/not a valid room code/i)
    })

    test('refuses a well-formed code for a room that does not exist', async ({ users }) => {
      const [alice] = await users(1)
      await alice.page.goto('/home')

      const result = await callAction(alice.page, 'joinQueue', { code: 'ZZZZZZ', displayName: 'A' })
      expect(result.success).toBe(false)
      if (!result.success) expect(result.error).toMatch(/no queue found/i)
    })

    test('refuses a blank display name', async ({ users }) => {
      const [alice] = await users(1)
      await alice.page.goto('/home')

      const { code } = await createTestRoom(alice.page, { name: testRoomName('Blank name') })
      const result = await callAction(alice.page, 'joinQueue', { code, displayName: '   ' })

      expect(result.success).toBe(false)
      if (!result.success) expect(result.error).toMatch(/display name/i)
    })

    test('gives the first joiner the turn and the second a place in line', async ({ users }) => {
      const [alice, bob] = await users(2)
      await alice.page.goto('/home')
      await bob.page.goto('/home')

      const { code } = await createTestRoom(alice.page, { name: testRoomName('Handoff') })

      const first = await callAction<{ hasTurn: boolean }>(alice.page, 'joinQueue', {
        code,
        displayName: 'Alice',
      })
      expect(first.success).toBe(true)
      if (first.success) expect(first.data.hasTurn).toBe(true)

      const second = await callAction<{ hasTurn: boolean }>(bob.page, 'joinQueue', {
        code,
        displayName: 'Bob',
      })
      expect(second.success).toBe(true)
      if (second.success) expect(second.data.hasTurn).toBe(false)
    })
  })
})
