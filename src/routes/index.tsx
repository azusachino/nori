import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useState, type FormEvent } from 'react'
import { CourseDetail } from '../components/CourseDetail'

export const Route = createFileRoute('/')({ component: Home })

type Course = { id: string; title: string; goal: string; created_at: string }

function Home() {
  const [courses, setCourses] = useState<Course[] | null>(null)
  const [signedIn, setSignedIn] = useState<boolean | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [password, setPassword] = useState('')
  const [title, setTitle] = useState('')
  const [goal, setGoal] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function load() {
    try {
      const response = await fetch('/api/courses')
      if (response.status === 401) { setSignedIn(false); return }
      if (!response.ok) throw new Error('Could not load your library.')
      setCourses(await response.json())
      setSignedIn(true)
    } catch { setError('Could not reach Same. Please try again.'); setSignedIn(false) }
  }
  useEffect(() => { void load() }, [])

  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError('')
    try {
      const response = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) })
      if (!response.ok) throw new Error(response.status === 429 ? 'Too many attempts. Try again later.' : 'Could not sign in. Check your password.')
      setPassword(''); await load()
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not sign in.') }
    finally { setBusy(false) }
  }
  async function createCourse(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError('')
    try {
      const response = await fetch('/api/courses', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title, goal }) })
      if (!response.ok) throw new Error('Could not save your learning goal.')
      setTitle(''); setGoal(''); await load()
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not save your learning goal.') }
    finally { setBusy(false) }
  }
  async function signOut() {
    try {
      const response = await fetch('/api/logout', { method: 'POST' })
      if (!response.ok) throw new Error('Could not sign out.')
      setCourses(null); setSelectedId(null); setSignedIn(false)
    } catch { setError('Could not sign out. Please try again.') }
  }

  return <>
    <header className="topbar"><a className="brand" href="/" aria-label="Same home"><span aria-hidden="true" className="brand-mark">s</span>same<span className="brand-dot">.</span></a><span className="top-caption">A little space to learn</span>{signedIn && <button className="text-button" type="button" onClick={() => void signOut()}>Sign out</button>}</header>
    <main className="page">
      {signedIn === null ? <p>Opening your library…</p> : signedIn === false ? <section className="sign-in"><p className="eyebrow">YOUR LEARNING SPACE</p><h1>Welcome back.</h1><p className="intro">Sign in to pick up where you left off.</p><form onSubmit={(e) => void signIn(e)}><label htmlFor="password">Password</label><input id="password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /><button className="primary" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'} <span aria-hidden="true">↗</span></button></form></section> : selectedId ? <CourseDetail id={selectedId} onBack={() => { setSelectedId(null); void load() }} /> : <>
        <section className="welcome"><div><p className="eyebrow">YOUR LEARNING SPACE <span> / </span> LIBRARY</p><h1>Good to see you<span className="accent">.</span></h1><p className="intro">A place for the things you want to understand.</p></div><div className="date-stamp"><span>YOUR LIBRARY</span><strong>{String(courses?.length ?? 0).padStart(2, '0')}</strong><span>LEARNING GOALS</span></div></section>
        <div className="workspace"><section className="library"><div className="section-heading"><div><p className="eyebrow">01 / YOUR LIBRARY</p><h2>What you’re learning</h2></div><span className="count">{courses?.length ?? 0} saved</span></div>{courses?.length ? <ul className="course-list">{courses.map((course, index) => <li key={course.id}><div className="course-number">{String(index + 1).padStart(2, '0')}</div><div><p className="course-label">LEARNING GOAL</p><h3><button className="course-link" type="button" onClick={() => setSelectedId(course.id)}>{course.title}</button></h3><p>{course.goal}</p></div><span className="course-status">Saved</span></li>)}</ul> : <div className="empty"><div className="empty-illustration" aria-hidden="true"><span>✳</span><i></i><b></b></div><h3>Your next curiosity starts here.</h3><p>Save a learning goal to begin building your library.</p></div>}</section>
        <aside className="start"><p className="eyebrow">02 / START SOMETHING</p><h2>What would you like to learn?</h2><p>Give your idea a name and a little context. You can return to it later.</p><form onSubmit={(e) => void createCourse(e)}><label htmlFor="title">Topic</label><input id="title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={160} placeholder="e.g. Kubernetes networking" required /><label htmlFor="goal">Your learning goal</label><textarea id="goal" value={goal} onChange={(e) => setGoal(e.target.value)} maxLength={4000} rows={5} placeholder="What would you like to be able to do?" required /><button className="primary" disabled={busy}>{busy ? 'Saving…' : 'Save learning goal'} <span aria-hidden="true">↗</span></button></form><p className="aside-note">Course generation is coming next. Your goal is saved locally.</p></aside></div>
      </>}
      {error && <p className="error" role="alert">{error}</p>}
    </main><footer className="footer"><span>TAKE YOUR TIME. LEARN SOMETHING WELL.</span><span>MADE FOR CURIOUS MINDS ✳</span></footer>
  </>
}
