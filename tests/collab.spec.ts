/**
 * Multi-user collaboration spec — verifies two users sign in into
 * separate browser contexts and the app distinguishes them.
 *
 * `users(2)` takes any two accounts from your pool, so this spec passes on a
 * fresh app with no setup beyond having two test accounts:
 *   npx deepspace test accounts list
 *   npx deepspace test accounts create --email a@deepspace.test --name "A" --password-stdin
 *
 * Ask for accounts *by name* (`users(['Alice', 'Bob'])`) only when the
 * behaviour under test depends on which identity acts — otherwise naming them
 * couples the spec to one machine's pool.
 *
 * The `users` fixture handles sign-in caching (per-account storageState
 * persisted to `~/.deepspace/playwright-states/`), context creation, and
 * cleanup. No need to manage browser contexts manually.
 */
import { test, expect, loadAllTestAccounts } from 'deepspace/testing'
import { callAction, createTestRoom, joinRoom, testRoomName } from './helpers/queue'

// A machine that has never created test accounts is the normal state of a
// fresh checkout, and there `users()` throws — turning "you have no pool yet"
// into three red tests about the app, which it is not. Skip the file instead
// and say what creates the pool. The count is of accounts usable HERE: the
// pool is global per developer, but passwords live only on the machine that
// created the account.
const usableTestAccounts = loadAllTestAccounts().length
test.skip(
  usableTestAccounts < 2,
  `Needs 2 usable test accounts, found ${usableTestAccounts}. Create them with ` +
    '`npx deepspace test accounts create --email <name>@deepspace.test --name "<name>" ' +
    '--password-stdin`, or fetch existing pool accounts with `npx deepspace test accounts recover --all`.',
)

test('each browser renders its own signed-in account', async ({ users }) => {
  const [a, b] = await users(2)

  // /home is dynamic (under src/pages/(app)/), so it mounts the nav shell;
  // '/' is the static landing and has no navigation.
  await Promise.all([a.page.goto('/home'), b.page.goto('/home')])

  // Email, not name. The page renders the *session's* `name || email`, while
  // `user.name` here comes from the LOCAL account registry — and the two are
  // not the same fact: a display name is optional, and an account recovered on
  // another machine has none stored locally at all. The email is the credential
  // the context signed in with, so it is the one identity both sides agree on,
  // and asserting it proves the page is showing THIS browser's account.
  // The two accounts are distinct, so two exact matches is also the proof that
  // the contexts are not sharing one session.
  for (const user of [a, b]) {
    await expect(user.page.getByTestId('app-navigation')).toBeVisible({ timeout: 15_000 })

    // The identity chip shows `name || email`. Its text is not predictable, but
    // its presence is: something must be there once the profile has loaded.
    // (It is `hidden sm:inline` in some templates, so assert text, not
    // visibility.)
    await expect(user.page.getByTestId('nav-user-name')).toHaveText(/\S/, { timeout: 15_000 })

    await user.page.getByRole('button', { name: 'Account menu' }).click()
    await expect(user.page.getByTestId('nav-user-email')).toHaveText(user.email, {
      timeout: 15_000,
    })
  }
})

test('API status page renders loading success and error states', async ({ users }) => {
  const [user] = await users(1)
  let shouldFail = false
  let requestCount = 0

  await user.page.route('**/api/integrations', async (route) => {
    requestCount += 1
    if (shouldFail) {
      await route.fulfill({
        status: 502,
        contentType: 'application/json',
        body: JSON.stringify({ success: false, error: 'Catalog unavailable' }),
      })
      return
    }

    await new Promise((resolve) => setTimeout(resolve, 100))
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: { integrations: { openai: {}, wikipedia: {} } } }),
    })
  })

  await user.page.goto('/api-status')
  await expect(user.page.getByText('Loading integration catalog...')).toBeVisible()
  await expect(user.page.getByText('Integration catalog ready')).toBeVisible()
  await expect(user.page.getByText('2 integrations available.')).toBeVisible()

  shouldFail = true
  await user.page.getByRole('button', { name: 'Refresh' }).click()
  await expect(user.page.getByText('Catalog unavailable')).toBeVisible()
  await expect(user.page.getByText('Showing the last loaded catalog')).toBeVisible()
  await expect(user.page.getByText('Integration catalog ready')).toBeVisible()

  const urlAfterFailure = user.page.url()
  const requestsAfterFailure = requestCount
  await user.page.getByRole('button', { name: 'Refresh' }).click()
  await expect.poll(() => requestCount).toBeGreaterThan(requestsAfterFailure)
  expect(user.page.url()).toBe(urlAfterFailure)
})

