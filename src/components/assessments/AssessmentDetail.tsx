import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { AssessmentDetailData } from './types'

export function AssessmentDetail({
  courseId,
  assessmentId,
  initialAnswers: initialAnswersProp,
  onAnswersChange,
  onDirtyChange,
  onBack,
}: {
  courseId: string
  assessmentId: string
  initialAnswers?: Record<string, string>
  onAnswersChange?: (answers: Record<string, string>) => void
  onDirtyChange?: (isDirty: boolean) => void
  onBack: () => void
}) {
  const [assessment, setAssessment] = useState<AssessmentDetailData | null>(null)
  const [answers, setAnswers] = useState<Record<string, string>>(initialAnswersProp || {})
  const [notes, setNotes] = useState<Record<string, string>>({})
  const [savedAnswers, setSavedAnswers] = useState<Record<string, string>>({})
  const [copiedItemId, setCopiedItemId] = useState<string | null>(null)
  const [copyError, setCopyError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [autoFinalizeError, setAutoFinalizeError] = useState<string | null>(null)
  const [clockOffset, setClockOffset] = useState(0)
  const [now, setNow] = useState(Date.now())

  const isAutoFinalizingRef = useRef(false)
  const autoFinalizeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const abortControllerRef = useRef<AbortController | null>(null)

  async function handleCopyDraft(itemId: string, text: string) {
    setCopyError(null)
    try {
      if (!navigator.clipboard || !navigator.clipboard.writeText) {
        throw new Error('Clipboard API unavailable in this browser.')
      }
      await navigator.clipboard.writeText(text)
      setCopiedItemId(itemId)
      if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current)
      copyTimeoutRef.current = setTimeout(() => setCopiedItemId(null), 2500)
    } catch (err) {
      setCopyError(err instanceof Error ? err.message : 'Could not copy to clipboard.')
    }
  }

  async function load() {
    const fetchStart = Date.now()
    abortControllerRef.current?.abort()
    const controller = new AbortController()
    abortControllerRef.current = controller

    const response = await fetch(`/api/courses/${courseId}/assessments/${assessmentId}`, {
      signal: controller.signal,
    })
    if (!response.ok) throw new Error('Could not open this assessment.')
    const data = (await response.json()) as { assessment: AssessmentDetailData }
    const current = data.assessment
    const fetchEnd = Date.now()
    const rtt = Math.max(0, fetchEnd - fetchStart)
    const estimatedServerNow = current.serverNow + Math.floor(rtt / 2)

    setAssessment(current)
    setClockOffset(estimatedServerNow - fetchEnd)
    setNow(fetchEnd)
    setAutoFinalizeError(null)

    // Handle early active response or schedule finalization retry
    if (current.status === 'active' && current.mode === 'timed' && current.deadlineAt) {
      isAutoFinalizingRef.current = false
      const remainingServerMs = current.deadlineAt - estimatedServerNow
      // If client reached deadline or within 500ms of deadline, schedule bounded retry
      if (remainingServerMs <= 500) {
        const retryDelay = Math.max(100, Math.min(Math.max(0, remainingServerMs) + 50, 3000))
        if (autoFinalizeTimeoutRef.current) {
          clearTimeout(autoFinalizeTimeoutRef.current)
        }
        autoFinalizeTimeoutRef.current = setTimeout(() => {
          void load().catch((err: Error) => {
            if (err.name !== 'AbortError') {
              setAutoFinalizeError(err.message)
            }
          })
        }, retryDelay)
      }
    } else {
      if (autoFinalizeTimeoutRef.current) {
        clearTimeout(autoFinalizeTimeoutRef.current)
        autoFinalizeTimeoutRef.current = null
      }
    }

    const loadedAnswers: Record<string, string> = {}
    const initialSaved: Record<string, string> = {}
    current.items.forEach((item) => {
      if (item.savedAnswer) {
        loadedAnswers[item.id] = item.savedAnswer
        initialSaved[item.id] = item.savedAnswer
      } else if (item.result?.answer) {
        loadedAnswers[item.id] = item.result.answer
        initialSaved[item.id] = item.result.answer
      }
    })
    setAnswers((prev) => ({ ...loadedAnswers, ...initialAnswersProp, ...prev }))
    setSavedAnswers((prev) => ({ ...initialSaved, ...prev }))
  }

  useEffect(() => {
    isAutoFinalizingRef.current = false
    setAutoFinalizeError(null)
    if (autoFinalizeTimeoutRef.current) {
      clearTimeout(autoFinalizeTimeoutRef.current)
      autoFinalizeTimeoutRef.current = null
    }
    void load().catch((err: Error) => {
      if (err.name !== 'AbortError') {
        setError(err.message)
      }
    })
    return () => {
      abortControllerRef.current?.abort()
      if (autoFinalizeTimeoutRef.current) {
        clearTimeout(autoFinalizeTimeoutRef.current)
        autoFinalizeTimeoutRef.current = null
      }
      if (copyTimeoutRef.current) {
        clearTimeout(copyTimeoutRef.current)
        copyTimeoutRef.current = null
      }
    }
  }, [courseId, assessmentId])

  // Timer tick for active timed assessment
  useEffect(() => {
    if (assessment?.status !== 'active' || assessment?.mode !== 'timed' || !assessment.deadlineAt) return
    const interval = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(interval)
  }, [assessment?.status, assessment?.mode, assessment?.deadlineAt])

  const effectiveServerNow = now + clockOffset
  const remainingMs =
    assessment?.status === 'active' && assessment.mode === 'timed' && assessment.deadlineAt
      ? assessment.deadlineAt - effectiveServerNow
      : null
  const remainingSeconds =
    remainingMs !== null ? Math.max(0, Math.ceil(remainingMs / 1000)) : null
  const isDeadlinePassed = remainingMs !== null && remainingMs <= 0

  // Trigger one GET at deadline to finalize on server and display finalized state
  useEffect(() => {
    if (
      assessment?.status === 'active' &&
      assessment.mode === 'timed' &&
      assessment.deadlineAt &&
      isDeadlinePassed &&
      !isAutoFinalizingRef.current
    ) {
      isAutoFinalizingRef.current = true
      void load().catch((err: Error) => {
        isAutoFinalizingRef.current = false
        if (err.name !== 'AbortError') {
          setAutoFinalizeError(err.message)
          if (autoFinalizeTimeoutRef.current) {
            clearTimeout(autoFinalizeTimeoutRef.current)
          }
          autoFinalizeTimeoutRef.current = setTimeout(() => {
            void load().catch(() => {})
          }, 2500)
        }
      })
    }
  }, [isDeadlinePassed, assessment?.status, assessment?.mode, assessment?.deadlineAt])

  const isFinalized = assessment?.status === 'submitted' || assessment?.status === 'expired'

  const hasUnsavedAnswers =
    assessment?.status === 'active' &&
    Boolean(assessment.items.some((item) => (answers[item.id] || '') !== (savedAnswers[item.id] || '')))

  const hasUnsavedDrafts =
    Boolean(isFinalized) &&
    Boolean(
      assessment?.items.some(
        (item) =>
          Boolean(answers[item.id]?.trim()) &&
          answers[item.id]?.trim() !== (item.result?.answer ?? '').trim()
      )
    )

  const isDirty = hasUnsavedAnswers || hasUnsavedDrafts

  useEffect(() => {
    onDirtyChange?.(isDirty)
    return () => onDirtyChange?.(false)
  }, [isDirty, onDirtyChange])

  function updateAnswer(itemId: string, val: string) {
    setAnswers((prev) => ({ ...prev, [itemId]: val }))
    onAnswersChange?.({ ...answers, [itemId]: val })
  }

  function handleBack() {
    if (hasUnsavedAnswers) {
      if (!window.confirm('You have unsaved answers. Do you want to leave without saving?')) {
        return
      }
    } else if (hasUnsavedDrafts) {
      if (!window.confirm('You have unsaved local draft answers. Do you want to leave this page?')) {
        return
      }
    }
    onBack()
  }

  async function postAction(action: string, body?: unknown) {
    setBusy(true)
    setError('')
    const fetchStart = Date.now()
    try {
      const response = await fetch(`/api/courses/${courseId}/assessments/${assessmentId}/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      const data = (await response.json()) as { error?: string; assessment?: AssessmentDetailData }
      if (data.assessment?.serverNow) {
        setClockOffset(data.assessment.serverNow - fetchStart)
      }
      if (!response.ok) {
        if (data.assessment) {
          setAssessment(data.assessment)
        }
        throw new Error(data.error || 'Request failed.')
      }
      if (data.assessment) {
        setAssessment(data.assessment)
        if (action === 'submit') {
          setSavedAnswers({})
        }
      }
      return data
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.')
      return false
    } finally {
      setBusy(false)
    }
  }

  async function handleStart() {
    await postAction('start')
  }

  async function handleSaveAnswer(itemId: string) {
    const answer = answers[itemId] ?? ''
    const result = await postAction('answers', {
      itemId,
      answer,
      expectedVersion: assessment?.version,
    })
    if (result && typeof result === 'object' && 'assessment' in result) {
      setSavedAnswers((prev) => ({ ...prev, [itemId]: answer }))
    }
  }

  async function handleSubmit() {
    if (hasUnsavedAnswers) {
      if (!window.confirm('You have unsaved changes in your answers. Submit the currently saved answers?')) {
        return
      }
    }
    await postAction('submit', { expectedVersion: assessment?.version })
  }

  async function handleRequestFeedback(itemId: string) {
    await postAction('feedback', { itemId, expectedVersion: assessment?.version })
  }

  async function handleSaveCorrection(e: FormEvent<HTMLFormElement>, itemId: string) {
    e.preventDefault()
    const note = notes[itemId]
    if (!note?.trim()) return
    await postAction('correct', { itemId, note, expectedVersion: assessment?.version })
  }

  if (!assessment) {
    return (
      <section className="assessment-detail">
        <Button variant="ghost" className="back text-left p-0 h-auto font-normal hover:bg-transparent hover:underline" type="button" onClick={onBack}>
          ← All assessments
        </Button>
        <p role="status">{error || 'Loading assessment…'}</p>
      </section>
    )
  }

  return (
    <section className="assessment-detail">
      <div className="detail-actions">
        <Button variant="ghost" className="back text-left p-0 h-auto font-normal hover:bg-transparent hover:underline" type="button" onClick={handleBack}>
          ← All assessments
        </Button>
      </div>

      <div className="assessment-header">
        <p className="eyebrow">
          COURSE ASSESSMENT / {assessment.mode.toUpperCase()} · STATUS: {assessment.status.toUpperCase()}
        </p>
        <h2>{assessment.title}</h2>
        <div className="assessment-badges">
          <span className={`badge-${assessment.mode}`}>
            {assessment.mode === 'timed'
              ? (assessment.durationSeconds || 0) < 60
                ? `Timed (${assessment.durationSeconds || 0}s)`
                : `Timed (${Math.round((assessment.durationSeconds || 0) / 60)} min)`
              : 'Untimed'}
          </span>
          <span className={`badge-status badge-${assessment.status}`}>
            {assessment.status === 'planned' && 'Scope planned'}
            {assessment.status === 'active' && 'In progress'}
            {assessment.status === 'submitted' && 'Submitted'}
            {assessment.status === 'expired' && 'Deadline passed'}
          </span>
          <span className="badge-version">v{assessment.version}</span>
        </div>
      </div>

      {error && <p className="error" role="alert">{error}</p>}

      {/* PLANNED STAGE */}
      {assessment.status === 'planned' && (
        <div className="assessment-planned">
          <section className="scope-card">
            <p className="eyebrow">ASSESSMENT SCOPE</p>
            <h3>Scope & Coverage</h3>
            <p className="muted">
              This assessment covers {assessment.scope.exerciseCount} exercises across {assessment.scope.modules.length} modules ({assessment.scope.lessonCount} lessons in scope).
            </p>
            <p className="aside-note">
              Assessments snapshot exercises at the module level. Individual question-to-lesson attribution is not claimed.
            </p>
            <ul className="scope-modules-list">
              {assessment.scope.modules.map((m) => (
                <li key={m.id}>
                  <strong>{m.title}</strong>
                  <span>{m.exercises} exercises ({m.lessons} lessons)</span>
                </li>
              ))}
            </ul>
          </section>

          <section className="preview-items">
            <h3>Exercises in Scope ({assessment.items.length})</h3>
            <p className="muted">
              Question structure and types in this assessment. To maintain assessment integrity, question prompts and options remain hidden until you start.
            </p>
            <ol className="item-preview-list">
              {assessment.items.map((item, idx) => (
                <li key={item.id} className="preview-item">
                  <div className="preview-item-header">
                    <span className="preview-item-num">Question {idx + 1} · {item.moduleTitle}</span>
                    <span className="course-label">{item.type.replace('_', ' ').toUpperCase()}</span>
                  </div>
                  <p className="prompt-hidden-notice">Question prompt hidden until you start.</p>
                </li>
              ))}
            </ol>
          </section>

          <div className="start-assessment-action">
            <Button className="primary" disabled={busy} type="button" onClick={handleStart}>
              {busy ? 'Starting…' : 'Start assessment'} <span aria-hidden="true">↗</span>
            </Button>
          </div>
        </div>
      )}

      {/* ACTIVE STAGE */}
      {assessment.status === 'active' && (
        <div className="assessment-active">
          {assessment.mode === 'timed' && remainingSeconds !== null && (
            <div className={`timer-banner ${remainingSeconds < 60 ? 'timer-urgent' : ''}`} role="timer" aria-live="polite">
              <span>Time remaining:</span>
              <strong>
                {Math.floor(remainingSeconds / 60)}:{String(remainingSeconds % 60).padStart(2, '0')}
              </strong>
              {(remainingSeconds === 0 || isDeadlinePassed) && (
                <span className="timer-expired-note">
                  {autoFinalizeError ? '(Deadline reached. Error finalizing.)' : '(Deadline reached. Finalizing…)'}
                </span>
              )}
            </div>
          )}

          {autoFinalizeError && (
            <div className="finalize-retry-banner" role="alert">
              <span>Failed to finalize automatically: {autoFinalizeError}</span>
              <Button
                className="secondary"
                size="sm"
                type="button"
                onClick={() => {
                  setAutoFinalizeError(null)
                  void load().catch((err: Error) => {
                    if (err.name !== 'AbortError') {
                      setAutoFinalizeError(err.message)
                    }
                  })
                }}
              >
                Retry
              </Button>
            </div>
          )}

          <p className="muted">
            Answer each question and click "Save answer" to preserve your work. When you are ready, click "Submit assessment".
          </p>

          <div className="assessment-items-list">
            {assessment.items.map((item, idx) => {
              const currentVal = answers[item.id] ?? ''
              const isSaved = (savedAnswers[item.id] ?? '') === currentVal && currentVal !== ''
              const isDirty = currentVal !== (savedAnswers[item.id] ?? '')
              const isTimedExpired = assessment.mode === 'timed' && (remainingSeconds === 0 || isDeadlinePassed)
              return (
                <article key={item.id} className="assessment-question-card">
                  <div className="question-header">
                    <span className="question-pos">Question {idx + 1} of {assessment.items.length}</span>
                    <span className="question-module">{item.moduleTitle}</span>
                  </div>
                  <fieldset className="question-fieldset">
                    <legend className="question-prompt">{item.prompt}</legend>
                    <p className="course-label">{item.type.replace('_', ' ').toUpperCase()}</p>

                    {item.type === 'multiple_choice' ? (
                      <div className="choice-group">
                        {item.options.map((opt) => (
                          <label key={opt} className="choice">
                            <input
                              type="radio"
                              name={`item-${item.id}`}
                              value={opt}
                              checked={currentVal === opt}
                              disabled={busy || isTimedExpired}
                              onChange={() => updateAnswer(item.id, opt)}
                            />
                            <span>{opt}</span>
                          </label>
                        ))}
                      </div>
                    ) : (
                      <div className="text-answer-group">
                        <label htmlFor={`answer-${item.id}`}>Your answer</label>
                        <Textarea
                          id={`answer-${item.id}`}
                          rows={item.type === 'code' ? 8 : 4}
                          value={currentVal}
                          disabled={busy || isTimedExpired}
                          onChange={(e) => updateAnswer(item.id, e.target.value)}
                        />
                      </div>
                    )}
                  </fieldset>

                  <div className="question-action-bar">
                    <Button
                      className="secondary"
                      type="button"
                      disabled={busy || !currentVal.trim() || isTimedExpired}
                      onClick={() => void handleSaveAnswer(item.id)}
                    >
                      Save answer
                    </Button>
                    <span className="save-status">
                      {isSaved && <span className="status-saved">✓ Saved</span>}
                      {isDirty && <span className="status-dirty">Unsaved edits</span>}
                      {!isSaved && !isDirty && <span className="status-empty">Not saved</span>}
                    </span>
                  </div>
                </article>
              )
            })}
          </div>

          <div className="submit-action-banner">
            <div>
              <h3>Ready to finalize?</h3>
              <p className="muted">
                {Object.keys(savedAnswers).filter((k) => savedAnswers[k]?.trim()).length} of {assessment.items.length} questions saved on server.
              </p>
            </div>
            <Button className="primary submit-btn" disabled={busy || (assessment.mode === 'timed' && (remainingSeconds === 0 || isDeadlinePassed))} type="button" onClick={handleSubmit}>
              {busy ? 'Submitting…' : 'Submit assessment'} <span aria-hidden="true">↗</span>
            </Button>
          </div>
        </div>
      )}

      {/* FINALIZED STAGE (SUBMITTED OR EXPIRED) */}
      {isFinalized && (
        <div className="assessment-finalized">
          <div className={`finalized-banner banner-${assessment.status}`}>
            <h3>{assessment.status === 'submitted' ? 'Assessment Submitted' : 'Assessment Finalized on Expiry'}</h3>
            <p>
              {assessment.status === 'submitted'
                ? `Submitted at ${new Date(assessment.submittedAt || assessment.finalizedAt || Date.now()).toLocaleTimeString()}`
                : `Deadline passed. Finalized at ${new Date(assessment.finalizedAt || Date.now()).toLocaleTimeString()} (No manual submission recorded)`}
            </p>
          </div>

          {hasUnsavedDrafts && (
            <div className="unsaved-warning-banner" role="alert">
              <strong>Unsaved draft answers preserved:</strong>
              <p>
                You had draft answers that were not saved before {assessment.status === 'expired' ? 'the deadline' : 'submission'}. They are shown below with copy buttons for your records.
              </p>
            </div>
          )}

          {/* Results Summary Card */}
          <section className="results-summary-card">
            <p className="eyebrow">RESULTS OVERVIEW</p>
            <h3>Performance Breakdown</h3>
            <div className="summary-grid">
              <div className="summary-stat">
                <span className="stat-label">Deterministic (Multiple Choice)</span>
                <strong className="stat-value">
                  {assessment.summary.deterministicCorrect ?? 0} / {assessment.summary.deterministicTotal ?? 0} correct
                </strong>
                <span className="stat-note">Scored deterministically against exact options</span>
              </div>
              <div className="summary-stat">
                <span className="stat-label">Unscored Exercises</span>
                <strong className="stat-value">{assessment.summary.unscoredCount ?? 0} items</strong>
                <span className="stat-note">Written and code exercises are unscored; advisory feedback available below</span>
              </div>
            </div>
            <p className="aside-note">
              Nori records your actual answers and attempt evidence rather than computing an artificial mastery score.
            </p>
          </section>

          {/* Detailed Question Review */}
          <section className="results-items-review">
            <h3>Review Questions & Explanations</h3>
            <div className="review-items-list">
              {assessment.items.map((item, idx) => {
                const res = item.result
                const isMC = item.type === 'multiple_choice'
                const isCorrect = res?.correct === 1
                const localDraft = answers[item.id]
                const hasUnsavedDraft = Boolean(localDraft?.trim() && localDraft?.trim() !== (res?.answer ?? '').trim())
                return (
                  <article key={item.id} className="review-item-card">
                    <div className="review-header">
                      <span className="review-pos">Question {idx + 1} · {item.moduleTitle}</span>
                      <span className="review-type">{item.type.replace('_', ' ').toUpperCase()}</span>
                      {isMC && (
                        <span className={`grade-badge ${isCorrect ? 'grade-correct' : 'grade-incorrect'}`}>
                          {isCorrect ? '✓ Correct' : '✗ Incorrect'}
                        </span>
                      )}
                      {!isMC && <span className="grade-badge grade-unscored">Unscored</span>}
                    </div>

                    <p className="review-prompt"><strong>{item.prompt}</strong></p>

                    <div className="review-answer-box">
                      <p><strong>Your answer:</strong> {res?.answer ?? <em>No answer submitted</em>}</p>

                      {hasUnsavedDraft && (
                        <div className="unsaved-draft-box" role="status">
                          <div className="unsaved-draft-header">
                            <span className="unsaved-badge">
                              {assessment.status === 'expired' ? 'Unsaved draft at expiry' : 'Unsaved draft at submission'}
                            </span>
                            <span className="unsaved-note">
                              ({assessment.status === 'expired' ? 'Not recorded on server before deadline' : 'Not saved before submission'})
                            </span>
                          </div>
                          <p className="unsaved-text">{localDraft}</p>
                          <div className="copy-action-row">
                            <Button
                              className="secondary copy-draft-btn"
                              type="button"
                              onClick={() => void handleCopyDraft(item.id, localDraft || '')}
                            >
                              {copiedItemId === item.id ? 'Copied to clipboard! ✓' : 'Copy unsaved draft'}
                            </Button>
                            {copyError && <span className="copy-error" role="alert">{copyError}</span>}
                          </div>
                        </div>
                      )}

                      {item.answer && (
                        <p className="reference-answer">
                          <strong>Reference {isMC ? 'option' : 'answer'}:</strong> {item.answer}
                        </p>
                      )}
                      {item.explanation && (
                        <p className="explanation">
                          <strong>Explanation:</strong> {item.explanation}
                        </p>
                      )}
                    </div>

                    {/* Model Advisory Feedback for Written/Code */}
                    {!isMC && (
                      <div className="advisory-feedback-box">
                        {res?.feedback ? (
                          <div className="feedback">
                            <strong>AI feedback · advisory</strong>
                            <p>{res.feedback}</p>
                          </div>
                        ) : res?.answer ? (
                          <Button
                            className="secondary"
                            type="button"
                            disabled={busy}
                            onClick={() => void handleRequestFeedback(item.id)}
                          >
                            {busy ? 'Requesting feedback…' : 'Request advisory AI feedback'}
                          </Button>
                        ) : null}

                        {/* Owner Note / Correction Form */}
                        <form className="correction-form" onSubmit={(e) => void handleSaveCorrection(e, item.id)}>
                          <label htmlFor={`note-${item.id}`}>Your correction or reflection</label>
                          <Textarea
                            id={`note-${item.id}`}
                            rows={2}
                            maxLength={4000}
                            placeholder="Add your own assessment note or correction…"
                            value={notes[item.id] ?? res?.ownerNote ?? ''}
                            onChange={(e) => setNotes({ ...notes, [item.id]: e.target.value })}
                          />
                          <Button
                            className="secondary"
                            disabled={busy || !notes[item.id]?.trim() || notes[item.id] === res?.ownerNote}
                          >
                            Save correction
                          </Button>
                          {res?.ownerNote && <p className="saved-note">Saved note: {res.ownerNote}</p>}
                        </form>
                      </div>
                    )}
                  </article>
                )
              })}
            </div>
          </section>
        </div>
      )}
    </section>
  )
}
