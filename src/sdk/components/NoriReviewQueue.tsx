import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import {
  getSharedNoriClient,
  NoriApiError,
  toAttemptSummary,
  type PracticeAttempt,
  type PracticeUpdatedDetail,
  type ReviewQueueSummaryItem,
  type ReviewQueueSummaryResponse,
} from '../index'
import {
  IconAlertTriangle,
  IconBookOpen,
  IconCheck,
  IconCheckCircle,
  IconClock,
  IconCopy,
  IconExerciseType,
  IconSend,
  IconWifi,
  IconWifiOff,
  IconXCircle,
} from './icons'
import { useNoriConnection } from './connection'
import { ExerciseAnswerField } from './ExerciseAnswerField'
import { renderRichText } from './markdown'

export type NoriReviewQueueProps = {
  courseKey?: string
  apiBaseUrl?: string
  title?: string
}

const itemKey = (item: { courseKey: string; lessonKey: string; exerciseKey: string }) =>
  `${item.courseKey}::${item.lessonKey}::${item.exerciseKey}`

function isAnswerReady(type: string, options: string[], answer: string): boolean {
  if (type === 'multiple_choice') return options.includes(answer)
  return answer.trim() !== ''
}

export function NoriReviewQueue({
  courseKey,
  apiBaseUrl = '/api/nori/v1',
  title = 'Spaced recall & weak-spot queue',
}: NoriReviewQueueProps) {
  const client = useMemo(() => getSharedNoriClient(apiBaseUrl), [apiBaseUrl])
  const [queue, setQueue] = useState<ReviewQueueSummaryResponse | null>(null)
  const [filter, setFilter] = useState<'due' | 'all'>('due')
  const [retryInputs, setRetryInputs] = useState<Record<string, string>>({})
  // Items answered here stay on screen with their result until dismissed, even once no longer due.
  const [answered, setAnswered] = useState<Record<string, PracticeAttempt>>({})
  const [itemErrors, setItemErrors] = useState<Record<string, string>>({})
  // Keys with a request in flight: 'digest', or one per queue item, so items save independently.
  const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set())
  const markBusy = (key: string, on: boolean) =>
    setBusy((prev) => {
      const next = new Set(prev)
      if (on) next.add(key)
      else next.delete(key)
      return next
    })
  // One attempt id per item and answer, kept until the save succeeds: a retry after a lost
  // response re-sends the same id, and the sidecar records it once.
  const pendingAttempts = useRef(new Map<string, { answer: string; id: string }>())
  const idPrefix = useId()
  const [copiedDigest, setCopiedDigest] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refreshQueue = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const res = await client.getReviewQueueSummary({ courseKey }, signal)
        if (signal?.aborted) return
        setQueue(res)
      } catch {
        // The shared client tracks offline state and retries with backoff.
      }
    },
    [client, courseKey],
  )

  const online = useNoriConnection(client, () => {
    refreshQueue()
  })

  useEffect(() => {
    const controller = new AbortController()
    refreshQueue(controller.signal)
    return () => controller.abort()
  }, [refreshQueue])

  useEffect(() => {
    if (typeof window === 'undefined') return
    const onUpdated = () => refreshQueue()
    window.addEventListener('nori:practice-updated', onUpdated)
    return () => window.removeEventListener('nori:practice-updated', onUpdated)
  }, [refreshQueue])

  const handleCopyDigest = async () => {
    markBusy('digest', true)
    setError(null)
    try {
      const digest = await client.getRecallDigest({ courseKey })
      await navigator.clipboard.writeText(digest.markdown)
      setCopiedDigest(true)
      setTimeout(() => setCopiedDigest(false), 1800)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not export recall digest.')
    } finally {
      markBusy('digest', false)
    }
  }

  const handleRetrySubmit = async (item: ReviewQueueSummaryItem) => {
    const key = itemKey(item)
    const answer = retryInputs[key] ?? ''
    if (busy.has(key) || !isAnswerReady(item.latestAttempt.exerciseType, item.latestAttempt.options, answer)) return
    let pending = pendingAttempts.current.get(key)
    if (!pending || pending.answer !== answer) {
      pending = { answer, id: crypto.randomUUID() }
      pendingAttempts.current.set(key, pending)
    }
    markBusy(key, true)
    setItemErrors((prev) => ({ ...prev, [key]: '' }))
    try {
      // The queue omits the reference answer; the attempt needs the full snapshot to be graded.
      const latest = await client.getAttempt(item.latestAttempt.id)
      const created = await client.createAttempt({
        id: pending.id,
        courseKey: item.courseKey,
        lessonKey: item.lessonKey,
        exerciseKey: item.exerciseKey,
        contentHash: latest.contentHash,
        exerciseSnapshot: latest.exerciseSnapshot,
        answer,
      })
      pendingAttempts.current.delete(key)
      setAnswered((prev) => ({ ...prev, [key]: created }))
      setRetryInputs((prev) => ({ ...prev, [key]: '' }))
      if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
        const detail: PracticeUpdatedDetail = { courseKey: item.courseKey, lessonKey: item.lessonKey, attempts: [toAttemptSummary(created)] }
        window.dispatchEvent(new CustomEvent('nori:practice-updated', { detail }))
      }
      await refreshQueue()
    } catch (e) {
      const message = e instanceof NoriApiError ? e.message : 'Could not save the answer. Check the connection and try again.'
      setItemErrors((prev) => ({ ...prev, [key]: message }))
    } finally {
      markBusy(key, false)
    }
  }

  const dismissAnswered = (key: string) =>
    setAnswered((prev) => {
      const next = { ...prev }
      delete next[key]
      return next
    })

  const items = useMemo(() => {
    if (!queue) return []
    return filter === 'due' ? queue.items.filter((i) => i.isDue || answered[itemKey(i)]) : queue.items
  }, [queue, filter, answered])

  return (
    <section className="nori-practice" aria-label={title}>
      <header className="nori-practice__header">
        <div className="nori-practice__title-group">
          <span className="nori-header-icon">
            <IconClock />
          </span>
          <h3 className="nori-practice__title">{title}</h3>
          {queue && (
            <>
              <span className={`nori-badge ${queue.summary.dueNow > 0 ? 'nori-badge--incorrect' : 'nori-badge--correct'}`}>
                {queue.summary.dueNow} due now
              </span>
              <span className="nori-badge">{queue.summary.totalTracked} tracked</span>
            </>
          )}
        </div>
        <div className="nori-practice__meta">
          <span className={`nori-badge ${online === 'online' ? 'nori-badge--online' : 'nori-badge--warn'}`} data-nori-status={online}>
            {online === 'online' ? <IconWifi /> : <IconWifiOff />}
            <span>{online === 'online' ? 'Nori recall synced' : 'Offline'}</span>
          </span>
          {online === 'online' && (
            <button
              type="button"
              data-ui="nori"
              className="nori-btn nori-btn--sm"
              disabled={busy.has('digest')}
              onClick={handleCopyDigest}
            >
              {copiedDigest ? <IconCheck /> : <IconCopy />}
              <span>{copiedDigest ? 'Copied Recall Digest' : 'Copy Recall Digest'}</span>
            </button>
          )}
        </div>
      </header>

      {error && <p className="nori-error">{error}</p>}

      {online === 'online' && queue && (
        <>
          <div className="nori-actions">
            <button
              type="button"
              data-ui="nori"
              className={`nori-btn nori-btn--sm${filter === 'due' ? ' nori-btn--primary' : ''}`}
              onClick={() => setFilter('due')}
            >
              <IconAlertTriangle />
              <span>Due &amp; weak spots ({queue.summary.dueNow})</span>
            </button>
            <button
              type="button"
              data-ui="nori"
              className={`nori-btn nori-btn--sm${filter === 'all' ? ' nori-btn--primary' : ''}`}
              onClick={() => setFilter('all')}
            >
              <IconBookOpen />
              <span>All tracked ({queue.summary.totalTracked})</span>
            </button>
          </div>

          {items.length === 0 ? (
            <div className="nori-card">
              <p className="nori-muted">
                {queue.summary.totalTracked === 0
                  ? 'No recorded practice attempts yet. Complete a lesson exercise to start spaced recall.'
                  : 'All tracked exercises are up to date — no weak spots or recall items due right now.'}
              </p>
            </div>
          ) : (
            items.map((item, itemIdx) => {
              const key = itemKey(item)
              const snap = { ...item.latestAttempt, type: item.latestAttempt.exerciseType }
              const value = retryInputs[key] ?? ''
              const result = answered[key]
              const promptId = `${idPrefix}-prompt-${itemIdx}`
              const lessonHref = item.lessonKey
                ? `/courses/${item.courseKey}/lessons/${item.lessonKey}`
                : `/courses/${item.courseKey}`

              return (
                <article key={key} className="nori-card" data-review-key={key}>
                  <div className="nori-card__top">
                    <div className="nori-practice__meta">
                      <span className="nori-index-badge">{item.exerciseKey}</span>
                      <a href={lessonHref} className="nori-badge" style={{ textDecoration: 'none' }}>
                        <IconBookOpen />
                        <span>{item.lessonKey || item.courseKey}</span>
                      </a>
                      <span className="nori-badge">
                        <IconExerciseType type={snap.type} />
                        <span>{snap.type.replace('_', ' ')}</span>
                      </span>
                      {item.reason === 'incorrect' ? (
                        <span className="nori-badge nori-badge--incorrect">
                          <IconXCircle />
                          <span>Weak spot (incorrect)</span>
                        </span>
                      ) : item.isDue ? (
                        <span className="nori-badge nori-badge--warn">
                          <IconClock />
                          <span>Due for recall (streak {item.streak})</span>
                        </span>
                      ) : (
                        <span className="nori-badge nori-badge--correct">
                          <IconCheckCircle />
                          <span>
                            Scheduled ({item.intervalDays}d · streak {item.streak})
                          </span>
                        </span>
                      )}
                    </div>
                    <span className="nori-muted">{item.attemptCount} attempt(s)</span>
                  </div>

                  <div id={promptId} className="nori-card__prompt">
                    {renderRichText(result ? result.exerciseSnapshot.prompt : snap.prompt)}
                  </div>

                  {result ? (
                    <>
                      <ExerciseAnswerField
                        type={result.exerciseSnapshot.type}
                        options={result.exerciseSnapshot.options}
                        name={`review-${key}`}
                        promptId={promptId}
                        value={result.answer}
                        onChange={() => undefined}
                        reveal={{ expected: result.exerciseSnapshot.answer, submitted: result.answer }}
                        disabled
                      />
                      <div className="nori-feedback" data-review-result={result.correct === 1 ? 'correct' : result.correct === 0 ? 'incorrect' : 'recorded'}>
                        <div className="nori-card__top">
                          <span
                            className={`nori-badge ${result.correct === 1 ? 'nori-badge--correct' : result.correct === 0 ? 'nori-badge--incorrect' : ''}`}
                          >
                            {result.correct === 1 ? <IconCheckCircle /> : result.correct === 0 ? <IconXCircle /> : <IconCheck />}
                            <span>{result.correct === 1 ? 'Correct' : result.correct === 0 ? 'Incorrect' : 'Answer recorded'}</span>
                          </span>
                          <span className="nori-muted">
                            {item.isDue ? 'Still due: try again later' : `Next review in ${item.intervalDays} day(s)`}
                          </span>
                        </div>
                        {result.exerciseSnapshot.type !== 'multiple_choice' && result.exerciseSnapshot.type !== 'multiple_select' && (
                          <div>
                            <strong>Reference answer</strong>
                            <div className="nori-attempt__answer">{renderRichText(result.exerciseSnapshot.answer)}</div>
                          </div>
                        )}
                        {result.exerciseSnapshot.explanation && (
                          <div className="nori-muted">{renderRichText(result.exerciseSnapshot.explanation)}</div>
                        )}
                      </div>
                      <div className="nori-actions">
                        <button type="button" data-ui="nori" className="nori-btn nori-btn--sm" onClick={() => dismissAnswered(key)}>
                          <IconCheck />
                          <span>Done</span>
                        </button>
                      </div>
                    </>
                  ) : (
                    <>
                      <ExerciseAnswerField
                        type={snap.type}
                        options={snap.options}
                        name={`review-${key}`}
                        promptId={promptId}
                        value={value}
                        onChange={(next) => setRetryInputs((prev) => ({ ...prev, [key]: next }))}
                        disabled={busy.has(key)}
                      />
                      {itemErrors[key] && <p className="nori-error">{itemErrors[key]}</p>}
                      <div className="nori-actions">
                        <button
                          type="button"
                          data-ui="nori"
                          className="nori-btn nori-btn--primary nori-btn--sm"
                          disabled={busy.has(key) || !isAnswerReady(snap.type, snap.options, value)}
                          onClick={() => handleRetrySubmit(item)}
                        >
                          <IconSend />
                          <span>{busy.has(key) ? 'Saving…' : 'Submit answer'}</span>
                        </button>
                        {item.latestAttempt.ownerNote && (
                          <span className="nori-muted">Takeaway: {item.latestAttempt.ownerNote}</span>
                        )}
                      </div>
                    </>
                  )}
                </article>
              )
            })
          )}
        </>
      )}
    </section>
  )
}
