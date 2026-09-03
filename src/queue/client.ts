/**
 * Client helper for calling the queue's server actions.
 *
 * Every queue write is an action, so this is the single place the caller's
 * bearer token is attached and a failed HTTP status is turned into the same
 * `{ success, error }` shape the action itself returns.
 */

import { getAuthToken } from 'deepspace'

export type ActionResponse<T> = { success: true; data: T } | { success: false; error: string }

export async function callQueueAction<T>(
  name: string,
  params: Record<string, unknown> = {},
): Promise<ActionResponse<T>> {
  let response: Response
  try {
    const token = await getAuthToken()
    response = await fetch(`/api/actions/${name}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(params),
    })
  } catch {
    return { success: false, error: 'Network error — check your connection and try again.' }
  }

  let body: unknown = null
  try {
    body = await response.json()
  } catch {
    body = null
  }

  const error = (body as { error?: string } | null)?.error
  if (!response.ok) {
    return { success: false, error: error ?? `Request failed (${response.status})` }
  }
  return body as ActionResponse<T>
}
