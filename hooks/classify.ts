import type { EngineInterface } from 'claude-code'

import type { ScannedSession, Verdict } from '../types'

const MODEL = 'haiku'
const MAX_LINE = 120
const MODEL_TIMEOUT_MS = 45_000
const HEURISTIC_WINDOW = 800
const ASK_PATTERN = /(tocca a te|ti spett|tuo ok|tuoi ok|per te:|serve il tuo|servono i tuoi|vuoi che|devi decidere|dimmi tu|aspetto (il )?tuo)/i

const SYSTEM = 'You triage the latest message of a coding-agent session for its owner. Reply with one JSON object and nothing else.'

export function clip(text: string, limit = MAX_LINE): string {
  const flat = text.replace(/[*`_#>]/g, '').replace(/\s+/g, ' ').trim()

  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`
}

function forcedAsk(session: ScannedSession): string {
  return session.pendingAsk || session.wrapAsk
}

function buildPrompt(session: ScannedSession): string {
  const state = session.status === 'busy' ? 'working right now' : 'idle: its turn has ended'
  const forced = forcedAsk(session)
  const pending = forced ? `It shows a pending question to the user: ${forced}\n` : ''

  return `Session "${session.name}" in ${session.cwd}, ${state}.
${pending}Its latest message to the user:
<<<
${session.lastText}
>>>

Reply with {"hasQuestion": boolean, "question": string, "summary": string}.
- hasQuestion: true only when the message waits on the user: a direct question to them, a decision, approval or OK they must give, or something they must do before the session can go on (for example "Should I push?", "Over to you", "I need your OK", "Vuoi che faccia push?", "Tocca a te", a list of decisions for the user). Progress narration, reports, plans the session carries out itself and requests addressed to another session are false.
- question: when hasQuestion, what the user must answer or do, in the language the message is written in, at most 110 characters, several asks joined with "; "; otherwise "".
- summary: in the language the message is written in, at most 110 characters, what the session has done or is doing now, without repeating the question.`
}

function parseVerdict(text: string): Verdict | undefined {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) {
    return undefined
  }
  try {
    const value = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>
    if (typeof value.hasQuestion !== 'boolean' || typeof value.summary !== 'string') {
      return undefined
    }
    const question = typeof value.question === 'string' ? value.question : ''

    return { hasQuestion: value.hasQuestion, question: value.hasQuestion ? clip(question) : '', summary: clip(value.summary), source: 'model' }
  } catch {
    return undefined
  }
}

function firstSentence(text: string): string {
  const line = text.split('\n').map(one => one.trim()).find(one => one.length > 0) ?? ''

  return line.split(/(?<=[.!?])\s/)[0] ?? line
}

export function heuristicVerdict(session: ScannedSession): Verdict {
  const forced = forcedAsk(session)
  const ending = session.lastText.slice(-HEURISTIC_WINDOW)
  const questionLines = ending.split('\n').map(one => one.trim()).filter(one => one.endsWith('?'))
  const questionLine = questionLines[questionLines.length - 1] ?? ''
  const hasQuestion = Boolean(forced || questionLine || ASK_PATTERN.test(ending))
  const question = hasQuestion ? clip(forced || questionLine || 'Waiting for your answer') : ''
  const summary = clip(firstSentence(session.lastText)) || (session.status === 'busy' ? 'Working' : 'No recent message')

  return { hasQuestion, question, summary, source: 'heuristic' }
}

export async function classify($: EngineInterface, session: ScannedSession): Promise<Verdict> {
  const forced = forcedAsk(session)
  if (!session.lastText && !forced) {
    return { hasQuestion: false, question: '', summary: session.status === 'busy' ? 'Working' : 'No recent message', source: 'model' }
  }
  const result = await $.model.complete({ model: MODEL, system: SYSTEM, prompt: buildPrompt(session), maxTokens: 400, timeoutMs: MODEL_TIMEOUT_MS })
  const parsed = result.isAnswered ? parseVerdict(result.text) : undefined
  if (!parsed) {
    return heuristicVerdict(session)
  }

  return forced ? { ...parsed, hasQuestion: true, question: parsed.question || clip(forced) } : parsed
}
