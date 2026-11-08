import { expect, mock, test } from 'claude-code/testing'

import { heuristicVerdict } from '../hooks/classify'
import { countdownLabel, DEFAULT_MINUTES, minuteOptions, nextMinutes, parseMinutes, storedMinutes } from '../hooks/period'
import type { ScannedSession } from '../types'

const PANE = { plugin: 'session-watch', component: 'Pane', requestId: 'session-watch', props: { title: 'Sessions', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} } } as const
const USAGE = { input_tokens: 10, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

function session(lastText: string, extra: Partial<ScannedSession> = {}): ScannedSession {
  return { name: 'demo', sessionId: 'id', bridgeSessionId: 'session_demo', cwd: '/opt/demo', status: 'idle', lastAt: null, ageMinutes: 1, pendingAsk: '', wrapAsk: '', lastText, digest: 'd', ...extra }
}

test('a closing question marks the session', async () => {
  const verdict = heuristicVerdict(session('Tutti i test sono verdi.\n\nPusho e installo la 1.4.0 su app.example.com?'))

  expect(verdict.hasQuestion).toBe(true)
  expect(verdict.question).toBe('Pusho e installo la 1.4.0 su app.example.com?')
})

test('a hand-off phrase marks the session', async () => {
  const verdict = heuristicVerdict(session('La release aspetta la revisione.\n\n**Tocca a te:** serve il tuo OK per il ramo.'))

  expect(verdict.hasQuestion).toBe(true)
})

test('a report alone does not mark the session', async () => {
  const verdict = heuristicVerdict(session('Il badge è online (commit 1a2b3c4).\n\nNon ho altro in corso.'))

  expect(verdict.hasQuestion).toBe(false)
  expect(verdict.question).toBe('')
})

test('a pending question tool always marks the session', async () => {
  const verdict = heuristicVerdict(session('', { pendingAsk: 'Quale opzione preferisci?' }))

  expect(verdict.hasQuestion).toBe(true)
  expect(verdict.question).toBe('Quale opzione preferisci?')
})

test('minutes are read from a number, "ogni N" or "every N min", within 1 to 120', async () => {
  expect(parseMinutes('5')).toBe(5)
  expect(parseMinutes('ogni 10')).toBe(10)
  expect(parseMinutes('every 3 min')).toBe(3)
  expect(parseMinutes(' 120 ')).toBe(120)
  expect(parseMinutes('0')).toBeUndefined()
  expect(parseMinutes('121')).toBeUndefined()
  expect(parseMinutes('2.5')).toBeUndefined()
  expect(parseMinutes('start')).toBeUndefined()
})

test('a stored period outside the range falls back to the default', async () => {
  expect(storedMinutes(7)).toBe(7)
  expect(storedMinutes(0)).toBe(DEFAULT_MINUTES)
  expect(storedMinutes('5')).toBe(DEFAULT_MINUTES)
  expect(storedMinutes(null)).toBe(DEFAULT_MINUTES)
})

test('the picker offers the presets and keeps a custom period', async () => {
  expect(minuteOptions(5).map(one => one.value)).toEqual(['1', '2', '3', '5', '10', '15', '30', '60'])
  expect(minuteOptions(7).map(one => one.value)).toEqual(['1', '2', '3', '5', '7', '10', '15', '30', '60'])
})

test('the countdown reads as minutes and two-digit seconds', async () => {
  expect(countdownLabel(90)).toBe('1:30')
  expect(countdownLabel(5)).toBe('0:05')
  expect(countdownLabel(0)).toBe('0:00')
  expect(countdownLabel(7200)).toBe('120:00')
})

test('the countdown shows beside the session count only while the timer runs', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('session.id', () => ({ value: 'self' }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: JSON.stringify({ scannedAt: '10:00', sessions: [] }), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  if ((await ui.find({ key: 'toggle' }))?.props.label === 'Start') {
    await ui.press({ key: 'toggle' })
  }
  await ui.select({ key: 'period', value: '3' })
  await ui.select({ key: 'period', value: '2' })
  await clock.advance(30_000)

  expect(await ui.find({ type: 'Text', text: /sessions · 1:30$/ })).toBeDefined()

  await ui.press({ key: 'toggle' })
  await clock.advance(5_000)

  expect(await ui.find({ type: 'Text', text: /sessions · \d+:\d\d/ })).toBeUndefined()
  await ui.unmount()
})

test('the mobile button steps to the next preset and wraps around', async () => {
  expect(nextMinutes(2)).toBe(3)
  expect(nextMinutes(7)).toBe(10)
  expect(nextMinutes(60)).toBe(1)
  expect(nextMinutes(120)).toBe(1)
})

test('the toggle stops and starts the timer, on every surface', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const before = (await ui.find({ key: 'toggle' }))?.props.label
    await ui.press({ key: 'toggle' })
    const after = (await ui.find({ key: 'toggle' }))?.props.label

    expect([before, after].sort()).toEqual(['Start', 'Stop'])
    await ui.unmount()
  }
})

