/**
 * Cron task definitions — registered into the AppCronRoom DO at construction
 * time (worker.ts). The DO alarm fires `runTask(name, env)` on the schedule
 * declared here; the DO itself records executions, tracks history, and
 * pushes status to admin clients via the `/ws/cron/:roomId` WebSocket.
 *
 * Each task declares EITHER `intervalMinutes` (run every N minutes) OR
 * `schedule` + `timezone` (5-field cron expression).
 *
 * This app runs one task: reclaiming turns whose time is up. One minute is
 * the finest interval the DO offers, which is coarse next to a turn measured
 * in seconds — so the room page also nudges the server the moment its own
 * countdown hits zero (see `sweepRoom` in src/actions/queue-actions.ts). The
 * nudge makes expiry feel immediate when somebody is watching; this task is
 * what guarantees it happens when nobody is.
 */

import { buildCronContext } from 'deepspace/worker'
import type { CronContext, CronTask } from 'deepspace/worker'
import type { Env } from '../worker'
import { sweepAllRooms, type QueueTools } from './actions/queue-state'

export const EXPIRE_TURNS_TASK = 'expire-turns'

export const tasks: CronTask[] = [{ name: EXPIRE_TURNS_TASK, intervalMinutes: 1 }]

export async function runTask(name: string, env: unknown): Promise<void> {
  if (name !== EXPIRE_TURNS_TASK) return

  const cronEnv = env as Env
  const ctx = buildCronContext(cronEnv, cronEnv.OWNER_USER_ID, `app:${cronEnv.DEEPSPACE_APP_ID}`)

  const report = await sweepAllRooms(cronToQueueTools(ctx))

  // Only worth a log line when the tick actually did something; an idle app
  // ticking every minute should not fill the log with "advanced 0". `skipped`
  // is reported but never on its own — losing a race to a client's nudge is
  // routine, and a log that cries wolf is one nobody reads.
  if (report.advanced > 0 || report.errors.length > 0) {
    console.info(
      `[cron] ${EXPIRE_TURNS_TASK} scanned=${report.scanned} advanced=${report.advanced}` +
        ` skipped=${report.skipped}` +
        (report.errors.length > 0 ? ` errors=${JSON.stringify(report.errors)}` : ''),
    )
  }
}

/**
 * Presents `CronContext.records` as the `QueueTools` shape the queue helpers
 * expect, so the scheduled sweep runs the same `expireIfDue` → `applyPlan`
 * path a user action does.
 *
 * Two mismatches to bridge: the cron API throws where the action API returns
 * `{ success: false }`, and it has no `get`, which a one-row query stands in
 * for.
 */
function cronToQueueTools(ctx: CronContext): QueueTools {
  async function attempt<T>(run: () => Promise<T>): Promise<{ success: true; data: T } | { success: false; error: string }> {
    try {
      return { success: true, data: await run() }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  type Row = { recordId: string; data: Record<string, unknown>; createdBy?: string }

  return {
    async get(collection, recordId) {
      const result = await attempt(() =>
        ctx.records.query(collection, { where: { recordId }, limit: 1 }),
      )
      if (!result.success) return result
      const record = (result.data as Row[])[0]
      if (!record) return { success: false, error: `Not found: ${collection}/${recordId}` }
      return { success: true, data: { record } } as never
    },

    async query(collection, options) {
      const result = await attempt(() =>
        ctx.records.query(collection, { where: options?.where, limit: options?.limit }),
      )
      if (!result.success) return result
      const records = result.data as Row[]
      return { success: true, data: { records, count: records.length } } as never
    },

    async create(collection, data) {
      const result = await attempt(() => ctx.records.create(collection, data))
      return (result.success ? { success: true, data: result.data } : result) as never
    },

    async update(collection, recordId, data) {
      const result = await attempt(() => ctx.records.update(collection, recordId, data))
      return (result.success ? { success: true, data: result.data } : result) as never
    },

    async remove(collection, recordId) {
      const result = await attempt(() => ctx.records.delete(collection, recordId))
      return (result.success ? { success: true, data: result.data } : result) as never
    },
  }
}
