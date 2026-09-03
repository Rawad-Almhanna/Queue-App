/**
 * Shared plumbing for the queue specs.
 *
 * Server actions require a Bearer token (a cookie session alone is refused by
 * registerActionRoutes), and the SDK mints one at POST /api/auth/token using
 * the session cookie. Running that fetch inside the signed-in page is the same
 * path `getAuthToken()` takes in the app, so the token is real, not a fixture.
 */

import type { APIResponse, Page } from '@playwright/test'

export type ActionResponse<T> = { success: true; data: T } | { success: false; error?: string }

export async function authToken(page: Page): Promise<string> {
  const token = await page.evaluate(async () => {
    const res = await fetch('/api/auth/token', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
    })
    if (!res.ok) return null
    const body = (await res.json()) as { token?: string }
    return body.token ?? null
  })

  if (!token) throw new Error('No auth token — the page is not signed in.')
  return token
}

/** POSTs an action as the signed-in user of `page`, returning the raw response. */
export async function postAction(
  page: Page,
  name: string,
  params: Record<string, unknown> = {},
  token?: string,
): Promise<APIResponse> {
  const bearer = token ?? (await authToken(page))
  return page.request.post(`/api/actions/${name}`, {
    headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
    data: params,
  })
}

/** POSTs an action and returns its parsed `{ success, data | error }` body. */
export async function callAction<T>(
  page: Page,
  name: string,
  params: Record<string, unknown> = {},
): Promise<ActionResponse<T>> {
  const res = await postAction(page, name, params)
  return (await res.json()) as ActionResponse<T>
}

/** Test rooms are named so they are recognisable in the dev Durable Object. */
export function testRoomName(label = 'Dryer'): string {
  return `__test-${Date.now()}__ ${label}`
}

export async function createTestRoom(
  page: Page,
  overrides: Record<string, unknown> = {},
): Promise<{ code: string; name: string }> {
  const name = (overrides.name as string) ?? testRoomName()
  const result = await callAction<{ code: string }>(page, 'createRoom', {
    name,
    turnSeconds: 60,
    graceSeconds: 30,
    ...overrides,
  })

  if (!result.success) throw new Error(`createRoom failed: ${result.error}`)
  return { code: result.data.code, name }
}

/**
 * The signed-in user's id, read from the same JWT the actions verify.
 *
 * Owner-permission tests need to name a victim for `removeParticipant`, and
 * this is the only way to learn another browser's id without trusting the page
 * to have already rendered it.
 */
export async function currentUserId(page: Page): Promise<string> {
  const token = await authToken(page)
  const segment = token.split('.')[1]
  if (!segment) throw new Error('Auth token is not a JWT.')

  const json = Buffer.from(segment.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
  const claims = JSON.parse(json) as { sub?: string; userId?: string }

  const userId = claims.sub ?? claims.userId
  if (!userId) throw new Error(`No subject claim in the auth token: ${json}`)
  return userId
}

/** Puts `page`'s user in `code`, failing loudly rather than half-setting-up a test. */
export async function joinRoom(page: Page, code: string, displayName: string): Promise<void> {
  const result = await callAction(page, 'joinQueue', { code, displayName })
  if (!result.success) throw new Error(`joinQueue failed for ${displayName}: ${result.error}`)
}
