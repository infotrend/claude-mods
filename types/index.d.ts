export type SessionStatus = 'busy' | 'idle'

export type ScannedSession = {
  name: string
  sessionId: string
  bridgeSessionId: string
  cwd: string
  status: SessionStatus
  lastAt: string | null
  ageMinutes: number | null
  pendingAsk: string
  wrapAsk: string
  lastText: string
  digest: string
}

export type Verdict = {
  hasQuestion: boolean
  question: string
  summary: string
  source: 'model' | 'heuristic'
}

export type WatchedSession = {
  name: string
  sessionId: string
  cwd: string
  status: SessionStatus
  ageMinutes: number | null
  digest: string
  url: string
  verdict: Verdict
}

export type Snapshot = {
  sessions: WatchedSession[]
  scannedAt: string
  error: string | null
}

declare module 'claude-code' {
  interface PluginState {
    'session-watch': {
      snapshot: Shaped<Snapshot | null>
      isRunning: boolean
      isRefreshing: boolean
      periodMinutes: number
      secondsLeft: number | null
    }
  }
}
