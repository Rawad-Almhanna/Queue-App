/**
 * Create a queue room. Reached at /queue — gating comes from
 * (protected)/_layout.tsx, so there is no auth logic in this file.
 *
 * The form validates with the same `validateCreateRoom` the server action
 * runs, so the field-level message a user sees is the rule that will actually
 * be enforced. The client check is convenience; the action's is the boundary.
 */

import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button, Input, Label, cn, useToast } from '@/components/ui'
import { callQueueAction } from '../../../queue/client'
import { isValidRoomCode, normalizeRoomCode, validateCreateRoom } from '../../../queue/room'
import { formatDuration, splitDuration, toSeconds, type DurationUnit } from '../../../queue/duration'
import {
  DEFAULT_GRACE_SECONDS,
  DEFAULT_TURN_SECONDS,
  ROOM_CODE_LENGTH,
} from '../../../queue/types'

interface CreatedRoom {
  code: string
  name: string
}

const TURN_UNITS: DurationUnit[] = ['seconds', 'minutes', 'hours']
/** Grace tops out at 10 minutes, so hours would only ever be invalid. */
const GRACE_UNITS: DurationUnit[] = ['seconds', 'minutes']

const UNIT_LABELS: Record<DurationUnit, string> = {
  seconds: 'seconds',
  minutes: 'minutes',
  hours: 'hours',
}

const defaultTurn = splitDuration(DEFAULT_TURN_SECONDS)
const defaultGrace = splitDuration(DEFAULT_GRACE_SECONDS)

/** Native select — one tap on mobile, and it inherits the Input styling. */
function UnitSelect({
  id,
  testId,
  value,
  units,
  onChange,
}: {
  id: string
  testId: string
  value: DurationUnit
  units: DurationUnit[]
  onChange: (unit: DurationUnit) => void
}) {
  return (
    <select
      id={id}
      data-testid={testId}
      value={value}
      onChange={(event) => onChange(event.target.value as DurationUnit)}
      className={cn(
        'h-10 rounded-md border border-input bg-transparent px-2 text-sm shadow-sm',
        'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
      )}
    >
      {units.map((unit) => (
        <option key={unit} value={unit}>
          {UNIT_LABELS[unit]}
        </option>
      ))}
    </select>
  )
}

