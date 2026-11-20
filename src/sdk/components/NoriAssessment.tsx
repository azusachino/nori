import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AssessmentAnswerSync,
  createCountdown,
  formatCountdown,
  localDeadline,
  type AnswerSaveState,
} from '../assessment-sync'
import {
  getSharedNoriClient,
  NoriApiError,
  type AssessmentDetail,
  type PracticeBank,
  type PracticeExercise,
} from '../index'
import {
  IconBookOpen,
  IconBookmark,
  IconCheckCircle,
  IconChevronLeft,
  IconClipboardCheck,
  IconClock,
  IconExerciseType,
  IconPlay,
  IconSend,
  IconSparkles,
  IconWifi,
  IconWifiOff,
  IconXCircle,
} from './icons'
import { useNoriConnection } from './connection'
import { renderInlineMarkdown, renderRichText } from './markdown'

export type NoriAssessmentProps = {
  courseKey: string
  lessonKey?: string
  bank?: string
  exercises?: PracticeExercise[]
  apiBaseUrl?: string
  title?: string
}

const OPTION_KEYS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'

/** Flush unsaved answers this close to the deadline so they land before the server finalizes. */
const DEADLINE_FLUSH_MS = 2000

const SAVE_STATE_LABEL: Record<AnswerSaveState, string> = {
  pending: 'Unsaved changes',
  saving: 'Saving…',
  saved: 'Saved',
  error: 'Not saved',
}

