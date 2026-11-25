import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import {
  AssessmentAnswerSync,
  createCountdown,
  formatCountdown,
  localDeadline,
  MAX_ANSWER_CHARS,
  openAssessment,
  type AnswerSaveState,
} from '../assessment-sync'
import {
  getSharedNoriClient,
  NoriApiError,
  toAssessmentSummary,
  type AssessmentDetail,
  type AssessmentSampleInfo,
  type AssessmentSummary,
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
  /**
   * Lesson of inline `exercises` and of a single `bank` (overriding the bank's own lessonKey).
   * With `banks`, only a fallback for a bank that names no lessonKey: each bank keeps its own.
   */
  lessonKey?: string
  bank?: string
  /** Several practice banks pooled together, e.g. every lesson of a course; used instead of `bank`. */
  banks?: string[]
  exercises?: PracticeExercise[]
  apiBaseUrl?: string
  title?: string
}

/** A bank exercise with the lesson it belongs to; (lessonKey, key) identifies it. */
export type PoolExercise = PracticeExercise & { lessonKey: string }

/**
 * Flattens loaded banks into one pool. One bank takes the island's lessonKey if given,
 * else its own. Pooled banks keep their own lessonKey, so lessons that reuse exercise
 * keys (`q-1` in each) stay distinct; the island's lessonKey fills in only where a bank has none.
 */
export function poolBankExercises(banks: PracticeBank[], lessonKey = '', pooled = banks.length > 1): PoolExercise[] {
  return banks.flatMap((d) => {
    const key = pooled ? d.lessonKey || lessonKey : lessonKey || d.lessonKey
    return (Array.isArray(d.exercises) ? d.exercises : []).map((ex) => ({ ...ex, lessonKey: key || '' }))
  })
}

type SampleChoice = { enabled: boolean; count: number; strategy: 'random' | 'weak'; seed: string }

const OPTION_KEYS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'

/** Flush unsaved answers this close to the deadline so they land before the server finalizes. */
const DEADLINE_FLUSH_MS = 2000

const SAVE_STATE_LABEL: Record<AnswerSaveState, string> = {
  pending: 'Unsaved changes',
  saving: 'Saving…',
  saved: 'Saved',
  error: 'Not saved yet · will retry when the sidecar answers',
  rejected: 'Not saved',
}

/** Show the character count once an answer is this close to the server limit. */
const COUNT_FROM_CHARS = Math.floor(MAX_ANSWER_CHARS * 0.9)

