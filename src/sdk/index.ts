export {
  checkBalancedDelimiters,
  extractReferenceCode,
  verifyCodeInBrowser,
  type CodeCheckItem,
  type CodeVerificationResult,
} from './code-runner'

export type SidecarExerciseType = 'multiple_choice' | 'multiple_select' | 'cloze' | 'written' | 'code'

export type ExerciseSnapshot = {
  type: SidecarExerciseType
  prompt: string
  options: string[]
  answer: string
  explanation: string
}

export type PracticeExercise = ExerciseSnapshot & {
  key: string
  promptHtml?: string
  optionHtmls?: string[]
  answerHtml?: string
  explanationHtml?: string
}

export type PracticeBank = {
  courseKey: string
  lessonKey?: string
  exercises: PracticeExercise[]
}

export type PracticeAttempt = {
  id: string
  courseKey: string
  lessonKey: string
  exerciseKey: string
  contentHash: string
  exerciseSnapshot: ExerciseSnapshot
  answer: string
  correct: number | null
  grading: 'deterministic' | 'unscored'
  feedback: string
  advisory: boolean
  ownerNote: string
  version: number
  createdAt: number
  updatedAt: number
}

export type HealthStatus = {
  ok: boolean
  apiVersion: number
  llmConfigured: boolean
}

export type CreateAttemptInput = {
  /** Client-generated UUID; repeating a create with the same id returns the stored attempt. */
  id?: string
  courseKey: string
  lessonKey?: string
  exerciseKey: string
  exerciseSnapshot: ExerciseSnapshot
  answer: string
  contentHash?: string
}

export type LocalDraft = {
  exerciseKey: string
  /** Attempt id reserved for this draft, so re-sending it never records it twice. */
  attemptId?: string
  answer: string
  updatedAt: number
  correct?: number | null
}

export type AssessmentItemDetail = {
  id: string
  position: number
  lessonKey: string
  exerciseKey: string
  contentHash: string
  type: SidecarExerciseType
  prompt: string
  options: string[]
  answer: string | null
  referenceAnswer?: string
  explanation?: string
  result: {
    grading: 'deterministic' | 'unscored'
    correct: number | null
    feedback: string
    advisory: boolean
    ownerNote: string
  } | null
}

export type AssessmentDetail = {
  id: string
  courseKey: string
  title: string
  mode: 'timed' | 'untimed'
  durationSeconds: number | null
  status: 'planned' | 'active' | 'submitted' | 'expired'
  createdAt: number
  startedAt: number | null
  deadlineAt: number | null
  submittedAt: number | null
  finalizedAt: number | null
  version: number
  serverNow: number
  remainingMs: number | null
  summary: {
    totalItems: number
    answeredCount: number
    deterministicTotal: number
    deterministicCorrect: number
    deterministicIncorrect: number
    unscoredCount: number
  }
  items: AssessmentItemDetail[]
}

export type CreateAssessmentInput = {
  courseKey: string
  title: string
  mode: 'timed' | 'untimed'
  durationSeconds?: number
  items: { lessonKey?: string; exerciseKey: string; exerciseSnapshot: ExerciseSnapshot }[]
}

export type TutorContextMeta = {
  lessonTitle: string
  lessonHash: string
  attemptIds: string[]
  contextLimit: number
  contextChars: number
  historyTurnsIncluded: number
  historyTurnsDropped: number
}

export type TutorTurn = {
  id: string
  role: 'user' | 'assistant'
  content: string
  lessonHash: string
  contextMeta: TutorContextMeta
  createdAt: number
}

export type TutorSession = {
  courseKey: string
  lessonKey: string
  contextLimit: number
  revision: number
  turns: TutorTurn[]
}

export type SendTutorInput = {
  courseKey: string
  lessonKey: string
  lessonTitle: string
  lessonText: string
  attemptIds?: string[]
  message: string
}

export type ReviewReason = 'incorrect' | 'has_takeaway_note' | 'due_for_recall' | 'scheduled'

export type ReviewQueueItem = {
  courseKey: string
  lessonKey: string
  exerciseKey: string
  attemptCount: number
  lastAttemptAt: number
  streak: number
  intervalDays: number
  dueAt: number
  isDue: boolean
  reason: ReviewReason
  latestAttempt: PracticeAttempt
}

