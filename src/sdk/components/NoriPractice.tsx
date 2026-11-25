import { useCallback, useEffect, useId, useMemo, useState } from 'react'
import {
  checkDeterministicExercise,
  computeContentHash,
  formatAttemptsAsMarkdown,
  getSharedNoriClient,
  isDeterministicExercise,
  loadLocalDrafts,
  mergeAttempts,
  NoriApiError,
  removeLocalDraft,
  resendLocalDrafts,
  saveLocalDraft,
  toAttemptSummary,
  verifyCodeInBrowser,
  type CodeVerificationResult,
  type HealthStatus,
  type LocalDraft,
  type PracticeAttempt,
  type PracticeAttemptSummary,
  type PracticeBank,
  type PracticeExercise,
  type PracticeUpdatedDetail,
} from '../index'
import { useNoriConnection } from './connection'
import {
  IconAlertTriangle,
  IconBookOpen,
  IconBookmark,
  IconCheck,
  IconCheckCircle,
  IconCode,
  IconCopy,
  IconExerciseType,
  IconSend,
  IconSparkles,
  IconWifi,
  IconWifiOff,
  IconXCircle,
} from './icons'
import { ExerciseAnswerField } from './ExerciseAnswerField'
import { renderInlineMarkdown, renderRichText } from './markdown'

export type NoriPracticeProps = {
  courseKey: string
  lessonKey?: string
  bank?: string
  exercises?: PracticeExercise[]
  apiBaseUrl?: string
  title?: string
}

function notifyPracticeUpdated(courseKey: string, lessonKey: string, attempts: PracticeAttempt[]) {
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    const detail: PracticeUpdatedDetail = { courseKey, lessonKey, attempts: attempts.map(toAttemptSummary) }
    window.dispatchEvent(new CustomEvent('nori:practice-updated', { detail }))
  }
}

