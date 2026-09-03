/**
 * The demo path, on a phone.
 *
 * One test walks the whole route a viewer would watch — landing, home, create,
 * share, join, take a turn — at a 390x844 viewport, because that is the size
 * this gets shown at and the size most likely to break. The rest cover the
 * screens either side of that walk.
 */

import { test, expect, loadAllTestAccounts } from 'deepspace/testing'
import { captureConsoleErrors } from './helpers/errors'
import { callAction, createTestRoom, joinRoom, testRoomName } from './helpers/queue'

const PHONE = { width: 390, height: 844 }

test.describe('Landing', () => {
  test('explains the product and links into the app', async ({ page }) => {
    const errors = captureConsoleErrors(page)
    await page.setViewportSize(PHONE)
    await page.goto('/')

    await expect(page.getByTestId('static-landing')).toBeVisible()
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Take turns')
    await page.getByRole('link', { name: /open queue/i }).click()
    await expect(page.getByTestId('app-navigation')).toBeVisible({ timeout: 15_000 })
    expect(errors).toEqual([])
  })

  test('nothing on the landing page overflows a phone screen', async ({ page }) => {
    await page.setViewportSize(PHONE)
    await page.goto('/')
    await expect(page.getByTestId('static-landing')).toBeVisible()

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    )
    expect(overflow).toBeLessThanOrEqual(0)
  })
})

test.describe('Home', () => {
  test('a signed-out visitor gets the pitch, not a wall', async ({ page }) => {
    await page.goto('/home')
    await expect(page.getByTestId('home-signed-out')).toBeVisible({ timeout: 15_000 })
    await expect(page.getByTestId('nav-sign-in-button')).toBeVisible()
    // The signed-out page must not open a subscription for queue data.
    await expect(page.getByTestId('your-queues')).toHaveCount(0)
  })

  test.describe('signed in', () => {
    test.skip(loadAllTestAccounts().length < 1, 'Needs 1 usable test account.')

    test('lists the queues you started and links into them', async ({ users }) => {
      const [alice] = await users(1)
      await alice.page.goto('/home')

      const { code, name } = await createTestRoom(alice.page, { name: testRoomName('Listed') })

      // The list is a live subscription, so the new room appears without a reload.
      const link = alice.page.getByTestId('your-queue-link').filter({ hasText: name })
      await expect(link).toBeVisible({ timeout: 20_000 })
      await expect(link).toContainText(code)
      await expect(link).toContainText('Free right now')

      await link.click()
      await expect(alice.page.getByTestId('room-title')).toHaveText(name, { timeout: 15_000 })
    })

    test('reflects who holds a queue without reloading', async ({ users }) => {
      const [alice] = await users(1)
      await alice.page.goto('/home')

      const { code, name } = await createTestRoom(alice.page, { name: testRoomName('Held') })
      const link = alice.page.getByTestId('your-queue-link').filter({ hasText: name })
      await expect(link).toContainText('Free right now', { timeout: 20_000 })

      await joinRoom(alice.page, code, 'Alice')
      await expect(link).toContainText('Alice has it', { timeout: 20_000 })
    })
  })
})

