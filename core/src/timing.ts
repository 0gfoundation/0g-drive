// Where an action's time goes before its wallet prompt, for the Activity
// log ("Asked your wallet to approve, 0.3 s after your click (chain check
// 0.3 s)"). The app starts a fresh record when the user acts; each step
// adds the time it took. Actions normally run one at a time; overlapping
// ones just share a record.

export type TimingStep = 'chain' | 'listings' | 'indexing' | 'preparing' | 'price'

let steps: Partial<Record<TimingStep, number>> = {}

export function startActionTiming(): void {
  steps = {}
}

export function addActionTiming(step: TimingStep, ms: number): void {
  steps[step] = (steps[step] ?? 0) + ms
}

/** Milliseconds per step since startActionTiming. */
export function actionTiming(): Partial<Record<TimingStep, number>> {
  return { ...steps }
}

/** `p`, its time added to `step`. */
export async function timed<T>(step: TimingStep, p: Promise<T>): Promise<T> {
  const start = performance.now()
  try {
    return await p
  } finally {
    addActionTiming(step, performance.now() - start)
  }
}
