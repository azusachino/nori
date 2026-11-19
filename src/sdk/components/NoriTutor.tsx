import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  NoriClient,
  type PracticeAttempt,
  type TutorTurn,
} from '../index'
import {
  IconBot,
  IconCheckCircle,
  IconExerciseType,
  IconSend,
  IconSparkles,
  IconUser,
  IconWifi,
  IconWifiOff,
  IconXCircle,
} from './icons'
import { renderRichText } from './markdown'

export type NoriTutorProps = {
  courseKey: string
  lessonKey: string
  lessonAsset: string
  apiBaseUrl?: string
  title?: string
}

export function NoriTutor({
  courseKey,
  lessonKey,
  lessonAsset,
  apiBaseUrl = '/api/nori/v1',
  title = 'Contextual tutor',
}: NoriTutorProps) {
  const client = useMemo(() => new NoriClient({ baseUrl: apiBaseUrl }), [apiBaseUrl])
  const [lesson, setLesson] = useState<{ title: string; body: string } | null>(null)
  const [online, setOnline] = useState<'checking' | 'online' | 'offline'>('checking')
  const [llmConfigured, setLlmConfigured] = useState(false)
  const [attempts, setAttempts] = useState<PracticeAttempt[]>([])
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [turns, setTurns] = useState<TutorTurn[]>([])
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    fetch(lessonAsset, { signal: controller.signal })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`Lesson asset error (${r.status})`))))
      .then((d: { title: string; body: string }) => setLesson(d))
      .catch((e) => {
        if (!controller.signal.aborted) setError(e instanceof Error ? e.message : 'Could not load lesson context.')
      })
    return () => controller.abort()
  }, [lessonAsset])

  const loadPracticeAttempts = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const practice = await client.listPractice({ courseKey, lessonKey }, signal)
        if (!signal?.aborted) setAttempts(practice.attempts)
      } catch {
        // Ignore background refresh error
      }
    },
    [client, courseKey, lessonKey],
  )

  useEffect(() => {
    const controller = new AbortController()
    client
      .health(controller.signal)
      .then(async (h) => {
        if (controller.signal.aborted) return
        setLlmConfigured(h.llmConfigured)
        setOnline('online')
        const [practice, tutor] = await Promise.all([
          client.listPractice({ courseKey, lessonKey }, controller.signal),
          client.getTutor(courseKey, lessonKey, controller.signal),
        ])
        if (controller.signal.aborted) return
        setAttempts(practice.attempts)
        setTurns(tutor.turns)
      })
      .catch(() => {
        if (!controller.signal.aborted) setOnline('offline')
      })
    return () => controller.abort()
  }, [client, courseKey, lessonKey])

  // Auto-sync when <NoriPractice /> on the same page creates or updates an attempt
  useEffect(() => {
    if (typeof window === 'undefined') return
    const onUpdated = (e: Event) => {
      const detail = (e as CustomEvent<{ courseKey?: string; lessonKey?: string }>).detail
      if (!detail || (detail.courseKey === courseKey && (!detail.lessonKey || detail.lessonKey === lessonKey))) {
        loadPracticeAttempts()
      }
    }
    window.addEventListener('nori:practice-updated', onUpdated)
    return () => window.removeEventListener('nori:practice-updated', onUpdated)
  }, [courseKey, lessonKey, loadPracticeAttempts])

  const toggleAttempt = (id: string) => {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]))
  }

  const handleSend = async () => {
    if (!lesson || !message.trim()) return
    setBusy(true)
    setError(null)
    try {
      const res = await client.sendTutorMessage({
        courseKey,
        lessonKey,
        lessonTitle: lesson.title,
        lessonText: lesson.body,
        attemptIds: selectedIds,
        message: message.trim(),
      })
      setTurns(res.turns)
      setMessage('')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Tutor request failed.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="nori-practice" aria-label={title}>
      <header className="nori-practice__header">
        <h3 className="nori-practice__title">
          <IconBot />
          <span>{title}</span>
        </h3>
        <span className={`nori-badge ${online === 'online' ? 'nori-badge--online' : 'nori-badge--warn'}`} data-nori-status={online}>
          {online === 'online' ? <IconWifi /> : <IconWifiOff />}
          <span>
            {online === 'online'
              ? llmConfigured
                ? 'Nori tutor ready'
                : 'Sidecar connected · no LLM configured'
              : online === 'offline'
                ? 'Offline · tutor unavailable'
                : 'Checking sidecar…'}
          </span>
        </span>
      </header>

      {error && <p className="nori-error">{error}</p>}

      {online === 'online' && (
        <>
          {attempts.length > 0 && (
            <div className="nori-card">
              <p className="nori-muted">Include recorded attempts in tutor context ({selectedIds.length} selected):</p>
              <div className="nori-options">
                {attempts.map((a) => (
                  <label key={a.id} className="nori-option">
                    <input type="checkbox" data-ui="nori" checked={selectedIds.includes(a.id)} onChange={() => toggleAttempt(a.id)} />
                    <div className="nori-option__body">
                      <div className="nori-practice__meta" style={{ marginBottom: '0.2rem' }}>
                        <span className="nori-badge">
                          <IconExerciseType type={a.exerciseSnapshot.type} />
                          <strong>{a.exerciseKey}</strong>
                        </span>
                        {a.grading === 'deterministic' && (
                          <span className={`nori-badge ${a.correct === 1 ? 'nori-badge--correct' : 'nori-badge--incorrect'}`}>
                            {a.correct === 1 ? <IconCheckCircle /> : <IconXCircle />}
                            <span>{a.correct === 1 ? 'Correct' : 'Incorrect'}</span>
                          </span>
                        )}
                      </div>
                      <div className="nori-attempt__answer">{renderRichText(a.answer)}</div>
                    </div>
                  </label>
                ))}
              </div>
            </div>
          )}

          {turns.length > 0 && (
            <div className="nori-history">
              {turns.map((t) => (
                <div key={t.id} className={t.role === 'assistant' ? 'nori-feedback' : 'nori-attempt'}>
                  <div className="nori-feedback__header">
                    {t.role === 'assistant' ? <IconSparkles /> : <IconUser />}
                    <strong>{t.role === 'assistant' ? 'Tutor' : 'You'}</strong>
                  </div>
                  <div className="nori-attempt__answer">{renderRichText(t.content)}</div>
                  {t.role === 'assistant' && (
                    <p className="nori-muted">
                      Context: {t.contextMeta.contextChars} chars · {t.contextMeta.attemptIds.length} attempt(s) · {t.contextMeta.historyTurnsIncluded} prior turn(s)
                    </p>
                  )}
                </div>
              ))}
            </div>
          )}

          <div className="nori-card">
            <textarea
              data-ui="nori"
              className="nori-textarea"
              placeholder="Ask a question about this lesson or your selected attempts…"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
            />
            <div className="nori-actions">
              <button
                type="button"
                data-ui="nori"
                className="nori-btn nori-btn--primary"
                disabled={busy || !lesson || !llmConfigured || !message.trim()}
                onClick={handleSend}
              >
                <IconSend />
                <span>{busy ? 'Asking tutor…' : 'Ask tutor'}</span>
              </button>
            </div>
          </div>
        </>
      )}
    </section>
  )
}
