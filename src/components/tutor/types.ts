export type TutorAttemptView = {
  id: string
  exerciseId: string | null
  exerciseIndex: number
  prompt: string
  answer: string
  feedback: string
  correct: number | null
  ownerNote: string
}

export type TutorHistoryTurn = {
  id: string
  role: 'user' | 'assistant'
  content: string
  createdAt: number
}

export type TutorContext = {
  moduleId: string
  moduleTitle: string
  lessonIndex: number
  lessonTitle: string
  lessonText: string
  attempts: TutorAttemptView[]
  sourceIds: string[]
  contextLimit: number
  contextChars: number
  historyTurnsIncluded: number
  historyTurnsDropped: number
  history: TutorHistoryTurn[]
  conversationRevision: number
}

export type TutorTurn = {
  id: string
  role: 'user' | 'assistant'
  content: string
  createdAt: number
  context: TutorContext
}

export type TutorProposal = {
  id: string
  content: string
  createdAt: number
  draft: { id: string; position: number; contentHash: string } | null
}

export type TutorHistoryResponse = {
  moduleId: string
  lessonIndex: number
  lessonTitle: string
  contextLimit: number
  revision: number
  turns: TutorTurn[]
  proposals: TutorProposal[]
}

export type TutorAskResponse = {
  reply: string
  context: TutorContext
  turns: [TutorTurn, TutorTurn]
  proposal: TutorProposal | null
  conversationRevision: number
}
