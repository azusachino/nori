import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { useEffect, useState, type FormEvent } from 'react'
import { ModuleView, type ModuleData } from './ModuleView'
import type { DraftContent, ModuleDraftState } from './ModuleDraft'
import { AssessmentManager } from './assessments/AssessmentManager'
import { AssessmentDetail } from './assessments/AssessmentDetail'

type Course = {
  id: string
  title: string
  goal: string
  outline: string
  outline_approved: number
  module: ModuleData | null
  modules?: ModuleData[]
  modulesHash?: string
  sources: { id: string; name: string }[]
  messages: { role: 'user' | 'assistant'; content: string }[]
}

export function CourseDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const [course, setCourse] = useState<Course | null>(null)
  const [selectedModuleId, setSelectedModuleId] = useState<string | null>(null)
  const [draftStates, setDraftStates] = useState<Record<string, ModuleDraftState>>({})
  const [viewSection, setViewSection] = useState<'modules' | 'assessments'>('modules')
  const [selectedAssessmentId, setSelectedAssessmentId] = useState<string | null>(null)
  const [assessmentDirty, setAssessmentDirty] = useState(false)
  const [assessmentDraftAnswers, setAssessmentDraftAnswers] = useState<Record<string, Record<string, string>>>({})
  const [tutorDraftQuestions, setTutorDraftQuestions] = useState<Record<string, string>>({})
  const [practiceAnswers, setPracticeAnswers] = useState<Record<string, Record<number, string>>>({})
  const [practiceNotes, setPracticeNotes] = useState<Record<string, Record<string, string>>>({})
  const [message, setMessage] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [outline, setOutline] = useState('')
  const [outlineBase, setOutlineBase] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function load(syncOutline = true) {
    const response = await fetch(`/api/courses/${id}`)
    if (!response.ok) throw new Error('Could not open this course.')
    const value = await response.json() as Course
    setCourse(value)
    if (syncOutline) {
      setOutline(value.outline)
      setOutlineBase(value.outline)
    }
  }

  useEffect(() => {
    void load().catch((err: Error) => setError(err.message))
  }, [id])

  const currentModules: ModuleData[] = course?.modules && course.modules.length > 0
    ? course.modules
    : (course?.module ? [course.module] : [])

  const hasUnsavedPracticeWork = currentModules.some((m) => {
    if (!m.accepted) return false
    const modAnswers = practiceAnswers[m.id] ?? {}
    const modNotes = practiceNotes[m.id] ?? {}

    for (let idx = 0; idx < m.exercises.length; idx++) {
      const ans = modAnswers[idx]
      if (ans && ans.trim()) {
        const exercise = m.exercises[idx]
        const attempts = m.attempts.filter(
          (a) => a.exercise_id === exercise?.id || a.exercise_index === idx
        )
        const latestAttempt = attempts.at(-1)
        if (!latestAttempt || latestAttempt.answer.trim() !== ans.trim()) {
          return true
        }
      }
    }

    for (const a of m.attempts) {
      if (a.correct === null) {
        const note = modNotes[a.id]
        if (note !== undefined && note.trim() !== (a.owner_note || '').trim() && note.trim().length > 0) {
          return true
        }
      }
    }
    return false
  })

  const hasUnsavedModuleDrafts = Object.values(draftStates).some((state) => !state.saved)
  const hasUnsavedOutline = Boolean(course && !course.outline_approved && outline !== outlineBase)
  const hasUnsentTutorQuestion = Object.values(tutorDraftQuestions).some((q) => q.trim().length > 0)
  const isCourseDirty =
    assessmentDirty ||
    hasUnsavedModuleDrafts ||
    hasUnsavedOutline ||
    hasUnsentTutorQuestion ||
    hasUnsavedPracticeWork

  useEffect(() => {
    if (!isCourseDirty) return
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault()
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [isCourseDirty])

  async function post(action: string, data: unknown) {
    setBusy(true)
    setError('')
    try {
      const response = await fetch(`/api/courses/${id}/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      })
      const result = await response.json() as { error?: string; module?: ModuleData; modules?: ModuleData[] }
      if (!response.ok) throw new Error(result.error || 'Something went wrong.')
      if (action === 'accept') {
        const body = data as { moduleId?: string } | null
        if (body?.moduleId) {
          setDraftStates((prev) => {
            const next = { ...prev }
            delete next[body.moduleId!]
            return next
          })
        }
      }
      await load(action === 'outline' || action === 'approve')
      return result
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.')
      return false
    } finally {
      setBusy(false)
    }
  }

  async function generateFirstModule() {
    const result = await post('module', {})
    if (result && typeof result === 'object' && 'module' in result && result.module) {
      setSelectedModuleId(result.module.id)
    }
  }

  async function generateNextModule() {
    const result = await post('modules', {})
    if (result && typeof result === 'object' && 'module' in result && result.module) {
      setSelectedModuleId(result.module.id)
    }
  }

  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!file) return
    const form = event.currentTarget
    setBusy(true)
    setError('')
    try {
      const data = new FormData()
      data.set('file', file)
      const response = await fetch(`/api/courses/${id}/sources`, { method: 'POST', body: data })
      const result = await response.json() as { error?: string }
      if (!response.ok) throw new Error(result.error || 'Could not add this source.')
      setFile(null)
      form.reset()
      await load(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add this source.')
    } finally {
      setBusy(false)
    }
  }

  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (await post('chat', { message })) setMessage('')
  }

  if (!course) {
    return (
      <section className="course-detail">
        <Button variant="ghost" className="back text-left p-0 h-auto font-normal hover:bg-transparent hover:underline" type="button" onClick={handleLibraryBack}>
          ← Your library
        </Button>
        <p role="status">{error || 'Opening your course…'}</p>
      </section>
    )
  }

  const modules = course.modules && course.modules.length > 0
    ? course.modules
    : (course.module ? [course.module] : [])

  const activeModule = (selectedModuleId ? modules.find((m) => m.id === selectedModuleId) : undefined)
    ?? (modules.find((m) => !m.accepted) ?? modules.at(-1) ?? null)

  const latestModule = modules.at(-1)
  const canGenerateNext = Boolean(course.outline_approved && latestModule?.accepted)
  const hasAcceptedModules = modules.some((m) => m.accepted)

  const currentDraftState: ModuleDraftState | undefined = activeModule && !activeModule.accepted
    ? (draftStates[activeModule.id] ?? {
        draft: {
          title: activeModule.title,
          lessons: activeModule.lessons,
          exercises: activeModule.exercises.map((item) => ({
            ...item,
            answer: item.answer || '',
            explanation: item.explanation || '',
          })),
        },
        saved: true,
        draftHash: activeModule.contentHash,
      })
    : undefined

  function handleDraftChange(moduleId: string, updatedDraft: DraftContent) {
    setDraftStates((prev) => ({
      ...prev,
      [moduleId]: {
        draft: updatedDraft,
        saved: false,
        draftHash: prev[moduleId]?.draftHash ?? activeModule?.contentHash ?? '',
      },
    }))
  }

  function handleDraftSaved(moduleId: string, newHash: string) {
    setDraftStates((prev) => {
      const existing = prev[moduleId]
      if (!existing) return prev
      return {
        ...prev,
        [moduleId]: {
          ...existing,
          saved: true,
          draftHash: newHash,
        },
      }
    })
  }

  function handleLibraryBack() {
    if (assessmentDirty) {
      if (!window.confirm('You have unsaved assessment answers. Do you want to leave your course?')) {
        return
      }
    } else if (hasUnsavedModuleDrafts) {
      if (!window.confirm('You have unsaved module draft edits. Do you want to leave your course without saving?')) {
        return
      }
    } else if (hasUnsavedOutline) {
      if (!window.confirm('You have unsaved outline changes. Do you want to leave without saving?')) {
        return
      }
    } else if (hasUnsentTutorQuestion) {
      if (!window.confirm('You have an unsent tutor question. Do you want to leave your course without sending?')) {
        return
      }
    } else if (hasUnsavedPracticeWork) {
      if (!window.confirm('You have unsaved exercise answers or notes. Do you want to leave without saving?')) {
        return
      }
    }
    onBack()
  }

  function handleSwitchToModules() {
    if (assessmentDirty) {
      if (!window.confirm('You have unsaved assessment answers. Do you want to switch to Modules?')) {
        return
      }
    }
    setViewSection('modules')
    setSelectedAssessmentId(null)
  }

  function handleSwitchToAssessments() {
    if (hasUnsentTutorQuestion) {
      if (!window.confirm('You have an unsent tutor question. Do you want to switch to Assessments?')) {
        return
      }
    }
    setViewSection('assessments')
  }

  return (
    <section className="course-detail">
      <div className="detail-actions">
        <Button variant="ghost" className="back text-left p-0 h-auto font-normal hover:bg-transparent hover:underline" type="button" onClick={handleLibraryBack}>
          ← Your library
        </Button>
        <a className="export-link" href={`/api/courses/${id}/export`} download>
          Export course ↓
        </a>
      </div>
      <p className="eyebrow">YOUR LEARNING SPACE / COURSE PLANNING</p>
      <h1>{course.title}<span className="accent">.</span></h1>
      <p className="intro">{course.goal}</p>
      <p className="source-disclaimer">
        {course.sources.length
          ? 'Source material is provided to the model; generated citations are not verified.'
          : 'No sources added. Generated material is unverified.'}
      </p>

      <details className="planning" open={modules.length === 0 || !modules[0].accepted}>
        <summary>Course planning and outline</summary>
        <div className="course-workspace">
          <section className="conversation">
            <div className="section-heading">
              <div>
                <p className="eyebrow">01 / PLAN TOGETHER</p>
                <h2>Shape your course</h2>
              </div>
            </div>
            <p className="muted">
              Tell your tutor about your experience, what you’re curious about, and how you like to learn. Up to 20 recent messages are sent to your model, within the context limit.
            </p>
            <details className="sources">
              <summary>Sources {course.sources.length ? `(${course.sources.length})` : '(optional)'}</summary>
              <p className="muted">Add Markdown, text, or a text-based PDF. Sources are sent to your configured model when generating the course.</p>
              {course.sources.length > 0 && (
                <ul>
                  {course.sources.map((source) => (
                    <li key={source.id}>
                      {source.name}{' '}
                      <Button
                        type="button"
                        className="text-button"
                        disabled={busy}
                        onClick={() => {
                          if (window.confirm(`Remove ${source.name} from this course?`)) {
                            void post('remove-source', { sourceId: source.id })
                          }
                        }}
                      >
                        Remove
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
              <form onSubmit={(event) => void upload(event)}>
                <label htmlFor="source">Add a source · up to 5 MB</label>
                <Input id="source" type="file" accept=".md,.markdown,.txt,.pdf" onChange={(event) => setFile(event.target.files?.[0] || null)} required />
                <Button className="secondary" disabled={busy}>Add source</Button>
              </form>
            </details>
            <div className="messages" aria-label="Conversation">
              {course.messages.length === 0 ? (
                <p className="message-hint">Start with what you already know, or ask for a suggested direction.</p>
              ) : (
                course.messages.map((item, index) => (
                  <article className={`message ${item.role}`} key={index}>
                    <p className="course-label">{item.role === 'user' ? 'YOU' : 'YOUR TUTOR'}</p>
                    <p>{item.content}</p>
                  </article>
                ))
              )}
            </div>
            <form onSubmit={(event) => void send(event)}>
              <label htmlFor="message">Your message</label>
              <Textarea id="message" rows={3} maxLength={4000} value={message} onChange={(event) => setMessage(event.target.value)} required />
              <Button className="primary" disabled={busy}>
                {busy ? 'Thinking…' : 'Send message'} <span aria-hidden="true">↗</span>
              </Button>
            </form>
          </section>

          <aside className="outline-panel">
            <p className="eyebrow">02 / YOUR OUTLINE</p>
            <h2>A plan to make it yours.</h2>
            <p className="muted">Generate an outline from your goal and conversation, then edit it before approving.</p>
            {course.outline_approved ? (
              <>
                <p className="approved">Outline approved</p>
                <div className="outline-text">{course.outline}</div>
                {modules.length === 0 && (
                  <Button className="primary" disabled={busy} type="button" onClick={generateFirstModule}>
                    {busy ? 'Preparing module…' : 'Generate first module'} <span aria-hidden="true">↗</span>
                  </Button>
                )}
              </>
            ) : (
              <>
                {!course.outline && (
                  <Button className="secondary" disabled={busy} type="button" onClick={() => void post('outline', { generate: true })}>
                    Generate outline
                  </Button>
                )}
                {course.outline && (
                  <form
                    onSubmit={(event) => {
                      event.preventDefault()
                      void post('outline', { outline, expectedOutline: outlineBase })
                    }}
                  >
                    <label htmlFor="outline">Edit your outline</label>
                    <Textarea id="outline" rows={15} maxLength={20000} value={outline} disabled={busy} onChange={(event) => setOutline(event.target.value)} required />
                    <Button className="secondary" disabled={busy || outlineBase !== course.outline}>Save changes</Button>
                    <Button className="primary" disabled={busy || outline !== course.outline || outlineBase !== course.outline} type="button" onClick={() => void post('approve', { expectedOutline: outlineBase })}>
                      Approve outline <span aria-hidden="true">↗</span>
                    </Button>
                    {outlineBase !== course.outline ? (
                      <p className="error" role="alert">The outline changed elsewhere. Copy any edits you want to keep, then reopen the course to review the latest version.</p>
                    ) : (
                      <p className="aside-note">Save your changes before approving.</p>
                    )}
                  </form>
                )}
              </>
            )}
          </aside>
        </div>
      </details>

      {hasAcceptedModules && (
        <nav className="course-view-nav" aria-label="Course section">
          <button
            type="button"
            className={`view-nav-item ${viewSection === 'modules' ? 'active' : ''}`}
            aria-current={viewSection === 'modules' ? 'true' : undefined}
            onClick={handleSwitchToModules}
          >
            Modules ({modules.length})
          </button>
          <button
            type="button"
            className={`view-nav-item ${viewSection === 'assessments' ? 'active' : ''}`}
            aria-current={viewSection === 'assessments' ? 'true' : undefined}
            onClick={handleSwitchToAssessments}
          >
            Assessments
          </button>
        </nav>
      )}

      {viewSection === 'assessments' ? (
        selectedAssessmentId ? (
          <AssessmentDetail
            courseId={id}
            assessmentId={selectedAssessmentId}
            initialAnswers={assessmentDraftAnswers[selectedAssessmentId]}
            onAnswersChange={(answers) =>
              setAssessmentDraftAnswers((prev) => ({ ...prev, [selectedAssessmentId]: answers }))
            }
            onDirtyChange={setAssessmentDirty}
            onBack={() => {
              setAssessmentDirty(false)
              setSelectedAssessmentId(null)
            }}
          />
        ) : (
          <AssessmentManager
            courseId={id}
            acceptedModules={modules.filter((m) => m.accepted)}
            onSelectAssessment={(assessmentId) => setSelectedAssessmentId(assessmentId)}
          />
        )
      ) : (
        <>
          {modules.length > 0 && (
            <nav className="module-nav" aria-label="Course modules">
              <div className="module-nav-header">
                <div>
                  <p className="eyebrow">COURSE MODULES</p>
                  <h3>Progress & Navigation ({modules.length})</h3>
                </div>
                {canGenerateNext && (
                  <Button
                    className="primary generate-next-btn"
                    disabled={busy}
                    type="button"
                    onClick={generateNextModule}
                  >
                    {busy ? 'Preparing module…' : 'Generate next module'} <span aria-hidden="true">↗</span>
                  </Button>
                )}
              </div>
              <ul className="module-list">
                {modules.map((m) => {
                  const isActive = m.id === activeModule?.id
                  const attemptCount = new Set(m.attempts.map((a) => a.exercise_index)).size
                  const isUnsaved = draftStates[m.id] && !draftStates[m.id].saved
                  return (
                    <li key={m.id}>
                      <button
                        type="button"
                        aria-current={isActive ? 'true' : undefined}
                        className={`module-nav-item ${isActive ? 'active' : ''}`}
                        onClick={() => setSelectedModuleId(m.id)}
                      >
                        <span className="module-nav-position">Module {m.position ?? 1}</span>
                        <strong className="module-nav-title">{m.title}</strong>
                        <span className="module-nav-status">
                          {m.accepted ? (
                            <>
                              <span className="badge-accepted">Accepted</span>
                              <span className="badge-attempts">
                                {attemptCount} of {m.exercises.length} attempted
                              </span>
                            </>
                          ) : (
                            <span className="badge-draft">
                              {isUnsaved ? 'Draft · Unsaved' : 'Draft'}
                            </span>
                          )}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </nav>
          )}

          {activeModule && (
            <div className="module-container">
              <ModuleView
                key={activeModule.id}
                courseId={id}
                module={activeModule}
                busy={busy}
                post={post}
                canGenerateNext={canGenerateNext && activeModule.id === latestModule?.id}
                onGenerateNext={generateNextModule}
                onOpenAssessments={handleSwitchToAssessments}
                draftState={currentDraftState}
                onDraftChange={(updated) => handleDraftChange(activeModule.id, updated)}
                onDraftSaved={(newHash) => handleDraftSaved(activeModule.id, newHash)}
                tutorDrafts={tutorDraftQuestions}
                onTutorDraftChange={(key, text) =>
                  setTutorDraftQuestions((prev) => ({ ...prev, [key]: text }))
                }
                currentDraftHash={modules.find((m) => !m.accepted)?.contentHash ?? null}
                practiceAnswers={practiceAnswers[activeModule.id] ?? {}}
                onPracticeAnswerChange={(index, ans) =>
                  setPracticeAnswers((prev) => ({
                    ...prev,
                    [activeModule.id]: { ...(prev[activeModule.id] ?? {}), [index]: ans },
                  }))
                }
                practiceNotes={practiceNotes[activeModule.id] ?? {}}
                onPracticeNoteChange={(attemptId, note) =>
                  setPracticeNotes((prev) => ({
                    ...prev,
                    [activeModule.id]: { ...(prev[activeModule.id] ?? {}), [attemptId]: note },
                  }))
                }
              />
            </div>
          )}
        </>
      )}

      {error && <p role="alert" className="error">{error}</p>}
    </section>
  )
}
