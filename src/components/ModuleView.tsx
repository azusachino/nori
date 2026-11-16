import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { useState, type FormEvent } from 'react'
import { ModuleDraft } from './ModuleDraft'

export type ModuleData = { id: string; accepted: number; contentHash: string; title: string; lessons: { title: string; body: string }[]; exercises: { id: string; type: 'multiple_choice' | 'written' | 'code'; prompt: string; options: string[]; answer?: string; explanation?: string }[]; attempts: { id: string; exercise_id: string | null; exercise_index: number; answer: string; feedback: string; correct: number | null; owner_note: string }[] }

export function ModuleView({ module, busy, post }: { module: ModuleData; busy: boolean; post: (action: string, data: unknown) => Promise<false | { module?: ModuleData }> }) {
  const [answers, setAnswers] = useState<Record<number, string>>({})
  const [notes, setNotes] = useState<Record<string, string>>({})
  async function submit(event: FormEvent<HTMLFormElement>, index: number) {
    event.preventDefault()
    await post('answer', { index, answer: answers[index] })
  }
  return <section className="module-view"><p className="eyebrow">03 / YOUR FIRST MODULE</p><h2>{module.title}</h2><p className="muted">{module.accepted ? 'Work through the lessons and exercises at your own pace.' : 'Review this draft before you start studying.'}</p>
    {!!module.accepted && module.lessons.map((lesson, index) => <article className="lesson" key={index}><p className="course-label">LESSON {String(index + 1).padStart(2, '0')}</p><h3>{lesson.title}</h3><div className="lesson-body">{lesson.body}</div></article>)}
    {!module.accepted ? <ModuleDraft module={module} busy={busy} post={post} /> : <section><p className="eyebrow">PRACTICE</p><h3>Try it for yourself.</h3><p className="muted">{new Set(module.attempts.map((attempt) => attempt.exercise_index)).size} of {module.exercises.length} exercises attempted</p>{module.exercises.map((exercise, index) => {
      const attempts = module.attempts.filter((attempt) => attempt.exercise_id === exercise.id)
      return <form className="exercise" key={exercise.id} onSubmit={(event) => void submit(event, index)}><fieldset><legend>{index + 1}. {exercise.prompt}</legend><p className="course-label">{exercise.type === 'multiple_choice' ? 'MULTIPLE CHOICE' : exercise.type === 'written' ? 'WRITTEN ANSWER' : 'CODE · REVIEW ONLY'}</p>{exercise.type === 'multiple_choice' ? exercise.options.map((option) => <label className="choice" key={option}><input type="radio" name={`exercise-${index}`} value={option} checked={answers[index] === option} onChange={() => setAnswers({ ...answers, [index]: option })} required /><span>{option}</span></label>) : <><label htmlFor={`answer-${index}`}>Your answer</label><Textarea id={`answer-${index}`} rows={exercise.type === 'code' ? 8 : 4} maxLength={10000} value={answers[index] || ''} onChange={(event) => setAnswers({ ...answers, [index]: event.target.value })} required /></>}</fieldset><Button className="secondary" disabled={busy}>Check answer</Button>{attempts.map((attempt, attemptIndex) => <div className="feedback" key={attempt.id}><strong>Attempt {attemptIndex + 1} · {attempt.correct === null ? 'AI feedback · advisory' : 'Feedback'}</strong><p>Your answer: {attempt.answer}</p><p role="status">{attempt.feedback}</p>{attempt.owner_note && <p>Your correction: {attempt.owner_note}</p>}{attempt.correct === null && <><label htmlFor={`note-${attempt.id}`}>Your correction or note</label><Textarea id={`note-${attempt.id}`} rows={2} maxLength={4000} value={notes[attempt.id] || ''} onChange={(event) => setNotes({ ...notes, [attempt.id]: event.target.value })} /><Button className="secondary" type="button" disabled={busy || !notes[attempt.id]?.trim()} onClick={() => void post('feedback', { attemptId: attempt.id, note: notes[attempt.id] })}>Save correction</Button></>}</div>)}</form>
    })}</section>}
  </section>
}
