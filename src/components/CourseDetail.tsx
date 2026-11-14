import { useEffect, useState, type FormEvent } from 'react'
import { ModuleView, type ModuleData } from './ModuleView'

type Course = { id: string; title: string; goal: string; outline: string; outline_approved: number; module: ModuleData | null; sources: { id: string; name: string }[]; messages: { role: 'user' | 'assistant'; content: string }[] }

export function CourseDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const [course, setCourse] = useState<Course | null>(null)
  const [message, setMessage] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [outline, setOutline] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function load(syncOutline = true) {
    const response = await fetch(`/api/courses/${id}`)
    if (!response.ok) throw new Error('Could not open this course.')
    const value = await response.json() as Course
    setCourse(value); if (syncOutline) setOutline(value.outline)
  }
  useEffect(() => { void load().catch((err: Error) => setError(err.message)) }, [id])
  async function post(action: string, data: unknown) {
    setBusy(true); setError('')
    try {
      const response = await fetch(`/api/courses/${id}/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })
      const result = await response.json() as { error?: string }
      if (!response.ok) throw new Error(result.error || 'Something went wrong.')
      await load(action === 'outline' || action === 'approve')
      return true
    } catch (err) { setError(err instanceof Error ? err.message : 'Something went wrong.'); return false }
    finally { setBusy(false) }
  }
  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!file) return
    const form = event.currentTarget
    setBusy(true); setError('')
    try {
      const data = new FormData(); data.set('file', file)
      const response = await fetch(`/api/courses/${id}/sources`, { method: 'POST', body: data })
      const result = await response.json() as { error?: string }
      if (!response.ok) throw new Error(result.error || 'Could not add this source.')
      setFile(null); form.reset(); await load(false)
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not add this source.') }
    finally { setBusy(false) }
  }
  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (await post('chat', { message })) setMessage('')
  }
  if (!course) return <section className="course-detail"><button className="back" type="button" onClick={onBack}>← Your library</button><p>{error || 'Opening your course…'}</p></section>
  return <section className="course-detail">
    <div className="detail-actions"><button className="back" type="button" onClick={onBack}>← Your library</button><a className="export-link" href={`/api/courses/${id}/export`} download>Export course ↓</a></div>
    <p className="eyebrow">YOUR LEARNING SPACE / COURSE PLANNING</p><h1>{course.title}<span className="accent">.</span></h1><p className="intro">{course.goal}</p>
    <div className="course-workspace"><section className="conversation"><div className="section-heading"><div><p className="eyebrow">01 / PLAN TOGETHER</p><h2>Shape your course</h2></div></div><p className="muted">Tell your tutor about your experience, what you’re curious about, and how you like to learn.</p>
      <details className="sources"><summary>Sources {course.sources.length ? `(${course.sources.length})` : '(optional)'}</summary><p className="muted">Add Markdown, text, or a text-based PDF. Sources are sent to your configured model when generating the course.</p>{course.sources.length > 0 && <ul>{course.sources.map((source) => <li key={source.id}>{source.name}</li>)}</ul>}<form onSubmit={(event) => void upload(event)}><label htmlFor="source">Add a source · up to 5 MB</label><input id="source" type="file" accept=".md,.markdown,.txt,.pdf" onChange={(event) => setFile(event.target.files?.[0] || null)} required /><button className="secondary" disabled={busy}>Add source</button></form></details>
      <div className="messages" aria-label="Conversation">{course.messages.length === 0 ? <p className="message-hint">Start with what you already know, or ask for a suggested direction.</p> : course.messages.map((item, index) => <article className={`message ${item.role}`} key={index}><p className="course-label">{item.role === 'user' ? 'YOU' : 'YOUR TUTOR'}</p><p>{item.content}</p></article>)}</div>
      <form onSubmit={(event) => void send(event)}><label htmlFor="message">Your message</label><textarea id="message" rows={3} maxLength={4000} value={message} onChange={(event) => setMessage(event.target.value)} required /><button className="primary" disabled={busy}>{busy ? 'Thinking…' : 'Send message'} <span aria-hidden="true">↗</span></button></form>
    </section><aside className="outline-panel"><p className="eyebrow">02 / YOUR OUTLINE</p><h2>A plan to make it yours.</h2><p className="muted">Generate an outline from your goal and conversation, then edit it before approving.</p>
      {course.outline_approved ? <><p className="approved">Outline approved</p><div className="outline-text">{course.outline}</div>{!course.module && <button className="primary" disabled={busy} type="button" onClick={() => void post('module', {})}>{busy ? 'Preparing module…' : 'Generate first module'} <span aria-hidden="true">↗</span></button>}</> : <>{!course.outline && <button className="secondary" disabled={busy} type="button" onClick={() => void post('outline', { generate: true })}>Generate outline</button>}{course.outline && <form onSubmit={(event) => { event.preventDefault(); void post('outline', { outline }) }}><label htmlFor="outline">Edit your outline</label><textarea id="outline" rows={15} maxLength={20000} value={outline} onChange={(event) => setOutline(event.target.value)} required /><button className="secondary" disabled={busy}>Save changes</button><button className="primary" disabled={busy || outline !== course.outline} type="button" onClick={() => void post('approve', {})}>Approve outline <span aria-hidden="true">↗</span></button><p className="aside-note">Save your changes before approving.</p></form>}</>}
    </aside></div>{course.module && <ModuleView module={course.module} busy={busy} post={post} />}{error && <p role="alert" className="error">{error}</p>}
  </section>
}