test.describe('Demo path on a phone', () => {
  test.skip(loadAllTestAccounts().length < 2, 'Needs 2 usable test accounts.')
  test.setTimeout(90_000)

  test('create, share, join, and take a turn at a phone viewport', async ({ users }) => {
    const [alice, bob] = await users(2)
    await alice.page.setViewportSize(PHONE)
    await bob.page.setViewportSize(PHONE)

    // 1. Land and enter the app.
    await alice.page.goto('/')
    await alice.page.getByRole('link', { name: /open queue/i }).click()
    await expect(alice.page.getByTestId('home-start-queue')).toBeVisible({ timeout: 15_000 })

    // 2. Start a queue.
    await alice.page.getByTestId('home-start-queue').click()
    await expect(alice.page.getByTestId('create-room-form')).toBeVisible({ timeout: 15_000 })

    const name = testRoomName('Demo dryer')
    await alice.page.getByTestId('room-name-input').fill(name)
    await alice.page.getByTestId('room-location-input').fill('Basement')
    await alice.page.getByTestId('turn-value-input').fill('15')
    await alice.page.getByTestId('turn-unit-select').selectOption('seconds')
    await alice.page.getByTestId('grace-value-input').fill('10')
    await alice.page.getByTestId('grace-unit-select').selectOption('seconds')
    await alice.page.getByTestId('create-room-submit').click()

    // 3. Get the shareable code.
    await expect(alice.page.getByTestId('room-created')).toBeVisible({ timeout: 15_000 })
    const code = (await alice.page.getByTestId('room-code').textContent())?.trim() ?? ''
    expect(code).toHaveLength(6)

    await alice.page.getByTestId('open-created-room').click()
    await expect(alice.page.getByTestId('room-title')).toHaveText(name, { timeout: 15_000 })

    // 4. Alice joins her own queue and gets the turn.
    await alice.page.getByTestId('join-name-input').fill('Alice')
    await alice.page.getByTestId('join-queue-submit').click()
    await expect(alice.page.getByTestId('turn-holder')).toContainText('Alice (you)', {
      timeout: 15_000,
    })

    // 5. Bob opens the queue by typing the code.
    await bob.page.goto('/queue')
    await bob.page.getByTestId('join-code-input').fill(code)
    await bob.page.getByTestId('join-by-code-submit').click()
    await expect(bob.page.getByTestId('room-title')).toHaveText(name, { timeout: 15_000 })

    await bob.page.getByTestId('join-name-input').fill('Bob')
    await bob.page.getByTestId('join-queue-submit').click()
    await expect(bob.page.getByTestId('my-position')).toContainText('1', { timeout: 15_000 })

    // 6. Alice's screen shows Bob arriving, present, with a running clock.
    await expect(alice.page.getByTestId('waiting-entry')).toHaveCount(1, { timeout: 15_000 })
    await expect(alice.page.getByTestId('present-count')).toHaveText('2')
    await expect(alice.page.getByTestId('turn-countdown')).toBeVisible()

    // 7. Nothing on either phone screen overflows sideways.
    for (const user of [alice, bob]) {
      const overflow = await user.page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      )
      expect(overflow).toBeLessThanOrEqual(0)
    }

    // 8. Alice starts, and the turn runs out on its own onto Bob.
    await alice.page.getByTestId('start-turn').click()
    await expect(bob.page.getByTestId('turn-holder')).toContainText('Bob (you)', {
      timeout: 45_000,
    })
  })

  test('the invite button copies a link, not just the code', async ({ users }) => {
    const [alice] = await users(1)
    await alice.page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
    await alice.page.goto('/queue')

    await alice.page.getByTestId('room-name-input').fill(testRoomName('Invite'))
    await alice.page.getByTestId('create-room-submit').click()
    await expect(alice.page.getByTestId('room-created')).toBeVisible({ timeout: 15_000 })

    const code = (await alice.page.getByTestId('room-code').textContent())?.trim() ?? ''
    await alice.page.getByTestId('copy-room-code').click()

    const copied = await alice.page.evaluate(() => navigator.clipboard.readText())
    expect(copied).toContain(`/q/${code}`)

    // Following the copied link lands in the room it names.
    await alice.page.goto(copied)
    await expect(alice.page.getByTestId('room-code')).toHaveText(code, { timeout: 15_000 })
  })

  test('an unknown code is refused before it can open an empty room', async ({ users }) => {
    const [alice] = await users(1)
    await alice.page.setViewportSize(PHONE)
    await alice.page.goto('/queue')

    await alice.page.getByTestId('join-code-input').fill('ZZZZZZ')
    await alice.page.getByTestId('join-by-code-submit').click()

    await expect(alice.page.getByTestId('join-code-error')).toBeVisible({ timeout: 15_000 })
    expect(new URL(alice.page.url()).pathname).toBe('/queue')
  })

  test('a room still loading shows a note rather than an empty queue', async ({ users }) => {
    const [alice, bob] = await users(2)
    await alice.page.goto('/home')
    await bob.page.goto('/home')

    const { code } = await createTestRoom(alice.page, { name: testRoomName('States') })
    await joinRoom(alice.page, code, 'Alice')

    // Bob arrives at a queue he is not in: he is offered the join form, and
    // the turn card names the holder rather than showing a blank.
    await bob.page.goto(`/q/${code}`)
    await expect(bob.page.getByTestId('join-queue-form')).toBeVisible({ timeout: 15_000 })
    await expect(bob.page.getByTestId('turn-holder')).toContainText('Alice')
    await expect(bob.page.getByTestId('waiting-empty')).toBeVisible()

    // A failing action surfaces as a toast, not a silent no-op.
    const refused = await callAction(bob.page, 'advanceQueue', { code })
    expect(refused.success).toBe(false)
  })
})