export type ReviewQueueResponse = {
  courseKey: string | null
  serverNow: number
  summary: {
    totalTracked: number
    dueNow: number
    incorrectCount: number
    scheduledCount: number
  }
  items: ReviewQueueItem[]
}

export type RecallDigestResponse = {
  courseKey: string | null
  generatedAt: number
  stats: {
    totalAttempts: number
    distinctExercises: number
    correctCount: number
    incorrectCount: number
    unscoredCount: number
    weakSpotsCount: number
    takeawayNotesCount: number
    tutorTurnsCount: number
  }
  markdown: string
}

export class NoriApiError extends Error {
  status: number
  attempt?: PracticeAttempt
  assessment?: AssessmentDetail

  constructor(message: string, status: number, attempt?: PracticeAttempt, assessment?: AssessmentDetail) {
    super(message)
    this.name = 'NoriApiError'
    this.status = status
    this.attempt = attempt
    this.assessment = assessment
  }
}

/** The sidecar did not answer: network failure, timeout, or a gateway reporting it down. */
export class NoriNetworkError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'NoriNetworkError'
  }
}

export type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export type ConnectionState = 'checking' | 'online' | 'offline'

/** Timeout for ordinary sidecar calls. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000
/** Timeout for calls that wait on the LLM; the sidecar gives its provider 90 s, so wait a little longer. */
export const DEFAULT_LLM_REQUEST_TIMEOUT_MS = 100_000

export type NoriClientOptions = {
  baseUrl?: string
  fetchFn?: FetchFn
  timeoutMs?: number
  llmTimeoutMs?: number
  /** First retry delay while offline; doubles on each failure up to retryMaxMs. */
  retryBaseMs?: number
  retryMaxMs?: number
}

type RequestOptions = RequestInit & { timeoutMs?: number }

const GATEWAY_STATUSES = new Set([502, 503, 504])

/** How long a health result (llmConfigured) is reused before asking again. */
const HEALTH_TTL_MS = 60_000

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(text) as unknown
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function withCallerSignal<T>(shared: Promise<T>, signal?: AbortSignal | null): Promise<T> {
  if (!signal) return shared
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    shared.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (err) => {
        signal.removeEventListener('abort', onAbort)
        reject(err)
      },
    )
  })
}

/**
 * Client for the Nori sidecar. Every request has a timeout; identical GETs in
 * flight share one round-trip; and the client tracks whether the sidecar is
 * answering, retrying with backoff while it is not. Use getSharedNoriClient so
 * every island on a page shares one client.
 */
export class NoriClient {
  private readonly baseUrl: string
  private readonly fetchFn: FetchFn
  private readonly timeoutMs: number
  private readonly llmTimeoutMs: number
  private readonly retryBaseMs: number
  private readonly retryMaxMs: number
  private state: ConnectionState = 'checking'
  private readonly listeners = new Set<(state: ConnectionState) => void>()
  private readonly inflight = new Map<string, Promise<unknown>>()
  private healthStatus: HealthStatus | null = null
  private healthCheckedAt = 0
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private retryDelayMs: number

