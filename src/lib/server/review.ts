import { asc, eq } from 'drizzle-orm'
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite'
import { practiceAttempts, sidecarSchema, sidecarTutorLessons, sidecarTutorTurns } from './schema'
import type { ExerciseSnapshot, PracticeAttempt } from './sidecar'

type SidecarOrm = BunSQLiteDatabase<typeof sidecarSchema>

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

const DAY_MS = 86_400_000
const INTERVAL_SCHEDULE_DAYS = [1, 3, 7, 14, 30]

const REASON_PRIORITY: Record<ReviewReason, number> = {
  incorrect: 0,
  has_takeaway_note: 1,
  due_for_recall: 2,
  scheduled: 3,
}

function rowToAttempt(row: typeof practiceAttempts.$inferSelect): PracticeAttempt {
  return {
    id: row.id,
    courseKey: row.courseKey,
    lessonKey: row.lessonKey,
    exerciseKey: row.exerciseKey,
    contentHash: row.contentHash,
    exerciseSnapshot: JSON.parse(row.exerciseSnapshot) as ExerciseSnapshot,
    answer: row.answer,
    correct: row.correct,
    grading: row.grading,
    feedback: row.feedback,
    advisory: Boolean(row.advisory),
    ownerNote: row.ownerNote,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

export function buildReviewQueue(
  orm: SidecarOrm,
  options: { courseKey?: string | null; onlyDue?: boolean; now?: number } = {},
): ReviewQueueResponse {
  const now = options.now ?? Date.now()
  const rows = options.courseKey
    ? orm
        .select()
        .from(practiceAttempts)
        .where(eq(practiceAttempts.courseKey, options.courseKey))
        .orderBy(asc(practiceAttempts.createdAt))
        .all()
    : orm.select().from(practiceAttempts).orderBy(asc(practiceAttempts.createdAt)).all()

  const groups = new Map<string, PracticeAttempt[]>()
  for (const row of rows) {
    const attempt = rowToAttempt(row)
    const key = `${attempt.courseKey}::${attempt.lessonKey}::${attempt.exerciseKey}`
    const list = groups.get(key)
    if (list) list.push(attempt)
    else groups.set(key, [attempt])
  }

  const allItems: ReviewQueueItem[] = []
  for (const list of groups.values()) {
    const latest = list[list.length - 1]!
    let streak = 0
    for (let i = list.length - 1; i >= 0; i--) {
      const a = list[i]!
      if (a.grading === 'deterministic' && a.correct === 1) {
        streak++
      } else {
        break
      }
    }

    let intervalDays: number
    if (latest.grading === 'deterministic' && latest.correct === 0) {
      intervalDays = 0
    } else if (latest.ownerNote && streak <= 1) {
      intervalDays = 1
    } else if (streak >= 1) {
      intervalDays = INTERVAL_SCHEDULE_DAYS[Math.min(streak - 1, INTERVAL_SCHEDULE_DAYS.length - 1)]!
    } else {
      intervalDays = 3
    }

    const dueAt = latest.createdAt + intervalDays * DAY_MS
    const isDue = intervalDays === 0 || now >= dueAt

    let reason: ReviewReason
    if (latest.grading === 'deterministic' && latest.correct === 0) {
      reason = 'incorrect'
    } else if (latest.ownerNote && isDue) {
      reason = 'has_takeaway_note'
    } else if (isDue) {
      reason = 'due_for_recall'
    } else {
      reason = 'scheduled'
    }

    allItems.push({
      courseKey: latest.courseKey,
      lessonKey: latest.lessonKey,
      exerciseKey: latest.exerciseKey,
      attemptCount: list.length,
      lastAttemptAt: latest.createdAt,
      streak,
      intervalDays,
      dueAt,
      isDue,
      reason,
      latestAttempt: latest,
    })
  }

  allItems.sort((a, b) => {
    const pDiff = REASON_PRIORITY[a.reason] - REASON_PRIORITY[b.reason]
    if (pDiff !== 0) return pDiff
    return a.dueAt - b.dueAt
  })

  const dueNow = allItems.filter((item) => item.isDue).length
  const incorrectCount = allItems.filter((item) => item.reason === 'incorrect').length
  const scheduledCount = allItems.length - dueNow

  const items = options.onlyDue ? allItems.filter((item) => item.isDue) : allItems

  return {
    courseKey: options.courseKey ?? null,
    serverNow: now,
    summary: {
      totalTracked: allItems.length,
      dueNow,
      incorrectCount,
      scheduledCount,
    },
    items,
  }
}

export function buildRecallDigest(
  orm: SidecarOrm,
  options: { courseKey?: string | null; now?: number } = {},
): RecallDigestResponse {
  const now = options.now ?? Date.now()
  const review = buildReviewQueue(orm, { courseKey: options.courseKey, now })

  const attemptRows = options.courseKey
    ? orm
        .select()
        .from(practiceAttempts)
        .where(eq(practiceAttempts.courseKey, options.courseKey))
        .orderBy(asc(practiceAttempts.createdAt))
        .all()
    : orm.select().from(practiceAttempts).orderBy(asc(practiceAttempts.createdAt)).all()

  const tutorRows = options.courseKey
    ? orm
        .select()
        .from(sidecarTutorTurns)
        .where(eq(sidecarTutorTurns.courseKey, options.courseKey))
        .orderBy(asc(sidecarTutorTurns.createdAt))
        .all()
    : orm.select().from(sidecarTutorTurns).orderBy(asc(sidecarTutorTurns.createdAt)).all()

  const lessonTitles = new Map(
    orm
      .select()
      .from(sidecarTutorLessons)
      .all()
      .map((l) => [l.hash, l.title]),
  )

  let correctCount = 0
  let incorrectCount = 0
  let unscoredCount = 0
  let takeawayNotesCount = 0

  for (const item of review.items) {
    const latest = item.latestAttempt
    if (latest.grading === 'deterministic') {
      if (latest.correct === 1) correctCount++
      else incorrectCount++
    } else {
      unscoredCount++
    }
    if (latest.ownerNote) takeawayNotesCount++
  }

  const weakSpots = review.items.filter((i) => i.reason === 'incorrect' || i.isDue)
  const notedItems = review.items.filter((i) => Boolean(i.latestAttempt.ownerNote || i.latestAttempt.feedback))

  const dateStr = new Date(now).toISOString().slice(0, 10)
  const scopeLabel = options.courseKey ?? 'all courses'
  const lines: string[] = [
    `## nori recall digest — ${scopeLabel} (${dateStr})`,
    '',
    `- **Tracked exercises:** \`${review.summary.totalTracked}\` (\`${correctCount}\` correct, \`${incorrectCount}\` incorrect, \`${unscoredCount}\` open-ended) across \`${attemptRows.length}\` total attempts.`,
    `- **Due for recall / weak spots:** \`${weakSpots.length}\` item(s) due now (\`${takeawayNotesCount}\` takeaway note(s), \`${tutorRows.length}\` tutor turn(s)).`,
    '',
  ]

  if (weakSpots.length > 0) {
    lines.push('### weak spots and due recall', '')
    for (const item of weakSpots) {
      const lessonLink = item.lessonKey
        ? `[[courses/${item.courseKey}/lessons/${item.lessonKey}|${item.lessonKey}]]`
        : `[[courses/${item.courseKey}/index|${item.courseKey}]]`
      const badge = item.reason === 'incorrect' ? '✗ incorrect' : '↻ due for recall'
      lines.push(`- **${item.exerciseKey}** in ${lessonLink} (${badge}, \`${item.attemptCount}\` attempt(s)):`)
      lines.push(`  - **Prompt:** ${item.latestAttempt.exerciseSnapshot.prompt}`)
      lines.push(`  - **Last answer:** ${item.latestAttempt.answer}`)
      if (item.latestAttempt.ownerNote) {
        lines.push(`  - **Takeaway:** ${item.latestAttempt.ownerNote}`)
      }
    }
    lines.push('')
  }

  if (notedItems.length > 0) {
    lines.push('### takeaway notes and advisory feedback', '')
    for (const item of notedItems) {
      const latest = item.latestAttempt
      const lessonLink = item.lessonKey
        ? `[[courses/${item.courseKey}/lessons/${item.lessonKey}|${item.lessonKey}]]`
        : item.courseKey
      lines.push(`- **${item.exerciseKey}** (${lessonLink}):`)
      if (latest.ownerNote) {
        lines.push(`  - **Correction / takeaway:** ${latest.ownerNote}`)
      }
      if (latest.feedback) {
        const oneLineFb = latest.feedback.replace(/\s+/g, ' ').trim()
        lines.push(`  - **Advisory AI feedback:** ${oneLineFb}`)
      }
    }
    lines.push('')
  }

  if (tutorRows.length > 0) {
    lines.push('### contextual tutor log', '')
    for (const turn of tutorRows) {
      const title = lessonTitles.get(turn.lessonHash) || turn.lessonKey
      const speaker = turn.role === 'assistant' ? 'Nori Tutor' : 'Learner'
      const body = turn.content.replace(/\s+/g, ' ').trim()
      lines.push(`- **[${title}] ${speaker}:** ${body}`)
    }
    lines.push('')
  }

  return {
    courseKey: options.courseKey ?? null,
    generatedAt: now,
    stats: {
      totalAttempts: attemptRows.length,
      distinctExercises: review.summary.totalTracked,
      correctCount,
      incorrectCount,
      unscoredCount,
      weakSpotsCount: weakSpots.length,
      takeawayNotesCount,
      tutorTurnsCount: tutorRows.length,
    },
    markdown: lines.join('\n').trimEnd() + '\n',
  }
}
