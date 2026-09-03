/**
 * The live queue room, at /q/:code.
 *
 * Both `useQuery` calls are WebSocket subscriptions, so every connected client
 * re-renders the moment the Durable Object broadcasts a change — including
 * changes made by a server action, which is how every queue write happens.
 * Nothing on this page polls.
 *
 * The buttons here mirror the server's rules but do not constitute them: each
 * one calls an action whose transition re-checks the caller. Hiding the owner
 * controls is a courtesy to non-owners, not the permission boundary.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useAuth, usePresenceRoom, useQuery, useUser } from 'deepspace'
import { Badge, Button, Input, useToast } from '@/components/ui'
import { callQueueAction } from '../../../../queue/client'
import {
  graceDeadline,
  phaseOf,
  positionOf,
  turnDeadline,
  waitingList,
} from '../../../../queue/logic'
import { formatClock, formatDuration } from '../../../../queue/duration'
import { normalizeRoomCode } from '../../../../queue/room'
import type {
  QueueEntry,
  QueueEntryData,
  QueueRoomData,
  QueueState,
} from '../../../../queue/types'

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

  /**
   * Who has this room open right now.
   *
   * This is a separate ephemeral Durable Object from the records above —
   * nothing here is stored, and a peer disappears when their socket closes.
   * That is deliberate: presence answers "is this person at the machine",
   * which would be a lie the moment it outlived the connection.
   */
  const { peers, connected } = usePresenceRoom(`queue:${code}`)

  // `peers` excludes self by design, so our own id is added back from the
  // connection state — otherwise you would always look absent to yourself.
  const presentUserIds = useMemo(() => {
    const ids = new Set(peers.map((peer) => peer.userId))
    if (connected && userId) ids.add(userId)
    return ids
  }, [peers, connected, userId])

  const [joinName, setJoinName] = useState('')
  const [pending, setPending] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const room = rooms[0]
  const roomEnvelope = room
    ? { recordId: code, data: room.data, createdBy: room.createdBy }
    : null
  const phase = roomEnvelope ? phaseOf(roomEnvelope) : 'idle'

  // Re-render once a second only while a clock is actually running.
  useTick(phase !== 'idle')

  const deadline = !roomEnvelope
    ? 0
    : phase === 'assigned'
      ? graceDeadline(roomEnvelope)
      : phase === 'active'
        ? turnDeadline(roomEnvelope)
        : 0
  const secondsLeft = deadline > 0 ? Math.max(0, Math.ceil((deadline - Date.now()) / 1000)) : 0

  /**
   * Nudge the server the instant this turn runs out.
   *
   * The cron task is the authority, but one minute is its finest interval, so
   * an unattended countdown could sit at zero for most of a minute. Whoever
   * has the page open asks the server to re-check instead. The ref keys on
   * `turnSeq` so each turn is nudged exactly once per client, and the action
   * is idempotent besides — several clients hitting it together is harmless.
   */
  const turnSeq = room?.data.turnSeq ?? -1
  const expired = deadline > 0 && secondsLeft === 0
  const nudgedFor = useRef<number | null>(null)

  useEffect(() => {
    if (!expired) return
    if (nudgedFor.current === turnSeq) return
    nudgedFor.current = turnSeq
    void callQueueAction('sweepRoom', { code })
  }, [expired, turnSeq, code])

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
  const myPosition = userId ? positionOf(state, userId) : 0
  const iHoldTheTurn = Boolean(userId) && room.data.holderUserId === userId
  const iAmOwner = Boolean(userId) && room.createdBy === userId
  const inQueue = iHoldTheTurn || myPosition > 0

  async function run(action: string, params: Record<string, unknown>, done?: string) {
    setPending(action)
    const result = await callQueueAction(action, { code, ...params })
    setPending(null)
    if (!result.success) {
      toastError('That did not work', result.error)
      return
    }
    if (done) success(done)
  }

  async function handleJoin(event: React.FormEvent) {
    event.preventDefault()
    const displayName = (joinName || user?.name || '').trim()
    if (!displayName) {
      toastError('Add a display name', 'Others need to know who is in line.')
      return
    }

    setPending('joinQueue')
    const result = await callQueueAction<{ hasTurn: boolean }>('joinQueue', { code, displayName })
    setPending(null)

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
          <div className="flex items-start justify-between gap-3">
            <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Using it now
            </p>
            {phase !== 'idle' && (
              <span
                data-testid="turn-countdown"
                className={`font-mono text-sm tabular-nums ${
                  secondsLeft === 0 ? 'text-destructive' : 'text-muted-foreground'
                }`}
              >
                {secondsLeft === 0 ? 'time is up — moving on…' : formatClock(secondsLeft)}
              </span>
            )}
          </div>

          {phase === 'idle' ? (
            <p data-testid="turn-holder" className="mt-2 text-lg font-medium">
              Nobody — it&apos;s free
            </p>
          ) : (
            <>
              <p data-testid="turn-holder" className="mt-2 flex items-center gap-2 text-lg font-medium">
                <PresenceDot present={presentUserIds.has(room.data.holderUserId)} />
                <span>
                  {room.data.holderName}
                  {iHoldTheTurn && <span className="text-muted-foreground"> (you)</span>}
                </span>
              </p>
              <p data-testid="turn-phase" className="mt-1 text-sm text-muted-foreground">
                {phase === 'active'
                  ? 'Turn in progress'
                  : `Hasn't started yet — ${formatDuration(room.data.graceSeconds)} to begin`}
                {!presentUserIds.has(room.data.holderUserId) && ' · not in the room'}
              </p>
            </>
          )}

          {(iHoldTheTurn || (iAmOwner && phase !== 'idle')) && (
            <div className="mt-4 flex flex-wrap gap-2">
              {iHoldTheTurn && phase === 'assigned' && (
                <Button
                  data-testid="start-turn"
                  disabled={pending !== null}
                  onClick={() => run('startTurn', {}, 'Your turn has started')}
                >
                  Start my turn
                </Button>
              )}
              {iHoldTheTurn && phase === 'active' && (
                <Button
                  data-testid="finish-turn"
                  disabled={pending !== null}
                  onClick={() => run('finishTurn', {}, 'Turn finished')}
                >
                  I&apos;m done
                </Button>
              )}
              {iHoldTheTurn && (
                <Button
                  data-testid="leave-turn"
                  variant="ghost"
                  disabled={pending !== null}
                  onClick={() => run('leaveQueue', {}, 'You left the queue')}
                >
                  Give up my turn
                </Button>
              )}
              {iAmOwner && !iHoldTheTurn && phase !== 'idle' && (
                <>
                  <Button
                    data-testid="advance-queue"
                    variant="secondary"
                    disabled={pending !== null}
                    onClick={() => run('advanceQueue', {}, 'Moved the queue along')}
                  >
                    Move the queue along
                  </Button>
                  <Button
                    data-testid="remove-holder"
                    variant="ghost"
                    disabled={pending !== null}
                    onClick={() =>
                      run('removeParticipant', { targetUserId: room.data.holderUserId })
                    }
                  >
                    Remove
                  </Button>
                </>
              )}
            </div>
          )}
        </section>

        <section className="mt-6">
          <div className="flex items-baseline justify-between">
            <h2 className="text-sm font-semibold">Waiting</h2>
            <span className="text-sm text-muted-foreground">
              <span data-testid="present-count">{presentUserIds.size}</span> here ·{' '}
              <span data-testid="waiting-count">{waiting.length}</span> in line
            </span>
          </div>

          {waiting.length === 0 ? (
            <p data-testid="waiting-empty" className="mt-3 text-sm text-muted-foreground">
              Nobody is waiting.
            </p>
          ) : (
            <ol data-testid="waiting-list" className="mt-3 space-y-2">
              {waiting.map((entry, index) => (
                <WaitingRow
                  key={entry.recordId}
                  entry={entry}
                  index={index}
                  total={waiting.length}
                  isMe={entry.data.userId === userId}
                  isPresent={presentUserIds.has(entry.data.userId)}
                  showOwnerControls={iAmOwner}
                  busy={pending !== null}
                  onRun={run}
                />
              ))}
            </ol>
          )}
        </section>

        {myPosition > 0 && (
          <div className="mt-4 flex items-center justify-between">
            <p data-testid="my-position" className="text-sm text-muted-foreground">
              You are number <strong className="text-foreground">{myPosition}</strong> in line.
            </p>
            <Button
              data-testid="leave-queue"
              variant="ghost"
              size="sm"
              disabled={pending !== null}
              onClick={() => run('leaveQueue', {}, 'You left the queue')}
            >
              Leave
            </Button>
          </div>
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
              <Button type="submit" data-testid="join-queue-submit" disabled={pending !== null}>
                {pending === 'joinQueue' ? 'Joining…' : 'Join'}
              </Button>
            </div>
          </form>
        )}
      </div>
    </div>
  )
}

