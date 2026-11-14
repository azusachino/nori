import { useState, type FormEvent } from 'react'

export type ModuleData = { id: string; accepted: number; title: string; lessons: { title: string; body: string }[]; exercises: { type: 'multiple_choice' | 'written' | 'code'; prompt: string; options: string[] }[]; attempts: { exercise_index: number; answer: string; feedback: string; correct: number | null }[] }

export function ModuleView({ module, busy, post }: { module: ModuleData; busy: boolean; post: (action: string, data: unknown) => Promise<boolean> }) {
  const [answers, setAnswers] = useState<Record<number, string>>({})
  async function submit(event: FormEvent<HTMLFormElement>, index: number) {
    event.preventDefault()
    await post('answer', { index, answer: answers[index] })
  }
  return <section className="module-view"><p className="eyebrow">03 / YOUR FIRST MODULE</p><h2>{module.title}</h2><p className="muted">{module.accepted ? 'Work through the lessons and exercises at your own pace.' : 'Review this draft before you start studying.'}</p>
    {module.lessons.map((lesson, index) => <article className="lesson" key={index}><p className="course-label">LESSON {String(index + 1).padStart(2, '0')}</p><h3>{lesson.title}</h3><div className="lesson-body">{lesson.body}</div></article>)}
    {!module.accepted ? <button className="primary" disabled={busy} type="button" onClick={() => void post('accept', {})}>Accept module <span aria-hidden="true">↗</span></button> : <section><p className="eyebrow">PRACTICE</p><h3>Try it for yourself.</h3>{module.exercises.map((exercise, index) => {
      const attempts = module.attempts.filter((attempt) => attempt.exercise_index === index)
      return <form className="exercise" key={index} onSubmit={(event) => void submit(event, index)}><fieldset><legend>{index + 1}. {exercise.prompt}</legend><p className="course-label">{exercise.type === 'multiple_choice' ? 'MULTIPLE CHOICE' : exercise.type === 'written' ? 'WRITTEN ANSWER' : 'CODE · REVIEW ONLY'}</p>{exercise.type === 'multiple_choice' ? exercise.options.map((option) => <label className="choice" key={option}><input type="radio" name={`exercise-${index}`} value={option} checked={answers[index] === option} onChange={() => setAnswers({ ...answers, [index]: option })} required />{option}</label>) : <><label htmlFor={`answer-${index}`}>Your answer</label><textarea id={`answer-${index}`} rows={exercise.type === 'code' ? 8 : 4} maxLength={10000} value={answers[index] || ''} onChange={(event) => setAnswers({ ...answers, [index]: event.target.value })} required /></>}</fieldset><button className="secondary" disabled={busy}>Check answer</button>{attempts.length > 0 && <div className="feedback" role="status"><strong>{attempts.at(-1)?.correct === null ? 'AI feedback · advisory' : 'Feedback'}</strong><p>{attempts.at(-1)?.feedback}</p></div>}</form>
    })}</section>}
  </section>
}
