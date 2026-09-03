/**
 * The live queue room, at /q/:code.
 *
 * Both `useQuery` calls are WebSocket subscriptions, so every connected client
 * re-renders the moment the Durable Object broadcasts a change — including
 * changes made by a server action, which is how every queue write happens.
 * Nothing on this page polls.
 */

import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useAuth, useQuery, useUser } from 'deepspace'
import { Badge, Button, Input, useToast } from '@/components/ui'
import { callQueueAction } from '../../../../queue/client'
import { phaseOf, positionOf, waitingList } from '../../../../queue/logic'
import { formatDuration } from '../../../../queue/duration'
import { normalizeRoomCode } from '../../../../queue/room'
import type { QueueEntryData, QueueRoomData, QueueState } from '../../../../queue/types'

export default function QueueRoomPage() {
  const { code: rawCode } = useParams<{ code: string }>()
  const code = normalizeRoomCode(rawCode ?? '')

  const { userId } = useAuth()
  const { user } = useUser()
  const { success, error: toastError } = useToast()

  const { records: rooms, status: roomStatus } = useQuery<QueueRoomData>('queue_rooms', {
    where: { recordId: code },
  })
  const { records: entryRecords } = useQuery<QueueEntryData>('queue_entries', {
    where: { roomId: code },
    orderBy: 'position',
    orderDir: 'asc',
  })

  const [joinName, setJoinName] = useState('')
  const [joining, setJoining] = useState(false)
  const [copied, setCopied] = useState(false)

  const room = rooms[0]

  if (roomStatus === 'loading' && !room) {
    return <CenteredNote testId="room-loading">Loading the queue…</CenteredNote>
  }

  if (!room) {
    return (
      <CenteredNote testId="room-not-found">
        <p className="font-medium text-foreground">No queue with the code {code}.</p>
        <p className="mt-1">Check the code and try again.</p>
        <Link to="/queue" className="mt-4 inline-block text-sm text-primary hover:underline">
          Start a queue instead
        </Link>
      </CenteredNote>
    )
  }

  const state: QueueState = {
    room: { recordId: room.recordId, data: room.data, createdBy: room.createdBy },
    entries: entryRecords.map((record) => ({ recordId: record.recordId, data: record.data })),
  }

  const waiting = waitingList(state)
  const phase = phaseOf(state.room)
  const myPosition = userId ? positionOf(state, userId) : 0
  const iHoldTheTurn = Boolean(userId) && room.data.holderUserId === userId
  const iAmOwner = Boolean(userId) && room.createdBy === userId
  const inQueue = iHoldTheTurn || myPosition > 0

  async function handleJoin(event: React.FormEvent) {
    event.preventDefault()
    const displayName = (joinName || user?.name || '').trim()
    if (!displayName) {
      toastError('Add a display name', 'Others need to know who is in line.')
      return
    }

    setJoining(true)
    const result = await callQueueAction<{ hasTurn: boolean }>('joinQueue', { code, displayName })
    setJoining(false)

    if (!result.success) {
      toastError('Could not join', result.error)
      return
    }
    success(result.data.hasTurn ? 'The resource is yours' : 'You are in the queue')
  }

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(window.location.href)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      toastError('Could not copy', 'Copy the link from the address bar.')
    }
  }

  return (
    <div className="min-h-full text-foreground">
      <div className="mx-auto max-w-lg px-4 py-8 sm:px-6">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 data-testid="room-title" className="truncate text-2xl font-semibold tracking-tight">
              {room.data.name}
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {room.data.location ? `${room.data.location} · ` : ''}
              {formatDuration(room.data.turnSeconds)} per turn
            </p>
          </div>
          <div className="flex items-center gap-2">
            {iAmOwner && <Badge data-testid="owner-badge">Owner</Badge>}
            <button
              type="button"
              data-testid="copy-room-link"
              onClick={handleCopy}
              title="Copy the link to this queue"
              className="rounded-md border border-border px-3 py-1.5 font-mono text-sm font-semibold tracking-widest hover:bg-accent"
            >
              <span data-testid="room-code">{code}</span>
              <span className="ml-2 font-sans text-xs font-normal text-muted-foreground">
                {copied ? 'copied' : 'copy'}
              </span>
            </button>
          </div>
        </header>

        <section
          data-testid="current-turn"
          data-phase={phase}
          className="mt-6 rounded-lg border border-border bg-card p-5"
        >
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Using it now
          </p>

          {phase === 'idle' ? (
            <p data-testid="turn-holder" className="mt-2 text-lg font-medium">
              Nobody — it&apos;s free
            </p>
          ) : (
            <>
              <p data-testid="turn-holder" className="mt-2 text-lg font-medium">
                {room.data.holderName}
                {iHoldTheTurn && <span className="text-muted-foreground"> (you)</span>}
              </p>
              <p data-testid="turn-phase" className="mt-1 text-sm text-muted-foreground">
                {phase === 'active'
                  ? 'Turn in progress'
                  : `Hasn't started yet — ${formatDuration(room.data.graceSeconds)} to begin`}
              </p>
            </>
          )}
        </section>

        <section className="mt-6">
          <div className="flex items-baseline justify-between">
            <h2 className="text-sm font-semibold">Waiting</h2>
            <span data-testid="waiting-count" className="text-sm text-muted-foreground">
              {waiting.length}
            </span>
          </div>

          {waiting.length === 0 ? (
            <p data-testid="waiting-empty" className="mt-3 text-sm text-muted-foreground">
              Nobody is waiting.
            </p>
          ) : (
            <ol data-testid="waiting-list" className="mt-3 space-y-2">
              {waiting.map((entry, index) => (
                <li
                  key={entry.recordId}
                  data-testid="waiting-entry"
                  data-user-id={entry.data.userId}
                  className="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3"
                >
                  <span className="w-5 text-sm tabular-nums text-muted-foreground">
                    {index + 1}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm">
                    {entry.data.displayName}
                    {entry.data.userId === userId && (
                      <span className="text-muted-foreground"> (you)</span>
                    )}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </section>

        {myPosition > 0 && (
          <p data-testid="my-position" className="mt-4 text-sm text-muted-foreground">
            You are number <strong className="text-foreground">{myPosition}</strong> in line.
          </p>
        )}

        {!inQueue && (
          <form
            data-testid="join-queue-form"
            onSubmit={handleJoin}
            noValidate
            className="mt-6 rounded-lg border border-border bg-card p-5"
          >
            <label htmlFor="join-name" className="text-sm font-medium">
              Join this queue
            </label>
            <div className="mt-3 flex flex-col gap-2 sm:flex-row">
              <Input
                id="join-name"
                data-testid="join-name-input"
                className="flex-1"
                placeholder={user?.name ?? 'Your name'}
                value={joinName}
                onChange={(event) => setJoinName(event.target.value)}
              />
              <Button type="submit" data-testid="join-queue-submit" disabled={joining}>
                {joining ? 'Joining…' : 'Join'}
              </Button>
            </div>
          </form>
        )}
      </div>
    </div>
  )
}

function CenteredNote({ testId, children }: { testId: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-full items-center justify-center px-6 py-20 text-center">
      <div data-testid={testId} className="text-sm text-muted-foreground">
        {children}
      </div>
    </div>
  )
}
