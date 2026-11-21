import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  getSharedNoriClient,
  mergeAttempts,
  type PracticeAttemptSummary,
  type PracticeUpdatedDetail,
  type TutorContextMeta,
  type TutorTurn,
} from '../index'
import { useNoriConnection } from './connection'
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
import { extractHeadings, renderInlineMarkdown, renderRichText } from './markdown'

/** A reply this long, or with this many headings, gets a jump list. */
const OUTLINE_MIN_CHARS = 1500
const OUTLINE_MIN_HEADINGS = 3
/** How often streamed text is redrawn. */
const STREAM_FLUSH_MS = 50

type PendingExchange = { message: string; reply: string; context: TutorContextMeta | null }

function contextNote(meta: TutorContextMeta): string {
  const dropped = meta.historyTurnsDropped
  return `Context: ${meta.contextChars} chars · ${meta.attemptIds.length} attempt(s) · ${meta.historyTurnsIncluded} prior turn(s)${
    dropped > 0 ? ` · ${dropped} earlier turn(s) left out` : ''
  }`
}

function ReplyOutline({ text, idPrefix }: { text: string; idPrefix: string }) {
  const headings = extractHeadings(text, idPrefix)
  if (headings.length < 2 || (headings.length < OUTLINE_MIN_HEADINGS && text.length < OUTLINE_MIN_CHARS)) return null
  return (
    <nav className="nori-outline" aria-label="Reply outline">
      <span className="nori-muted">In this reply:</span>
      <ul>
        {headings.map((h) => (
          <li key={h.id} className={`nori-outline__item nori-outline__item--${h.level}`}>
            <a href={`#${h.id}`}>{renderInlineMarkdown(h.text)}</a>
          </li>
        ))}
      </ul>
    </nav>
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
  const client = useMemo(() => getSharedNoriClient(apiBaseUrl), [apiBaseUrl])
  const [lesson, setLesson] = useState<{ title: string; body: string } | null>(null)
  const [llmConfigured, setLlmConfigured] = useState(false)
  const [attempts, setAttempts] = useState<PracticeAttemptSummary[]>([])
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [turns, setTurns] = useState<TutorTurn[]>([])
  const [historyLimit, setHistoryLimit] = useState<{ maxTurns: number } | null>(null)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [pending, setPending] = useState<PendingExchange | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const inflight = useRef<AbortController | null>(null)

  // Leaving the page cancels the reply, which also stops the model on the sidecar.
  useEffect(() => () => inflight.current?.abort(), [])

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

  // Data calls double as the health check; the shared client dedupes the /practice
  // and /health requests NoriPractice makes on the same page.
  const loadFromSidecar = useCallback(
    async (signal?: AbortSignal) => {
      client
        .health(signal)
        .then((h) => {
          if (!signal?.aborted) setLlmConfigured(h.llmConfigured)
        })
        .catch(() => undefined)
      try {
        const [practice, tutor] = await Promise.all([
          client.listPracticeSummaries({ courseKey, lessonKey }, signal),
          client.getTutor(courseKey, lessonKey, signal),
        ])
        if (signal?.aborted) return
        setAttempts(practice.attempts)
        setTurns(tutor.turns)
        setHistoryLimit(tutor.historyLimit ?? null)
      } catch {
        // The shared client tracks offline state and retries with backoff.
      }
    },
    [client, courseKey, lessonKey],
  )

  const online = useNoriConnection(client, () => {
    loadFromSidecar()
  })

  useEffect(() => {
    const controller = new AbortController()
    loadFromSidecar(controller.signal)
    return () => controller.abort()
  }, [loadFromSidecar])

  // <NoriPractice /> on the same page sends the attempts it created or updated;
  // merge them instead of refetching. Refetch only if an event carries none.
  useEffect(() => {
    if (typeof window === 'undefined') return
    const onUpdated = (e: Event) => {
      const detail = (e as CustomEvent<Partial<PracticeUpdatedDetail>>).detail
      if (detail && (detail.courseKey !== courseKey || (detail.lessonKey && detail.lessonKey !== lessonKey))) return
      const incoming = detail?.attempts
      if (!incoming) {
        client
          .listPracticeSummaries({ courseKey, lessonKey })
          .then((practice) => setAttempts(practice.attempts))
          .catch(() => undefined)
        return
      }
      setAttempts((prev) => mergeAttempts(prev, incoming))
    }
    window.addEventListener('nori:practice-updated', onUpdated)
    return () => window.removeEventListener('nori:practice-updated', onUpdated)
  }, [client, courseKey, lessonKey])

  const toggleAttempt = (id: string) => {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]))
  }

  const handleSend = async () => {
    const sent = message.trim()
    if (!lesson || !sent || inflight.current) return
    const controller = new AbortController()
    inflight.current = controller
    setBusy(true)
    setError(null)
    setNotice(null)
    setMessage('')
    setPending({ message: sent, reply: '', context: null })
    let streamed = ''
    let flushTimer: ReturnType<typeof setTimeout> | null = null
    const flush = () => {
      flushTimer = null
      setPending((p) => p && { ...p, reply: streamed })
    }
    try {
      const res = await client.streamTutorMessage(
        {
          courseKey,
          lessonKey,
          lessonTitle: lesson.title,
          lessonText: lesson.body,
          attemptIds: selectedIds,
          message: sent,
        },
        {
          onStart: (context) => setPending((p) => p && { ...p, context }),
          onDelta: (text) => {
            streamed += text
            flushTimer ??= setTimeout(flush, STREAM_FLUSH_MS)
          },
        },
        controller.signal,
      )
      setTurns(res.turns)
    } catch (e) {
      // Nothing was saved: give the question back so it can be sent again.
      setMessage((current) => current || sent)
      if (controller.signal.aborted) setNotice('Cancelled. Nothing was saved.')
      else setError(e instanceof Error ? e.message : 'Tutor request failed.')
    } finally {
      if (flushTimer) clearTimeout(flushTimer)
      setPending(null)
      inflight.current = null
      setBusy(false)
    }
  }

  const handleCancel = () => inflight.current?.abort()

  const olderTurnsLeftOut = historyLimit !== null && turns.length > historyLimit.maxTurns

  return (
    <section className="nori-practice" aria-label={title}>
      <header className="nori-practice__header">
        <div className="nori-practice__title-group">
          <span className="nori-header-icon">
            <IconBot />
          </span>
          <h3 className="nori-practice__title">{title}</h3>
        </div>
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
      {notice && <p className="nori-muted">{notice}</p>}

      {online === 'online' && (
        <>
          {attempts.length > 0 && (
            <div className="nori-card">
              <p className="nori-muted">Include recorded attempts in tutor context ({selectedIds.length} selected):</p>
              <div className="nori-options">
                {attempts.map((a) => {
                  const isChecked = selectedIds.includes(a.id)
                  const isSingleLine = !a.answer.includes('\n')
                  return (
                    <label key={a.id} className={`nori-option${isChecked ? ' nori-option--selected' : ''}`}>
                      <input type="checkbox" data-ui="nori" checked={isChecked} onChange={() => toggleAttempt(a.id)} />
                      <div className="nori-option__body">
                        <div className="nori-attempt__summary">
                          <span className="nori-index-badge">{a.exerciseKey}</span>
                          {a.grading === 'deterministic' && (
                            <span className={`nori-badge ${a.correct === 1 ? 'nori-badge--correct' : 'nori-badge--incorrect'}`}>
                              {a.correct === 1 ? <IconCheckCircle /> : <IconXCircle />}
                              <span>{a.correct === 1 ? 'Correct' : 'Incorrect'}</span>
                            </span>
                          )}
                          {a.grading === 'unscored' && (
                            <span className="nori-badge">
                              <IconExerciseType type={a.exerciseType} />
                              <span>{a.exerciseType}</span>
                            </span>
                          )}
                          {isSingleLine && (
                            <span className="nori-attempt__answer nori-attempt__answer--inline">
                              {renderInlineMarkdown(a.answer)}
                            </span>
                          )}
                        </div>
                        {!isSingleLine && <div className="nori-attempt__answer">{renderRichText(a.answer)}</div>}
                      </div>
                    </label>
                  )
                })}
              </div>
            </div>
          )}

          {(turns.length > 0 || pending) && (
            <div className="nori-history">
              {turns.map((t) => {
                const idPrefix = `nori-tutor-${t.id}`
                return (
                  <div key={t.id} className={t.role === 'assistant' ? 'nori-feedback' : 'nori-attempt'}>
                    <div className="nori-feedback__header">
                      {t.role === 'assistant' ? <IconSparkles /> : <IconUser />}
                      <strong>{t.role === 'assistant' ? 'Nori Tutor' : 'You'}</strong>
                    </div>
                    {t.role === 'assistant' && <ReplyOutline text={t.content} idPrefix={idPrefix} />}
                    <div className="nori-attempt__answer">
                      {renderRichText(t.content, t.role === 'assistant' ? { headingIdPrefix: idPrefix } : {})}
                    </div>
                    {t.role === 'assistant' && <p className="nori-muted">{contextNote(t.contextMeta)}</p>}
                  </div>
                )
              })}
              {pending && (
                <>
                  <div className="nori-attempt">
                    <div className="nori-feedback__header">
                      <IconUser />
                      <strong>You</strong>
                    </div>
                    <div className="nori-attempt__answer">{renderRichText(pending.message)}</div>
                  </div>
                  <div className="nori-feedback" aria-busy="true">
                    <div className="nori-feedback__header">
                      <IconSparkles />
                      <strong>Nori Tutor</strong>
                    </div>
                    <div className="nori-attempt__answer">
                      {pending.reply ? renderRichText(pending.reply) : <span className="nori-muted">Thinking…</span>}
                    </div>
                    {pending.context && <p className="nori-muted">{contextNote(pending.context)}</p>}
                  </div>
                </>
              )}
            </div>
          )}

          <div className="nori-card">
            <textarea
              data-ui="nori"
              className="nori-textarea"
              placeholder="Ask a question about this lesson or your selected attempts… (Ctrl/Cmd + Enter to send)"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !busy && lesson && llmConfigured && message.trim()) {
                  e.preventDefault()
                  handleSend()
                }
              }}
            />
            <div className="nori-card__top">
              <span className="nori-muted">
                {selectedIds.length > 0
                  ? `Lesson context + ${selectedIds.length} attempt(s) attached`
                  : 'Lesson context attached'}
                {olderTurnsLeftOut && ` · only the last ${historyLimit.maxTurns} turns are sent; older ones are left out`}
              </span>
              {busy ? (
                <button type="button" data-ui="nori" className="nori-btn" onClick={handleCancel}>
                  <IconXCircle />
                  <span>Cancel</span>
                </button>
              ) : (
                <button
                  type="button"
                  data-ui="nori"
                  className="nori-btn nori-btn--primary"
                  disabled={!lesson || !llmConfigured || !message.trim()}
                  onClick={handleSend}
                >
                  <IconSend />
                  <span>Ask tutor</span>
                </button>
              )}
            </div>
          </div>
        </>
      )}
    </section>
  )
}