export function NoriAssessment({
  courseKey,
  lessonKey = '',
  bank,
  exercises: inlineExercises,
  apiBaseUrl = '/api/nori/v1',
  title = 'Assessment',
}: NoriAssessmentProps) {
  const client = useMemo(() => getSharedNoriClient(apiBaseUrl), [apiBaseUrl])
  const [exercises, setExercises] = useState<PracticeExercise[]>(inlineExercises ?? [])
  const [llmConfigured, setLlmConfigured] = useState(false)
  const [assessments, setAssessments] = useState<AssessmentDetail[]>([])
  const [active, setActive] = useState<AssessmentDetail | null>(null)
  const [mode, setMode] = useState<'untimed' | 'timed'>('untimed')
  const [minutes, setMinutes] = useState(15)
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [notes, setNotes] = useState<Record<string, string>>({})
  const [saveStates, setSaveStates] = useState<Record<string, AnswerSaveState>>({})
  const [deadline, setDeadline] = useState<number | null>(null)
  const [remainingMs, setRemainingMs] = useState<number | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const syncRef = useRef<AssessmentAnswerSync | null>(null)

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

  const syncAssessment = useCallback((detail: AssessmentDetail) => {
    setActive(detail)
    setDeadline(localDeadline(detail))
    setAssessments((prev) => [detail, ...prev.filter((a) => a.id !== detail.id)])
    const nextAnswers: Record<string, string> = {}
    for (const item of detail.items) {
      if (item.answer !== null) nextAnswers[item.id] = item.answer
    }
    setAnswers((prev) => ({ ...nextAnswers, ...prev }))
  }, [])

  // The list call doubles as the health check; /health only adds llmConfigured.
  const loadFromSidecar = useCallback(
    async (signal?: AbortSignal) => {
      client
        .health(signal)
        .then((h) => {
          if (!signal?.aborted) setLlmConfigured(h.llmConfigured)
        })
        .catch(() => undefined)
      try {
        const list = await client.listAssessments(courseKey, signal)
        if (!signal?.aborted) setAssessments(list.assessments)
      } catch {
        // The shared client tracks offline state and retries with backoff.
      }
    },
    [client, courseKey],
  )

  const online = useNoriConnection(client, () => {
    loadFromSidecar()
    // Answers typed while offline are still queued; save them now.
    syncRef.current?.flush().catch(() => undefined)
  })

  useEffect(() => {
    const controller = new AbortController()
    loadFromSidecar(controller.signal)
    return () => controller.abort()
  }, [loadFromSidecar])

  // One auto-save queue per active assessment.
  const activeId = active?.status === 'active' ? active.id : null
  useEffect(() => {
    if (!activeId || !active) return
    const sync = new AssessmentAnswerSync({
      client,
      assessment: active,
      onUpdate: syncAssessment,
      onStateChange: setSaveStates,
    })
    syncRef.current = sync
    setSaveStates({})
    return () => {
      sync.flush().catch(() => undefined)
      sync.dispose()
      if (syncRef.current === sync) syncRef.current = null
    }
    // Recreate only when a different assessment becomes active.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, client, syncAssessment])

  // Tick from the server deadline. At expiry the server finalizes the assessment
  // as "expired" with the answers saved so far, so lock inputs and reload it.
  useEffect(() => {
    if (deadline === null || !activeId) {
      setRemainingMs(null)
      return
    }
    return createCountdown({
      deadline,
      onTick: (ms) => {
        setRemainingMs(ms)
        if (ms <= DEADLINE_FLUSH_MS && syncRef.current?.hasUnsaved) syncRef.current.flush().catch(() => undefined)
      },
      onExpire: () => {
        const sync = syncRef.current
        ;(sync ? sync.flush() : Promise.resolve())
          .catch(() => undefined)
          .then(() => client.getAssessment(activeId))
          .then(syncAssessment)
          .catch((e) => setError(e instanceof Error ? e.message : 'Could not reload the expired assessment.'))
      },
    })
  }, [deadline, activeId, client, syncAssessment])

  const timeUp = remainingMs === 0

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

  const handleAnswerChange = (itemId: string, answer: string) => {
    setAnswers((prev) => ({ ...prev, [itemId]: answer }))
    syncRef.current?.setAnswer(itemId, answer)
  }

  const handleAnswerBlur = () => {
    syncRef.current?.flush().catch((e) => setError(e instanceof Error ? e.message : 'Could not save answer.'))
  }

  const handleSubmit = async () => {
    const sync = syncRef.current
    if (!sync) return
    setBusy('submit')
    setError(null)
    try {
      // submit() saves every pending answer first, so nothing is graded blank by accident.
      await sync.submit()
    } catch (e) {
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
        <div className="nori-practice__title-group">
          <span className="nori-header-icon">
            <IconClipboardCheck />
          </span>
          <h3 className="nori-practice__title">{title}</h3>
        </div>
        <span className={`nori-badge ${online === 'online' ? 'nori-badge--online' : 'nori-badge--warn'}`} data-nori-status={online}>
          {online === 'online' ? <IconWifi /> : <IconWifiOff />}
          <span>
            {online === 'online'
              ? 'Nori sidecar connected'
              : online === 'offline'
                ? 'Offline · retrying; answers save when the sidecar is back'
                : 'Checking sidecar…'}
          </span>
        </span>
      </header>

      {error && <p className="nori-error">{error}</p>}

      {online === 'online' && !active && (
        <div className="nori-card">
          <div className="nori-actions">
            <label className="nori-badge" style={{ cursor: 'pointer' }}>
              <input type="radio" data-ui="nori" name={`mode-${courseKey}`} checked={mode === 'untimed'} onChange={() => setMode('untimed')} />
              <span>Untimed</span>
            </label>
            <label className="nori-badge" style={{ cursor: 'pointer' }}>
              <input type="radio" data-ui="nori" name={`mode-${courseKey}`} checked={mode === 'timed'} onChange={() => setMode('timed')} />
              <IconClock />
              <span>Timed ({minutes}m)</span>
            </label>
            {mode === 'timed' && (
              <input
                type="number"
                data-ui="nori"
                className="nori-input-inline"
                min={1}
                max={480}
                value={minutes}
                onChange={(e) => setMinutes(Math.max(1, Number(e.target.value) || 15))}
                style={{ width: '5rem', flex: '0 0 5rem' }}
              />
            )}
            <button
              type="button"
              data-ui="nori"
              className="nori-btn nori-btn--primary"
              disabled={busy === 'create' || !exercises.length}
              onClick={handleCreateAndStart}
            >
              <IconPlay />
              <span>{busy === 'create' ? 'Starting…' : `Start assessment (${exercises.length} items)`}</span>
            </button>
          </div>
          {assessments.length > 0 && (
            <div className="nori-history">
              <p className="nori-muted">Previous assessments ({assessments.length})</p>
              <div className="nori-actions">
                {assessments.map((a) => (
                  <button key={a.id} type="button" data-ui="nori" className="nori-btn nori-btn--sm" onClick={() => syncAssessment(a)}>
                    <IconClipboardCheck />
                    <span>
                      {a.title} · {a.status}
                    </span>
                  </button>
                ))}
              </div>
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
              {active.status === 'active' && remainingMs !== null && (
                <span className={`nori-badge${remainingMs <= 60_000 ? ' nori-badge--warn' : ''}`} role="timer" aria-live="off">
                  <IconClock />
                  <span>{timeUp ? 'Time is up' : `${formatCountdown(remainingMs)} left`}</span>
                </span>
              )}
              <button type="button" data-ui="nori" className="nori-btn nori-btn--sm" onClick={() => setActive(null)}>
                <IconChevronLeft />
                <span>All assessments</span>
              </button>
            </div>
          </div>

          {active.items.map((item, idx) => {
            const bankEx = exercises.find((e) => e.key === item.exerciseKey)
            return (
              <div key={item.id} className="nori-attempt">
                <div className="nori-card__top">
                  <div className="nori-practice__meta">
                    <span className="nori-index-badge">#{String(idx + 1).padStart(2, '0')}</span>
                    <span className="nori-badge">
                      <IconExerciseType type={item.type} />
                      <span>{item.type.replace('_', ' ')}</span>
                    </span>
                  </div>
                  {active.status !== 'active' && item.result && (
                    <span
                      className={`nori-badge ${
                        item.result.grading === 'deterministic'
                          ? item.result.correct === 1
                            ? 'nori-badge--correct'
                            : 'nori-badge--incorrect'
                          : ''
                      }`}
                    >
                      {item.result.grading === 'deterministic' ? (
                        item.result.correct === 1 ? (
                          <>
                            <IconCheckCircle />
                            <span>Correct</span>
                          </>
                        ) : (
                          <>
                            <IconXCircle />
                            <span>Incorrect</span>
                          </>
                        )
                      ) : (
                        <span>Unscored</span>
                      )}
                    </span>
                  )}
                </div>

                {bankEx?.promptHtml ? (
                  <div className="nori-card__prompt" dangerouslySetInnerHTML={{ __html: bankEx.promptHtml }} />
                ) : (
                  <div className="nori-card__prompt">{renderRichText(item.prompt)}</div>
                )}

                {active.status === 'active' ? (
                  <>
                    {item.type === 'multiple_choice' ? (
                      <div className="nori-options">
                        {item.options.map((opt, optIdx) => {
                          const isSelected = (answers[item.id] ?? '') === opt
                          return (
                            <label
                              key={opt}
                              className={`nori-option nori-option--has-key${isSelected ? ' nori-option--selected' : ''}`}
                            >
                              <input
                                type="radio"
                                data-ui="nori"
                                name={`assess-${active.id}-${item.id}`}
                                checked={isSelected}
                                disabled={timeUp}
                                onChange={() => handleAnswerChange(item.id, opt)}
                                onBlur={handleAnswerBlur}
                              />
                              <span className="nori-option__key" aria-hidden="true">
                                {OPTION_KEYS[optIdx] ?? optIdx + 1}
                              </span>
                              {bankEx?.optionHtmls?.[optIdx] ? (
                                <span className="nori-option__body" dangerouslySetInnerHTML={{ __html: bankEx.optionHtmls[optIdx]! }} />
                              ) : (
                                <span className="nori-option__body">{renderInlineMarkdown(opt)}</span>
                              )}
                            </label>
                          )
                        })}
                      </div>
                    ) : (
                      <textarea
                        data-ui="nori"
                        className={`nori-textarea${item.type === 'code' ? ' nori-textarea--code' : ''}`}
                        value={answers[item.id] ?? ''}
                        readOnly={timeUp}
                        onChange={(e) => handleAnswerChange(item.id, e.target.value)}
                        onBlur={handleAnswerBlur}
                      />
                    )}
                    {saveStates[item.id] && (
                      <p className="nori-muted" data-nori-save-state={saveStates[item.id]} aria-live="polite">
                        {SAVE_STATE_LABEL[saveStates[item.id]!]}
                      </p>
                    )}
                  </>
                ) : (
                  <>
                    <div className="nori-attempt__answer">{item.answer ? renderRichText(item.answer) : '(Unanswered)'}</div>

                    {(item.referenceAnswer || bankEx?.answer || bankEx?.explanation) && (
                      <details className="nori-details">
                        <summary>
                          <IconBookOpen />
                          <span>Reference answer &amp; explanation</span>
                        </summary>
                        {bankEx?.answerHtml ? (
                          <div className="nori-attempt__answer" dangerouslySetInnerHTML={{ __html: bankEx.answerHtml }} />
                        ) : (
                          <div className="nori-attempt__answer">{renderRichText(item.referenceAnswer ?? bankEx?.answer ?? '')}</div>
                        )}
                        {(item.explanation || bankEx?.explanation) &&
                          (bankEx?.explanationHtml ? (
                            <div className="nori-muted" dangerouslySetInnerHTML={{ __html: bankEx.explanationHtml }} />
                          ) : (
                            <div className="nori-muted">{renderRichText(item.explanation ?? bankEx?.explanation ?? '')}</div>
                          ))}
                      </details>
                    )}

                    {item.result?.feedback && (
                      <div className="nori-feedback">
                        <div className="nori-feedback__header">
                          <IconSparkles />
                          <strong>Advisory AI feedback</strong>
                        </div>
                        <div className="nori-attempt__answer">{renderRichText(item.result.feedback)}</div>
                      </div>
                    )}

                    <div className="nori-actions">
                      {item.result?.grading === 'unscored' && item.answer && (
                        <button
                          type="button"
                          data-ui="nori"
                          className="nori-btn nori-btn--sm"
                          disabled={busy === `fb:${item.id}` || !llmConfigured}
                          onClick={() => handleFeedback(item.id)}
                        >
                          <IconSparkles />
                          <span>Ask AI for advisory feedback</span>
                        </button>
                      )}
                      <input
                        type="text"
                        data-ui="nori"
                        className="nori-input-inline"
                        placeholder="Correction note…"
                        value={notes[item.id] ?? item.result?.ownerNote ?? ''}
                        onChange={(e) => setNotes((prev) => ({ ...prev, [item.id]: e.target.value }))}
                      />
                      <button
                        type="button"
                        data-ui="nori"
                        className="nori-btn nori-btn--sm"
                        disabled={busy === `corr:${item.id}`}
                        onClick={() => handleCorrect(item.id)}
                      >
                        <IconBookmark />
                        <span>Save correction</span>
                      </button>
                    </div>
                  </>
                )}
              </div>
            )
          })}

          {active.status === 'active' && (
            <div className="nori-actions">
              <button type="button" data-ui="nori" className="nori-btn nori-btn--primary" disabled={busy === 'submit' || timeUp} onClick={handleSubmit}>
                <IconSend />
                <span>{busy === 'submit' ? 'Submitting…' : 'Submit assessment'}</span>
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  )
}
