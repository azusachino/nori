export type SidecarExerciseType = 'multiple_choice' | 'written' | 'code'

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
  courseKey: string
  lessonKey?: string
  exerciseKey: string
  exerciseSnapshot: ExerciseSnapshot
  answer: string
  contentHash?: string
}

export type LocalDraft = {
  exerciseKey: string
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

export type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export type NoriClientOptions = {
  baseUrl?: string
  fetchFn?: FetchFn
}

export class NoriClient {
  private readonly baseUrl: string
  private readonly fetchFn: FetchFn

  constructor(options: NoriClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? '/api/nori/v1').replace(/\/+$/, '')
    this.fetchFn = options.fetchFn ?? ((input, init) => fetch(input, init))
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await this.fetchFn(`${this.baseUrl}${path}`, init)
    const data = (await response.json().catch(() => ({}))) as Record<string, unknown>
    if (!response.ok) {
      const message = typeof data.error === 'string' ? data.error : `Request failed (${response.status})`
      throw new NoriApiError(
        message,
        response.status,
        data.attempt as PracticeAttempt | undefined,
        data.assessment as AssessmentDetail | undefined,
      )
    }
    return data as T
  }

  async health(signal?: AbortSignal): Promise<HealthStatus> {
    return this.request<HealthStatus>('/health', { method: 'GET', signal })
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
  ): Promise<AssessmentDetail> {
    const body = expectedVersion === undefined ? { itemId, answer } : { itemId, answer, expectedVersion }
    const data = await this.request<{ assessment: AssessmentDetail }>(`/assessments/${encodeURIComponent(assessmentId)}/answers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
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
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
      signal,
    })
  }
}

export function normalizeSnapshot(snapshot: ExerciseSnapshot): ExerciseSnapshot {
  return {
    type: snapshot.type,
    prompt: snapshot.prompt.trim(),
    options: snapshot.type === 'multiple_choice' ? [...snapshot.options] : [],
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

export function removeLocalDraft(courseKey: string, lessonKey: string, exerciseKey: string): Record<string, LocalDraft> {
  const next = { ...loadLocalDrafts(courseKey, lessonKey) }
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
  if (typeof props.lessonKey !== 'string' && inferredLesson && componentName !== 'NoriAssessment') {
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