export function NoriPractice({
  courseKey,
  lessonKey = '',
  bank,
  exercises: inlineExercises,
  apiBaseUrl = '/api/nori/v1',
  title = 'Practice',
}: NoriPracticeProps) {
  const client = useMemo(() => getSharedNoriClient(apiBaseUrl), [apiBaseUrl])
  const idPrefix = useId()

  const [exercises, setExercises] = useState<PracticeExercise[]>(inlineExercises ?? [])
  const [hashes, setHashes] = useState<Record<string, string>>({})
  const [bankError, setBankError] = useState<string | null>(null)
  const [health, setHealth] = useState<HealthStatus | null>(null)
  // Summaries for the list; full attempts (feedback, snapshot) only once loaded on demand.
  const [attempts, setAttempts] = useState<PracticeAttemptSummary[]>([])
  const [fullAttempts, setFullAttempts] = useState<Record<string, PracticeAttempt>>({})
  const [drafts, setDrafts] = useState<Record<string, LocalDraft>>(() => loadLocalDrafts(courseKey, lessonKey))
  const [inputs, setInputs] = useState<Record<string, string>>({})
  const [noteInputs, setNoteInputs] = useState<Record<string, string>>({})
  const [codeResults, setCodeResults] = useState<Record<string, CodeVerificationResult>>({})
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

  // A successful data call is the health check; /health only adds llmConfigured.
  const loadFromSidecar = useCallback(
    async (signal?: AbortSignal) => {
      client
        .health(signal)
        .then((status) => {
          if (!signal?.aborted) setHealth(status)
        })
        .catch(() => {
          if (!signal?.aborted) setHealth(null)
        })
      try {
        const data = await client.listPracticeSummaries({ courseKey, lessonKey }, signal)
        if (signal?.aborted) return
        setAttempts(data.attempts)
      } catch {
        // The shared client tracks offline state and retries with backoff.
      }
    },
    [client, courseKey, lessonKey],
  )

  const connectionState = useNoriConnection(client, () => {
    loadFromSidecar()
  })

  useEffect(() => {
    const controller = new AbortController()
    loadFromSidecar(controller.signal)
    return () => controller.abort()
  }, [loadFromSidecar])

  // Re-send drafts saved while offline once the sidecar answers and the bank is loaded.
  useEffect(() => {
    if (connectionState !== 'online' || !exercises.length) return
    if (!Object.keys(loadLocalDrafts(courseKey, lessonKey)).length) return
    let cancelled = false
    resendLocalDrafts({ client, courseKey, lessonKey, exercises }).then((result) => {
      if (cancelled) return
      setDrafts(result.drafts)
      if (result.sent.length) {
        rememberFull(result.sent)
        notifyPracticeUpdated(courseKey, lessonKey, result.sent)
      }
      if (Object.keys(result.failed).length) setErrorByKey((prev) => ({ ...prev, ...result.failed }))
    })
    return () => {
      cancelled = true
    }
  }, [client, connectionState, courseKey, lessonKey, exercises])

  const handleVerifyCode = async (exercise: PracticeExercise) => {
    const code = inputs[exercise.key] ?? ''
    setBusyKey(`verify:${exercise.key}`)
    try {
      const result = await verifyCodeInBrowser(code, exercise.answer, exercise.prompt)
      setCodeResults((prev) => ({ ...prev, [exercise.key]: result }))
    } finally {
      setBusyKey(null)
    }
  }

  const submitAnswer = async (exercise: PracticeExercise, fromDraft?: LocalDraft) => {
    const answer = fromDraft?.answer ?? inputs[exercise.key] ?? ''
    // One id per attempt: a retry or re-sent draft with this id is recorded once.
    const attemptId = fromDraft?.attemptId ?? crypto.randomUUID()
    const isValid =
      exercise.type === 'multiple_choice'
        ? exercise.options.includes(answer)
        : exercise.type === 'multiple_select'
          ? answer
              .split('\n')
              .map((s) => s.trim())
              .filter(Boolean).length > 0
          : Boolean(answer.trim())

    if (!isValid) {
      setErrorByKey((prev) => ({ ...prev, [exercise.key]: 'Enter or select an answer first.' }))
      return
    }
    setErrorByKey((prev) => ({ ...prev, [exercise.key]: '' }))

    if (exercise.type === 'code') {
      const result = await verifyCodeInBrowser(answer, exercise.answer, exercise.prompt)
      setCodeResults((prev) => ({ ...prev, [exercise.key]: result }))
    }

    const deterministic = isDeterministicExercise(exercise.type)

    if (connectionState !== 'online') {
      const localDraft: LocalDraft = {
        exerciseKey: exercise.key,
        attemptId,
        answer,
        updatedAt: Date.now(),
        correct: deterministic ? (checkDeterministicExercise(exercise, answer) ? 1 : 0) : null,
      }
      setDrafts(saveLocalDraft(courseKey, lessonKey, localDraft))
      return
    }

    setBusyKey(`submit:${exercise.key}`)
    try {
      const contentHash = hashes[exercise.key] ?? (await computeContentHash(exercise))
      const created = await client.createAttempt({
        id: attemptId,
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
      rememberFull([created])
      setDrafts(removeLocalDraft(courseKey, lessonKey, exercise.key, attemptId))
      notifyPracticeUpdated(courseKey, lessonKey, [created])
    } catch (err) {
      // A 4xx is the sidecar refusing this answer; anything else may be transient, so keep a draft.
      if (err instanceof NoriApiError && err.status < 500) {
        setErrorByKey((prev) => ({ ...prev, [exercise.key]: err.message }))
      } else {
        // The sidecar may have recorded it before the connection failed; keep the
        // same id so the re-send returns that attempt instead of adding another.
        const localDraft: LocalDraft = {
          exerciseKey: exercise.key,
          attemptId,
          answer,
          updatedAt: Date.now(),
          correct: deterministic ? (checkDeterministicExercise(exercise, answer) ? 1 : 0) : null,
        }
        setDrafts(saveLocalDraft(courseKey, lessonKey, localDraft))
        setErrorByKey((prev) => ({ ...prev, [exercise.key]: 'Sidecar unreachable — saved locally as an unsent draft.' }))
      }
    } finally {
      setBusyKey(null)
    }
  }

  /** Keep full attempts from a response, and their summaries in the list. */
  const rememberFull = (full: PracticeAttempt[]) => {
    setFullAttempts((prev) => ({ ...prev, ...Object.fromEntries(full.map((a) => [a.id, a])) }))
    setAttempts((prev) => mergeAttempts(prev, full.map(toAttemptSummary)))
  }

  const loadFullAttempt = async (attemptId: string) => {
    if (fullAttempts[attemptId]) return
    setBusyKey(`load:${attemptId}`)
    try {
      rememberFull([await client.getAttempt(attemptId)])
    } catch (err) {
      setErrorByKey((prev) => ({ ...prev, [attemptId]: err instanceof Error ? err.message : 'Could not load the attempt.' }))
    } finally {
      setBusyKey(null)
    }
  }

  const handleFeedback = async (attempt: PracticeAttemptSummary) => {
    setBusyKey(`feedback:${attempt.id}`)
    setErrorByKey((prev) => ({ ...prev, [attempt.id]: '' }))
    try {
      const updated = await client.requestFeedback(attempt.id, attempt.version)
      rememberFull([updated])
      notifyPracticeUpdated(courseKey, lessonKey, [updated])
    } catch (err) {
      if (err instanceof NoriApiError && err.attempt) rememberFull([err.attempt])
      setErrorByKey((prev) => ({ ...prev, [attempt.id]: err instanceof Error ? err.message : 'Feedback failed.' }))
    } finally {
      setBusyKey(null)
    }
  }

  const handleCorrection = async (attempt: PracticeAttemptSummary) => {
    const note = noteInputs[attempt.id] ?? attempt.ownerNote
    setBusyKey(`correct:${attempt.id}`)
    setErrorByKey((prev) => ({ ...prev, [attempt.id]: '' }))
    try {
      const updated = await client.saveCorrection(attempt.id, note, attempt.version)
      rememberFull([updated])
      notifyPracticeUpdated(courseKey, lessonKey, [updated])
    } catch (err) {
      if (err instanceof NoriApiError && err.attempt) rememberFull([err.attempt])
      setErrorByKey((prev) => ({ ...prev, [attempt.id]: err instanceof Error ? err.message : 'Could not save correction.' }))
    } finally {
      setBusyKey(null)
    }
  }

  const handleCopyMarkdown = async () => {
    // The export needs prompts and feedback, which the list does not carry: fetch them now.
    // Offline, fall back to what is on the page (current prompts, feedback already loaded).
    const mdPromise = (async () => {
      let full: PracticeAttempt[]
      try {
        full = (await client.listPractice({ courseKey, lessonKey })).attempts
      } catch {
        full = attempts.map((summary) => {
          const loaded = fullAttempts[summary.id]
          if (loaded) return loaded
          const exercise = exercises.find((ex) => ex.key === summary.exerciseKey)
          const { exerciseType, hasFeedback: _hasFeedback, ...rest } = summary
          return {
            ...rest,
            feedback: '',
            exerciseSnapshot: {
              type: exerciseType,
              prompt: exercise?.prompt ?? '',
              options: exercise?.options ?? [],
              answer: exercise?.answer ?? '',
              explanation: exercise?.explanation ?? '',
            },
          }
        })
      }
      return formatAttemptsAsMarkdown({ courseKey, lessonKey, attempts: full, drafts })
    })()
    try {
      // Safari requires clipboard writes to start synchronously within the click gesture.
      if (typeof ClipboardItem !== 'undefined' && typeof navigator.clipboard?.write === 'function') {
        await navigator.clipboard.write([
          new ClipboardItem({ 'text/plain': mdPromise.then((md) => new Blob([md], { type: 'text/plain' })) }),
        ])
      } else {
        await navigator.clipboard.writeText(await mdPromise)
      }
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } catch {
      setErrorByKey((prev) => ({ ...prev, _global: 'Clipboard unavailable in this browser context.' }))
    }
  }

  const completedCount = exercises.filter(
    (ex) => attempts.some((a) => a.exerciseKey === ex.key) || Boolean(drafts[ex.key]),
  ).length

  return (
    <section className="nori-practice" aria-label={title}>
      <header className="nori-practice__header">
        <div className="nori-practice__title-group">
          <span className="nori-header-icon">
            <IconBookOpen />
          </span>
          <h3 className="nori-practice__title">{title}</h3>
          {exercises.length > 0 && (
            <span className="nori-badge">
              {completedCount} / {exercises.length} done
            </span>
          )}
        </div>
        <div className="nori-practice__meta">
          {connectionState === 'online' ? (
            <span className="nori-badge nori-badge--online" data-nori-status="online">
              <IconWifi />
              <span>Nori sidecar connected{health?.llmConfigured ? ' · AI ready' : ' · no LLM'}</span>
            </span>
          ) : connectionState === 'offline' ? (
            <span className="nori-badge nori-badge--warn" data-nori-status="offline">
              <IconWifiOff />
              <span>Offline · local mode</span>
            </span>
          ) : (
            <span className="nori-badge" data-nori-status="checking">
              <span>Checking sidecar…</span>
            </span>
          )}
          <button type="button" data-ui="nori" className="nori-btn nori-btn--sm" onClick={handleCopyMarkdown}>
            {copied ? <IconCheck /> : <IconCopy />}
            <span>{copied ? 'Copied Markdown' : 'Copy as Markdown'}</span>
          </button>
        </div>
      </header>

      {bankError && <p className="nori-error">{bankError}</p>}
      {errorByKey._global && <p className="nori-error">{errorByKey._global}</p>}

      {exercises.map((exercise, exIdx) => {
        const exerciseAttempts = attempts.filter((item) => item.exerciseKey === exercise.key)
        const currentHash = hashes[exercise.key]
        const localDraft = drafts[exercise.key]
        const value = inputs[exercise.key] ?? ''
        const hasSubmitted = exerciseAttempts.length > 0 || Boolean(localDraft)

        const latestAttempt = exerciseAttempts[exerciseAttempts.length - 1]
        const latestAnswer = latestAttempt?.answer ?? localDraft?.answer ?? ''
        const latestCorrect = latestAttempt ? latestAttempt.correct : localDraft?.correct
        const deterministic = isDeterministicExercise(exercise.type)
        const codeVerify = codeResults[exercise.key]
        const promptId = `${idPrefix}-prompt-${exIdx}`

        return (
          <article key={exercise.key} className="nori-card" data-exercise-key={exercise.key}>
            <div className="nori-card__top">
              <div className="nori-practice__meta">
                <span className="nori-index-badge">#{String(exIdx + 1).padStart(2, '0')}</span>
                <span className="nori-badge">
                  <IconExerciseType type={exercise.type} />
                  <span>{exercise.type.replace('_', ' ')}</span>
                </span>
                {deterministic && latestCorrect !== null && latestCorrect !== undefined && (
                  <span className={`nori-badge ${latestCorrect === 1 ? 'nori-badge--correct' : 'nori-badge--incorrect'}`}>
                    {latestCorrect === 1 ? <IconCheckCircle /> : <IconXCircle />}
                    <span>{latestCorrect === 1 ? 'Correct' : 'Incorrect'}</span>
                  </span>
                )}
              </div>
              {localDraft && (
                <span className="nori-badge nori-badge--warn">
                  <IconAlertTriangle />
                  <span>Unsent local draft</span>
                </span>
              )}
            </div>

            {exercise.promptHtml ? (
              <div id={promptId} className="nori-card__prompt" dangerouslySetInnerHTML={{ __html: exercise.promptHtml }} />
            ) : (
              <div id={promptId} className="nori-card__prompt">
                {renderRichText(exercise.prompt)}
              </div>
            )}

            <ExerciseAnswerField
              type={exercise.type}
              options={exercise.options}
              optionHtmls={exercise.optionHtmls}
              name={`nori-${courseKey}-${lessonKey}-${exercise.key}`}
              promptId={promptId}
              value={value}
              onChange={(next) => setInputs((prev) => ({ ...prev, [exercise.key]: next }))}
              reveal={hasSubmitted ? { expected: exercise.answer, submitted: latestAnswer } : null}
            />

            <div className="nori-actions">
              <button
                type="button"
                data-ui="nori"
                className="nori-btn nori-btn--primary"
                disabled={busyKey === `submit:${exercise.key}`}
                onClick={() => submitAnswer(exercise)}
              >
                <IconSend />
                <span>
                  {connectionState === 'online'
                    ? busyKey === `submit:${exercise.key}`
                      ? 'Saving…'
                      : 'Submit attempt'
                    : deterministic
                      ? 'Check locally'
                      : 'Save draft locally'}
                </span>
              </button>

              {exercise.type === 'code' && (
                <button
                  type="button"
                  data-ui="nori"
                  className="nori-btn"
                  disabled={busyKey === `verify:${exercise.key}` || !value.trim()}
                  onClick={() => handleVerifyCode(exercise)}
                >
                  <IconCode />
                  <span>{busyKey === `verify:${exercise.key}` ? 'Checking…' : 'Check code'}</span>
                </button>
              )}

              {connectionState === 'online' && localDraft && (
                <button
                  type="button"
                  data-ui="nori"
                  className="nori-btn"
                  disabled={busyKey === `submit:${exercise.key}`}
                  onClick={() => submitAnswer(exercise, localDraft)}
                >
                  <IconSend />
                  <span>Submit saved draft to Nori</span>
                </button>
              )}
            </div>

            {codeVerify && (
              <div className="nori-feedback" data-code-verified={codeVerify.passed ? 'pass' : 'fail'}>
                <div className="nori-card__top">
                  <div className="nori-feedback__header">
                    <IconCode />
                    <strong>{codeVerify.executed ? 'In-browser code run' : 'Heuristic check, not executed'}</strong>
                  </div>
                  <span className={`nori-badge ${codeVerify.passed ? 'nori-badge--correct' : 'nori-badge--incorrect'}`}>
                    {codeVerify.passed ? <IconCheckCircle /> : <IconXCircle />}
                    <span>{codeVerify.summary}</span>
                  </span>
                </div>
                <div className="nori-options">
                  {codeVerify.checks.map((c, idx) => (
                    <div key={idx} className="nori-attempt__summary">
                      <span className={`nori-badge ${c.passed ? 'nori-badge--correct' : 'nori-badge--incorrect'}`}>
                        {c.passed ? <IconCheckCircle /> : <IconXCircle />}
                        <span>{c.passed ? 'Pass' : 'Check'}</span>
                      </span>
                      <span className="nori-attempt__answer nori-attempt__answer--inline">{renderInlineMarkdown(c.label)}</span>
                      {c.detail && <span className="nori-muted">({c.detail})</span>}
                    </div>
                  ))}
                </div>
                {codeVerify.output && (
                  <pre className="nori-codeblock">
                    <span className="nori-codeblock__lang">stdout</span>
                    <code>{codeVerify.output}</code>
                  </pre>
                )}
              </div>
            )}

            {errorByKey[exercise.key] && <p className="nori-error">{errorByKey[exercise.key]}</p>}

            {hasSubmitted && (
              <details className="nori-details">
                <summary>
                  <IconBookOpen />
                  <span>Reference answer &amp; explanation</span>
                </summary>
                {exercise.answerHtml ? (
                  <div className="nori-attempt__answer" dangerouslySetInnerHTML={{ __html: exercise.answerHtml }} />
                ) : (
                  <div className="nori-attempt__answer">{renderRichText(exercise.answer)}</div>
                )}
                {exercise.explanation &&
                  (exercise.explanationHtml ? (
                    <div className="nori-muted" dangerouslySetInnerHTML={{ __html: exercise.explanationHtml }} />
                  ) : (
                    <div className="nori-muted">{renderRichText(exercise.explanation)}</div>
                  ))}
              </details>
            )}

            {exerciseAttempts.length > 0 && (
              <div className="nori-history">
                <div className="nori-history__header">
                  <p className="nori-muted">Recorded attempts ({exerciseAttempts.length})</p>
                </div>
                {exerciseAttempts.map((attempt) => {
                  const drifted = Boolean(currentHash && attempt.contentHash !== currentHash)
                  const full = fullAttempts[attempt.id]
                  const noteValue = noteInputs[attempt.id] ?? attempt.ownerNote
                  const isSingleLine = !attempt.answer.includes('\n')
                  return (
                    <div key={attempt.id} className="nori-attempt" data-attempt-id={attempt.id}>
                      <div className="nori-attempt__header">
                        <div className="nori-attempt__summary">
                          <span
                            className={`nori-badge ${
                              attempt.grading === 'deterministic'
                                ? attempt.correct === 1
                                  ? 'nori-badge--correct'
                                  : 'nori-badge--incorrect'
                                : ''
                            }`}
                          >
                            {attempt.grading === 'deterministic' ? (
                              attempt.correct === 1 ? (
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
                              <>
                                <IconExerciseType type={attempt.exerciseType} />
                                <span>Unscored</span>
                              </>
                            )}
                          </span>
                          {drifted && (
                            <span className="nori-badge nori-badge--warn">
                              <IconAlertTriangle />
                              <span>Previous question version</span>
                            </span>
                          )}
                          {isSingleLine && (
                            <span className="nori-attempt__answer nori-attempt__answer--inline">
                              {renderInlineMarkdown(attempt.answer)}
                            </span>
                          )}
                        </div>

                        {attempt.grading === 'unscored' && connectionState === 'online' && (
                          <button
                            type="button"
                            data-ui="nori"
                            className="nori-btn nori-btn--sm"
                            disabled={busyKey === `feedback:${attempt.id}` || !health?.llmConfigured}
                            onClick={() => handleFeedback(attempt)}
                          >
                            <IconSparkles />
                            <span>
                              {busyKey === `feedback:${attempt.id}`
                                ? 'Requesting feedback…'
                                : attempt.hasFeedback
                                  ? 'Refresh advisory feedback'
                                  : 'Ask AI for advisory feedback'}
                            </span>
                          </button>
                        )}
                      </div>

                      {drifted && full && (
                        <div className="nori-muted">Prompt at attempt time: {renderRichText(full.exerciseSnapshot.prompt)}</div>
                      )}
                      {!isSingleLine && <div className="nori-attempt__answer">{renderRichText(attempt.answer)}</div>}

                      {full?.feedback ? (
                        <div className="nori-feedback">
                          <div className="nori-feedback__header">
                            <IconSparkles />
                            <strong>Advisory AI feedback</strong>
                          </div>
                          <div className="nori-attempt__answer">{renderRichText(full.feedback)}</div>
                        </div>
                      ) : (
                        !full &&
                        (attempt.hasFeedback || drifted) && (
                          <div className="nori-actions">
                            <button
                              type="button"
                              data-ui="nori"
                              className="nori-btn nori-btn--sm"
                              disabled={busyKey === `load:${attempt.id}`}
                              onClick={() => loadFullAttempt(attempt.id)}
                            >
                              {attempt.hasFeedback ? <IconSparkles /> : <IconAlertTriangle />}
                              <span>
                                {busyKey === `load:${attempt.id}`
                                  ? 'Loading…'
                                  : attempt.hasFeedback
                                    ? drifted
                                      ? 'Show advisory feedback and prompt at attempt time'
                                      : 'Show advisory feedback'
                                    : 'Show prompt at attempt time'}
                              </span>
                            </button>
                          </div>
                        )
                      )}

                      {connectionState === 'online' && (
                        <div className="nori-actions">
                          <input
                            type="text"
                            data-ui="nori"
                            className="nori-input-inline"
                            placeholder="Record correction or takeaway…"
                            aria-label="Correction or takeaway note"
                            value={noteValue}
                            onChange={(e) => setNoteInputs((prev) => ({ ...prev, [attempt.id]: e.target.value }))}
                          />
                          <button
                            type="button"
                            data-ui="nori"
                            className="nori-btn nori-btn--sm"
                            disabled={busyKey === `correct:${attempt.id}`}
                            onClick={() => handleCorrection(attempt)}
                          >
                            <IconBookmark />
                            <span>{busyKey === `correct:${attempt.id}` ? 'Saving…' : 'Save correction'}</span>
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