test('API status page shows local retry after first-load API failure', async ({ users }) => {
  const [user] = await users(1)
  let requestCount = 0

  await user.page.route('**/api/integrations', async (route) => {
    requestCount += 1
    await route.fulfill({
      status: 502,
      contentType: 'application/json',
      body: JSON.stringify({ success: false, error: 'Catalog unavailable' }),
    })
  })

  await user.page.goto('/api-status')
  await expect(user.page.getByText('Loading integration catalog...')).toBeVisible()
  await expect(user.page.getByText('Could not load API data')).toBeVisible()
  await expect(user.page.getByText('Retried 1 time automatically.')).toBeVisible()

  const retryButton = user.page.getByRole('button', { name: 'Retry' })
  await expect(retryButton).toBeVisible()

  const urlAfterFailure = user.page.url()
  const requestsAfterFailure = requestCount
  await retryButton.click()
  await expect.poll(() => requestCount).toBeGreaterThan(requestsAfterFailure)
  expect(user.page.url()).toBe(urlAfterFailure)
})

/**
 * Live queue sync.
 *
 * Every write below goes through a server action, so these also prove that
 * action writes broadcast over the records WebSocket: neither page reloads,
 * and no assertion polls an endpoint.
 */
test.describe('Queue room sync', () => {
  test('two people see the same queue without reloading', async ({ users }) => {
    const [alice, bob] = await users(2)

    await alice.page.goto('/home')
    await bob.page.goto('/home')

    const { code, name } = await createTestRoom(alice.page, { name: testRoomName('Shared dryer') })

    await alice.page.goto(`/q/${code}`)
    await bob.page.goto(`/q/${code}`)

    // Both render the same room.
    for (const user of [alice, bob]) {
      await expect(user.page.getByTestId('room-title')).toHaveText(name, { timeout: 15_000 })
      await expect(user.page.getByTestId('room-code')).toHaveText(code)
    }

    // Nobody has joined, so the resource is free on both screens.
    for (const user of [alice, bob]) {
      await expect(user.page.getByTestId('current-turn')).toHaveAttribute('data-phase', 'idle')
      await expect(user.page.getByTestId('waiting-empty')).toBeVisible()
    }

    // Alice joins an empty queue, so she takes the turn immediately.
    await alice.page.getByTestId('join-name-input').fill('Alice')
    await alice.page.getByTestId('join-queue-submit').click()

    // Bob's page updates over the WebSocket, with no reload.
    await expect(bob.page.getByTestId('turn-holder')).toHaveText('Alice', { timeout: 15_000 })
    await expect(bob.page.getByTestId('current-turn')).toHaveAttribute('data-phase', 'assigned')
    await expect(alice.page.getByTestId('turn-holder')).toContainText('Alice (you)')

    // Bob joins behind her; Alice sees him arrive.
    await bob.page.getByTestId('join-name-input').fill('Bob')
    await bob.page.getByTestId('join-queue-submit').click()

    await expect(alice.page.getByTestId('waiting-entry')).toHaveCount(1, { timeout: 15_000 })
    await expect(alice.page.getByTestId('waiting-entry').first()).toContainText('Bob')
    await expect(alice.page.getByTestId('waiting-count')).toHaveText('1')

    // Bob is told where he stands; Alice, who holds the turn, is not in line.
    await expect(bob.page.getByTestId('my-position')).toContainText('1')
    await expect(alice.page.getByTestId('my-position')).toHaveCount(0)
  })

  test('the queue keeps its order across both clients', async ({ users }) => {
    const [alice, bob] = await users(2)
    await alice.page.goto('/home')
    await bob.page.goto('/home')

    const { code } = await createTestRoom(alice.page, { name: testRoomName('Order') })

    // Alice takes the turn, Bob queues behind her — both server-side.
    await callAction(alice.page, 'joinQueue', { code, displayName: 'Alice' })
    await callAction(bob.page, 'joinQueue', { code, displayName: 'Bob' })

    await alice.page.goto(`/q/${code}`)
    await bob.page.goto(`/q/${code}`)

    for (const user of [alice, bob]) {
      await expect(user.page.getByTestId('turn-holder')).toContainText('Alice', { timeout: 15_000 })
      await expect(user.page.getByTestId('waiting-entry')).toHaveCount(1)
      await expect(user.page.getByTestId('waiting-entry').first()).toContainText('Bob')
    }
  })

  test('only the room creator is shown as the owner', async ({ users }) => {
    const [alice, bob] = await users(2)
    await alice.page.goto('/home')
    await bob.page.goto('/home')

    const { code } = await createTestRoom(alice.page, { name: testRoomName('Ownership') })

    await alice.page.goto(`/q/${code}`)
    await bob.page.goto(`/q/${code}`)

    await expect(alice.page.getByTestId('owner-badge')).toBeVisible({ timeout: 15_000 })
    await expect(bob.page.getByTestId('room-title')).toBeVisible({ timeout: 15_000 })
    await expect(bob.page.getByTestId('owner-badge')).toHaveCount(0)
  })

  test('an unknown room code reports itself instead of rendering an empty queue', async ({
    users,
  }) => {
    const [alice] = await users(1)
    await alice.page.goto('/q/ZZZZZZ')
    await expect(alice.page.getByTestId('room-not-found')).toBeVisible({ timeout: 15_000 })
  })

  test('a turn taken and finished on one screen moves the queue on the other', async ({
    users,
  }) => {
    const [alice, bob] = await users(2)
    await alice.page.goto('/home')
    await bob.page.goto('/home')

    const { code } = await createTestRoom(alice.page, { name: testRoomName('Turn flow') })
    await joinRoom(alice.page, code, 'Alice')
    await joinRoom(bob.page, code, 'Bob')

    await alice.page.goto(`/q/${code}`)
    await bob.page.goto(`/q/${code}`)

    // Bob waits, so he gets no turn controls at all.
    await expect(bob.page.getByTestId('my-position')).toContainText('1', { timeout: 15_000 })
    await expect(bob.page.getByTestId('start-turn')).toHaveCount(0)
    await expect(bob.page.getByTestId('finish-turn')).toHaveCount(0)

    // Alice starts her turn; Bob's screen reflects it without reloading.
    await alice.page.getByTestId('start-turn').click()
    await expect(bob.page.getByTestId('current-turn')).toHaveAttribute('data-phase', 'active', {
      timeout: 15_000,
    })
    await expect(bob.page.getByTestId('turn-phase')).toHaveText('Turn in progress')
    await expect(alice.page.getByTestId('turn-countdown')).toBeVisible()

    // She finishes, and the turn lands on Bob live.
    await alice.page.getByTestId('finish-turn').click()
    await expect(bob.page.getByTestId('turn-holder')).toContainText('Bob (you)', {
      timeout: 15_000,
    })
    await expect(bob.page.getByTestId('start-turn')).toBeVisible()

    // Alice is out of the queue entirely, so she is offered the join form again.
    await expect(alice.page.getByTestId('join-queue-form')).toBeVisible({ timeout: 15_000 })
    await expect(alice.page.getByTestId('waiting-empty')).toBeVisible()
  })

  test('owner controls are shown to the owner and to nobody else', async ({ users }) => {
    const [alice, bob] = await users(2)
    await alice.page.goto('/home')
    await bob.page.goto('/home')

    const { code } = await createTestRoom(alice.page, { name: testRoomName('Controls') })
    await joinRoom(bob.page, code, 'Bob')

    await alice.page.goto(`/q/${code}`)
    await bob.page.goto(`/q/${code}`)

    // Bob holds the turn. Alice owns the room but is not in the queue.
    await expect(alice.page.getByTestId('turn-holder')).toContainText('Bob', { timeout: 15_000 })
    await expect(alice.page.getByTestId('advance-queue')).toBeVisible()
    await expect(alice.page.getByTestId('remove-holder')).toBeVisible()

    // Bob, holding the turn, sees his own controls but none of the owner's.
    await expect(bob.page.getByTestId('start-turn')).toBeVisible({ timeout: 15_000 })
    await expect(bob.page.getByTestId('advance-queue')).toHaveCount(0)
    await expect(bob.page.getByTestId('remove-holder')).toHaveCount(0)

    // Advancing an otherwise empty queue frees the resource on both screens.
    await alice.page.getByTestId('advance-queue').click()
    for (const user of [alice, bob]) {
      await expect(user.page.getByTestId('current-turn')).toHaveAttribute('data-phase', 'idle', {
        timeout: 15_000,
      })
    }
  })

  test('the owner reorders the waiting list and everyone sees the new order', async ({ users }) => {
    const [alice, bob] = await users(2)
    await alice.page.goto('/home')
    await bob.page.goto('/home')

    const { code } = await createTestRoom(alice.page, { name: testRoomName('Reorder') })
    // A third participant is seeded through Alice's session so two people wait
    // behind the holder without needing a third browser.
    await joinRoom(alice.page, code, 'Alice')
    await joinRoom(bob.page, code, 'Bob')

    await alice.page.goto(`/q/${code}`)
    await bob.page.goto(`/q/${code}`)

    await expect(alice.page.getByTestId('waiting-entry')).toHaveCount(1, { timeout: 15_000 })

    // Bob is alone in line, so both arrows are unavailable to the owner.
    const row = alice.page.getByTestId('waiting-entry').first()
    await expect(row.getByTestId('move-up')).toBeDisabled()
    await expect(row.getByTestId('move-down')).toBeDisabled()

    // Removing him empties the list on Bob's screen too.
    await row.getByTestId('remove-entry').click()
    await expect(bob.page.getByTestId('waiting-empty')).toBeVisible({ timeout: 15_000 })
    await expect(bob.page.getByTestId('join-queue-form')).toBeVisible()
    await expect(alice.page.getByTestId('waiting-count')).toHaveText('0')
  })

  test('a waiting member can leave and the list closes up live', async ({ users }) => {
    const [alice, bob] = await users(2)
    await alice.page.goto('/home')
    await bob.page.goto('/home')

    const { code } = await createTestRoom(alice.page, { name: testRoomName('Leave live') })
    await joinRoom(alice.page, code, 'Alice')
    await joinRoom(bob.page, code, 'Bob')

    await alice.page.goto(`/q/${code}`)
    await bob.page.goto(`/q/${code}`)

    await expect(alice.page.getByTestId('waiting-entry')).toHaveCount(1, { timeout: 15_000 })

    await bob.page.getByTestId('leave-queue').click()

    await expect(alice.page.getByTestId('waiting-empty')).toBeVisible({ timeout: 15_000 })
    await expect(bob.page.getByTestId('my-position')).toHaveCount(0)
    // Alice still holds the turn — Bob leaving the line did not disturb it.
    await expect(alice.page.getByTestId('turn-holder')).toContainText('Alice (you)')
  })

  test('joining twice is refused by the server', async ({ users }) => {
    const [alice] = await users(1)
    await alice.page.goto('/home')

    const { code } = await createTestRoom(alice.page, { name: testRoomName('Double join') })

    const first = await callAction(alice.page, 'joinQueue', { code, displayName: 'Alice' })
    expect(first.success).toBe(true)

    const second = await callAction(alice.page, 'joinQueue', { code, displayName: 'Alice' })
    expect(second.success).toBe(false)
    if (!second.success) expect(second.error).toMatch(/already/i)
  })
})