export default function CreateQueuePage() {
  const [name, setName] = useState('')
  const [location, setLocation] = useState('')
  const [turnValue, setTurnValue] = useState(String(defaultTurn.value))
  const [turnUnit, setTurnUnit] = useState<DurationUnit>(defaultTurn.unit)
  const [graceValue, setGraceValue] = useState(String(defaultGrace.value))
  const [graceUnit, setGraceUnit] = useState<DurationUnit>(defaultGrace.unit)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [created, setCreated] = useState<CreatedRoom | null>(null)
  const [copied, setCopied] = useState(false)
  const [joinCode, setJoinCode] = useState('')
  const [joinError, setJoinError] = useState<string | null>(null)
  const [checkingCode, setCheckingCode] = useState(false)
  const { success, error: toastError } = useToast()
  const navigate = useNavigate()

  const turnSeconds = toSeconds(turnValue, turnUnit)
  const graceSeconds = toSeconds(graceValue, graceUnit)

  async function handleCreate(event: React.FormEvent) {
    event.preventDefault()
    setError(null)

    if (turnSeconds === null) return setError('Enter a number for the turn length.')
    if (graceSeconds === null) return setError('Enter a number for the grace period.')

    const input = { name, location, turnSeconds, graceSeconds }
    const validation = validateCreateRoom(input)
    if (!validation.ok) {
      setError(validation.error)
      return
    }

    setCreating(true)
    const result = await callQueueAction<{ code: string }>('createRoom', input)
    setCreating(false)

    if (!result.success) {
      setError(result.error)
      toastError('Could not create the queue', result.error)
      return
    }

    setCreated({ code: result.data.code, name: validation.data.name })
    success('Queue created', `Share the code ${result.data.code}`)
  }

  /** Resolve the code server-side first, so a typo says so instead of opening an empty room. */
  async function handleJoinByCode(event: React.FormEvent) {
    event.preventDefault()
    setJoinError(null)

    const code = normalizeRoomCode(joinCode)
    if (!isValidRoomCode(code)) {
      setJoinError('Room codes are 6 characters, like ABC234.')
      return
    }

    setCheckingCode(true)
    const result = await callQueueAction<{ code: string }>('getRoom', { code })
    setCheckingCode(false)

    if (!result.success) {
      setJoinError(result.error)
      return
    }
    void navigate(`/q/${result.data.code}`)
  }

  async function handleCopy(code: string) {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      toastError('Could not copy', 'Copy the code manually.')
    }
  }

  if (created) {
    return (
      <div className="min-h-full text-foreground">
        <div className="mx-auto max-w-md px-6 py-16">
          <div
            data-testid="room-created"
            className="rounded-lg border border-border bg-card p-6 text-center"
          >
            <h1 className="text-xl font-semibold">{created.name} is ready</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              Share this code so others can join the queue.
            </p>

            <p
              data-testid="room-code"
              className="my-6 font-mono text-4xl font-bold tracking-[0.3em]"
            >
              {created.code}
            </p>

            <Button
              data-testid="open-created-room"
              className="w-full"
              onClick={() => void navigate(`/q/${created.code}`)}
            >
              Open the queue
            </Button>
            <Button
              data-testid="copy-room-code"
              variant="secondary"
              className="mt-2 w-full"
              onClick={() => handleCopy(created.code)}
            >
              {copied ? 'Copied' : 'Copy code'}
            </Button>
            <Button
              data-testid="create-another"
              variant="ghost"
              className="mt-2 w-full"
              onClick={() => setCreated(null)}
            >
              Create another queue
            </Button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-full text-foreground">
      <div className="mx-auto max-w-md px-6 py-12">
        <form
          data-testid="join-by-code-form"
          onSubmit={handleJoinByCode}
          noValidate
          className="rounded-lg border border-border bg-card p-5"
        >
          <Label htmlFor="join-code">Have a code?</Label>
          <div className="mt-3 flex gap-2">
            <Input
              id="join-code"
              data-testid="join-code-input"
              className="flex-1 font-mono uppercase tracking-widest"
              placeholder="ABC234"
              maxLength={ROOM_CODE_LENGTH}
              value={joinCode}
              onChange={(event) => setJoinCode(event.target.value.toUpperCase())}
            />
            <Button
              type="submit"
              variant="secondary"
              data-testid="join-by-code-submit"
              disabled={checkingCode}
            >
              {checkingCode ? 'Checking…' : 'Open'}
            </Button>
          </div>
          {joinError && (
            <p data-testid="join-code-error" role="alert" className="mt-3 text-sm text-destructive">
              {joinError}
            </p>
          )}
        </form>

        <h1 className="mt-12 text-2xl font-semibold tracking-tight">Start a queue</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Set up a shared resource and get a code to pass around.
        </p>

        <form
          data-testid="create-room-form"
          onSubmit={handleCreate}
          // Native constraint validation would block submit before the shared
          // validator runs, so the user would get the browser's message
          // instead of the rule the server actually enforces.
          noValidate
          className="mt-8 space-y-5 rounded-lg border border-border bg-card p-6"
        >
          <div className="space-y-2">
            <Label htmlFor="room-name">What is being shared?</Label>
            <Input
              id="room-name"
              data-testid="room-name-input"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Dryer 3"
              autoFocus
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="room-location">Location (optional)</Label>
            <Input
              id="room-location"
              data-testid="room-location-input"
              value={location}
              onChange={(event) => setLocation(event.target.value)}
              placeholder="Basement"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="turn-value">Turn length</Label>
            <div className="flex gap-2">
              <Input
                id="turn-value"
                data-testid="turn-value-input"
                type="number"
                inputMode="numeric"
                min={1}
                className="flex-1"
                value={turnValue}
                onChange={(event) => setTurnValue(event.target.value)}
              />
              <UnitSelect
                id="turn-unit"
                testId="turn-unit-select"
                value={turnUnit}
                units={TURN_UNITS}
                onChange={setTurnUnit}
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="grace-value">Grace period</Label>
            <div className="flex gap-2">
              <Input
                id="grace-value"
                data-testid="grace-value-input"
                type="number"
                inputMode="numeric"
                min={1}
                className="flex-1"
                value={graceValue}
                onChange={(event) => setGraceValue(event.target.value)}
              />
              <UnitSelect
                id="grace-unit"
                testId="grace-unit-select"
                value={graceUnit}
                units={GRACE_UNITS}
                onChange={setGraceUnit}
              />
            </div>
          </div>

          <p data-testid="duration-summary" className="text-xs text-muted-foreground">
            Each turn lasts <strong>{formatDuration(turnSeconds ?? 0)}</strong>. If someone is
            handed the turn and doesn&apos;t start it within{' '}
            <strong>{formatDuration(graceSeconds ?? 0)}</strong>, the queue moves on.
          </p>

          {error && (
            <p data-testid="create-room-error" role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}

          <Button
            type="submit"
            data-testid="create-room-submit"
            className="w-full"
            disabled={creating}
          >
            {creating ? 'Creating…' : 'Create queue'}
          </Button>
        </form>
      </div>
    </div>
  )
}
