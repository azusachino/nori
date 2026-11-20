import { NoriApiError, type AssessmentDetail, type NoriClient } from './index'

/** Format a countdown as mm:ss, rounding up so "00:00" shows only once time is up. */
export function formatCountdown(remainingMs: number): string {
  const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

/**
 * Local-clock deadline for a timed assessment, from the server's remainingMs at
 * the moment the detail arrived, so client/server clock skew does not matter.
 */
export function localDeadline(detail: AssessmentDetail, receivedAt = Date.now()): number | null {
  return detail.status === 'active' && detail.remainingMs !== null ? receivedAt + detail.remainingMs : null
}

/**
 * Fetch an assessment fresh and compute its local deadline at receipt. A
 * detail from an earlier list call has a stale remainingMs, so never start a
 * countdown from one.
 */
export async function openAssessment(
  client: NoriClient,
  assessmentId: string,
  now: () => number = Date.now,
): Promise<{ detail: AssessmentDetail; deadline: number | null }> {
  const detail = await client.getAssessment(assessmentId)
  return { detail, deadline: localDeadline(detail, now()) }
}

/**
 * Tick once per interval until the deadline, then call onExpire once.
 * Calls onTick immediately. Returns a stop function.
 */
export function createCountdown(options: {
  deadline: number
  onTick: (remainingMs: number) => void
  onExpire: () => void
  intervalMs?: number
  now?: () => number
}): () => void {
  const now = options.now ?? Date.now
  let timer: ReturnType<typeof setInterval> | null = null
  const stop = () => {
    if (timer) clearInterval(timer)
    timer = null
  }
  const tick = () => {
    const remaining = Math.max(0, options.deadline - now())
    options.onTick(remaining)
    if (remaining === 0) {
      stop()
      options.onExpire()
      return false
    }
    return true
  }
  if (tick()) timer = setInterval(tick, options.intervalMs ?? 1000)
  return stop
}

export type AnswerSaveState = 'pending' | 'saving' | 'saved' | 'error'

/**
 * Auto-saves assessment answers. Each change is debounced, saves run one at a
 * time against the latest assessment version, and flush() waits until every
 * changed answer is on the server, so submit() always grades every answer.
 */
export class AssessmentAnswerSync {
  private detail: AssessmentDetail
  private readonly client: NoriClient
  private readonly debounceMs: number
  private readonly onUpdate: (detail: AssessmentDetail) => void
  private readonly onStateChange: (states: Record<string, AnswerSaveState>) => void
  private readonly dirty = new Map<string, string>()
  private readonly states: Record<string, AnswerSaveState> = {}
  private timer: ReturnType<typeof setTimeout> | null = null
  private queue: Promise<void> = Promise.resolve()

  constructor(options: {
    client: NoriClient
    assessment: AssessmentDetail
    debounceMs?: number
    onUpdate?: (detail: AssessmentDetail) => void
    onStateChange?: (states: Record<string, AnswerSaveState>) => void
  }) {
    this.client = options.client
    this.detail = options.assessment
    this.debounceMs = options.debounceMs ?? 800
    this.onUpdate = options.onUpdate ?? (() => undefined)
    this.onStateChange = options.onStateChange ?? (() => undefined)
    for (const item of this.detail.items) {
      if (item.answer !== null) this.states[item.id] = 'saved'
    }
  }

  get assessment(): AssessmentDetail {
    return this.detail
  }

  get hasUnsaved(): boolean {
    return this.dirty.size > 0
  }

  setAnswer(itemId: string, answer: string): void {
    this.dirty.set(itemId, answer)
    this.setItemState(itemId, 'pending')
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      this.flush().catch(() => undefined)
    }, this.debounceMs)
  }

  /** Save every changed answer now. Rejects if any answer could not be saved. */
  flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    const run = this.queue.then(() => this.saveDirty())
    this.queue = run.catch(() => undefined)
    return run
  }

  /** Flush pending answers, then submit with the version that includes them. */
  async submit(): Promise<AssessmentDetail> {
    await this.flush()
    try {
      return this.accept(await this.client.submitAssessment(this.detail.id, this.detail.version))
    } catch (err) {
      if (!(err instanceof NoriApiError) || !err.assessment) throw err
      this.accept(err.assessment)
      // Version moved under us while still active: retry once with the server's version.
      if (err.status !== 409 || err.assessment.status !== 'active') throw err
      return this.accept(await this.client.submitAssessment(this.detail.id, this.detail.version))
    }
  }

  /**
   * Best-effort save of unsaved answers while the page unloads. Uses keepalive
   * requests without expectedVersion, since there is no time to wait for each
   * save to return a new version.
   */
  flushOnPageHide(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    for (const [itemId, answer] of this.dirty) {
      this.client
        .saveAssessmentAnswer(this.detail.id, itemId, answer, undefined, undefined, { keepalive: true })
        .catch(() => undefined)
    }
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  private accept(detail: AssessmentDetail): AssessmentDetail {
    this.detail = detail
    this.onUpdate(detail)
    return detail
  }

  private setItemState(itemId: string, state: AnswerSaveState): void {
    this.states[itemId] = state
    this.onStateChange({ ...this.states })
  }

  private async saveDirty(): Promise<void> {
    for (const [itemId, answer] of [...this.dirty]) {
      if (this.dirty.get(itemId) !== answer) continue
      this.setItemState(itemId, 'saving')
      try {
        await this.saveOne(itemId, answer)
      } catch (err) {
        this.setItemState(itemId, 'error')
        throw err
      }
      // A newer edit made while saving stays dirty for the next flush.
      if (this.dirty.get(itemId) === answer) {
        this.dirty.delete(itemId)
        this.setItemState(itemId, 'saved')
      } else {
        this.setItemState(itemId, 'pending')
      }
    }
    if (this.dirty.size > 0) return this.saveDirty()
  }

  private async saveOne(itemId: string, answer: string): Promise<void> {
    try {
      this.accept(await this.client.saveAssessmentAnswer(this.detail.id, itemId, answer, this.detail.version))
    } catch (err) {
      if (!(err instanceof NoriApiError) || !err.assessment) throw err
      this.accept(err.assessment)
      // Version moved under us while still active: retry once with the server's version.
      if (err.status !== 409 || err.assessment.status !== 'active') throw err
      this.accept(await this.client.saveAssessmentAnswer(this.detail.id, itemId, answer, this.detail.version))
    }
  }
}