  constructor(options: NoriClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? '/api/nori/v1').replace(/\/+$/, '')
    this.fetchFn = options.fetchFn ?? ((input, init) => fetch(input, init))
    this.timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    this.llmTimeoutMs = options.llmTimeoutMs ?? DEFAULT_LLM_REQUEST_TIMEOUT_MS
    this.retryBaseMs = options.retryBaseMs ?? 1_000
    this.retryMaxMs = options.retryMaxMs ?? 30_000
    this.retryDelayMs = this.retryBaseMs
  }

  get connectionState(): ConnectionState {
    return this.state
  }

  /** Subscribe to connection state changes; returns an unsubscribe function. */
  subscribe = (listener: (state: ConnectionState) => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Stop the offline retry loop and drop listeners. */
  dispose(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
    this.listeners.clear()
  }

  private setState(next: ConnectionState): void {
    if (next === this.state) return
    this.state = next
    if (next === 'online') {
      if (this.retryTimer) clearTimeout(this.retryTimer)
      this.retryTimer = null
      this.retryDelayMs = this.retryBaseMs
    } else if (next === 'offline') {
      this.healthStatus = null
      this.scheduleRetry()
    }
    for (const listener of [...this.listeners]) listener(next)
  }

  private scheduleRetry(): void {
    if (this.retryTimer) return
    const delay = this.retryDelayMs
    this.retryDelayMs = Math.min(this.retryDelayMs * 2, this.retryMaxMs)
    this.retryTimer = setTimeout(async () => {
      this.retryTimer = null
      await this.health().catch(() => undefined)
      if (this.state === 'offline') this.scheduleRetry()
    }, delay)
  }

  private request<T>(path: string, init: RequestOptions = {}): Promise<T> {
    const method = (init.method ?? 'GET').toUpperCase()
    if (method !== 'GET') return this.send<T>(path, init)
    // Identical GETs share one round-trip; each caller can still cancel its own wait.
    let shared = this.inflight.get(path) as Promise<T> | undefined
    if (!shared) {
      shared = this.send<T>(path, { ...init, signal: undefined }).finally(() => this.inflight.delete(path))
      this.inflight.set(path, shared)
    }
    return withCallerSignal(shared, init.signal)
  }

  private async send<T>(path: string, init: RequestOptions): Promise<T> {
    const { timeoutMs = this.timeoutMs, signal: callerSignal, ...rest } = init
    const timeout = AbortSignal.timeout(timeoutMs)
    const signal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout
    let response: Response
    let text: string
    try {
      response = await this.fetchFn(`${this.baseUrl}${path}`, { ...rest, signal })
      // Reading the body stays under the timeout, so a stalled body ends as a network error.
      text = await response.text()
    } catch (err) {
      if (callerSignal?.aborted) throw err
      this.setState('offline')
      throw new NoriNetworkError(
        timeout.aborted
          ? `The Nori sidecar did not respond within ${Math.round(timeoutMs / 1000)} s.`
          : 'The Nori sidecar is unreachable.',
        { cause: err },
      )
    }
    const parsed = parseJsonObject(text)
    if (response.ok && parsed === null) {
      // Something other than the sidecar answered (an HTML fallback page, a truncated body).
      this.setState('offline')
      throw new NoriNetworkError(`The Nori sidecar returned an invalid response (${response.status}).`)
    }
    const data = parsed ?? {}
    if (!response.ok) {
      if (GATEWAY_STATUSES.has(response.status) && typeof data.error !== 'string') {
        this.setState('offline')
        throw new NoriNetworkError(`The Nori sidecar is unreachable (${response.status}).`)
      }
      this.setState('online')
      const message = typeof data.error === 'string' ? data.error : `Request failed (${response.status})`
      throw new NoriApiError(
        message,
        response.status,
        data.attempt as PracticeAttempt | undefined,
        data.assessment as AssessmentDetail | undefined,
      )
    }
    this.setState('online')
    return data as T
  }

  async health(signal?: AbortSignal): Promise<HealthStatus> {
    if (this.healthStatus && this.state === 'online' && Date.now() - this.healthCheckedAt < HEALTH_TTL_MS) {
      return this.healthStatus
    }
    const status = await this.request<HealthStatus>('/health', { method: 'GET', signal })
    this.healthStatus = status
    this.healthCheckedAt = Date.now()
    return status
  }

  async listPractice(
    params: { courseKey: string; lessonKey?: string; exerciseKey?: string },
    signal?: AbortSignal,
  ): Promise<{ courseKey: string; lessonKey: string | null; attempts: PracticeAttempt[] }> {
    const query = new URLSearchParams({ courseKey: params.courseKey })
    if (params.lessonKey !== undefined) query.set('lessonKey', params.lessonKey)
    if (params.exerciseKey !== undefined) query.set('exerciseKey', params.exerciseKey)
    return this.request(`/practice?${query.toString()}`, { method: 'GET', signal })
  }

  async createAttempt(input: CreateAttemptInput, signal?: AbortSignal): Promise<PracticeAttempt> {
    const data = await this.request<{ attempt: PracticeAttempt }>('/practice/attempts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
      signal,
    })
    return data.attempt
  }

  async requestFeedback(attemptId: string, expectedVersion?: number, signal?: AbortSignal): Promise<PracticeAttempt> {
    const body = expectedVersion === undefined ? {} : { expectedVersion }
    const data = await this.request<{ attempt: PracticeAttempt }>(`/practice/attempts/${encodeURIComponent(attemptId)}/feedback`, {
      method: 'POST',
      timeoutMs: this.llmTimeoutMs,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    })
    return data.attempt
  }

  async saveCorrection(attemptId: string, ownerNote: string, expectedVersion?: number, signal?: AbortSignal): Promise<PracticeAttempt> {
    const body = expectedVersion === undefined ? { ownerNote } : { ownerNote, expectedVersion }
    const data = await this.request<{ attempt: PracticeAttempt }>(`/practice/attempts/${encodeURIComponent(attemptId)}/correct`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    })
    return data.attempt
  }

  async listAssessments(courseKey: string, signal?: AbortSignal): Promise<{ courseKey: string; assessments: AssessmentDetail[] }> {
    const query = new URLSearchParams({ courseKey })
    return this.request(`/assessments?${query.toString()}`, { method: 'GET', signal })
  }

  async createAssessment(input: CreateAssessmentInput, signal?: AbortSignal): Promise<AssessmentDetail> {
    const data = await this.request<{ assessment: AssessmentDetail }>('/assessments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
      signal,
    })
    return data.assessment
  }

  async getAssessment(assessmentId: string, signal?: AbortSignal): Promise<AssessmentDetail> {
    const data = await this.request<{ assessment: AssessmentDetail }>(`/assessments/${encodeURIComponent(assessmentId)}`, {
      method: 'GET',
      signal,
    })
    return data.assessment
  }

  async startAssessment(assessmentId: string, signal?: AbortSignal): Promise<AssessmentDetail> {
    const data = await this.request<{ assessment: AssessmentDetail }>(`/assessments/${encodeURIComponent(assessmentId)}/start`, {
      method: 'POST',
      signal,
    })
    return data.assessment
  }

  async saveAssessmentAnswer(
    assessmentId: string,
    itemId: string,
    answer: string,
    expectedVersion?: number,
    signal?: AbortSignal,
    /** keepalive lets the save finish while the page unloads. */
    options: { keepalive?: boolean } = {},
  ): Promise<AssessmentDetail> {
    const body = expectedVersion === undefined ? { itemId, answer } : { itemId, answer, expectedVersion }
    const data = await this.request<{ assessment: AssessmentDetail }>(`/assessments/${encodeURIComponent(assessmentId)}/answers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
      keepalive: options.keepalive,
    })
    return data.assessment
  }

  async submitAssessment(assessmentId: string, expectedVersion?: number, signal?: AbortSignal): Promise<AssessmentDetail> {
    const body = expectedVersion === undefined ? {} : { expectedVersion }
    const data = await this.request<{ assessment: AssessmentDetail }>(`/assessments/${encodeURIComponent(assessmentId)}/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    })
    return data.assessment
  }

  async requestAssessmentFeedback(assessmentId: string, itemId: string, expectedVersion?: number, signal?: AbortSignal): Promise<AssessmentDetail> {
    const body = expectedVersion === undefined ? { itemId } : { itemId, expectedVersion }
    const data = await this.request<{ assessment: AssessmentDetail }>(`/assessments/${encodeURIComponent(assessmentId)}/feedback`, {
      method: 'POST',
      timeoutMs: this.llmTimeoutMs,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    })
    return data.assessment
  }

  async saveAssessmentCorrection(
    assessmentId: string,
    itemId: string,
    ownerNote: string,
    expectedVersion?: number,
    signal?: AbortSignal,
  ): Promise<AssessmentDetail> {
    const body = expectedVersion === undefined ? { itemId, ownerNote } : { itemId, ownerNote, expectedVersion }
    const data = await this.request<{ assessment: AssessmentDetail }>(`/assessments/${encodeURIComponent(assessmentId)}/correct`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    })
    return data.assessment
  }

  async getTutor(courseKey: string, lessonKey: string, signal?: AbortSignal): Promise<TutorSession> {
    const query = new URLSearchParams({ courseKey, lessonKey })
    return this.request(`/tutor?${query.toString()}`, { method: 'GET', signal })
  }

  async sendTutorMessage(
    input: SendTutorInput,
    signal?: AbortSignal,
  ): Promise<{ courseKey: string; lessonKey: string; revision: number; context: TutorContextMeta; turns: TutorTurn[] }> {
    return this.request('/tutor', {
      method: 'POST',
      timeoutMs: this.llmTimeoutMs,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
      signal,
    })
  }

  async getReviewQueue(
    params: { courseKey?: string; onlyDue?: boolean } = {},
    signal?: AbortSignal,
  ): Promise<ReviewQueueResponse> {
    const query = new URLSearchParams()
    if (params.courseKey) query.set('courseKey', params.courseKey)
    if (params.onlyDue) query.set('onlyDue', '1')
    const qs = query.toString()
    return this.request(`/review${qs ? `?${qs}` : ''}`, { method: 'GET', signal })
  }

  async getRecallDigest(
    params: { courseKey?: string } = {},
    signal?: AbortSignal,
  ): Promise<RecallDigestResponse> {
    const query = new URLSearchParams()
    if (params.courseKey) query.set('courseKey', params.courseKey)
    const qs = query.toString()
    return this.request(`/digest${qs ? `?${qs}` : ''}`, { method: 'GET', signal })
  }
}