test('picking the minutes changes the period shown', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))

  for (const [surface, value] of [['terminal', '5'], ['desktop', '15']] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.select({ key: 'period', value })

    expect((await ui.find({ key: 'period' }))?.props.value).toBe(value)
    await ui.unmount()
  }
})

test('on mobile a button steps the period, as it has no picker', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))

  const ui = await $.ui.mount({ ...PANE, surface: 'mobile' })
  const before = String((await ui.find({ key: 'period' }))?.props.label)
  await ui.press({ key: 'period' })
  const after = String((await ui.find({ key: 'period' }))?.props.label)

  expect(before).toMatch(/^Every \d+ min$/)
  expect(after).toMatch(/^Every \d+ min$/)
  expect(after).not.toBe(before)
  await ui.unmount()
})

test('the toggle line shows the chosen period while the timer runs', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.select({ key: 'period', value: '10' })
  if ((await ui.find({ key: 'toggle' }))?.props.label === 'Start') {
    await ui.press({ key: 'toggle' })
  }

  expect(await ui.find({ type: 'Text', text: /every 10 min/ })).toBeDefined()
  await ui.unmount()
})

test('each session row links to its Remote Control session', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  const scanned = { scannedAt: '10:00', sessions: [session('Pusho la 1.4.0?', { name: 'demo-main', bridgeSessionId: 'session_011abc' })] }
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('session.id', () => ({ value: 'self' }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: JSON.stringify(scanned), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('model.complete', () => ({ value: { isAnswered: true, text: '{"hasQuestion": true, "question": "Pushare la 1.4.0?", "summary": "Test verdi"}', usage: USAGE } }))

  for (const surface of ['terminal', 'desktop', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'now' })
    await clock.advance(1)
    const hrefs = (await ui.findAll({ type: 'Link' })).map(one => one.props.href)

    expect(hrefs.length).toBe(3)
    expect(hrefs.every(href => href === 'https://claude.ai/code/session_011abc')).toBe(true)
    await ui.unmount()
  }
})

test('a session working in background reads so and sorts before the idle ones', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  const scanned = { scannedAt: '10:00', sessions: [session('Fatto.', { name: 'quiet', sessionId: 'a', ageMinutes: 1 }), session('Aspetto la fine del build.', { name: 'build', sessionId: 'b', status: 'background', ageMinutes: 12 })] }
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('session.id', () => ({ value: 'self' }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: JSON.stringify(scanned), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('model.complete', () => ({ value: { isAnswered: true, text: '{"hasQuestion": false, "question": "", "summary": "Build in corso"}', usage: USAGE } }))

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'now' })
  await clock.advance(1)
  const metas = (await ui.findAll({ type: 'Text', text: /^ · (working|working in background|idle) · / })).map(one => one.text)

  expect(metas).toEqual([' · working in background · 12 min ago', ' · idle · 1 min ago'])
  await ui.unmount()
})

test('a session working in background with no message reads as working', async () => {
  expect(heuristicVerdict(session('', { status: 'background' })).summary).toBe('Working')
  expect(heuristicVerdict(session('')).summary).toBe('No recent message')
})
