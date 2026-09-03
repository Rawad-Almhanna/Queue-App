import { test, expect, loadAllTestAccounts } from 'deepspace/testing'
import { captureConsoleErrors } from './helpers/errors'
import { ROOM_CODE_LENGTH } from '../src/queue/types'

/**
 * Smoke tests covering both page kinds this template ships:
 *   - '/'      → the static landing (top level of src/pages/): no providers,
 *                so no auth fetch and no records WebSocket on load.
 *   - '/home'  → a dynamic page (under src/pages/(app)/): the providers mount,
 *                the nav shell renders, and the records WebSocket connects.
 *
 * The "static contract" test is the guardrail for the per-page opt-out: if
 * someone moves the providers back up into _app.tsx, it fails.
 */

/** Wait for the React app shell (present on every page). */
async function waitForApp(page: import('@playwright/test').Page) {
  await page.waitForSelector('[data-testid="app-root"]', { timeout: 15000 })
}

test.describe('Smoke tests', () => {
  test('static landing loads without JS errors', async ({ page }) => {
    const errors = captureConsoleErrors(page)
    await page.goto('/')
    await waitForApp(page)
    await expect(page.getByTestId('static-landing')).toBeVisible()
    expect(errors).toEqual([])
  })

  test('static contract: landing fires no auth request, opens no websocket', async ({ page }) => {
    const offenders: string[] = []
    page.on('request', (req) => {
      if (req.url().includes('/api/auth/')) offenders.push(req.url())
    })
    // Only the DO room route counts — vite's own HMR socket is a dev artifact.
    page.on('websocket', (ws) => {
      if (new URL(ws.url()).pathname.startsWith('/ws/')) offenders.push(`ws: ${ws.url()}`)
    })
    await page.goto('/')
    await expect(page.getByTestId('static-landing')).toBeVisible()
    await page.waitForTimeout(1500)
    expect(offenders).toEqual([])
  })

  test('dynamic app boundary mounts on /home', async ({ page }) => {
    await page.goto('/home')
    await expect(page.getByTestId('app-navigation')).toBeVisible({ timeout: 15000 })
  })

  test('sign-in button visible when logged out', async ({ page }) => {
    await page.goto('/home')
    await expect(page.getByTestId('nav-sign-in-button')).toBeVisible({ timeout: 15000 })
    await expect(page.getByTestId('nav-user-name')).toHaveCount(0)
  })

  test('unknown route shows 404', async ({ page }) => {
    await page.goto('/nonexistent-page-xyz')
    await waitForApp(page)
    await expect(page.locator('text=404')).toBeVisible()
  })
})

test.describe('Create queue page', () => {
  test('/queue is gated for signed-out visitors', async ({ page }) => {
    await page.goto('/queue')
    // This scaffold passes AuthGate its own fallback, so a signed-out visitor
    // gets the in-chrome panel rather than the SDK's full-screen overlay.
    await expect(page.getByRole('heading', { name: 'Sign in to continue' })).toBeVisible({
      timeout: 15000,
    })
    await expect(page.getByTestId('create-room-form')).toHaveCount(0)
  })

  test.describe('signed in', () => {
    test.skip(
      loadAllTestAccounts().length < 1,
      'Needs 1 usable test account. Create one with ' +
        '`npx deepspace test accounts create --email <name>@deepspace.test --name "<name>" --password-stdin`.',
    )

    test('creates a queue and shows its code', async ({ users }) => {
      const [alice] = await users(1)
      await alice.page.goto('/queue')

      await expect(alice.page.getByTestId('create-room-form')).toBeVisible({ timeout: 15000 })
      await expect(alice.page.getByTestId('auth-overlay')).toHaveCount(0)

      await alice.page.getByTestId('room-name-input').fill(`__test-${Date.now()}__ Grill`)
      await alice.page.getByTestId('room-location-input').fill('Roof deck')
      await alice.page.getByTestId('turn-value-input').fill('2')
      await alice.page.getByTestId('turn-unit-select').selectOption('minutes')
      await expect(alice.page.getByTestId('duration-summary')).toContainText('2 min')

      await alice.page.getByTestId('create-room-submit').click()

      await expect(alice.page.getByTestId('room-created')).toBeVisible({ timeout: 15000 })
      await expect(alice.page.getByTestId('room-code')).toHaveText(
        new RegExp(`^[A-Z2-9]{${ROOM_CODE_LENGTH}}$`),
      )
    })

    test('converts the chosen unit into seconds', async ({ users }) => {
      const [alice] = await users(1)
      await alice.page.goto('/queue')
      await expect(alice.page.getByTestId('create-room-form')).toBeVisible({ timeout: 15000 })

      // 1 hour is only valid because the unit is applied — as raw seconds it
      // would be under the 15-second floor.
      await alice.page.getByTestId('turn-value-input').fill('1')
      await alice.page.getByTestId('turn-unit-select').selectOption('hours')
      await expect(alice.page.getByTestId('duration-summary')).toContainText('1 hr')

      await alice.page.getByTestId('grace-value-input').fill('2')
      await alice.page.getByTestId('grace-unit-select').selectOption('minutes')
      await expect(alice.page.getByTestId('duration-summary')).toContainText('2 min')
    })

    test('shows a field error for an out-of-range turn length', async ({ users }) => {
      const [alice] = await users(1)
      await alice.page.goto('/queue')

      await expect(alice.page.getByTestId('create-room-form')).toBeVisible({ timeout: 15000 })
      await alice.page.getByTestId('room-name-input').fill(`__test-${Date.now()}__ Bad`)
      await alice.page.getByTestId('turn-value-input').fill('3')
      await alice.page.getByTestId('turn-unit-select').selectOption('seconds')
      await alice.page.getByTestId('create-room-submit').click()

      await expect(alice.page.getByTestId('create-room-error')).toContainText('must be between')
      await expect(alice.page.getByTestId('room-created')).toHaveCount(0)
    })

    test('rejects a turn length that is not a number', async ({ users }) => {
      const [alice] = await users(1)
      await alice.page.goto('/queue')

      await expect(alice.page.getByTestId('create-room-form')).toBeVisible({ timeout: 15000 })
      await alice.page.getByTestId('room-name-input').fill(`__test-${Date.now()}__ Blank`)
      await alice.page.getByTestId('turn-value-input').fill('')
      await alice.page.getByTestId('create-room-submit').click()

      await expect(alice.page.getByTestId('create-room-error')).toContainText('Enter a number')
    })
  })
})