/**
 * Automatic expiry, end to end against the real Durable Object.
 *
 * These use the shortest turn the schema allows (15s) and the shortest grace
 * (10s), so they are slow by nature — but they are the only tests that prove
 * the clock, the action, and the live update actually meet. The pure rules are
 * covered far more thoroughly in src/actions/sweep.test.ts.
 */
test.describe('Automatic expiry', () => {
  test.setTimeout(90_000)

  test('an unstarted turn passes to the next person when the grace period lapses', async ({
    users,
  }) => {
    const [alice, bob] = await users(2)
    await alice.page.goto('/home')
    await bob.page.goto('/home')

    const { code } = await createTestRoom(alice.page, {
      name: testRoomName('Grace expiry'),
      turnSeconds: 15,
      graceSeconds: 10,
    })
    await joinRoom(alice.page, code, 'Alice')
    await joinRoom(bob.page, code, 'Bob')

    await alice.page.goto(`/q/${code}`)
    await bob.page.goto(`/q/${code}`)

    // Alice has been handed the turn but never presses Start.
    await expect(alice.page.getByTestId('current-turn')).toHaveAttribute('data-phase', 'assigned', {
      timeout: 20_000,
    })

    // Nobody clicks anything from here on — the grace period simply runs out.
    await expect(bob.page.getByTestId('turn-holder')).toContainText('Bob (you)', {
      timeout: 45_000,
    })
    await expect(alice.page.getByTestId('turn-holder')).toContainText('Bob')

    // Alice is out of the queue entirely, not moved to the back of it.
    await expect(alice.page.getByTestId('join-queue-form')).toBeVisible()
    await expect(alice.page.getByTestId('waiting-empty')).toBeVisible()
  })

  test('a running turn is reclaimed when its time is up', async ({ users }) => {
    const [alice, bob] = await users(2)
    await alice.page.goto('/home')
    await bob.page.goto('/home')

    const { code } = await createTestRoom(alice.page, {
      name: testRoomName('Turn expiry'),
      turnSeconds: 15,
      graceSeconds: 600,
    })
    await joinRoom(alice.page, code, 'Alice')
    await joinRoom(bob.page, code, 'Bob')

    await alice.page.goto(`/q/${code}`)
    await bob.page.goto(`/q/${code}`)

    // Alice starts, so the 15s turn clock is what expires — not the grace one.
    await alice.page.getByTestId('start-turn').click()
    await expect(bob.page.getByTestId('current-turn')).toHaveAttribute('data-phase', 'active', {
      timeout: 20_000,
    })

    await expect(bob.page.getByTestId('turn-holder')).toContainText('Bob (you)', {
      timeout: 45_000,
    })
    await expect(bob.page.getByTestId('start-turn')).toBeVisible()
  })

  test('an expiring turn with nobody waiting frees the resource', async ({ users }) => {
    const [alice] = await users(1)
    await alice.page.goto('/home')

    const { code } = await createTestRoom(alice.page, {
      name: testRoomName('Expire to empty'),
      turnSeconds: 15,
      graceSeconds: 10,
    })
    await joinRoom(alice.page, code, 'Alice')
    await alice.page.goto(`/q/${code}`)

    await expect(alice.page.getByTestId('current-turn')).toHaveAttribute('data-phase', 'assigned', {
      timeout: 20_000,
    })

    await expect(alice.page.getByTestId('current-turn')).toHaveAttribute('data-phase', 'idle', {
      timeout: 45_000,
    })
    await expect(alice.page.getByTestId('turn-holder')).toContainText("it's free")
  })

  test('sweeping early does nothing, and is safe to call repeatedly', async ({ users }) => {
    const [alice, bob] = await users(2)
    await alice.page.goto('/home')
    await bob.page.goto('/home')

    const { code } = await createTestRoom(alice.page, {
      name: testRoomName('Early sweep'),
      turnSeconds: 3600,
      graceSeconds: 600,
    })
    await joinRoom(alice.page, code, 'Alice')
    await joinRoom(bob.page, code, 'Bob')

    // Anyone may ask, including a member who does not own the room — the
    // action carries no actor, only the clock.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = await callAction<{ event: string | null }>(bob.page, 'sweepRoom', { code })
      expect(result.success).toBe(true)
      if (result.success) expect(result.data.event).toBeNull()
    }

    // Alice still holds the turn she was given.
    const after = await callAction<{ room: { holderName: string } }>(alice.page, 'getRoom', { code })
    if (after.success) expect(after.data.room.holderName).toBe('Alice')
  })
})

