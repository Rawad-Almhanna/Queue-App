/**
 * Home — where a signed-in user picks up where they left off.
 *
 * This page is deliberately *not* under (protected): a signed-out visitor can
 * land here and gets the pitch plus the nav's sign-in button, rather than a
 * wall. The live query therefore lives in a child that only mounts once we
 * have a user id, so an anonymous visit opens no subscription.
 */

import { Link } from 'react-router-dom'
import { useAuth, useQuery } from 'deepspace'
import { APP_TITLE } from '../../constants'
import { formatDuration } from '../../queue/duration'
import type { QueueRoomData } from '../../queue/types'

export default function HomePage() {
  const { userId } = useAuth()

  return (
    <div className="min-h-full text-foreground">
      <div className="mx-auto max-w-lg px-4 py-10 sm:px-6">
        <h1 className="text-2xl font-semibold tracking-tight">{APP_TITLE}</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          A live shared queue for something a group takes turns using.
        </p>

        <div className="mt-6 flex flex-col gap-2 sm:flex-row">
          <Link
            to="/queue"
            data-testid="home-start-queue"
            className="inline-flex flex-1 items-center justify-center rounded-md bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
          >
            Start a queue
          </Link>
          <Link
            to="/queue"
            data-testid="home-join-queue"
            className="inline-flex flex-1 items-center justify-center rounded-md border border-border px-4 py-2.5 text-sm font-medium transition-colors hover:bg-accent"
          >
            Join with a code
          </Link>
        </div>

        {userId ? (
          <YourQueues userId={userId} />
        ) : (
          <p data-testid="home-signed-out" className="mt-10 text-sm text-muted-foreground">
            Sign in to keep track of the queues you start.
          </p>
        )}
      </div>
    </div>
  )
}

/**
 * The rooms this user created.
 *
 * Only rooms you own, which is one indexed query on `createdBy`. Listing the
 * rooms you are merely *waiting* in would mean reading your entries and then
 * fetching each room by id — a query per row, to rebuild something you
 * already have a link or a code for.
 */
function YourQueues({ userId }: { userId: string }) {
  const { records, status } = useQuery<QueueRoomData>('queue_rooms', {
    where: { createdBy: userId },
    orderBy: 'createdAt',
    orderDir: 'desc',
    limit: 20,
  })

  return (
    <section className="mt-10">
      <h2 className="text-sm font-semibold">Queues you started</h2>

      {status === 'loading' && records.length === 0 ? (
        <p data-testid="your-queues-loading" className="mt-3 text-sm text-muted-foreground">
          Loading…
        </p>
      ) : records.length === 0 ? (
        <p data-testid="your-queues-empty" className="mt-3 text-sm text-muted-foreground">
          You haven&apos;t started one yet.
        </p>
      ) : (
        <ul data-testid="your-queues" className="mt-3 space-y-2">
          {records.map((record) => (
            <li key={record.recordId}>
              <Link
                to={`/q/${record.recordId}`}
                data-testid="your-queue-link"
                className="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3 transition-colors hover:bg-accent"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{record.data.name}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {record.data.holderUserId
                      ? `${record.data.holderName} has it`
                      : 'Free right now'}
                    {' · '}
                    {formatDuration(record.data.turnSeconds)} turns
                  </span>
                </span>
                <span className="font-mono text-xs tracking-widest text-muted-foreground">
                  {record.recordId}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
