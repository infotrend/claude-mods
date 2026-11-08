import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { ScannedSession, SessionStatus, Snapshot, Verdict, WatchedSession } from '../types'
import { classify } from './classify'
import { countdownLabel, DEFAULT_MINUTES, minuteOptions, nextMinutes, parseMinutes, storedMinutes } from './period'
import { SCANNER_SOURCE } from './scanner'

const PANE = 'session-watch'
const PANE_TITLE = 'Sessions'
const SECOND_MS = 1000
const MINUTE_MS = 60 * SECOND_MS
const SCAN_TIMEOUT_MS = 90_000
const CONCURRENCY = 4
// Bumped with the English texts, so no verdict cached with the older wording is shown again.
const VERDICTS_KEY = 'verdicts-2'
const RUNNING_KEY = 'isRunning'
const MINUTES_KEY = 'periodMinutes'
const ORANGE = '#f97316'
const STATUS_LABELS: Record<SessionStatus, string> = { busy: 'working', background: 'working in background', idle: 'idle' }
// What Claude Code itself links a Remote Control session to.
const REMOTE_SESSION_URL = 'https://claude.ai/code/'

// Bump the shape tag when Snapshot's fields change: a value stored by an
// earlier version is then read as the initial value.
const snapshot = atom({ plugin: 'session-watch', key: 'snapshot' } as const, null, { shape: 'snapshot-2' })
const isRunning = atom({ plugin: 'session-watch', key: 'isRunning' } as const, true)
const isRefreshing = atom({ plugin: 'session-watch', key: 'isRefreshing' } as const, false)
const periodMinutes = atom({ plugin: 'session-watch', key: 'periodMinutes' } as const, DEFAULT_MINUTES)
// Seconds to the next timed refresh while the timer runs; null while it is stopped.
const secondsLeft = atom({ plugin: 'session-watch', key: 'secondsLeft' } as const, null)

type ScanOutput = { scannedAt: string, sessions: ScannedSession[] }

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  const queue = items.map((item, index) => ({ item, index }))
  const worker = async () => {
    for (let job = queue.shift(); job !== undefined; job = queue.shift()) {
      results[job.index] = await fn(job.item)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))

  return results
}

function rank(session: WatchedSession): number {
  if (session.verdict.hasQuestion) {
    return 0
  }

  return session.status === 'idle' ? 2 : 1
}

function sortSessions(sessions: readonly WatchedSession[]): WatchedSession[] {
  return [...sessions].sort((a, b) => rank(a) - rank(b) || (a.ageMinutes ?? Infinity) - (b.ageMinutes ?? Infinity) || a.name.localeCompare(b.name))
}

