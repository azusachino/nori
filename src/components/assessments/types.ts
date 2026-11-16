export type AssessmentMode = 'timed' | 'untimed'
export type AssessmentStatus = 'planned' | 'active' | 'submitted' | 'expired'

export type AssessmentScope = {
  modules: { id: string; title: string; lessons: number; exercises: number }[]
  lessonCount: number
  exerciseCount: number
}

export type AssessmentSummaryData = {
  id: string
  courseId: string
  title: string
  mode: AssessmentMode
  durationSeconds: number | null
  status: AssessmentStatus
  createdAt: number
  startedAt: number | null
  deadlineAt: number | null
  submittedAt: number | null
  finalizedAt: number | null
  version: number
  serverNow: number
  remainingMs: number | null
  scope: AssessmentScope
  summary: {
    itemCount: number
    answeredCount: number
    deterministicTotal?: number
    deterministicCorrect?: number
    deterministicIncorrect?: number
    unscoredCount?: number
  }
}

export type AssessmentItemData = {
  id: string
  position: number
  moduleId: string
  moduleTitle: string
  exerciseId: string
  type: 'multiple_choice' | 'written' | 'code'
  prompt: string
  options: string[]
  savedAnswer?: string
  answer?: string
  explanation?: string
  result?: {
    answer: string | null
    correct: number | null
    grading: 'deterministic' | 'unscored'
    feedback: string
    advisory: boolean
    ownerNote: string
  } | null
}

export type AssessmentDetailData = AssessmentSummaryData & {
  items: AssessmentItemData[]
}
