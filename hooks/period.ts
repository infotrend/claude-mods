export const DEFAULT_MINUTES = 2
export const MIN_MINUTES = 1
export const MAX_MINUTES = 120
export const MINUTE_CHOICES: readonly number[] = [1, 2, 3, 5, 10, 15, 30, 60]

const MINUTES_PATTERN = /^(?:ogni|every)?\s*(\d{1,3})\s*(?:m|min|minuti|minutes)?$/i

function isValidMinutes(value: number): boolean {
  return Number.isInteger(value) && value >= MIN_MINUTES && value <= MAX_MINUTES
}

// Reads "5", "ogni 5", "every 5 min": a whole number of minutes in range, else undefined.
export function parseMinutes(text: string): number | undefined {
  const digits = MINUTES_PATTERN.exec(text.trim())?.[1]
  if (digits === undefined) {
    return undefined
  }
  const minutes = Number(digits)

  return isValidMinutes(minutes) ? minutes : undefined
}

// A value read back from the store: kept when valid, the default otherwise.
export function storedMinutes(value: unknown): number {
  return typeof value === 'number' && isValidMinutes(value) ? value : DEFAULT_MINUTES
}

// Seconds as m:ss, minutes unbounded: 90 → "1:30", 7200 → "120:00".
export function countdownLabel(seconds: number): string {
  const whole = Math.max(0, Math.ceil(seconds))

  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`
}

// The first preset after the current period, back to the shortest after the last.
export function nextMinutes(current: number): number {
  return MINUTE_CHOICES.find(value => value > current) ?? MINUTE_CHOICES[0] ?? DEFAULT_MINUTES
}

// The picker's options, the current value included when it is not a preset.
export function minuteOptions(current: number): { value: string, label: string }[] {
  const values = MINUTE_CHOICES.includes(current) ? MINUTE_CHOICES : [...MINUTE_CHOICES, current].sort((a, b) => a - b)

  return values.map(value => ({ value: String(value), label: `${value} min` }))
}
