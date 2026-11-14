import { useState, type FormEvent } from 'react'
import type { ModuleData } from './ModuleView'

type Draft = { title: string; lessons: { title: string; body: string }[]; exercises: { type: 'multiple_choice' | 'written' | 'code'; prompt: string; options: string[]; answer: string; explanation: string }[] }

export function ModuleDraft({ module, busy, post }: { module: ModuleData; busy: boolean; post: (action: string, data: unknown) => Promise<boolean> }) {
  const [draft, setDraft] = useState<Draft>(() => ({ title: module.title, lessons: module.lessons, exercises: module.exercises.map((item) => ({ ...item, answer: item.answer || '', explanation: item.explanation || '' })) }))
  const [saved, setSaved] = useState(true)
  function updateLesson(index: number, key: 'title' | 'body', value: string) {
    setDraft((old) => ({ ...old, lessons: old.lessons.map((lesson, i) => i === index ? { ...lesson, [key]: value } : lesson) })); setSaved(false)
  }
  function updateExercise(index: number, key: 'prompt' | 'answer' | 'explanation', value: string) {
    setDraft((old) => ({ ...old, exercises: old.exercises.map((exercise, i) => i === index ? { ...exercise, [key]: value } : exercise) })); setSaved(false)
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (await post('save-module', { content: draft })) setSaved(true)
  }
  return <form className="draft-editor" onSubmit={(event) => void save(event)}><p className="muted">Review and edit the lessons and answers before accepting this module.</p>
    <label htmlFor="module-title">Module title</label><input id="module-title" value={draft.title} maxLength={160} required onChange={(event) => { setDraft({ ...draft, title: event.target.value }); setSaved(false) }} />
    {draft.lessons.map((lesson, index) => <fieldset key={index}><legend>Lesson {index + 1}</legend><label htmlFor={`lesson-title-${index}`}>Title</label><input id={`lesson-title-${index}`} value={lesson.title} maxLength={160} required onChange={(event) => updateLesson(index, 'title', event.target.value)} /><label htmlFor={`lesson-body-${index}`}>Content</label><textarea id={`lesson-body-${index}`} rows={8} maxLength={12000} value={lesson.body} required onChange={(event) => updateLesson(index, 'body', event.target.value)} /></fieldset>)}
    {draft.exercises.map((exercise, index) => <fieldset key={index}><legend>Exercise {index + 1} · {exercise.type.replace('_', ' ')}</legend><label htmlFor={`draft-prompt-${index}`}>Question</label><textarea id={`draft-prompt-${index}`} rows={2} value={exercise.prompt} required onChange={(event) => updateExercise(index, 'prompt', event.target.value)} />{exercise.type === 'multiple_choice' && <><label htmlFor={`draft-options-${index}`}>Options · one per line</label><textarea id={`draft-options-${index}`} rows={4} value={exercise.options.join('\n')} onChange={(event) => { const options = event.target.value.split('\n'); setDraft((old) => ({ ...old, exercises: old.exercises.map((item, i) => i === index ? { ...item, options } : item) })); setSaved(false) }} /></>}<label htmlFor={`draft-answer-${index}`}>{exercise.type === 'multiple_choice' ? 'Correct option · match one option exactly' : 'Reference answer'}</label><textarea id={`draft-answer-${index}`} rows={2} value={exercise.answer} required onChange={(event) => updateExercise(index, 'answer', event.target.value)} /><label htmlFor={`draft-explanation-${index}`}>Explanation</label><textarea id={`draft-explanation-${index}`} rows={2} value={exercise.explanation} required onChange={(event) => updateExercise(index, 'explanation', event.target.value)} /></fieldset>)}
    <button className="secondary" disabled={busy || saved}>Save draft changes</button><button className="primary" disabled={busy || !saved} type="button" onClick={() => void post('accept', {})}>Accept module <span aria-hidden="true">↗</span></button>{!saved && <p className="aside-note">Save your changes before accepting.</p>}
  </form>
}
