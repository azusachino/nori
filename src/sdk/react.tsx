import { Fragment, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  checkMultipleChoice,
  computeContentHash,
  formatAttemptsAsMarkdown,
  loadLocalDrafts,
  NoriApiError,
  NoriClient,
  removeLocalDraft,
  saveLocalDraft,
  type AssessmentDetail,
  type HealthStatus,
  type LocalDraft,
  type PracticeAttempt,
  type PracticeBank,
  type PracticeExercise,
  type TutorTurn,
} from './index'

export type NoriPracticeProps = {
  courseKey: string
  lessonKey?: string
  bank?: string
  exercises?: PracticeExercise[]
  apiBaseUrl?: string
  title?: string
}

const INLINE_TOKEN_RE = /(\[\[([^\]|]+)(?:\|([^\]]+))?\]\]|`([^`]+)`|\*\*([^*]+)\*\*|\[([^\]]+)\]\((https?:\/\/[^\s)]+|\/[^\s)]+)\))/g

export function renderInlineMarkdown(text: string): ReactNode[] {
  const nodes: ReactNode[] = []
  let lastIndex = 0
  let key = 0
  for (const match of text.matchAll(INLINE_TOKEN_RE)) {
    const idx = match.index ?? 0
    if (idx > lastIndex) {
      nodes.push(text.slice(lastIndex, idx))
    }
    if (match[2] !== undefined) {
      const rawTarget = match[2].trim()
      const label = (match[3] ?? rawTarget.split('/').pop() ?? rawTarget).trim()
      const href = `/${rawTarget.replace(/\.md$/, '').replace(/\/index$/, '')}`
      nodes.push(
        <a key={`w-${key++}`} href={href}>
          {label}
        </a>,
      )
    } else if (match[4] !== undefined) {
      nodes.push(<code key={`c-${key++}`}>{match[4]}</code>)
    } else if (match[5] !== undefined) {
      nodes.push(<strong key={`b-${key++}`}>{match[5]}</strong>)
    } else if (match[6] !== undefined && match[7] !== undefined) {
      nodes.push(
        <a key={`l-${key++}`} href={match[7]}>
          {match[6]}
        </a>,
      )
    }
    lastIndex = idx + match[0].length
  }
  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex))
  }
  return nodes
}

export function renderRichText(text: string): ReactNode {
  const parts = text.split(/(```[\s\S]*?```)/g)
  return parts.map((part, idx) => {
    if (part.startsWith('```') && part.endsWith('```')) {
      const inner = part.slice(3, -3).replace(/^[a-zA-Z0-9_-]+\n/, '')
      return (
        <pre key={`pre-${idx}`} className="nori-codeblock">
          <code>{inner}</code>
        </pre>
      )
    }
    return <Fragment key={`txt-${idx}`}>{renderInlineMarkdown(part)}</Fragment>
  })
}

export function NoriPractice({
  courseKey,
  lessonKey = '',
  bank,
  exercises: inlineExercises,
  apiBaseUrl = '/api/nori/v1',
  title = 'Practice',
}: NoriPracticeProps) {
  const client = useMemo(() => new NoriClient({ baseUrl: apiBaseUrl }), [apiBaseUrl])

  const [exercises, setExercises] = useState<PracticeExercise[]>(inlineExercises ?? [])
  const [hashes, setHashes] = useState<Record<string, string>>({})
  const [bankError, setBankError] = useState<string | null>(null)
  const [health, setHealth] = useState<HealthStatus | null>(null)
  const [connectionState, setConnectionState] = useState<'checking' | 'online' | 'offline'>('checking')
  const [attempts, setAttempts] = useState<PracticeAttempt[]>([])
  const [drafts, setDrafts] = useState<Record<string, LocalDraft>>(() => loadLocalDrafts(courseKey, lessonKey))
  const [inputs, setInputs] = useState<Record<string, string>>({})
  const [noteInputs, setNoteInputs] = useState<Record<string, string>>({})
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [errorByKey, setErrorByKey] = useState<Record<string, string>>({})
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    const loaded = loadLocalDrafts(courseKey, lessonKey)
    setDrafts(loaded)
    setInputs((prev) => {
      const merged = { ...prev }
      for (const draft of Object.values(loaded)) {
        if (!(draft.exerciseKey in merged)) merged[draft.exerciseKey] = draft.answer
      }
      return merged
    })
  }, [courseKey, lessonKey])

  useEffect(() => {
    if (inlineExercises) {
      setExercises(inlineExercises)
      setBankError(null)
      return
    }
    if (!bank) return
    const controller = new AbortController()
    fetch(bank, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`Failed to load exercise bank (${res.status})`)
        const data = (await res.json()) as PracticeBank
        setExercises(Array.isArray(data.exercises) ? data.exercises : [])
        setBankError(null)
      })
      .catch((err) => {
        if (controller.signal.aborted) return
        setBankError(err instanceof Error ? err.message : 'Could not load exercises.')
      })
    return () => controller.abort()
  }, [bank, inlineExercises])

  useEffect(() => {
    let cancelled = false
    Promise.all(exercises.map(async (ex) => [ex.key, await computeContentHash(ex)] as const)).then((entries) => {
      if (!cancelled) setHashes(Object.fromEntries(entries))
    })
    return () => {
      cancelled = true
    }
  }, [exercises])

  const refreshOnlineState = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const status = await client.health(signal)
        if (signal?.aborted) return
        setHealth(status)
        setConnectionState('online')
        const data = await client.listPractice({ courseKey, lessonKey }, signal)
        if (signal?.aborted) return
        setAttempts(data.attempts)
      } catch {
        if (signal?.aborted) return
        setHealth(null)
        setConnectionState('offline')
      }
    },
    [client, courseKey, lessonKey],
  )

  useEffect(() => {
    const controller = new AbortController()
    refreshOnlineState(controller.signal)
    return () => controller.abort()
  }, [refreshOnlineState])

  const submitAnswer = async (exercise: PracticeExercise, overrideAnswer?: string) => {
    const answer = overrideAnswer ?? inputs[exercise.key] ?? ''
    if (exercise.type === 'multiple_choice' ? !exercise.options.includes(answer) : !answer.trim()) {
      setErrorByKey((prev) => ({ ...prev, [exercise.key]: 'Enter or select an answer first.' }))
      return
    }
    setErrorByKey((prev) => ({ ...prev, [exercise.key]: '' }))

    if (connectionState !== 'online') {
      const localDraft: LocalDraft = {
        exerciseKey: exercise.key,
        answer,
        updatedAt: Date.now(),
        correct: exercise.type === 'multiple_choice' ? (checkMultipleChoice(exercise, answer) ? 1 : 0) : null,
      }
      setDrafts(saveLocalDraft(courseKey, lessonKey, localDraft))
      return
    }

    setBusyKey(`submit:${exercise.key}`)
    try {
      const contentHash = hashes[exercise.key] ?? (await computeContentHash(exercise))
      const created = await client.createAttempt({
        courseKey,
        lessonKey,
        exerciseKey: exercise.key,
        contentHash,
        exerciseSnapshot: {
          type: exercise.type,
          prompt: exercise.prompt,
          options: exercise.options,
          answer: exercise.answer,
          explanation: exercise.explanation,
        },
        answer,
      })
      setAttempts((prev) => [...prev, created])
      setDrafts(removeLocalDraft(courseKey, lessonKey, exercise.key))
    } catch (err) {
      if (err instanceof NoriApiError) {
        setErrorByKey((prev) => ({ ...prev, [exercise.key]: err.message }))
      } else {
        setConnectionState('offline')
        const localDraft: LocalDraft = {
          exerciseKey: exercise.key,
          answer,
          updatedAt: Date.now(),
          correct: exercise.type === 'multiple_choice' ? (checkMultipleChoice(exercise, answer) ? 1 : 0) : null,
        }
        setDrafts(saveLocalDraft(courseKey, lessonKey, localDraft))
        setErrorByKey((prev) => ({ ...prev, [exercise.key]: 'Sidecar unreachable — saved locally as an unsent draft.' }))
      }
    } finally {
      setBusyKey(null)
    }
  }

  const handleFeedback = async (attempt: PracticeAttempt) => {
    setBusyKey(`feedback:${attempt.id}`)
    setErrorByKey((prev) => ({ ...prev, [attempt.id]: '' }))
    try {
      const updated = await client.requestFeedback(attempt.id, attempt.version)
      setAttempts((prev) => prev.map((item) => (item.id === updated.id ? updated : item)))
    } catch (err) {
      if (err instanceof NoriApiError && err.attempt) {
        setAttempts((prev) => prev.map((item) => (item.id === err.attempt!.id ? err.attempt! : item)))
      }
      setErrorByKey((prev) => ({ ...prev, [attempt.id]: err instanceof Error ? err.message : 'Feedback failed.' }))
    } finally {
      setBusyKey(null)
    }
  }

  const handleCorrection = async (attempt: PracticeAttempt) => {
    const note = noteInputs[attempt.id] ?? attempt.ownerNote
    setBusyKey(`correct:${attempt.id}`)
    setErrorByKey((prev) => ({ ...prev, [attempt.id]: '' }))
    try {
      const updated = await client.saveCorrection(attempt.id, note, attempt.version)
      setAttempts((prev) => prev.map((item) => (item.id === updated.id ? updated : item)))
    } catch (err) {
      if (err instanceof NoriApiError && err.attempt) {
        setAttempts((prev) => prev.map((item) => (item.id === err.attempt!.id ? err.attempt! : item)))
      }
      setErrorByKey((prev) => ({ ...prev, [attempt.id]: err instanceof Error ? err.message : 'Could not save correction.' }))
    } finally {
      setBusyKey(null)
    }
  }

  const handleCopyMarkdown = async () => {
    const md = formatAttemptsAsMarkdown({ courseKey, lessonKey, attempts, drafts })
    try {
      await navigator.clipboard.writeText(md)
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } catch {
      setErrorByKey((prev) => ({ ...prev, _global: 'Clipboard unavailable in this browser context.' }))
    }
  }

  return (
    <section className="nori-practice" aria-label={title}>
      <header className="nori-practice__header">
        <h3 className="nori-practice__title">{title}</h3>
        <div className="nori-practice__meta">
          {connectionState === 'online' ? (
            <span className="nori-badge nori-badge--online" data-nori-status="online">
              Nori sidecar connected{health?.llmConfigured ? ' · AI ready' : ' · no LLM'}
            </span>
          ) : connectionState === 'offline' ? (
            <span className="nori-badge nori-badge--warn" data-nori-status="offline">
              Offline · local mode (AI feedback &amp; sync paused)
            </span>
          ) : (
            <span className="nori-badge" data-nori-status="checking">
              Checking sidecar…
            </span>
          )}
          <button type="button" data-ui="nori" className="nori-btn" onClick={handleCopyMarkdown}>
            {copied ? 'Copied Markdown' : 'Copy as Markdown'}
          </button>
        </div>
      </header>

      {bankError && <p className="nori-error">{bankError}</p>}
      {errorByKey._global && <p className="nori-error">{errorByKey._global}</p>}

      {exercises.map((exercise) => {
        const exerciseAttempts = attempts.filter((item) => item.exerciseKey === exercise.key)
        const currentHash = hashes[exercise.key]
        const localDraft = drafts[exercise.key]
        const value = inputs[exercise.key] ?? ''
        const hasSubmitted = exerciseAttempts.length > 0 || Boolean(localDraft)

        return (
          <article key={exercise.key} className="nori-card" data-exercise-key={exercise.key}>
            <div className="nori-card__top">
              <span className="nori-badge">{exercise.type.replace('_', ' ')}</span>
              {localDraft && (
                <span className="nori-badge nori-badge--warn">
                  Unsent local draft
                  {exercise.type === 'multiple_choice' && localDraft.correct !== null && localDraft.correct !== undefined
                    ? localDraft.correct === 1
                      ? ' · Correct'
                      : ' · Incorrect'
                    : ''}
                </span>
              )}
            </div>

            <div className="nori-card__prompt">{renderRichText(exercise.prompt)}</div>

            {exercise.type === 'multiple_choice' ? (
              <div className="nori-options" role="radiogroup" aria-label={exercise.prompt}>
                {exercise.options.map((option) => (
                  <label key={option} className="nori-option">
                    <input
                      type="radio"
                      data-ui="nori"
                      name={`nori-${courseKey}-${lessonKey}-${exercise.key}`}
                      value={option}
                      checked={value === option}
                      onChange={() => setInputs((prev) => ({ ...prev, [exercise.key]: option }))}
                    />
                    <span>{renderInlineMarkdown(option)}</span>
                  </label>
                ))}
              </div>
            ) : (
              <textarea
                data-ui="nori"
                className={`nori-textarea${exercise.type === 'code' ? ' nori-textarea--code' : ''}`}
                placeholder={exercise.type === 'code' ? 'Write your code attempt (not executed)…' : 'Write your explanation in your own words…'}
                value={value}
                onChange={(e) => setInputs((prev) => ({ ...prev, [exercise.key]: e.target.value }))}
              />
            )}

            <div className="nori-actions">
              <button
                type="button"
                data-ui="nori"
                className="nori-btn nori-btn--primary"
                disabled={busyKey === `submit:${exercise.key}`}
                onClick={() => submitAnswer(exercise)}
              >
                {connectionState === 'online'
                  ? busyKey === `submit:${exercise.key}`
                    ? 'Saving…'
                    : 'Submit attempt'
                  : exercise.type === 'multiple_choice'
                    ? 'Check locally'
                    : 'Save draft locally'}
              </button>

              {connectionState === 'online' && localDraft && (
                <button
                  type="button"
                  data-ui="nori"
                  className="nori-btn"
                  disabled={busyKey === `submit:${exercise.key}`}
                  onClick={() => submitAnswer(exercise, localDraft.answer)}
                >
                  Submit saved draft to Nori
                </button>
              )}
            </div>

            {errorByKey[exercise.key] && <p className="nori-error">{errorByKey[exercise.key]}</p>}

            {hasSubmitted && (
              <details className="nori-details">
                <summary>Reference answer &amp; explanation</summary>
                <div className="nori-attempt__answer">{renderRichText(exercise.answer)}</div>
                {exercise.explanation && <div className="nori-muted">{renderRichText(exercise.explanation)}</div>}
              </details>
            )}

            {exerciseAttempts.length > 0 && (
              <div className="nori-history">
                <p className="nori-muted">Recorded attempts ({exerciseAttempts.length})</p>
                {exerciseAttempts.map((attempt) => {
                  const drifted = Boolean(currentHash && attempt.contentHash !== currentHash)
                  const noteValue = noteInputs[attempt.id] ?? attempt.ownerNote
                  return (
                    <div key={attempt.id} className="nori-attempt" data-attempt-id={attempt.id}>
                      <div className="nori-card__top">
                        <span className="nori-badge">
                          {attempt.grading === 'deterministic'
                            ? attempt.correct === 1
                              ? 'Correct'
                              : 'Incorrect'
                            : 'Unscored'}
                        </span>
                        {drifted && <span className="nori-badge nori-badge--warn">Previous question version</span>}
                      </div>

                      {drifted && <div className="nori-muted">Prompt at attempt time: {renderInlineMarkdown(attempt.exerciseSnapshot.prompt)}</div>}
                      <p className="nori-attempt__answer">{attempt.answer}</p>

                      {attempt.feedback && (
                        <div className="nori-feedback">
                          <strong>Advisory AI feedback:</strong>
                          {'\n'}
                          {renderRichText(attempt.feedback)}
                        </div>
                      )}

                      {attempt.grading === 'unscored' && connectionState === 'online' && (
                        <div className="nori-actions">
                          <button
                            type="button"
                            data-ui="nori"
                            className="nori-btn"
                            disabled={busyKey === `feedback:${attempt.id}` || !health?.llmConfigured}
                            onClick={() => handleFeedback(attempt)}
                          >
                            {busyKey === `feedback:${attempt.id}`
                              ? 'Requesting feedback…'
                              : attempt.feedback
                                ? 'Refresh advisory feedback'
                                : 'Ask AI for advisory feedback'}
                          </button>
                        </div>
                      )}

                      {connectionState === 'online' && (
                        <div className="nori-actions">
                          <input
                            type="text"
                            data-ui="nori"
                            className="nori-textarea"
                            style={{ minHeight: '36px', flex: '1 1 200px' }}
                            placeholder="Record correction or takeaway…"
                            value={noteValue}
                            onChange={(e) => setNoteInputs((prev) => ({ ...prev, [attempt.id]: e.target.value }))}
                          />
                          <button
                            type="button"
                            data-ui="nori"
                            className="nori-btn"
                            disabled={busyKey === `correct:${attempt.id}`}
                            onClick={() => handleCorrection(attempt)}
                          >
                            {busyKey === `correct:${attempt.id}` ? 'Saving…' : 'Save correction'}
                          </button>
                        </div>
                      )}

                      {errorByKey[attempt.id] && <p className="nori-error">{errorByKey[attempt.id]}</p>}
                    </div>
                  )
                })}
              </div>
            )}
          </article>
        )
      })}
    </section>
  )
}

export type NoriAssessmentProps = {
  courseKey: string
  lessonKey?: string
  bank?: string
  exercises?: PracticeExercise[]
  apiBaseUrl?: string
  title?: string
}

export function NoriAssessment({
  courseKey,
  lessonKey = '',
  bank,
  exercises: inlineExercises,
  apiBaseUrl = '/api/nori/v1',
  title = 'Assessment',
}: NoriAssessmentProps) {
  const client = useMemo(() => new NoriClient({ baseUrl: apiBaseUrl }), [apiBaseUrl])
  const [exercises, setExercises] = useState<PracticeExercise[]>(inlineExercises ?? [])
  const [online, setOnline] = useState<'checking' | 'online' | 'offline'>('checking')
  const [llmConfigured, setLlmConfigured] = useState(false)
  const [assessments, setAssessments] = useState<AssessmentDetail[]>([])
  const [active, setActive] = useState<AssessmentDetail | null>(null)
  const [mode, setMode] = useState<'untimed' | 'timed'>('untimed')
  const [minutes, setMinutes] = useState(15)
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [notes, setNotes] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (inlineExercises) {
      setExercises(inlineExercises)
      return
    }
    if (!bank) return
    const controller = new AbortController()
    fetch(bank, { signal: controller.signal })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`Bank error (${r.status})`))))
      .then((d: PracticeBank) => setExercises(Array.isArray(d.exercises) ? d.exercises : []))
      .catch((e) => {
        if (!controller.signal.aborted) setError(e instanceof Error ? e.message : 'Failed to load bank.')
      })
    return () => controller.abort()
  }, [bank, inlineExercises])

  useEffect(() => {
    const controller = new AbortController()
    client
      .health(controller.signal)
      .then(async (h) => {
        if (controller.signal.aborted) return
        setLlmConfigured(h.llmConfigured)
        setOnline('online')
        const list = await client.listAssessments(courseKey, controller.signal)
        if (!controller.signal.aborted) setAssessments(list.assessments)
      })
      .catch(() => {
        if (!controller.signal.aborted) setOnline('offline')
      })
    return () => controller.abort()
  }, [client, courseKey])

  const syncAssessment = (detail: AssessmentDetail) => {
    setActive(detail)
    setAssessments((prev) => [detail, ...prev.filter((a) => a.id !== detail.id)])
    const nextAnswers: Record<string, string> = {}
    for (const item of detail.items) {
      if (item.answer !== null) nextAnswers[item.id] = item.answer
    }
    setAnswers((prev) => ({ ...nextAnswers, ...prev }))
  }

  const handleCreateAndStart = async () => {
    if (!exercises.length) return
    setBusy('create')
    setError(null)
    try {
      const created = await client.createAssessment({
        courseKey,
        title: `${title} (${new Date().toISOString().slice(0, 10)})`,
        mode,
        durationSeconds: mode === 'timed' ? minutes * 60 : undefined,
        items: exercises.map((ex) => ({
          lessonKey,
          exerciseKey: ex.key,
          exerciseSnapshot: { type: ex.type, prompt: ex.prompt, options: ex.options, answer: ex.answer, explanation: ex.explanation },
        })),
      })
      const started = await client.startAssessment(created.id)
      setAnswers({})
      syncAssessment(started)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start assessment.')
    } finally {
      setBusy(null)
    }
  }

  const handleSaveItem = async (itemId: string) => {
    if (!active) return
    setBusy(`save:${itemId}`)
    setError(null)
    try {
      const updated = await client.saveAssessmentAnswer(active.id, itemId, answers[itemId] ?? '', active.version)
      syncAssessment(updated)
    } catch (e) {
      if (e instanceof NoriApiError && e.assessment) syncAssessment(e.assessment)
      setError(e instanceof Error ? e.message : 'Could not save answer.')
    } finally {
      setBusy(null)
    }
  }

  const handleSubmit = async () => {
    if (!active) return
    setBusy('submit')
    setError(null)
    try {
      const finalized = await client.submitAssessment(active.id, active.version)
      syncAssessment(finalized)
    } catch (e) {
      if (e instanceof NoriApiError && e.assessment) syncAssessment(e.assessment)
      setError(e instanceof Error ? e.message : 'Could not submit assessment.')
    } finally {
      setBusy(null)
    }
  }

  const handleFeedback = async (itemId: string) => {
    if (!active) return
    setBusy(`fb:${itemId}`)
    setError(null)
    try {
      const updated = await client.requestAssessmentFeedback(active.id, itemId, active.version)
      syncAssessment(updated)
    } catch (e) {
      if (e instanceof NoriApiError && e.assessment) syncAssessment(e.assessment)
      setError(e instanceof Error ? e.message : 'Feedback failed.')
    } finally {
      setBusy(null)
    }
  }

  const handleCorrect = async (itemId: string) => {
    if (!active) return
    setBusy(`corr:${itemId}`)
    setError(null)
    try {
      const updated = await client.saveAssessmentCorrection(active.id, itemId, notes[itemId] ?? '', active.version)
      syncAssessment(updated)
    } catch (e) {
      if (e instanceof NoriApiError && e.assessment) syncAssessment(e.assessment)
      setError(e instanceof Error ? e.message : 'Could not save correction.')
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="nori-practice" aria-label={title}>
      <header className="nori-practice__header">
        <h3 className="nori-practice__title">{title}</h3>
        <span className={`nori-badge ${online === 'online' ? 'nori-badge--online' : 'nori-badge--warn'}`} data-nori-status={online}>
          {online === 'online' ? 'Nori sidecar connected' : online === 'offline' ? 'Offline · assessments require sidecar' : 'Checking sidecar…'}
        </span>
      </header>

      {error && <p className="nori-error">{error}</p>}

      {online === 'online' && !active && (
        <div className="nori-card">
          <div className="nori-actions">
            <label className="nori-badge">
              <input type="radio" data-ui="nori" name={`mode-${courseKey}`} checked={mode === 'untimed'} onChange={() => setMode('untimed')} /> Untimed
            </label>
            <label className="nori-badge">
              <input type="radio" data-ui="nori" name={`mode-${courseKey}`} checked={mode === 'timed'} onChange={() => setMode('timed')} /> Timed ({minutes}m)
            </label>
            {mode === 'timed' && (
              <input
                type="number"
                data-ui="nori"
                min={1}
                max={480}
                value={minutes}
                onChange={(e) => setMinutes(Math.max(1, Number(e.target.value) || 15))}
                style={{ width: '5rem', padding: '0.25rem 0.4rem' }}
              />
            )}
            <button type="button" data-ui="nori" className="nori-btn nori-btn--primary" disabled={busy === 'create' || !exercises.length} onClick={handleCreateAndStart}>
              {busy === 'create' ? 'Starting…' : `Start assessment (${exercises.length} items)`}
            </button>
          </div>
          {assessments.length > 0 && (
            <div className="nori-history">
              <p className="nori-muted">Previous assessments ({assessments.length})</p>
              {assessments.map((a) => (
                <div key={a.id} className="nori-actions">
                  <button type="button" data-ui="nori" className="nori-btn" onClick={() => syncAssessment(a)}>
                    {a.title} · {a.status}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {active && (
        <div className="nori-card">
          <div className="nori-card__top">
            <strong>{active.title}</strong>
            <div className="nori-practice__meta">
              <span className="nori-badge">{active.status}</span>
              {active.remainingMs !== null && <span className="nori-badge">{Math.ceil(active.remainingMs / 1000)}s left</span>}
              <button type="button" data-ui="nori" className="nori-btn" onClick={() => setActive(null)}>
                All assessments
              </button>
            </div>
          </div>

          {active.items.map((item) => (
            <div key={item.id} className="nori-attempt">
              <div className="nori-card__prompt">{renderRichText(item.prompt)}</div>
              {active.status === 'active' ? (
                <>
                  {item.type === 'multiple_choice' ? (
                    <div className="nori-options">
                      {item.options.map((opt) => (
                        <label key={opt} className="nori-option">
                          <input
                            type="radio"
                            data-ui="nori"
                            name={`assess-${active.id}-${item.id}`}
                            checked={(answers[item.id] ?? '') === opt}
                            onChange={() => setAnswers((prev) => ({ ...prev, [item.id]: opt }))}
                          />
                          <span>{renderInlineMarkdown(opt)}</span>
                        </label>
                      ))}
                    </div>
                  ) : (
                    <textarea
                      data-ui="nori"
                      className={`nori-textarea${item.type === 'code' ? ' nori-textarea--code' : ''}`}
                      value={answers[item.id] ?? ''}
                      onChange={(e) => setAnswers((prev) => ({ ...prev, [item.id]: e.target.value }))}
                    />
                  )}
                  <button type="button" data-ui="nori" className="nori-btn" disabled={busy === `save:${item.id}`} onClick={() => handleSaveItem(item.id)}>
                    {busy === `save:${item.id}` ? 'Saving…' : 'Save answer'}
                  </button>
                </>
              ) : (
                <>
                  <p className="nori-attempt__answer">{item.answer ?? '(Unanswered)'}</p>
                  {item.result && (
                    <span className="nori-badge">
                      {item.result.grading === 'deterministic' ? (item.result.correct === 1 ? 'Correct' : 'Incorrect') : 'Unscored'}
                    </span>
                  )}
                  {item.referenceAnswer && (
                    <details className="nori-details">
                      <summary>Reference answer</summary>
                      <div className="nori-attempt__answer">{renderRichText(item.referenceAnswer)}</div>
                    </details>
                  )}
                  {item.result?.feedback && <div className="nori-feedback">{renderRichText(item.result.feedback)}</div>}
                  {item.result?.grading === 'unscored' && item.answer && (
                    <button
                      type="button"
                      data-ui="nori"
                      className="nori-btn"
                      disabled={busy === `fb:${item.id}` || !llmConfigured}
                      onClick={() => handleFeedback(item.id)}
                    >
                      Ask AI for advisory feedback
                    </button>
                  )}
                  <div className="nori-actions">
                    <input
                      type="text"
                      data-ui="nori"
                      className="nori-textarea"
                      style={{ minHeight: '36px', flex: '1 1 200px' }}
                      placeholder="Correction note…"
                      value={notes[item.id] ?? item.result?.ownerNote ?? ''}
                      onChange={(e) => setNotes((prev) => ({ ...prev, [item.id]: e.target.value }))}
                    />
                    <button type="button" data-ui="nori" className="nori-btn" disabled={busy === `corr:${item.id}`} onClick={() => handleCorrect(item.id)}>
                      Save correction
                    </button>
                  </div>
                </>
              )}
            </div>
          ))}

          {active.status === 'active' && (
            <button type="button" data-ui="nori" className="nori-btn nori-btn--primary" disabled={busy === 'submit'} onClick={handleSubmit}>
              {busy === 'submit' ? 'Submitting…' : 'Submit assessment'}
            </button>
          )}
        </div>
      )}
    </section>
  )
}

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
        <h3 className="nori-practice__title">{title}</h3>
        <span className={`nori-badge ${online === 'online' ? 'nori-badge--online' : 'nori-badge--warn'}`} data-nori-status={online}>
          {online === 'online'
            ? llmConfigured
              ? 'Nori tutor ready'
              : 'Sidecar connected · no LLM configured'
            : online === 'offline'
              ? 'Offline · tutor unavailable'
              : 'Checking sidecar…'}
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
                    <span>
                      <strong>{a.exerciseKey}:</strong> {a.answer.slice(0, 100)}
                    </span>
                  </label>
                ))}
              </div>
            </div>
          )}

          {turns.length > 0 && (
            <div className="nori-history">
              {turns.map((t) => (
                <div key={t.id} className={t.role === 'assistant' ? 'nori-feedback' : 'nori-attempt'}>
                  <strong>{t.role === 'assistant' ? 'Tutor' : 'You'}</strong>
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
            <button
              type="button"
              data-ui="nori"
              className="nori-btn nori-btn--primary"
              disabled={busy || !lesson || !llmConfigured || !message.trim()}
              onClick={handleSend}
            >
              {busy ? 'Asking tutor…' : 'Ask tutor'}
            </button>
          </div>
        </>
      )}
    </section>
  )
}