export function NoriAssessment({
  courseKey,
  lessonKey = '',
  bank,
  banks,
  exercises: inlineExercises,
  apiBaseUrl = '/api/nori/v1',
  title = 'Assessment',
}: NoriAssessmentProps) {
  const client = useMemo(() => getSharedNoriClient(apiBaseUrl), [apiBaseUrl])
  const [exercises, setExercises] = useState<PoolExercise[]>(() => (inlineExercises ?? []).map((ex) => ({ ...ex, lessonKey })))
  const [sample, setSample] = useState<SampleChoice>({ enabled: false, count: 10, strategy: 'random', seed: '' })
  const [lastSample, setLastSample] = useState<(AssessmentSampleInfo & { assessmentId: string }) | null>(null)
  const [llmConfigured, setLlmConfigured] = useState(false)
  const [assessments, setAssessments] = useState<AssessmentSummary[]>([])
  const [active, setActive] = useState<AssessmentDetail | null>(null)
  const [mode, setMode] = useState<'untimed' | 'timed'>('untimed')
  const [minutes, setMinutes] = useState(15)
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const answersRef = useRef(answers)
  answersRef.current = answers
  const [notes, setNotes] = useState<Record<string, string>>({})
  const [saveStates, setSaveStates] = useState<Record<string, AnswerSaveState>>({})
  const [saveErrors, setSaveErrors] = useState<Record<string, string>>({})
  const [deadline, setDeadline] = useState<number | null>(null)
  const [remainingMs, setRemainingMs] = useState<number | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const syncRef = useRef<AssessmentAnswerSync | null>(null)
  // Id of the assessment on screen; late responses for any other one are dropped.
  const openIdRef = useRef<string | null>(null)
  const openSeqRef = useRef(0)
  const idPrefix = useId()

  useEffect(() => {
    if (inlineExercises) {
      setExercises(inlineExercises.map((ex) => ({ ...ex, lessonKey })))
      return
    }
    const urls = banks ?? (bank ? [bank] : [])
    if (!urls.length) return
    const controller = new AbortController()
    Promise.all(
      urls.map((url) =>
        fetch(url, { signal: controller.signal })
          .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`Bank error (${r.status})`)))) as Promise<PracticeBank>,
      ),
    )
      .then((loaded) => setExercises(poolBankExercises(loaded, lessonKey, banks !== undefined)))
      .catch((e) => {
        if (!controller.signal.aborted) setError(e instanceof Error ? e.message : 'Failed to load bank.')
      })
    return () => controller.abort()
    // banks is compared by content so an inline array literal does not refetch on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bank, banks?.join('\n'), inlineExercises, lessonKey])

  // Pass deadlineAt when the detail was fetched to (re)start the countdown; it is
  // anchored at send time. Other updates for the open assessment keep its deadline.
  const syncAssessment = useCallback((detail: AssessmentDetail, deadlineAt?: number | null) => {
    const sameAssessment = openIdRef.current === detail.id
    openIdRef.current = detail.id
    setActive(detail)
    if (detail.status !== 'active') setDeadline(null)
    else if (deadlineAt !== undefined) setDeadline(deadlineAt)
    else if (!sameAssessment) setDeadline(localDeadline(detail))
    setAssessments((prev) => [toAssessmentSummary(detail), ...prev.filter((a) => a.id !== detail.id)])
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
        const list = await client.listAssessmentSummaries(courseKey, signal)
        if (!signal?.aborted) setAssessments(list.assessments)
      } catch {
        // The shared client tracks offline state and retries with backoff.
      }
    },
    [client, courseKey],
  )

  const refreshOpen = useCallback(async () => {
    const id = openIdRef.current
    if (!id) return
    const opened = await openAssessment(client, id)
    if (openIdRef.current === opened.detail.id) syncAssessment(opened.detail, opened.deadline)
  }, [client, syncAssessment])

  const online = useNoriConnection(client, () => {
    loadFromSidecar()
    // Answers typed while offline are still queued: save them, then refresh the open
    // assessment (it may have expired while offline and still be locked on screen).
    const sync = syncRef.current
    ;(sync ? sync.flush() : Promise.resolve())
      .catch(() => undefined)
      .then(refreshOpen)
      .catch(() => undefined)
  })

  const handleOpen = async (assessmentId: string) => {
    const seq = ++openSeqRef.current
    setError(null)
    try {
      // List entries carry a stale remainingMs; fetch fresh before starting the countdown.
      const opened = await openAssessment(client, assessmentId)
      if (openSeqRef.current !== seq) return
      syncAssessment(opened.detail, opened.deadline)
    } catch (e) {
      if (openSeqRef.current !== seq) return
      setError(e instanceof Error ? e.message : 'Could not open assessment.')
    }
  }

  const handleClose = () => {
    openSeqRef.current++
    openIdRef.current = null
    setActive(null)
  }

  // Save unsaved answers if the learner closes or navigates away from the page.
  useEffect(() => {
    if (typeof window === 'undefined') return
    const onPageHide = () => syncRef.current?.flushOnPageHide()
    window.addEventListener('pagehide', onPageHide)
    return () => window.removeEventListener('pagehide', onPageHide)
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    loadFromSidecar(controller.signal)
    return () => controller.abort()
  }, [loadFromSidecar])

  // One auto-save queue per active assessment.
  const activeId = active?.status === 'active' ? active.id : null
  useEffect(() => {
    if (!activeId || !active) return
    setSaveStates({})
    setSaveErrors({})
    const sync = new AssessmentAnswerSync({
      client,
      assessment: active,
      // Answers typed before the assessment was last closed but never saved are saved now.
      localAnswers: answersRef.current,
      onUpdate: (detail) => {
        if (openIdRef.current === detail.id) syncAssessment(detail)
      },
      onStateChange: (states, errors) => {
        setSaveStates(states)
        setSaveErrors(errors)
      },
    })
    syncRef.current = sync
    return () => {
      sync.flush().catch(() => undefined)
      sync.dispose()
      if (syncRef.current === sync) syncRef.current = null
    }
    // Recreate only when a different assessment becomes active.
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
          .then(refreshOpen)
          .catch((e) => setError(e instanceof Error ? e.message : 'Could not reload the expired assessment.'))
      },
    })
  }, [deadline, activeId, refreshOpen])

  const timeUp = remainingMs === 0
  const seedValid = sample.seed.trim() === '' || (/^\d+$/.test(sample.seed.trim()) && Number(sample.seed) <= 0xffffffff)

  const handleCreateAndStart = async () => {
    if (!exercises.length) return
    setBusy('create')
    setError(null)
    try {
      const input = {
        courseKey,
        title: `${title} (${new Date().toISOString().slice(0, 10)})`,
        mode,
        durationSeconds: mode === 'timed' ? minutes * 60 : undefined,
        items: exercises.map((ex) => ({
          lessonKey: ex.lessonKey,
          exerciseKey: ex.key,
          exerciseSnapshot: { type: ex.type, prompt: ex.prompt, options: ex.options, answer: ex.answer, explanation: ex.explanation },
        })),
      }
      let created: AssessmentDetail
      if (sample.enabled) {
        const seed = sample.seed.trim() === '' ? undefined : Number(sample.seed)
        const res = await client.createSampledAssessment({
          ...input,
          sample: { count: Math.min(sample.count, exercises.length), strategy: sample.strategy, seed },
        })
        created = res.assessment
        setLastSample({ ...res.sample, assessmentId: res.assessment.id })
      } else {
        created = await client.createAssessment(input)
        setLastSample(null)
      }
      const sentAt = Date.now()
      const started = await client.startAssessment(created.id)
      setAnswers({})
      syncAssessment(started, localDeadline(started, sentAt))
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
      if (openIdRef.current === updated.id) syncAssessment(updated)
    } catch (e) {
      if (e instanceof NoriApiError && e.assessment && openIdRef.current === e.assessment.id) syncAssessment(e.assessment)
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
      if (openIdRef.current === updated.id) syncAssessment(updated)
    } catch (e) {
      if (e instanceof NoriApiError && e.assessment && openIdRef.current === e.assessment.id) syncAssessment(e.assessment)
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
                aria-label="Time limit in minutes"
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
              disabled={busy === 'create' || !exercises.length || (sample.enabled && !seedValid)}
              onClick={handleCreateAndStart}
            >
              <IconPlay />
              <span>
                {busy === 'create'
                  ? 'Starting…'
                  : `Start assessment (${sample.enabled ? Math.min(sample.count, exercises.length) : exercises.length} items)`}
              </span>
            </button>
          </div>
          {exercises.length > 1 && (
            <div className="nori-actions">
              <label className="nori-badge" style={{ cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  data-ui="nori"
                  checked={sample.enabled}
                  onChange={(e) => setSample((prev) => ({ ...prev, enabled: e.target.checked }))}
                />
                <span>Draw a sample of</span>
              </label>
              {sample.enabled && (
                <>
                  <input
                    type="number"
                    data-ui="nori"
                    aria-label="Number of items to draw"
                    className="nori-input-inline"
                    min={1}
                    max={Math.min(100, exercises.length)}
                    value={sample.count}
                    onChange={(e) =>
                      setSample((prev) => ({ ...prev, count: Math.max(1, Math.min(100, Math.floor(Number(e.target.value)) || 1)) }))
                    }
                    style={{ width: '5rem', flex: '0 0 5rem' }}
                  />
                  <span className="nori-muted">of {exercises.length}</span>
                  <label className="nori-badge" style={{ cursor: 'pointer' }}>
                    <input
                      type="radio"
                      data-ui="nori"
                      name={`${idPrefix}-strategy`}
                      checked={sample.strategy === 'random'}
                      onChange={() => setSample((prev) => ({ ...prev, strategy: 'random' }))}
                    />
                    <span>At random</span>
                  </label>
                  <label className="nori-badge" style={{ cursor: 'pointer' }}>
                    <input
                      type="radio"
                      data-ui="nori"
                      name={`${idPrefix}-strategy`}
                      checked={sample.strategy === 'weak'}
                      onChange={() => setSample((prev) => ({ ...prev, strategy: 'weak' }))}
                    />
                    <span>Favour weak &amp; due</span>
                  </label>
                  <input
                    type="text"
                    inputMode="numeric"
                    data-ui="nori"
                    aria-label="Seed (optional; repeats a draw)"
                    aria-invalid={!seedValid}
                    className="nori-input-inline"
                    placeholder="Seed (optional)"
                    value={sample.seed}
                    onChange={(e) => setSample((prev) => ({ ...prev, seed: e.target.value }))}
                    style={{ width: '9rem', flex: '0 0 9rem' }}
                  />
                </>
              )}
            </div>
          )}
          {sample.enabled && !seedValid && <p className="nori-error">The seed is a whole number from 0 to 4294967295.</p>}
          {assessments.length > 0 && (
            <div className="nori-history">
              <p className="nori-muted">Previous assessments ({assessments.length})</p>
              <div className="nori-actions">
                {assessments.map((a) => (
                  <button key={a.id} type="button" data-ui="nori" className="nori-btn nori-btn--sm" onClick={() => handleOpen(a.id)}>
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
              <button type="button" data-ui="nori" className="nori-btn nori-btn--sm" onClick={handleClose}>
                <IconChevronLeft />
                <span>All assessments</span>
              </button>
            </div>
          </div>
          {lastSample?.assessmentId === active.id && (
            <p className="nori-muted" data-sample-seed={lastSample.seed}>
              Drew {lastSample.count} of {lastSample.poolSize} {lastSample.strategy === 'weak' ? 'favouring weak and due exercises' : 'at random'} ·
              seed {lastSample.seed} (enter it again to repeat this draw)
            </p>
          )}

          {active.items.map((item, idx) => {
            const bankEx = exercises.find((e) => e.key === item.exerciseKey && e.lessonKey === item.lessonKey)
            const promptId = `${idPrefix}-prompt-${idx}`
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
                  <div id={promptId} className="nori-card__prompt" dangerouslySetInnerHTML={{ __html: bankEx.promptHtml }} />
                ) : (
                  <div id={promptId} className="nori-card__prompt">
                    {renderRichText(item.prompt)}
                  </div>
                )}

                {active.status === 'active' ? (
                  <>
                    {item.type === 'multiple_choice' ? (
                      <div className="nori-options" role="radiogroup" aria-labelledby={promptId}>
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
                        aria-labelledby={promptId}
                        data-ui="nori"
                        className={`nori-textarea${item.type === 'code' ? ' nori-textarea--code' : ''}`}
                        value={answers[item.id] ?? ''}
                        maxLength={MAX_ANSWER_CHARS}
                        readOnly={timeUp}
                        onChange={(e) => handleAnswerChange(item.id, e.target.value)}
                        onBlur={handleAnswerBlur}
                      />
                    )}
                    {item.type !== 'multiple_choice' && (answers[item.id]?.length ?? 0) >= COUNT_FROM_CHARS && (
                      <p className="nori-muted" data-nori-char-count>
                        {(answers[item.id]?.length ?? 0).toLocaleString()} / {MAX_ANSWER_CHARS.toLocaleString()} characters
                      </p>
                    )}
                    {saveStates[item.id] && (
                      <p
                        className={saveStates[item.id] === 'rejected' ? 'nori-error' : 'nori-muted'}
                        data-nori-save-state={saveStates[item.id]}
                        aria-live="polite"
                      >
                        {SAVE_STATE_LABEL[saveStates[item.id]!]}
                        {saveStates[item.id] === 'rejected' && saveErrors[item.id] ? `: ${saveErrors[item.id]}` : ''}
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
                        aria-label={`Correction note for item ${idx + 1}`}
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