/**
 * Presence.
 *
 * Presence is a different question from queue membership: being in the line is
 * a stored record, being *here* is an open socket. These tests keep the two
 * apart, because the interesting case for this app is exactly when they
 * disagree — someone holds the turn but walked away from the machine.
 */
test.describe('Presence', () => {
  test('each person sees the other as present while both have the room open', async ({ users }) => {
    const [alice, bob] = await users(2)
    await alice.page.goto('/home')
    await bob.page.goto('/home')

    const { code } = await createTestRoom(alice.page, { name: testRoomName('Presence') })
    await joinRoom(alice.page, code, 'Alice')
    await joinRoom(bob.page, code, 'Bob')

    await alice.page.goto(`/q/${code}`)
    await bob.page.goto(`/q/${code}`)

    // Two people connected, counted the same way on both screens.
    for (const user of [alice, bob]) {
      await expect(user.page.getByTestId('present-count')).toHaveText('2', { timeout: 20_000 })
    }

    // Alice holds the turn and is present; Bob waits and is present.
    await expect(alice.page.getByTestId('waiting-entry').first()).toHaveAttribute(
      'data-present',
      'true',
    )
    await expect(bob.page.getByTestId('waiting-entry').first()).toHaveAttribute(
      'data-present',
      'true',
    )
  })

  test('leaving the page marks that person away for everyone else', async ({ users }) => {
    const [alice, bob] = await users(2)
    await alice.page.goto('/home')
    await bob.page.goto('/home')

    const { code } = await createTestRoom(alice.page, { name: testRoomName('Away') })
    await joinRoom(alice.page, code, 'Alice')
    await joinRoom(bob.page, code, 'Bob')

    await alice.page.goto(`/q/${code}`)
    await bob.page.goto(`/q/${code}`)

    const bobRow = alice.page.getByTestId('waiting-entry').first()
    await expect(bobRow).toHaveAttribute('data-present', 'true', { timeout: 20_000 })

    // Bob navigates away, closing his presence socket.
    await bob.page.goto('/home')

    await expect(bobRow).toHaveAttribute('data-present', 'false', { timeout: 20_000 })
    await expect(alice.page.getByTestId('present-count')).toHaveText('1')

    // He is away, not gone: his place in line is untouched.
    await expect(alice.page.getByTestId('waiting-entry')).toHaveCount(1)
    await expect(bobRow).toContainText('away')

    // And coming back restores him without rejoining.
    await bob.page.goto(`/q/${code}`)
    await expect(bobRow).toHaveAttribute('data-present', 'true', { timeout: 20_000 })
    await expect(bob.page.getByTestId('my-position')).toContainText('1')
  })

  test('a holder who is not in the room is called out on the turn card', async ({ users }) => {
    const [alice, bob] = await users(2)
    await alice.page.goto('/home')
    await bob.page.goto('/home')

    // Bob takes the turn, then never opens the room.
    const { code } = await createTestRoom(alice.page, { name: testRoomName('Absent holder') })
    await joinRoom(bob.page, code, 'Bob')

    await alice.page.goto(`/q/${code}`)

    await expect(alice.page.getByTestId('turn-holder')).toContainText('Bob', { timeout: 20_000 })
    await expect(alice.page.getByTestId('turn-phase')).toContainText('not in the room')

    // Only Alice is here, even though two people are involved in the room.
    await expect(alice.page.getByTestId('present-count')).toHaveText('1')

    // When Bob opens it, the warning clears live on Alice's screen.
    await bob.page.goto(`/q/${code}`)
    await expect(alice.page.getByTestId('turn-phase')).not.toContainText('not in the room', {
      timeout: 20_000,
    })
    await expect(alice.page.getByTestId('present-count')).toHaveText('2')
  })

  test('presence is scoped to one room, not shared across rooms', async ({ users }) => {
    const [alice, bob] = await users(2)
    await alice.page.goto('/home')
    await bob.page.goto('/home')

    const first = await createTestRoom(alice.page, { name: testRoomName('Room one') })
    const second = await createTestRoom(alice.page, { name: testRoomName('Room two') })

    // Both are signed in and active, but in different rooms.
    await alice.page.goto(`/q/${first.code}`)
    await bob.page.goto(`/q/${second.code}`)

    await expect(alice.page.getByTestId('present-count')).toHaveText('1', { timeout: 20_000 })
    await expect(bob.page.getByTestId('present-count')).toHaveText('1', { timeout: 20_000 })
  })
})

