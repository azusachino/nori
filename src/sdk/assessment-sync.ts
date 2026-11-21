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
 * Fetch an assessment fresh and compute its local deadline. The deadline is
 * anchored at send time, so network latency can only make the local clock
 * expire early, never late. A detail from an earlier list call has a stale
 * remainingMs, so never start a countdown from one.
 */
export async function openAssessment(
  client: NoriClient,
  assessmentId: string,
  now: () => number = Date.now,
): Promise<{ detail: AssessmentDetail; deadline: number | null }> {
  const sentAt = now()
  const detail = await client.getAssessment(assessmentId)
  return { detail, deadline: localDeadline(detail, sentAt) }
}

type Schedule = (fn: () => void, ms: number) => () => void

const defaultSchedule: Schedule = (fn, ms) => {
  const timer = setTimeout(fn, ms)
  return () => clearTimeout(timer)
}

/**
 * Tick on each whole-second boundary of the remaining time until the deadline,
 * then call onExpire once, exactly at the deadline. Calls onTick immediately.
 * Returns a stop function.
 */
export function createCountdown(options: {
  deadline: number
  onTick: (remainingMs: number) => void
  onExpire: () => void
  now?: () => number
  schedule?: Schedule
}): () => void {
  const now = options.now ?? Date.now
  const schedule = options.schedule ?? defaultSchedule
  let cancel: (() => void) | null = null
  let stopped = false
  const tick = () => {
    if (stopped) return
    const remaining = Math.max(0, options.deadline - now())
    options.onTick(remaining)
    if (remaining === 0) {
      stopped = true
      options.onExpire()
      return
    }
    // Wake when the ceil-rounded second changes: 2500 ms left -> wake at 2000 ms left.
    cancel = schedule(tick, ((remaining - 1) % 1000) + 1)
  }
  tick()
  return () => {
    stopped = true
    cancel?.()
  }
}

/** Server limit on an answer's length (sidecar-activities.ts). */
export const MAX_ANSWER_CHARS = 20_000

/** Browsers cap keepalive request bodies at 64 KB in total; stay under it. */
const KEEPALIVE_BUDGET_BYTES = 60_000

/**
 * pending: changed, not yet sent. saving: in flight. saved: on the server.
 * error: could not reach the sidecar; retried on the next flush.
 * rejected: the sidecar refused this answer (see errors); not retried until it changes.
 */
export type AnswerSaveState = 'pending' | 'saving' | 'saved' | 'error' | 'rejected'

/** The assessment is no longer active (submitted or expired); nothing more can be saved. */
class AssessmentClosedError extends Error {}

/**
 * Auto-saves assessment answers. Each change is debounced; saves run one at a
 * time against the latest assessment version, and each item is saved on its
 * own, so an answer the sidecar rejects never holds back the others. flush()
 * saves everything it can; submit() then refuses only if an answer is still
 * unsaved, naming the item.
 */
export class AssessmentAnswerSync {
  private detail: AssessmentDetail
  private readonly client: NoriClient
  private readonly debounceMs: number
  private readonly onUpdate: (detail: AssessmentDetail) => void
  private readonly onStateChange: (states: Record<string, AnswerSaveState>, errors: Record<string, string>) => void
  private readonly dirty = new Map<string, string>()
  private readonly states: Record<string, AnswerSaveState> = {}
  private readonly errors: Record<string, string> = {}
  private timer: ReturnType<typeof setTimeout> | null = null
  private queue: Promise<void> = Promise.resolve()
  private disposed = false
  private closed = false
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private readonly retryBaseMs: number
  private readonly retryMaxMs: number
  private retryDelayMs: number

  constructor(options: {
    client: NoriClient
    assessment: AssessmentDetail
    debounceMs?: number
    /**
     * Answers the learner typed earlier (by item id). Any that differ from the
     * server's start out unsaved, so an answer whose save failed before the
     * assessment was closed is saved when it is opened again.
     */
    localAnswers?: Record<string, string>
    /** First delay before retrying answers that hit a network or server error; doubles up to retryMaxMs. */
    retryBaseMs?: number
    retryMaxMs?: number
    onUpdate?: (detail: AssessmentDetail) => void
    onStateChange?: (states: Record<string, AnswerSaveState>, errors: Record<string, string>) => void
  }) {
    this.client = options.client
    this.detail = options.assessment
    this.debounceMs = options.debounceMs ?? 800
    this.retryBaseMs = options.retryBaseMs ?? 2_000
    this.retryMaxMs = options.retryMaxMs ?? 30_000
    this.retryDelayMs = this.retryBaseMs
    this.onUpdate = options.onUpdate ?? (() => undefined)
    this.onStateChange = options.onStateChange ?? (() => undefined)
    for (const item of this.detail.items) {
      if (item.answer !== null) this.states[item.id] = 'saved'
    }
    const unsaved = this.detail.items.filter(
      (item) => options.localAnswers?.[item.id] !== undefined && options.localAnswers[item.id] !== (item.answer ?? ''),
    )
    if (unsaved.length && this.detail.status === 'active') {
      for (const item of unsaved) this.setAnswer(item.id, options.localAnswers![item.id]!)
    }
  }

  get assessment(): AssessmentDetail {
    return this.detail
  }

  /** True while any answer is not on the server, including rejected ones. */
  get hasUnsaved(): boolean {
    return this.dirty.size > 0
  }

