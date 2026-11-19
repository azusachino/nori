import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  checkDeterministicExercise,
  computeContentHash,
  formatAttemptsAsMarkdown,
  isDeterministicExercise,
  loadLocalDrafts,
  NoriApiError,
  NoriClient,
  removeLocalDraft,
  saveLocalDraft,
  verifyCodeInBrowser,
  type CodeVerificationResult,
  type HealthStatus,
  type LocalDraft,
  type PracticeAttempt,
  type PracticeBank,
  type PracticeExercise,
} from '../index'
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
import { renderInlineMarkdown, renderRichText } from './markdown'

export type NoriPracticeProps = {
  courseKey: string
  lessonKey?: string
  bank?: string
  exercises?: PracticeExercise[]
  apiBaseUrl?: string
  title?: string
}

function notifyPracticeUpdated(courseKey: string, lessonKey: string) {
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    window.dispatchEvent(new CustomEvent('nori:practice-updated', { detail: { courseKey, lessonKey } }))
  }
}

const OPTION_KEYS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'

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

  const toggleMultiOption = (exerciseKey: string, option: string) => {
    setInputs((prev) => {
      const current = (prev[exerciseKey] ?? '')
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean)
      const next = current.includes(option) ? current.filter((item) => item !== option) : [...current, option]
      return { ...prev, [exerciseKey]: next.join('\n') }
    })
  }

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

  const submitAnswer = async (exercise: PracticeExercise, overrideAnswer?: string) => {
    const answer = overrideAnswer ?? inputs[exercise.key] ?? ''
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
      notifyPracticeUpdated(courseKey, lessonKey)
    } catch (err) {
      if (err instanceof NoriApiError) {
        setErrorByKey((prev) => ({ ...prev, [exercise.key]: err.message }))
      } else {
        setConnectionState('offline')
        const localDraft: LocalDraft = {
          exerciseKey: exercise.key,
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

  const handleFeedback = async (attempt: PracticeAttempt) => {
    setBusyKey(`feedback:${attempt.id}`)
    setErrorByKey((prev) => ({ ...prev, [attempt.id]: '' }))
    try {
      const updated = await client.requestFeedback(attempt.id, attempt.version)
      setAttempts((prev) => prev.map((item) => (item.id === updated.id ? updated : item)))
      notifyPracticeUpdated(courseKey, lessonKey)
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
      notifyPracticeUpdated(courseKey, lessonKey)
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

        const expectedSet =
          exercise.type === 'multiple_select'
            ? new Set(
                exercise.answer
                  .split('\n')
                  .map((s) => s.trim())
                  .filter(Boolean),
              )
            : null
        const latestPickedSet =
          exercise.type === 'multiple_select'
            ? new Set(
                latestAnswer
                  .split('\n')
                  .map((s) => s.trim())
                  .filter(Boolean),
              )
            : null
        const currentPickedSet =
          exercise.type === 'multiple_select'
            ? new Set(
                value
                  .split('\n')
                  .map((s) => s.trim())
                  .filter(Boolean),
              )
            : null

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
              <div className="nori-card__prompt" dangerouslySetInnerHTML={{ __html: exercise.promptHtml }} />
            ) : (
              <div className="nori-card__prompt">{renderRichText(exercise.prompt)}</div>
            )}

            {exercise.type === 'multiple_choice' ? (
              <div className="nori-options" role="radiogroup" aria-label={exercise.prompt}>
                {exercise.options.map((option, optIdx) => {
                  const isSelected = value === option
                  const isCorrectOption = hasSubmitted && option === exercise.answer
                  const isWrongPicked = hasSubmitted && latestAnswer === option && option !== exercise.answer
                  const classes = ['nori-option', 'nori-option--has-key']
                  if (isCorrectOption) classes.push('nori-option--correct')
                  else if (isWrongPicked) classes.push('nori-option--incorrect')
                  else if (isSelected) classes.push('nori-option--selected')

                  return (
                    <label key={option} className={classes.join(' ')}>
                      <input
                        type="radio"
                        data-ui="nori"
                        name={`nori-${courseKey}-${lessonKey}-${exercise.key}`}
                        value={option}
                        checked={isSelected}
                        onChange={() => setInputs((prev) => ({ ...prev, [exercise.key]: option }))}
                      />
                      <span className="nori-option__key" aria-hidden="true">
                        {OPTION_KEYS[optIdx] ?? optIdx + 1}
                      </span>
                      {exercise.optionHtmls?.[optIdx] ? (
                        <span className="nori-option__body" dangerouslySetInnerHTML={{ __html: exercise.optionHtmls[optIdx]! }} />
                      ) : (
                        <span className="nori-option__body">{renderInlineMarkdown(option)}</span>
                      )}
                      {isCorrectOption && (
                        <span className="nori-option__status nori-option__status--correct" aria-label="Correct option">
                          <IconCheckCircle />
                        </span>
                      )}
                      {isWrongPicked && (
                        <span className="nori-option__status nori-option__status--incorrect" aria-label="Incorrect choice">
                          <IconXCircle />
                        </span>
                      )}
                    </label>
                  )
                })}
              </div>
            ) : exercise.type === 'multiple_select' ? (
              <div className="nori-options" role="group" aria-label={exercise.prompt}>
                {exercise.options.map((option, optIdx) => {
                  const isSelected = Boolean(currentPickedSet?.has(option))
                  const isCorrectOption = hasSubmitted && Boolean(expectedSet?.has(option))
                  const isWrongPicked = hasSubmitted && Boolean(latestPickedSet?.has(option)) && !expectedSet?.has(option)
                  const classes = ['nori-option']
                  if (isCorrectOption) classes.push('nori-option--correct')
                  else if (isWrongPicked) classes.push('nori-option--incorrect')
                  else if (isSelected) classes.push('nori-option--selected')

                  return (
                    <label key={option} className={classes.join(' ')}>
                      <input
                        type="checkbox"
                        data-ui="nori"
                        checked={isSelected}
                        onChange={() => toggleMultiOption(exercise.key, option)}
                      />
                      <span className="nori-option__key" aria-hidden="true">
                        {OPTION_KEYS[optIdx] ?? optIdx + 1}
                      </span>
                      {exercise.optionHtmls?.[optIdx] ? (
                        <span className="nori-option__body" dangerouslySetInnerHTML={{ __html: exercise.optionHtmls[optIdx]! }} />
                      ) : (
                        <span className="nori-option__body">{renderInlineMarkdown(option)}</span>
                      )}
                      {isCorrectOption && (
                        <span className="nori-option__status nori-option__status--correct" aria-label="Correct option">
                          <IconCheckCircle />
                        </span>
                      )}
                      {isWrongPicked && (
                        <span className="nori-option__status nori-option__status--incorrect" aria-label="Incorrect choice">
                          <IconXCircle />
                        </span>
                      )}
                    </label>
                  )
                })}
              </div>
            ) : exercise.type === 'cloze' ? (
              <input
                type="text"
                data-ui="nori"
                className="nori-input-inline"
                style={{ width: '100%', height: '38px' }}
                placeholder="Type exact answer…"
                value={value}
                onChange={(e) => setInputs((prev) => ({ ...prev, [exercise.key]: e.target.value }))}
              />
            ) : (
              <textarea
                data-ui="nori"
                className={`nori-textarea${exercise.type === 'code' ? ' nori-textarea--code' : ''}`}
                placeholder={exercise.type === 'code' ? 'Write your code attempt (in-browser verification ready)…' : 'Write your explanation in your own words…'}
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
                  <span>{busyKey === `verify:${exercise.key}` ? 'Verifying…' : 'Verify code'}</span>
                </button>
              )}

              {connectionState === 'online' && localDraft && (
                <button
                  type="button"
                  data-ui="nori"
                  className="nori-btn"
                  disabled={busyKey === `submit:${exercise.key}`}
                  onClick={() => submitAnswer(exercise, localDraft.answer)}
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
                    <strong>In-browser code verification</strong>
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
                                <IconExerciseType type={attempt.exerciseSnapshot.type} />
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
                                : attempt.feedback
                                  ? 'Refresh advisory feedback'
                                  : 'Ask AI for advisory feedback'}
                            </span>
                          </button>
                        )}
                      </div>

                      {drifted && (
                        <div className="nori-muted">Prompt at attempt time: {renderRichText(attempt.exerciseSnapshot.prompt)}</div>
                      )}
                      {!isSingleLine && <div className="nori-attempt__answer">{renderRichText(attempt.answer)}</div>}

                      {attempt.feedback && (
                        <div className="nori-feedback">
                          <div className="nori-feedback__header">
                            <IconSparkles />
                            <strong>Advisory AI feedback</strong>
                          </div>
                          <div className="nori-attempt__answer">{renderRichText(attempt.feedback)}</div>
                        </div>
                      )}

                      {connectionState === 'online' && (
                        <div className="nori-actions">
                          <input
                            type="text"
                            data-ui="nori"
                            className="nori-input-inline"
                            placeholder="Record correction or takeaway…"
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