const sharedClients = new Map<string, NoriClient>()

/** One client per sidecar base URL for the whole page, so islands share connection state and in-flight requests. */
export function getSharedNoriClient(baseUrl = '/api/nori/v1'): NoriClient {
  const key = baseUrl.replace(/\/+$/, '')
  let client = sharedClients.get(key)
  if (!client) {
    client = new NoriClient({ baseUrl: key })
    sharedClients.set(key, client)
  }
  return client
}

/** Detail of the `nori:practice-updated` window event; `attempts` carries the new or changed attempts. */
export type PracticeUpdatedDetail = {
  courseKey: string
  lessonKey: string
  attempts?: PracticeAttempt[]
}

/** Insert or replace attempts by id, keeping existing order. */
export function mergeAttempts(prev: PracticeAttempt[], incoming: PracticeAttempt[]): PracticeAttempt[] {
  const next = [...prev]
  for (const attempt of incoming) {
    const idx = next.findIndex((item) => item.id === attempt.id)
    if (idx === -1) next.push(attempt)
    else next[idx] = attempt
  }
  return next
}

export function isDeterministicExercise(type: SidecarExerciseType): boolean {
  return type === 'multiple_choice' || type === 'multiple_select' || type === 'cloze'
}

export function normalizeSnapshot(snapshot: ExerciseSnapshot): ExerciseSnapshot {
  return {
    type: snapshot.type,
    prompt: snapshot.prompt.trim(),
    options: snapshot.type === 'multiple_choice' || snapshot.type === 'multiple_select' ? [...snapshot.options] : [],
    answer: snapshot.type === 'multiple_choice' ? snapshot.answer : snapshot.answer.trim(),
    explanation: snapshot.explanation.trim(),
  }
}

