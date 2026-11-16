import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { useState, type FormEvent } from 'react'
import { ModuleDraft, type DraftContent, type ModuleDraftState } from './ModuleDraft'
import { LessonTutor } from './tutor/LessonTutor'

export type ModuleData = { id: string; position?: number; accepted: number; acceptedAt?: number | null; contentHash: string; title: string; lessons: { title: string; body: string }[]; exercises: { id: string; type: 'multiple_choice' | 'written' | 'code'; prompt: string; options: string[]; answer?: string; explanation?: string }[]; attempts: { id: string; exercise_id: string | null; exercise_index: number; answer: string; feedback: string; correct: number | null; owner_note: string }[] }

export function ModuleView({
  module,
  busy,
  post,
  canGenerateNext,
  onGenerateNext,
  onOpenAssessments,
  draftState,
  onDraftChange,
  onDraftSaved,
  courseId,
  tutorDrafts,
  onTutorDraftChange,
  currentDraftHash,
  practiceAnswers,
  onPracticeAnswerChange,
  practiceNotes,
  onPracticeNoteChange,
}: {
  module: ModuleData
  busy: boolean
  post: (action: string, data: unknown) => Promise<false | { module?: ModuleData }>
  canGenerateNext?: boolean
  onGenerateNext?: () => void
  onOpenAssessments?: () => void
  draftState?: ModuleDraftState
  onDraftChange?: (updated: DraftContent) => void
  onDraftSaved?: (newHash: string) => void
  courseId?: string
  tutorDrafts?: Record<string, string>
  onTutorDraftChange?: (key: string, text: string) => void
  currentDraftHash?: string | null
  practiceAnswers?: Record<number, string>
  onPracticeAnswerChange?: (index: number, answer: string) => void
  practiceNotes?: Record<string, string>
  onPracticeNoteChange?: (attemptId: string, note: string) => void
}) {
  const [localAnswers, setLocalAnswers] = useState<Record<number, string>>({})
  const [localNotes, setLocalNotes] = useState<Record<string, string>>({})
  const [activeTutorLessonIndex, setActiveTutorLessonIndex] = useState<number | null>(null)

  const answers = practiceAnswers ?? localAnswers
  const notes = practiceNotes ?? localNotes

  function updateAnswer(index: number, val: string) {
    if (onPracticeAnswerChange) {
      onPracticeAnswerChange(index, val)
    } else {
      setLocalAnswers((prev) => ({ ...prev, [index]: val }))
    }
  }

  function updateNote(attemptId: string, val: string) {
    if (onPracticeNoteChange) {
      onPracticeNoteChange(attemptId, val)
    } else {
      setLocalNotes((prev) => ({ ...prev, [attemptId]: val }))
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>, index: number) {
    event.preventDefault()
    await post('answer', { index, answer: answers[index], moduleId: module.id })
  }

  return (
    <section className="module-view">
      <p className="eyebrow">03 / MODULE {module.position ?? 1}</p>
      <h2>{module.title}</h2>
      <p className="muted">
        {module.accepted
          ? 'Work through the lessons and exercises at your own pace.'
          : 'Review this draft before you start studying.'}
      </p>

      {!!module.accepted &&
        module.lessons.map((lesson, index) => {
          const isTutorOpen = activeTutorLessonIndex === index
          const tutorKey = `${module.id}-${index}`
          return (
            <article className="lesson" key={index}>
              <div className="lesson-header-row">
                <div>
                  <p className="course-label">LESSON {String(index + 1).padStart(2, '0')}</p>
                  <h3>{lesson.title}</h3>
                </div>
                {courseId && (
                  <Button
                    type="button"
                    variant="outline"
                    className="ask-tutor-btn"
                    onClick={() => setActiveTutorLessonIndex(isTutorOpen ? null : index)}
                    aria-expanded={isTutorOpen}
                  >
                    {isTutorOpen ? 'Close tutor' : 'Ask about this lesson'}
                  </Button>
                )}
              </div>
              <div className="lesson-body">{lesson.body}</div>
              {isTutorOpen && courseId && (
                <LessonTutor
                  courseId={courseId}
                  moduleId={module.id}
                  moduleTitle={module.title}
                  moduleAttempts={module.attempts}
                  moduleExercises={module.exercises}
                  lessonIndex={index}
                  lessonTitle={lesson.title}
                  lessonBody={lesson.body}
                  draftQuestion={tutorDrafts?.[tutorKey] ?? ''}
                  onDraftQuestionChange={(text) => onTutorDraftChange?.(tutorKey, text)}
                  currentDraftHash={currentDraftHash}
                  onClose={() => setActiveTutorLessonIndex(null)}
                />
              )}
            </article>
          )
        })}

      {!module.accepted ? (
        <ModuleDraft
          module={module}
          busy={busy}
          post={post}
          draftState={draftState}
          onDraftChange={onDraftChange}
          onDraftSaved={onDraftSaved}
        />
      ) : (
        <section>
          <p className="eyebrow">PRACTICE</p>
          <h3>Try it for yourself.</h3>
          <p className="muted">
            {new Set(module.attempts.map((attempt) => attempt.exercise_index)).size} of{' '}
            {module.exercises.length} exercises attempted
          </p>
          {module.exercises.map((exercise, index) => {
            const attempts = module.attempts.filter((attempt) => attempt.exercise_id === exercise.id)
            return (
              <form className="exercise" key={exercise.id} onSubmit={(event) => void submit(event, index)}>
                <fieldset>
                  <legend>
                    {index + 1}. {exercise.prompt}
                  </legend>
                  <p className="course-label">
                    {exercise.type === 'multiple_choice'
                      ? 'MULTIPLE CHOICE'
                      : exercise.type === 'written'
                      ? 'WRITTEN ANSWER'
                      : 'CODE · REVIEW ONLY'}
                  </p>
                  {exercise.type === 'multiple_choice' ? (
                    exercise.options.map((option) => (
                      <label className="choice" key={option}>
                        <input
                          type="radio"
                          name={`exercise-${index}`}
                          value={option}
                          checked={answers[index] === option}
                          onChange={() => updateAnswer(index, option)}
                          required
                        />
                        <span>{option}</span>
                      </label>
                    ))
                  ) : (
                    <>
                      <label htmlFor={`answer-${index}`}>Your answer</label>
                      <Textarea
                        id={`answer-${index}`}
                        rows={exercise.type === 'code' ? 8 : 4}
                        maxLength={10000}
                        value={answers[index] || ''}
                        onChange={(event) => updateAnswer(index, event.target.value)}
                        required
                      />
                    </>
                  )}
                </fieldset>
                <Button className="secondary" disabled={busy}>
                  Check answer
                </Button>
                {attempts.map((attempt, attemptIndex) => (
                  <div className="feedback" key={attempt.id}>
                    <strong>
                      Attempt {attemptIndex + 1} ·{' '}
                      {attempt.correct === null ? 'AI feedback · advisory' : 'Feedback'}
                    </strong>
                    <p>Your answer: {attempt.answer}</p>
                    <p role="status">{attempt.feedback}</p>
                    {attempt.owner_note && <p>Your correction: {attempt.owner_note}</p>}
                    {attempt.correct === null && (
                      <>
                        <label htmlFor={`note-${attempt.id}`}>Your correction or note</label>
                        <Textarea
                          id={`note-${attempt.id}`}
                          rows={2}
                          maxLength={4000}
                          value={notes[attempt.id] || ''}
                          onChange={(event) =>
                            updateNote(attempt.id, event.target.value)
                          }
                        />
                        <Button
                          className="secondary"
                          type="button"
                          disabled={busy || !notes[attempt.id]?.trim()}
                          onClick={() =>
                            void post('feedback', {
                              attemptId: attempt.id,
                              note: notes[attempt.id],
                              moduleId: module.id,
                            })
                          }
                        >
                          Save correction
                        </Button>
                      </>
                    )}
                  </div>
                ))}
              </form>
            )
          })}
          {canGenerateNext && onGenerateNext && (
            <div className="next-module-banner">
              <div>
                <h4>Ready to continue?</h4>
                <p className="muted">
                  This module is accepted. You can generate the next module based on your outline, or
                  test your understanding with an assessment.
                </p>
              </div>
              <div className="banner-actions">
                <Button className="primary" disabled={busy} type="button" onClick={onGenerateNext}>
                  {busy ? 'Preparing module…' : 'Generate next module'} <span aria-hidden="true">↗</span>
                </Button>
                {onOpenAssessments && (
                  <Button className="secondary" type="button" onClick={onOpenAssessments}>
                    Check understanding in assessments <span aria-hidden="true">→</span>
                  </Button>
                )}
              </div>
            </div>
          )}
        </section>
      )}
    </section>
  )
}
