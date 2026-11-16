import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { useState, type FormEvent } from 'react'
import type { ModuleData } from './ModuleView'

export type DraftContent = {
  title: string
  lessons: { title: string; body: string }[]
  exercises: {
    id: string
    type: 'multiple_choice' | 'written' | 'code'
    prompt: string
    options: string[]
    answer: string
    explanation: string
  }[]
}

export type ModuleDraftState = {
  draft: DraftContent
  saved: boolean
  draftHash: string
}

export function ModuleDraft({
  module,
  busy,
  post,
  draftState,
  onDraftChange,
  onDraftSaved,
}: {
  module: ModuleData
  busy: boolean
  post: (action: string, data: unknown) => Promise<false | { module?: ModuleData }>
  draftState?: ModuleDraftState
  onDraftChange?: (updated: DraftContent) => void
  onDraftSaved?: (newHash: string) => void
}) {
  const [localDraft, setLocalDraft] = useState<DraftContent>(() => ({
    title: module.title,
    lessons: module.lessons,
    exercises: module.exercises.map((item) => ({ ...item, answer: item.answer || '', explanation: item.explanation || '' })),
  }))
  const [localSaved, setLocalSaved] = useState(true)
  const [localDraftHash, setLocalDraftHash] = useState(module.contentHash)

  const draft = draftState ? draftState.draft : localDraft
  const saved = draftState ? draftState.saved : localSaved
  const draftHash = draftState ? draftState.draftHash : localDraftHash
  const changedElsewhere = draftHash !== module.contentHash

  function applyDraft(newDraft: DraftContent) {
    if (onDraftChange) {
      onDraftChange(newDraft)
    } else {
      setLocalDraft(newDraft)
      setLocalSaved(false)
    }
  }

  function updateLesson(index: number, key: 'title' | 'body', value: string) {
    applyDraft({ ...draft, lessons: draft.lessons.map((lesson, i) => (i === index ? { ...lesson, [key]: value } : lesson)) })
  }

  function updateExercise(index: number, key: 'prompt' | 'answer' | 'explanation', value: string) {
    applyDraft({ ...draft, exercises: draft.exercises.map((exercise, i) => (i === index ? { ...exercise, [key]: value } : exercise)) })
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const result = await post('save-module', { content: draft, expectedContentHash: draftHash, moduleId: module.id })
    if (result && typeof result === 'object' && 'module' in result && result.module) {
      const newHash = result.module.contentHash
      if (onDraftSaved) {
        onDraftSaved(newHash)
      } else {
        setLocalDraftHash(newHash)
        setLocalSaved(true)
      }
    }
  }

  return (
    <form className="draft-editor" onSubmit={(event) => void save(event)}>
      <p className="muted">Review and edit the lessons and answers before accepting this module.</p>
      <fieldset disabled={busy} className="draft-fields">
        <label htmlFor="module-title">Module title</label>
        <Input
          id="module-title"
          value={draft.title}
          maxLength={160}
          required
          onChange={(event) => applyDraft({ ...draft, title: event.target.value })}
        />
        {draft.lessons.map((lesson, index) => (
          <fieldset key={index}>
            <legend>Lesson {index + 1}</legend>
            <label htmlFor={`lesson-title-${index}`}>Title</label>
            <Input id={`lesson-title-${index}`} value={lesson.title} maxLength={160} required onChange={(event) => updateLesson(index, 'title', event.target.value)} />
            <label htmlFor={`lesson-body-${index}`}>Content</label>
            <Textarea id={`lesson-body-${index}`} rows={8} maxLength={12000} value={lesson.body} required onChange={(event) => updateLesson(index, 'body', event.target.value)} />
          </fieldset>
        ))}
        {draft.exercises.map((exercise, index) => (
          <fieldset key={index}>
            <legend>Exercise {index + 1} · {exercise.type.replace('_', ' ')}</legend>
            <label htmlFor={`draft-prompt-${index}`}>Question</label>
            <Textarea id={`draft-prompt-${index}`} rows={2} value={exercise.prompt} required onChange={(event) => updateExercise(index, 'prompt', event.target.value)} />
            {exercise.type === 'multiple_choice' && (
              <>
                <label htmlFor={`draft-options-${index}`}>Options · one per line</label>
                <Textarea
                  id={`draft-options-${index}`}
                  rows={4}
                  value={exercise.options.join('\n')}
                  onChange={(event) => {
                    const options = event.target.value.split('\n')
                    applyDraft({ ...draft, exercises: draft.exercises.map((item, i) => (i === index ? { ...item, options } : item)) })
                  }}
                />
              </>
            )}
            <label htmlFor={`draft-answer-${index}`}>{exercise.type === 'multiple_choice' ? 'Correct option · match one option exactly' : 'Reference answer'}</label>
            <Textarea id={`draft-answer-${index}`} rows={2} value={exercise.answer} required onChange={(event) => updateExercise(index, 'answer', event.target.value)} />
            <label htmlFor={`draft-explanation-${index}`}>Explanation</label>
            <Textarea id={`draft-explanation-${index}`} rows={2} value={exercise.explanation} required onChange={(event) => updateExercise(index, 'explanation', event.target.value)} />
          </fieldset>
        ))}
        <Button className="secondary" disabled={busy || saved || changedElsewhere}>Save draft changes</Button>
        <Button className="primary" disabled={busy || !saved || changedElsewhere} type="button" onClick={() => void post('accept', { expectedContentHash: draftHash, moduleId: module.id })}>
          Accept module <span aria-hidden="true">↗</span>
        </Button>
        {changedElsewhere ? (
          <p className="error" role="alert">The draft changed elsewhere. Copy any edits you want to keep, then reopen the course to review the latest version.</p>
        ) : (
          !saved && <p className="aside-note">Save your changes before accepting.</p>
        )}
      </fieldset>
    </form>
  )
}
