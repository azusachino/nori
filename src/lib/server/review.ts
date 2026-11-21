import { asc, count, eq, sql } from 'drizzle-orm'
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

const REASONS: ReviewReason[] = ['incorrect', 'has_takeaway_note', 'due_for_recall', 'scheduled']

/** The latest attempt as the review island renders it: no reference answer, explanation or feedback. */
export type ReviewAttemptSummary = {
  id: string
  contentHash: string
  exerciseType: ExerciseSnapshot['type']
  prompt: string
  options: string[]
  answer: string
  correct: number | null
  grading: 'deterministic' | 'unscored'
  ownerNote: string
  createdAt: number
}

export type ReviewQueueSummaryItem = Omit<ReviewQueueItem, 'latestAttempt'> & { latestAttempt: ReviewAttemptSummary }

type ReviewRow = typeof practiceAttempts.$inferSelect & {
  attemptCount: number
  streak: number
  intervalDays: number
  dueAt: number
  isDue: number
  reasonRank: number
  totalTracked: number
  dueNow: number
  incorrectCount: number
}

/**
 * One row per tracked exercise (course, lesson, exercise), computed in SQLite:
 * the latest attempt, the run of trailing deterministic-correct attempts
 * (streak), the spaced-recall interval (0 if the latest is incorrect, 1 day
 * after a takeaway note, then 1/3/7/14/30 days by streak, 3 days for
 * open-ended), the due time and the reason rank. Only the selected rows reach
 * JavaScript, already ordered by reason and due time.
 */
function scoredExercises(courseKey: string | null, now: number) {
  return sql`
    WITH ranked AS (
      -- Everything is ranked and scored on narrow columns; the wide text columns
      -- (snapshot, answer, feedback) are read only for the rows returned.
      SELECT rowid AS rid, course_key, lesson_key, exercise_key, created_at, grading, correct,
        owner_note <> '' AS has_note,
        ROW_NUMBER() OVER (
          PARTITION BY course_key, lesson_key, exercise_key ORDER BY created_at DESC, rowid DESC
        ) AS rn
      FROM practice_attempts
      ${courseKey === null ? sql`` : sql`WHERE course_key = ${courseKey}`}
    ),
    groups AS (
      -- One pass over the ranked rows: the latest attempt's fields (rn = 1) and the streak.
      SELECT course_key, lesson_key, exercise_key,
        MAX(CASE WHEN rn = 1 THEN rid END) AS latest_rid,
        MAX(CASE WHEN rn = 1 THEN created_at END) AS latest_at,
        MAX(CASE WHEN rn = 1 THEN grading = 'deterministic' AND correct = 0 END) AS is_incorrect,
        MAX(CASE WHEN rn = 1 THEN grading = 'deterministic' AND correct = 1 END) AS is_correct,
        MAX(CASE WHEN rn = 1 THEN has_note END) AS has_note,
        MAX(rn) AS attempt_count,
        MIN(created_at) AS first_at,
        COALESCE(
          MIN(CASE WHEN NOT (grading = 'deterministic' AND COALESCE(correct, 0) = 1) THEN rn END) - 1,
          MAX(rn)
        ) AS streak
      FROM ranked
      GROUP BY course_key, lesson_key, exercise_key
    ),
    latest AS (
      SELECT groups.*,
        CASE
          WHEN is_incorrect THEN 0
          WHEN has_note AND streak <= 1 THEN 1
          WHEN streak >= 5 THEN 30
          WHEN streak = 4 THEN 14
          WHEN streak = 3 THEN 7
          WHEN streak = 2 THEN 3
          WHEN streak = 1 THEN 1
          ELSE 3
        END AS interval_days
      FROM groups
    ),
    scored AS (
      SELECT latest.*,
        latest_at + interval_days * ${DAY_MS} AS due_at,
        CASE WHEN interval_days = 0 OR ${now} >= latest_at + interval_days * ${DAY_MS} THEN 1 ELSE 0 END AS is_due
      FROM latest
    )`
}

