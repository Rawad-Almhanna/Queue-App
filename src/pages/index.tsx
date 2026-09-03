/**
 * Landing page — a STATIC page.
 *
 * It lives at the top level of src/pages/ (not under (app)/), so it renders
 * with no DeepSpace providers: no auth session fetch, no records WebSocket.
 * That makes it cheap to serve and safe for logged-out / crawler traffic.
 * A smoke test enforces exactly that, so keep this page free of hooks that
 * reach the network.
 */

import { Link } from 'react-router-dom'
import { APP_TITLE } from '../constants'

const STEPS = [
  { title: 'Name the thing', body: 'A dryer, a grill, the good printer. Set how long a turn lasts.' },
  { title: 'Share the code', body: 'Six characters. No app to install, no group chat to wrangle.' },
  { title: 'Take your turn', body: 'The queue moves itself along when a turn runs out.' },
]

export default function Landing() {
  return (
    <div
      data-testid="static-landing"
      className="flex min-h-screen flex-col items-center justify-center px-6 py-16 text-center"
    >
      <p className="mb-3 text-sm font-medium uppercase tracking-widest text-muted-foreground">
        {APP_TITLE}
      </p>

      <h1 className="mb-4 max-w-2xl text-4xl font-bold tracking-tight text-foreground sm:text-5xl">
        Take turns without hovering
      </h1>

      <p className="mb-10 max-w-md text-balance text-muted-foreground">
        A live shared queue for one thing a group has to take turns using. Everyone sees the same
        list, the same countdown, and who is actually there.
      </p>

      <Link
        to="/home"
        className="inline-flex items-center rounded-full bg-primary px-6 py-3 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
      >
        Open {APP_TITLE}
      </Link>

      <ol className="mt-16 grid max-w-3xl gap-6 text-left sm:grid-cols-3">
        {STEPS.map((step, index) => (
          <li key={step.title} className="rounded-lg border border-border bg-card p-5">
            <span className="font-mono text-xs text-muted-foreground">{index + 1}</span>
            <h2 className="mt-2 font-medium text-foreground">{step.title}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{step.body}</p>
          </li>
        ))}
      </ol>
    </div>
  )
}
