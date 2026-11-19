import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  NoriClient,
  type ReviewQueueItem,
  type ReviewQueueResponse,
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
import { renderInlineMarkdown, renderRichText } from './markdown'

export type NoriReviewQueueProps = {
  courseKey?: string
  apiBaseUrl?: string
  title?: string
}

const OPTION_KEYS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'

export function NoriReviewQueue({
  courseKey,
  apiBaseUrl = '/api/nori/v1',
  title = 'Spaced recall & weak-spot queue',
}: NoriReviewQueueProps) {
  const client = useMemo(() => new NoriClient({ baseUrl: apiBaseUrl }), [apiBaseUrl])
  const [online, setOnline] = useState<'checking' | 'online' | 'offline'>('checking')
  const [queue, setQueue] = useState<ReviewQueueResponse | null>(null)
  const [filter, setFilter] = useState<'due' | 'all'>('due')
  const [retryInputs, setRetryInputs] = useState<Record<string, string>>({})
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [copiedDigest, setCopiedDigest] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refreshQueue = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const res = await client.getReviewQueue({ courseKey }, signal)
        if (signal?.aborted) return
        setQueue(res)
        setOnline('online')
      } catch {
        if (!signal?.aborted) setOnline('offline')
      }
    },
    [client, courseKey],
  )

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
    setBusyKey('digest')
    setError(null)
    try {
      const digest = await client.getRecallDigest({ courseKey })
      await navigator.clipboard.writeText(digest.markdown)
      setCopiedDigest(true)
      setTimeout(() => setCopiedDigest(false), 1800)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not export recall digest.')
    } finally {
      setBusyKey(null)
    }
  }

  const handleRetrySubmit = async (item: ReviewQueueItem) => {
    const key = `${item.courseKey}::${item.lessonKey}::${item.exerciseKey}`
    const answer = retryInputs[key] ?? ''
    if (!answer.trim()) return
    setBusyKey(key)
    setError(null)
    try {
      await client.createAttempt({
        courseKey: item.courseKey,
        lessonKey: item.lessonKey,
        exerciseKey: item.exerciseKey,
        contentHash: item.latestAttempt.contentHash,
        exerciseSnapshot: item.latestAttempt.exerciseSnapshot,
        answer,
      })
      setRetryInputs((prev) => ({ ...prev, [key]: '' }))
      await refreshQueue()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Retry submission failed.')
    } finally {
      setBusyKey(null)
    }
  }

  const items = useMemo(() => {
    if (!queue) return []
    return filter === 'due' ? queue.items.filter((i) => i.isDue) : queue.items
  }, [queue, filter])

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
              disabled={busyKey === 'digest'}
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
            items.map((item) => {
              const key = `${item.courseKey}::${item.lessonKey}::${item.exerciseKey}`
              const snap = item.latestAttempt.exerciseSnapshot
              const value = retryInputs[key] ?? ''
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

                  <div className="nori-card__prompt">{renderRichText(snap.prompt)}</div>

                  {snap.type === 'multiple_choice' ? (
                    <div className="nori-options">
                      {snap.options.map((opt, idx) => {
                        const isSelected = value === opt
                        return (
                          <label
                            key={opt}
                            className={`nori-option nori-option--has-key${isSelected ? ' nori-option--selected' : ''}`}
                          >
                            <input
                              type="radio"
                              data-ui="nori"
                              name={`review-${key}`}
                              checked={isSelected}
                              onChange={() => setRetryInputs((prev) => ({ ...prev, [key]: opt }))}
                            />
                            <span className="nori-option__key">{OPTION_KEYS[idx] ?? idx + 1}</span>
                            <span className="nori-option__body">{renderInlineMarkdown(opt)}</span>
                          </label>
                        )
                      })}
                    </div>
                  ) : (
                    <input
                      type="text"
                      data-ui="nori"
                      className="nori-input-inline"
                      placeholder="Write a quick recall retry…"
                      value={value}
                      onChange={(e) => setRetryInputs((prev) => ({ ...prev, [key]: e.target.value }))}
                    />
                  )}

                  <div className="nori-actions">
                    <button
                      type="button"
                      data-ui="nori"
                      className="nori-btn nori-btn--primary nori-btn--sm"
                      disabled={busyKey === key || !value.trim()}
                      onClick={() => handleRetrySubmit(item)}
                    >
                      <IconSend />
                      <span>{busyKey === key ? 'Saving retry…' : 'Submit recall retry'}</span>
                    </button>
                    {item.latestAttempt.ownerNote && (
                      <span className="nori-muted">Takeaway: {item.latestAttempt.ownerNote}</span>
                    )}
                  </div>
                </article>
              )
            })
          )}
        </>
      )}
    </section>
  )
}