function ageLabel(minutes: number | null): string {
  if (minutes === null) {
    return ''
  }
  if (minutes < 1) {
    return 'just now'
  }
  if (minutes < 60) {
    return `${minutes} min ago`
  }
  if (minutes < 24 * 60) {
    return `${Math.floor(minutes / 60)} h ago`
  }

  return `${Math.floor(minutes / (24 * 60))} d ago`
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function scan($: EngineInterface): Promise<ScanOutput> {
  const self = await $.session.id()
  const run = await $.process.run(['python3', '-I', '-'], { stdin: SCANNER_SOURCE, env: { SW_SELF: self }, timeoutMs: SCAN_TIMEOUT_MS })
  if (run.exitCode !== 0) {
    throw new Error(`Scanner exited with code ${run.exitCode}: ${run.stderr.slice(0, 300)}`)
  }

  return JSON.parse(run.stdout) as ScanOutput
}

async function loadVerdicts($: EngineInterface): Promise<Record<string, Verdict>> {
  const stored = await $.store.get(VERDICTS_KEY)

  return stored !== null && typeof stored === 'object' ? (stored as Record<string, Verdict>) : {}
}

function watched(one: ScannedSession, verdict: Verdict): WatchedSession {
  const url = `${REMOTE_SESSION_URL}${encodeURIComponent(one.bridgeSessionId)}`

  return { name: one.name, sessionId: one.sessionId, cwd: one.cwd, status: one.status, ageMinutes: one.ageMinutes, digest: one.digest, url, verdict }
}

function publishStatus($: EngineInterface, sessions: readonly WatchedSession[], running: boolean): void {
  const questions = sessions.filter(one => one.verdict.hasQuestion).length
  const head = questions === 0 ? 'Sessions: no questions' : `● ${questions} ${questions === 1 ? 'session has' : 'sessions have'} a question`
  $.ui.status(running ? head : `${head} (timer stopped)`)
}

let timer: Timer | undefined
let ticker: Timer | undefined
let nextRefreshAt = 0
let isScanning = false

async function refresh($: EngineInterface): Promise<void> {
  if (isScanning) {
    return
  }
  isScanning = true
  await update($, isRefreshing, () => true)
  try {
    const scanned = await scan($)
    const cached = await loadVerdicts($)
    const sessions = await mapLimit(scanned.sessions, CONCURRENCY, async one => watched(one, cached[one.digest] ?? (await classify($, one))))
    // Only model verdicts are kept: a heuristic one is retried next time.
    const kept = Object.fromEntries(sessions.filter(one => one.verdict.source === 'model').map(one => [one.digest, one.verdict]))
    await $.store.set(VERDICTS_KEY, kept)
    const next: Snapshot = { sessions: sortSessions(sessions), scannedAt: scanned.scannedAt, error: null }
    await update($, snapshot, () => next)
    publishStatus($, next.sessions, await read($, isRunning))
  } catch (error) {
    const message = errorText(error)
    await update($, snapshot, previous => ({ sessions: previous?.sessions ?? [], scannedAt: previous?.scannedAt ?? '', error: message }))
    $.ui.status('Sessions: refresh failed')
  } finally {
    isScanning = false
    await update($, isRefreshing, () => false)
  }
}

function refreshSoon($: EngineInterface): void {
  $.clock.after(1, () => {
    void refresh($)
  })
}

async function tickCountdown($: EngineInterface): Promise<void> {
  const seconds = Math.max(0, Math.ceil((nextRefreshAt - (await $.clock.now())) / SECOND_MS))
  await update($, secondsLeft, () => seconds)
}

function cancelTimers(): void {
  timer?.cancel()
  ticker?.cancel()
  timer = undefined
  ticker = undefined
}

async function startTimer($: EngineInterface, minutes: number): Promise<void> {
  cancelTimers()
  const period = minutes * MINUTE_MS
  nextRefreshAt = (await $.clock.now()) + period
  timer = $.clock.every(period, () => {
    nextRefreshAt += period
    void refresh($)
  })
  ticker = $.clock.every(SECOND_MS, () => {
    void tickCountdown($)
  })
  await tickCountdown($)
}

async function stopTimer($: EngineInterface): Promise<void> {
  cancelTimers()
  await update($, secondsLeft, () => null)
}

async function setRunning($: EngineInterface, running: boolean): Promise<void> {
  await update($, isRunning, () => running)
  await $.store.set(RUNNING_KEY, running)
  if (running) {
    await startTimer($, await read($, periodMinutes))
    refreshSoon($)
  } else {
    await stopTimer($)
  }
  const current = await read($, snapshot)
  publishStatus($, current?.sessions ?? [], running)
}

// Reads the flag when pressed, never the value the drawing captured.
async function toggleRunning($: EngineInterface): Promise<void> {
  await setRunning($, !(await read($, isRunning)))
}

// A running timer restarts at once with the new period; a stopped one keeps it for its next start.
async function setPeriod($: EngineInterface, minutes: number): Promise<void> {
  await update($, periodMinutes, () => minutes)
  await $.store.set(MINUTES_KEY, minutes)
  if (await read($, isRunning)) {
    await startTimer($, minutes)
  }
}

async function pickPeriod($: EngineInterface, value: string): Promise<void> {
  const minutes = parseMinutes(value)
  if (minutes !== undefined) {
    await setPeriod($, minutes)
  }
}

// The surfaces without a Select (mobile) step through the presets with a button.
async function cyclePeriod($: EngineInterface): Promise<void> {
  await setPeriod($, nextMinutes(await read($, periodMinutes)))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'session-watch', description: 'Summary of the sessions with Remote Control: opens the pane; start, stop, now, or the timer\'s minutes (1-120)', argumentHint: 'start | stop | now | <minutes>' })
    const running = (await $.store.get(RUNNING_KEY)) !== false
    const minutes = storedMinutes(await $.store.get(MINUTES_KEY))
    await update($, isRunning, () => running)
    await update($, periodMinutes, () => minutes)
    await update($, isRefreshing, () => false)
    void $.ui.open({ id: PANE, title: PANE_TITLE })
    if (running) {
      await startTimer($, minutes)
      refreshSoon($)
    } else {
      await stopTimer($)
    }

    return next(e)
  })

  on('command.run', { command: 'session-watch' }, async ($, e) => {
    const action = e.args.trim().toLowerCase()
    if (action === 'start') {
      await setRunning($, true)

      return { text: `Session watch: refreshing every ${await read($, periodMinutes)} min.` }
    }
    if (action === 'stop') {
      await setRunning($, false)

      return { text: 'Session watch: automatic refresh stopped.' }
    }
    if (action === 'now') {
      refreshSoon($)

      return { text: 'Session watch: refreshing now.' }
    }
    if (action !== '') {
      const minutes = parseMinutes(action)
      if (minutes === undefined) {
        return { text: `Unknown argument "${e.args.trim()}": use start, stop, now or the timer's minutes, from 1 to 120.` }
      }
      await setPeriod($, minutes)
      const running = await read($, isRunning)

      return { text: `Session watch: refreshing every ${minutes} min${running ? '.' : ' once the timer starts (it is stopped: use start).'}` }
    }
    await $.ui.open({ id: PANE, title: PANE_TITLE })

    return { text: 'Sessions pane opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Text, Button, Link } = elements
    const current = await read($, snapshot)
    const running = await read($, isRunning)
    const refreshing = await read($, isRefreshing)
    const minutes = await read($, periodMinutes)
    const left = await read($, secondsLeft)
    const countdown = running && left !== null ? ` · ${countdownLabel(left)}` : ''
    const sessions = current?.sessions ?? []
    const questions = sessions.filter(one => one.verdict.hasQuestion).length
    const updated = current?.scannedAt ? `updated at ${current.scannedAt}` : 'never updated'
    const timerLabel = running ? `every ${minutes} min` : 'timer stopped'

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between" alignItems="center" columnGap={1} flexWrap="wrap">
          <Box flexDirection="column">
            <Text weight="semibold" color={questions > 0 ? ORANGE : undefined}>
              {questions === 0 ? 'No questions' : `${questions} ${questions === 1 ? 'question' : 'questions'}`}
              <Text dimColor weight="regular"> · {sessions.length} {sessions.length === 1 ? 'session' : 'sessions'}{countdown}</Text>
            </Text>
            <Text dimColor>{refreshing ? 'Refreshing…' : `${updated} · ${timerLabel}`}</Text>
          </Box>
          <Box flexDirection="row" alignItems="center" columnGap={1}>
            {e.surface !== 'mobile' && 'Select' in elements ? (
              <elements.Select key="period" label="Every" options={minuteOptions(minutes)} value={String(minutes)} onSelect={(value: string) => pickPeriod($, value)} />
            ) : (
              <Button key="period" label={`Every ${minutes} min`} onPress={() => cyclePeriod($)} />
            )}
            <Button key="toggle" label={running ? 'Stop' : 'Start'} variant={running ? 'secondary' : 'primary'} onPress={() => toggleRunning($)} />
            <Button key="now" label="Refresh" onPress={() => refreshSoon($)} />
          </Box>
        </Box>
        {current?.error ? <Text color="error">Refresh failed: {current.error}</Text> : null}
        {current === null && !refreshing ? <Text dimColor>Press Refresh to read the sessions.</Text> : null}
        {sessions.map(one => (
          <Box key={one.sessionId} flexDirection="column" marginTop={1}>
            <Text>
              <Text color={one.verdict.hasQuestion ? ORANGE : 'inactive'}>{one.verdict.hasQuestion ? '●' : '○'}</Text>{' '}
              <Link href={one.url}>
                <Text weight="semibold">{one.name}</Text>
                <Text dimColor> · {STATUS_LABELS[one.status]}{one.ageMinutes === null ? '' : ` · ${ageLabel(one.ageMinutes)}`}</Text>
              </Link>
            </Text>
            {one.verdict.hasQuestion ? <Text color={ORANGE}>  <Link href={one.url}>{one.verdict.question}</Link></Text> : null}
            <Text dimColor>  <Link href={one.url}>{one.verdict.summary}</Link></Text>
          </Box>
        ))}
      </Box>
    )
  })
}