function WaitingRow({
  entry,
  index,
  total,
  isMe,
  isPresent,
  showOwnerControls,
  busy,
  onRun,
}: {
  entry: QueueEntry
  index: number
  total: number
  isMe: boolean
  isPresent: boolean
  showOwnerControls: boolean
  busy: boolean
  onRun: (action: string, params: Record<string, unknown>, done?: string) => void
}) {
  return (
    <li
      data-testid="waiting-entry"
      data-user-id={entry.data.userId}
      data-present={isPresent}
      className="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3"
    >
      <span className="w-5 text-sm tabular-nums text-muted-foreground">{index + 1}</span>
      <PresenceDot present={isPresent} />
      <span className={`min-w-0 flex-1 truncate text-sm ${isPresent ? '' : 'text-muted-foreground'}`}>
        {entry.data.displayName}
        {isMe && <span className="text-muted-foreground"> (you)</span>}
        {!isPresent && <span className="ml-2 text-xs text-muted-foreground">away</span>}
      </span>

      {showOwnerControls && (
        <span className="flex items-center gap-1">
          <IconButton
            testId="move-up"
            label="Move up"
            disabled={busy || index === 0}
            onClick={() => onRun('reorderEntry', { recordId: entry.recordId, direction: 'up' })}
          >
            ↑
          </IconButton>
          <IconButton
            testId="move-down"
            label="Move down"
            disabled={busy || index === total - 1}
            onClick={() => onRun('reorderEntry', { recordId: entry.recordId, direction: 'down' })}
          >
            ↓
          </IconButton>
          <IconButton
            testId="remove-entry"
            label={`Remove ${entry.data.displayName}`}
            disabled={busy}
            onClick={() => onRun('removeParticipant', { targetUserId: entry.data.userId })}
          >
            ×
          </IconButton>
        </span>
      )}
    </li>
  )
}

function IconButton({
  testId,
  label,
  disabled,
  onClick,
  children,
}: {
  testId: string
  label: string
  disabled: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="rounded-md border border-border px-2 py-1 text-sm leading-none text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-30 disabled:hover:bg-transparent"
    >
      {children}
    </button>
  )
}

/**
 * Present or away. The label is not decoration — a screen reader gets the same
 * distinction a sighted user gets from the colour.
 */
function PresenceDot({ present }: { present: boolean }) {
  const label = present ? 'In the room' : 'Not in the room'
  return (
    <span
      data-testid="presence-dot"
      data-present={present}
      role="img"
      aria-label={label}
      title={label}
      className={`size-2 shrink-0 rounded-full ${
        present ? 'bg-emerald-500' : 'border border-muted-foreground/50 bg-transparent'
      }`}
    />
  )
}

/** Drives the countdown. Idle rooms have no clock, so they get no interval. */
function useTick(active: boolean) {
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!active) return
    const id = setInterval(() => setTick((value) => value + 1), 1000)
    return () => clearInterval(id)
  }, [active])
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