export async function computeContentHash(snapshot: ExerciseSnapshot): Promise<string> {
  const normalized = normalizeSnapshot(snapshot)
  const canonical = JSON.stringify({
    type: normalized.type,
    prompt: normalized.prompt,
    options: normalized.options,
    answer: normalized.answer,
    explanation: normalized.explanation,
  })
  const encoded = new TextEncoder().encode(canonical)
  const digest = await crypto.subtle.digest('SHA-256', encoded)
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

export function checkMultipleChoice(exercise: ExerciseSnapshot, answer: string): boolean {
  return exercise.type === 'multiple_choice' && exercise.options.includes(answer) && answer === exercise.answer
}

export function checkMultipleSelect(exercise: ExerciseSnapshot, answer: string): boolean {
  if (exercise.type !== 'multiple_select') return false
  const picked = Array.from(
    new Set(
      answer
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  )
  const expected = Array.from(
    new Set(
      exercise.answer
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  )
  return (
    picked.length > 0 &&
    picked.length === expected.length &&
    picked.every((opt) => exercise.options.includes(opt) && expected.includes(opt))
  )
}

export function checkCloze(exercise: ExerciseSnapshot, answer: string): boolean {
  if (exercise.type !== 'cloze') return false
  const norm = (s: string) => s.trim().replace(/^`+|`+$/g, '').replace(/\s+/g, ' ').toLowerCase()
  const learner = norm(answer)
  if (!learner) return false
  const accepted = exercise.answer.split('|').map(norm).filter(Boolean)
  return accepted.includes(learner)
}

export function checkDeterministicExercise(exercise: ExerciseSnapshot, answer: string): boolean {
  if (exercise.type === 'multiple_choice') return checkMultipleChoice(exercise, answer)
  if (exercise.type === 'multiple_select') return checkMultipleSelect(exercise, answer)
  if (exercise.type === 'cloze') return checkCloze(exercise, answer)
  return false
}

function draftStorageKey(courseKey: string, lessonKey: string): string {
  return `nori:drafts:${courseKey}:${lessonKey}`
}

export function loadLocalDrafts(courseKey: string, lessonKey = ''): Record<string, LocalDraft> {
  try {
    if (typeof globalThis.localStorage === 'undefined') return {}
    const raw = globalThis.localStorage.getItem(draftStorageKey(courseKey, lessonKey))
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed as Record<string, LocalDraft>
  } catch {
    return {}
  }
}

export function saveLocalDraft(courseKey: string, lessonKey: string, draft: LocalDraft): Record<string, LocalDraft> {
  const next = { ...loadLocalDrafts(courseKey, lessonKey), [draft.exerciseKey]: draft }
  try {
    if (typeof globalThis.localStorage !== 'undefined') {
      globalThis.localStorage.setItem(draftStorageKey(courseKey, lessonKey), JSON.stringify(next))
    }
  } catch {
    // Ignore storage quota or private-mode errors
  }
  return next
}

/** Remove a draft; with attemptId, only if the stored draft is still that attempt (not a newer one). */
export function removeLocalDraft(
  courseKey: string,
  lessonKey: string,
  exerciseKey: string,
  attemptId?: string,
): Record<string, LocalDraft> {
  const next = { ...loadLocalDrafts(courseKey, lessonKey) }
  const stored = next[exerciseKey]
  if (attemptId !== undefined && stored?.attemptId !== undefined && stored.attemptId !== attemptId) return next
  delete next[exerciseKey]
  try {
    if (typeof globalThis.localStorage !== 'undefined') {
      globalThis.localStorage.setItem(draftStorageKey(courseKey, lessonKey), JSON.stringify(next))
    }
  } catch {
    // Ignore storage quota or private-mode errors
  }
  return next
}

export type ResendDraftsResult = {
  sent: PracticeAttempt[]
  /** Server rejections by exercise key; those drafts stay stored. */
  failed: Record<string, string>
  /** Drafts still stored after the run. */
  drafts: Record<string, LocalDraft>
}

const resendsInFlight = new Map<string, Promise<ResendDraftsResult>>()

/**
 * Send stored offline drafts for one lesson to the sidecar, removing each one
 * the sidecar records. Stops at the first network failure (the client goes
 * offline and will retry). Concurrent calls for the same lesson share one run,
 * so a draft is never sent twice.
 */
export function resendLocalDrafts(input: {
  client: NoriClient
  courseKey: string
  lessonKey?: string
  exercises: PracticeExercise[]
}): Promise<ResendDraftsResult> {
  const lessonKey = input.lessonKey ?? ''
  const key = draftStorageKey(input.courseKey, lessonKey)
  const running = resendsInFlight.get(key)
  if (running) return running
  const run = (async (): Promise<ResendDraftsResult> => {
    const sent: PracticeAttempt[] = []
    const failed: Record<string, string> = {}
    for (const stored of Object.values(loadLocalDrafts(input.courseKey, lessonKey))) {
      const exercise = input.exercises.find((ex) => ex.key === stored.exerciseKey)
      if (!exercise) continue
      // Reserve the id before sending, so a lost response or another tab re-sends the same attempt.
      const draft = stored.attemptId ? stored : { ...stored, attemptId: crypto.randomUUID() }
      if (draft !== stored) saveLocalDraft(input.courseKey, lessonKey, draft)
      const exerciseSnapshot: ExerciseSnapshot = {
        type: exercise.type,
        prompt: exercise.prompt,
        options: exercise.options,
        answer: exercise.answer,
        explanation: exercise.explanation,
      }
      try {
        const attempt = await input.client.createAttempt({
          id: draft.attemptId,
          courseKey: input.courseKey,
          lessonKey,
          exerciseKey: exercise.key,
          contentHash: await computeContentHash(exerciseSnapshot),
          exerciseSnapshot,
          answer: draft.answer,
        })
        sent.push(attempt)
        removeLocalDraft(input.courseKey, lessonKey, draft.exerciseKey, draft.attemptId)
      } catch (err) {
        if (err instanceof NoriApiError) {
          failed[draft.exerciseKey] = err.message
          continue
        }
        break
      }
    }
    return { sent, failed, drafts: loadLocalDrafts(input.courseKey, lessonKey) }
  })().finally(() => resendsInFlight.delete(key))
  resendsInFlight.set(key, run)
  return run
}

export function formatAttemptsAsMarkdown(input: {
  courseKey: string
  lessonKey?: string
  attempts: PracticeAttempt[]
  drafts?: Record<string, LocalDraft>
}): string {
  const lines: string[] = []
  const heading = input.lessonKey ? `${input.courseKey} — ${input.lessonKey}` : input.courseKey
  lines.push(`## practice attempts: ${heading}`, '')

  if (!input.attempts.length && (!input.drafts || !Object.keys(input.drafts).length)) {
    lines.push('No attempts recorded yet.')
    return lines.join('\n')
  }

  for (const attempt of input.attempts) {
    const date = new Date(attempt.createdAt).toISOString().slice(0, 16).replace('T', ' ')
    const status =
      attempt.grading === 'deterministic'
        ? attempt.correct === 1
          ? 'correct'
          : 'incorrect'
        : 'unscored'
    lines.push(`### ${attempt.exerciseKey} (${date}, ${status})`, '')
    lines.push(`**Prompt:** ${attempt.exerciseSnapshot.prompt}`, '')
    lines.push('**Attempt:**', '', attempt.answer, '')
    if (attempt.feedback) {
      lines.push('**Advisory feedback (AI):**', '', attempt.feedback, '')
    }
    if (attempt.ownerNote) {
      lines.push('**Correction / takeaway:**', '', attempt.ownerNote, '')
    }
  }

  if (input.drafts) {
    const unsent = Object.values(input.drafts)
    if (unsent.length) {
      lines.push('### unsent local drafts', '')
      for (const draft of unsent) {
        const date = new Date(draft.updatedAt).toISOString().slice(0, 16).replace('T', ' ')
        lines.push(`- **${draft.exerciseKey}** (${date}): ${draft.answer}`)
      }
      lines.push('')
    }
  }

  return lines.join('\n').trimEnd() + '\n'
}

export function resolveNoriIslandProps(
  componentName: string,
  rawProps: Record<string, unknown>,
  sourceRelPath = '',
): Record<string, unknown> {
  const props = { ...rawProps }
  const normalizedPath = sourceRelPath.split('\\').join('/')
  const lessonMatch = normalizedPath.match(/^courses\/([^/]+\/[^/]+)\/lessons\/([^/]+)\.md$/)
  const courseMatch = normalizedPath.match(/^courses\/([^/]+\/[^/]+)\//)
  const inferredCourse = lessonMatch?.[1] ?? courseMatch?.[1]
  const inferredLesson = lessonMatch?.[2]

  if (typeof props.courseKey !== 'string' && inferredCourse) props.courseKey = inferredCourse
  if (
    typeof props.lessonKey !== 'string' &&
    inferredLesson &&
    componentName !== 'NoriAssessment' &&
    componentName !== 'NoriReviewQueue'
  ) {
    props.lessonKey = inferredLesson
  }
  const cKey = typeof props.courseKey === 'string' ? props.courseKey : undefined
  const lKey = typeof props.lessonKey === 'string' ? props.lessonKey : undefined
  if (componentName === 'NoriPractice' && typeof props.bank !== 'string' && cKey && lKey) {
    props.bank = `/practice-banks/${cKey}/${lKey}.json`
  }
  if (componentName === 'NoriAssessment' && typeof props.bank !== 'string' && cKey) {
    props.bank = `/practice-banks/${cKey}/${lKey || 'all'}.json`
  }
  if (componentName === 'NoriTutor' && typeof props.lessonAsset !== 'string' && cKey && lKey) {
    props.lessonAsset = `/lesson-context/${cKey}/${lKey}.json`
  }
  return props
}