  setAnswer(itemId: string, answer: string): void {
    this.dirty.set(itemId, answer)
    delete this.errors[itemId]
    this.setItemState(itemId, 'pending')
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      this.flush().catch(() => undefined)
    }, this.debounceMs)
  }

  /**
   * Save every changed answer that can be saved. Rejects on a network failure
   * (the rest stay pending for the next flush) or when the assessment closed.
   * Rejected answers do not make flush() fail; submit() reports them.
   */
  flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    const run = this.queue.then(() => this.saveDirty())
    this.queue = run.catch(() => undefined).then(() => this.scheduleRetry())
    return run
  }

  /** Save what can be saved, then submit, or refuse naming the answers that could not be saved. */
  async submit(): Promise<AssessmentDetail> {
    await this.flush()
    if (this.dirty.size > 0) {
      const lines = this.detail.items
        .filter((item) => this.dirty.has(item.id))
        .map((item) => `#${item.position + 1}: ${this.errors[item.id] ?? 'not saved yet'}`)
      throw new Error(`Some answers could not be saved, so the assessment was not submitted. ${lines.join('; ')}`)
    }
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
   * Best-effort save of unsaved answers while the page unloads, as keepalive
   * requests without expectedVersion (there is no time to chain versions).
   * Smallest bodies go first within the keepalive budget; the rest are skipped
   * and stay unsaved locally.
   */
  flushOnPageHide(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    const encoder = new TextEncoder()
    const bodies = [...this.dirty]
      .filter(([itemId]) => this.states[itemId] !== 'rejected')
      .map(([itemId, answer]) => ({ itemId, answer, bytes: encoder.encode(JSON.stringify({ itemId, answer })).length }))
      .sort((a, b) => a.bytes - b.bytes)
    let budget = KEEPALIVE_BUDGET_BYTES
    for (const { itemId, answer, bytes } of bodies) {
      if (bytes > budget) break
      budget -= bytes
      this.client
        .saveAssessmentAnswer(this.detail.id, itemId, answer, undefined, undefined, { keepalive: true })
        .catch(() => undefined)
    }
  }

  /** Stop timers and callbacks; saves already in flight finish silently. */
  dispose(): void {
    this.disposed = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
  }

  /** Retry answers in the error state with backoff, so "will retry" stays true. */
  private scheduleRetry(): void {
    const failing = Object.entries(this.states).some(([itemId, state]) => state === 'error' && this.dirty.has(itemId))
    if (!failing) {
      this.retryDelayMs = this.retryBaseMs
      return
    }
    if (this.disposed || this.closed || this.retryTimer) return
    const delay = this.retryDelayMs
    this.retryDelayMs = Math.min(this.retryDelayMs * 2, this.retryMaxMs)
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      this.flush().catch(() => undefined)
    }, delay)
  }

  private accept(detail: AssessmentDetail): AssessmentDetail {
    this.detail = detail
    if (!this.disposed) this.onUpdate(detail)
    return detail
  }

  private setItemState(itemId: string, state: AnswerSaveState): void {
    this.states[itemId] = state
    if (!this.disposed) this.onStateChange({ ...this.states }, { ...this.errors })
  }

  private async saveDirty(): Promise<void> {
    // Values tried in this flush, so an item that failed is not retried in a loop.
    const tried = new Map<string, string>()
    for (;;) {
      const next = [...this.dirty].find(
        ([itemId, answer]) => tried.get(itemId) !== answer && this.states[itemId] !== 'rejected',
      )
      if (!next) return
      const [itemId, answer] = next
      tried.set(itemId, answer)
      this.setItemState(itemId, 'saving')
      try {
        await this.saveOne(itemId, answer)
      } catch (err) {
        if (err instanceof AssessmentClosedError) {
          this.closed = true
          this.setItemState(itemId, 'error')
          throw err
        }
        // A 409 that survived the version retry is a race, not a verdict on the answer: retry later.
        if (err instanceof NoriApiError && err.status >= 400 && err.status < 500 && err.status !== 409) {
          // The sidecar refused this answer; show why and move on to the others.
          if (this.dirty.get(itemId) === answer) {
            this.errors[itemId] = err.message
            this.setItemState(itemId, 'rejected')
          }
          continue
        }
        this.setItemState(itemId, this.dirty.get(itemId) === answer ? 'error' : 'pending')
        // A sidecar error (5xx, 409) is per item; a network failure stops this flush.
        if (err instanceof NoriApiError) continue
        throw err
      }
      // A newer edit made while saving stays dirty for the next pass.
      if (this.dirty.get(itemId) === answer) {
        this.dirty.delete(itemId)
        this.setItemState(itemId, 'saved')
      } else {
        this.setItemState(itemId, 'pending')
      }
    }
  }

  private async saveOne(itemId: string, answer: string): Promise<void> {
    try {
      this.accept(await this.client.saveAssessmentAnswer(this.detail.id, itemId, answer, this.detail.version))
    } catch (err) {
      if (!(err instanceof NoriApiError) || !err.assessment) throw err
      this.accept(err.assessment)
      if (err.assessment.status !== 'active') throw new AssessmentClosedError(err.message)
      // Version moved under us while still active: retry once with the server's version.
      if (err.status !== 409) throw err
      this.accept(await this.client.saveAssessmentAnswer(this.detail.id, itemId, answer, this.detail.version))
    }
  }
}
