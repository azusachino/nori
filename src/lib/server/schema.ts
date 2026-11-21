import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

export const practiceAttempts = sqliteTable(
  'practice_attempts',
  {
    id: text('id').primaryKey(),
    courseKey: text('course_key').notNull(),
    lessonKey: text('lesson_key').notNull().default(''),
    exerciseKey: text('exercise_key').notNull(),
    contentHash: text('content_hash').notNull(),
    exerciseSnapshot: text('exercise_snapshot').notNull(),
    answer: text('answer').notNull(),
    correct: integer('correct'),
    grading: text('grading', { enum: ['deterministic', 'unscored'] }).notNull(),
    feedback: text('feedback').notNull().default(''),
    advisory: integer('advisory').notNull().default(0),
    ownerNote: text('owner_note').notNull().default(''),
    version: integer('version').notNull().default(0),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    index('practice_attempts_scope').on(table.courseKey, table.lessonKey, table.createdAt),
    // Covers the review queue's ranking (partition, order and the grading/correct/owner_note
    // tests) so it never reads the wide snapshot, answer and feedback columns.
    index('practice_attempts_review').on(
      table.courseKey,
      table.lessonKey,
      table.exerciseKey,
      table.createdAt,
      table.grading,
      table.correct,
      table.ownerNote,
    ),
  ],
)

export const sidecarAssessments = sqliteTable(
  'sidecar_assessments',
  {
    id: text('id').primaryKey(),
    courseKey: text('course_key').notNull(),
    title: text('title').notNull(),
    mode: text('mode', { enum: ['timed', 'untimed'] }).notNull(),
    durationSeconds: integer('duration_seconds'),
    status: text('status', { enum: ['planned', 'active', 'submitted', 'expired'] }).notNull(),
    createdAt: integer('created_at').notNull(),
    startedAt: integer('started_at'),
    deadlineAt: integer('deadline_at'),
    submittedAt: integer('submitted_at'),
    finalizedAt: integer('finalized_at'),
    version: integer('version').notNull().default(0),
  },
  (table) => [index('sidecar_assessments_course').on(table.courseKey, table.createdAt)],
)

export const sidecarAssessmentItems = sqliteTable(
  'sidecar_assessment_items',
  {
    id: text('id').primaryKey(),
    assessmentId: text('assessment_id')
      .notNull()
      .references(() => sidecarAssessments.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    lessonKey: text('lesson_key').notNull().default(''),
    exerciseKey: text('exercise_key').notNull(),
    contentHash: text('content_hash').notNull(),
    exerciseSnapshot: text('exercise_snapshot').notNull(),
  },
  (table) => [uniqueIndex('sidecar_assessment_items_pos').on(table.assessmentId, table.position)],
)

export const sidecarAssessmentAnswers = sqliteTable(
  'sidecar_assessment_answers',
  {
    assessmentId: text('assessment_id')
      .notNull()
      .references(() => sidecarAssessments.id, { onDelete: 'cascade' }),
    itemId: text('item_id')
      .notNull()
      .references(() => sidecarAssessmentItems.id, { onDelete: 'cascade' }),
    answer: text('answer').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.assessmentId, table.itemId] })],
)

export const sidecarAssessmentResults = sqliteTable(
  'sidecar_assessment_results',
  {
    id: text('id').primaryKey(),
    assessmentId: text('assessment_id')
      .notNull()
      .references(() => sidecarAssessments.id, { onDelete: 'cascade' }),
    itemId: text('item_id')
      .notNull()
      .references(() => sidecarAssessmentItems.id, { onDelete: 'cascade' }),
    answer: text('answer'),
    correct: integer('correct'),
    grading: text('grading', { enum: ['deterministic', 'unscored'] }).notNull(),
    feedback: text('feedback').notNull().default(''),
    advisory: integer('advisory').notNull().default(0),
    ownerNote: text('owner_note').notNull().default(''),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [uniqueIndex('sidecar_assessment_results_item').on(table.assessmentId, table.itemId)],
)

export const sidecarTutorLessons = sqliteTable('sidecar_tutor_lessons', {
  hash: text('hash').primaryKey(),
  title: text('title').notNull(),
  body: text('body').notNull(),
  createdAt: integer('created_at').notNull(),
})

export const sidecarTutorTurns = sqliteTable(
  'sidecar_tutor_turns',
  {
    id: text('id').primaryKey(),
    courseKey: text('course_key').notNull(),
    lessonKey: text('lesson_key').notNull(),
    role: text('role', { enum: ['user', 'assistant'] }).notNull(),
    content: text('content').notNull(),
    lessonHash: text('lesson_hash')
      .notNull()
      .references(() => sidecarTutorLessons.hash),
    contextMeta: text('context_meta').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [index('sidecar_tutor_scope').on(table.courseKey, table.lessonKey, table.createdAt)],
)

export const sidecarSchema = {
  practiceAttempts,
  sidecarAssessments,
  sidecarAssessmentItems,
  sidecarAssessmentAnswers,
  sidecarAssessmentResults,
  sidecarTutorLessons,
  sidecarTutorTurns,
}