function reviewRows(orm: SidecarOrm, courseKey: string | null, now: number, onlyDue: boolean): ReviewRow[] {
  const query = sql`
    ${scoredExercises(courseKey, now)},
    counted AS (
      SELECT scored.*,
        CASE WHEN is_incorrect THEN 0 WHEN has_note AND is_due = 1 THEN 1 WHEN is_due = 1 THEN 2 ELSE 3 END AS reason_rank,
        COUNT(*) OVER () AS total_tracked,
        SUM(is_due) OVER () AS due_now,
        SUM(is_incorrect) OVER () AS incorrect_count
      FROM scored
    )
    SELECT p.*, c.attempt_count, c.streak, c.interval_days, c.due_at, c.is_due, c.reason_rank,
      c.total_tracked, c.due_now, c.incorrect_count
    FROM counted c
    JOIN practice_attempts p ON p.rowid = c.latest_rid
    WHERE ${onlyDue ? 1 : 0} = 0 OR c.is_due = 1
    ORDER BY c.reason_rank, c.due_at, c.first_at
  `
  const raw = orm.all<Record<string, unknown>>(query)
  return raw.map((r) => ({
    id: r.id as string,
    courseKey: r.course_key as string,
    lessonKey: r.lesson_key as string,
    exerciseKey: r.exercise_key as string,
    contentHash: r.content_hash as string,
    exerciseSnapshot: r.exercise_snapshot as string,
    answer: r.answer as string,
    correct: r.correct as number | null,
    grading: r.grading as 'deterministic' | 'unscored',
    feedback: r.feedback as string,
    advisory: r.advisory as number,
    ownerNote: r.owner_note as string,
    version: r.version as number,
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number,
    attemptCount: r.attempt_count as number,
    streak: r.streak as number,
    intervalDays: r.interval_days as number,
    dueAt: r.due_at as number,
    isDue: r.is_due as number,
    reasonRank: r.reason_rank as number,
    totalTracked: r.total_tracked as number,
    dueNow: r.due_now as number,
    incorrectCount: r.incorrect_count as number,
  }))
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

function reviewSummary(orm: SidecarOrm, courseKey: string | null, now: number, rows: ReviewRow[], onlyDue: boolean) {
  // Counts ride on every row; only an empty onlyDue result needs a second query.
  const first = rows[0] ?? (onlyDue ? reviewRows(orm, courseKey, now, false)[0] : undefined)
  const totalTracked = first?.totalTracked ?? 0
  const dueNow = first?.dueNow ?? 0
  return {
    totalTracked,
    dueNow,
    incorrectCount: first?.incorrectCount ?? 0,
    scheduledCount: totalTracked - dueNow,
  }
}

function itemFields(row: ReviewRow) {
  return {
    courseKey: row.courseKey,
    lessonKey: row.lessonKey,
    exerciseKey: row.exerciseKey,
    attemptCount: row.attemptCount,
    lastAttemptAt: row.createdAt,
    streak: row.streak,
    intervalDays: row.intervalDays,
    dueAt: row.dueAt,
    isDue: row.isDue === 1,
    reason: REASONS[row.reasonRank]!,
  }
}

export function buildReviewQueue(
  orm: SidecarOrm,
  options: { courseKey?: string | null; onlyDue?: boolean; now?: number } = {},
): ReviewQueueResponse {
  const now = options.now ?? Date.now()
  const courseKey = options.courseKey ?? null
  const rows = reviewRows(orm, courseKey, now, Boolean(options.onlyDue))
  return {
    courseKey,
    serverNow: now,
    summary: reviewSummary(orm, courseKey, now, rows, Boolean(options.onlyDue)),
    items: rows.map((row) => ({ ...itemFields(row), latestAttempt: rowToAttempt(row) })),
  }
}

/** The review queue as the island renders it; fetch a full attempt by id when it is needed. */
export function buildReviewQueueSummary(
  orm: SidecarOrm,
  options: { courseKey?: string | null; onlyDue?: boolean; now?: number } = {},
): Omit<ReviewQueueResponse, 'items'> & { items: ReviewQueueSummaryItem[] } {
  const now = options.now ?? Date.now()
  const courseKey = options.courseKey ?? null
  const rows = reviewRows(orm, courseKey, now, Boolean(options.onlyDue))
  return {
    courseKey,
    serverNow: now,
    summary: reviewSummary(orm, courseKey, now, rows, Boolean(options.onlyDue)),
    items: rows.map((row) => {
      const snapshot = JSON.parse(row.exerciseSnapshot) as ExerciseSnapshot
      return {
        ...itemFields(row),
        latestAttempt: {
          id: row.id,
          contentHash: row.contentHash,
          exerciseType: snapshot.type,
          prompt: snapshot.prompt,
          options: snapshot.options,
          answer: row.answer,
          correct: row.correct,
          grading: row.grading,
          ownerNote: row.ownerNote,
          createdAt: row.createdAt,
        },
      }
    }),
  }
}

export type LessonProgress = {
  lessonKey: string
  /** Exercises with at least one attempt. */
  exercisesAttempted: number
  /** Exercises whose latest attempt was graded correct. */
  exercisesCorrect: number
  /** Exercises whose latest attempt was graded incorrect. */
  exercisesIncorrect: number
  /** Exercises due for recall now (incorrect ones included), as in the review queue. */
  exercisesDue: number
  attempts: number
  lastActivityAt: number
}

export type CourseProgressResponse = {
  courseKey: string
  serverNow: number
  totals: Omit<LessonProgress, 'lessonKey'>
  lessons: LessonProgress[]
}

/**
 * Per-lesson progress for a course, aggregated in SQLite over the same
 * per-exercise scoring as the review queue (so "due" agrees with it). Lessons
 * with no attempts are not listed; the island fills them in from its banks.
 */
export function buildCourseProgress(orm: SidecarOrm, courseKey: string, now: number): CourseProgressResponse {
  const rows = orm.all<Record<string, number | string>>(sql`
    ${scoredExercises(courseKey, now)}
    SELECT lesson_key,
      COUNT(*) AS exercises_attempted,
      COALESCE(SUM(is_correct), 0) AS exercises_correct,
      COALESCE(SUM(is_incorrect), 0) AS exercises_incorrect,
      SUM(is_due) AS exercises_due,
      SUM(attempt_count) AS attempts,
      MAX(latest_at) AS last_activity_at
    FROM scored
    GROUP BY lesson_key
    ORDER BY lesson_key
  `)
  const lessons: LessonProgress[] = rows.map((r) => ({
    lessonKey: r.lesson_key as string,
    exercisesAttempted: Number(r.exercises_attempted),
    exercisesCorrect: Number(r.exercises_correct),
    exercisesIncorrect: Number(r.exercises_incorrect),
    exercisesDue: Number(r.exercises_due),
    attempts: Number(r.attempts),
    lastActivityAt: Number(r.last_activity_at),
  }))
  const totals = {
    exercisesAttempted: 0,
    exercisesCorrect: 0,
    exercisesIncorrect: 0,
    exercisesDue: 0,
    attempts: 0,
    lastActivityAt: 0,
  }
  for (const l of lessons) {
    totals.exercisesAttempted += l.exercisesAttempted
    totals.exercisesCorrect += l.exercisesCorrect
    totals.exercisesIncorrect += l.exercisesIncorrect
    totals.exercisesDue += l.exercisesDue
    totals.attempts += l.attempts
    totals.lastActivityAt = Math.max(totals.lastActivityAt, l.lastActivityAt)
  }
  return { courseKey, serverNow: now, totals, lessons }
}

/** Recall state of each tracked exercise of a course, keyed by `lessonKey` + NUL + `exerciseKey`. */
export function exerciseRecallStates(orm: SidecarOrm, courseKey: string, now: number): Map<string, { isDue: boolean; isIncorrect: boolean }> {
  const rows = orm.all<{ lesson_key: string; exercise_key: string; is_due: number; is_incorrect: number }>(sql`
    ${scoredExercises(courseKey, now)}
    SELECT lesson_key, exercise_key, is_due, is_incorrect FROM scored
  `)
  return new Map(rows.map((r) => [`${r.lesson_key}\u0000${r.exercise_key}`, { isDue: r.is_due === 1, isIncorrect: r.is_incorrect === 1 }]))
}

export function buildRecallDigest(
  orm: SidecarOrm,
  options: { courseKey?: string | null; now?: number } = {},
): RecallDigestResponse {
  const now = options.now ?? Date.now()
  const review = buildReviewQueue(orm, { courseKey: options.courseKey, now })

  const totalAttempts =
    (options.courseKey
      ? orm.select({ n: count() }).from(practiceAttempts).where(eq(practiceAttempts.courseKey, options.courseKey)).get()
      : orm.select({ n: count() }).from(practiceAttempts).get()
    )?.n ?? 0

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
    `- **Tracked exercises:** \`${review.summary.totalTracked}\` (\`${correctCount}\` correct, \`${incorrectCount}\` incorrect, \`${unscoredCount}\` open-ended) across \`${totalAttempts}\` total attempts.`,
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
      totalAttempts: totalAttempts,
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
