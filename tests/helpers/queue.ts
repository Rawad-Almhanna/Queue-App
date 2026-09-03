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
