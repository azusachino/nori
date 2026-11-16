import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { useEffect, useState, type FormEvent } from 'react'
import type {
  TutorAskResponse,
  TutorHistoryResponse,
  TutorProposal,
  TutorTurn,
} from './types'

export type LessonTutorProps = {
  courseId: string
  moduleId: string
  moduleTitle: string
  moduleAttempts: {
    id: string
    exercise_id: string | null
    exercise_index: number
    answer: string
    feedback: string
    correct: number | null
    owner_note: string
  }[]
  moduleExercises: {
    id: string
    prompt: string
    type: string
  }[]
  lessonIndex: number
  lessonTitle: string
  lessonBody: string
  draftQuestion: string
  onDraftQuestionChange: (question: string) => void
  currentDraftHash?: string | null
  onClose?: () => void
}

export function LessonTutor({
  courseId,
  moduleId,
  moduleAttempts,
  moduleExercises,
  lessonIndex,
  lessonTitle,
  lessonBody,
  draftQuestion,
  onDraftQuestionChange,
  currentDraftHash,
  onClose,
}: LessonTutorProps) {
  const [turns, setTurns] = useState<TutorTurn[]>([])
  const [proposals, setProposals] = useState<TutorProposal[]>([])
  const [selectedAttemptIds, setSelectedAttemptIds] = useState<string[]>([])
  const [isProposal, setIsProposal] = useState(false)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [copyStatus, setCopyStatus] = useState<Record<string, 'idle' | 'copied' | 'error'>>({})

  useEffect(() => {
    let cancelled = false
    async function loadHistory() {
      setLoading(true)
      setError('')
      try {
        const res = await fetch(
          `/api/courses/${courseId}/tutor?moduleId=${moduleId}&lessonIndex=${lessonIndex}`
        )
        if (!res.ok) {
          const errData = await res.json().catch(() => ({}))
          if (!cancelled) {
            setError(errData.error || `Failed to load tutor history (${res.status})`)
          }
          return
        }
        const data: TutorHistoryResponse = await res.json()
        if (!cancelled) {
          setTurns(data.turns)
          setProposals(data.proposals)
        }
      } catch (err: unknown) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Network error loading tutor history')
        }
      } finally {
        if (!cancelled) {
          setLoading(false)
        }
      }
    }

    void loadHistory()
    return () => {
      cancelled = true
    }
  }, [courseId, moduleId, lessonIndex])

  function toggleAttempt(id: string) {
    setSelectedAttemptIds((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]
    )
  }

  async function handleAsk(e: FormEvent) {
    e.preventDefault()
    if (!draftQuestion.trim()) return

    setBusy(true)
    setError('')

    const payload: {
      moduleId: string
      lessonIndex: number
      attemptIds: string[]
      message: string
      proposal: boolean
      expectedDraftContentHash?: string
    } = {
      moduleId,
      lessonIndex,
      attemptIds: selectedAttemptIds,
      message: draftQuestion.trim(),
      proposal: isProposal,
    }

    if (isProposal && currentDraftHash) {
      payload.expectedDraftContentHash = currentDraftHash
    }

    try {
      const res = await fetch(`/api/courses/${courseId}/tutor`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}))
        setError(errData.error || `Tutor error (${res.status}): Request failed`)
        // Intentionally keep draftQuestion intact on error!
        return
      }

      const data: TutorAskResponse = await res.json()
      setTurns((prev) => [...prev, ...data.turns])
      if (data.proposal) {
        setProposals((prev) => [...prev, data.proposal!])
      }
      onDraftQuestionChange('')
      setIsProposal(false)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Network error contacting tutor')
      // Intentionally keep draftQuestion intact on error!
    } finally {
      setBusy(false)
    }
  }

  async function copyProposal(id: string, text: string) {
    try {
      await navigator.clipboard.writeText(text)
      setCopyStatus((prev) => ({ ...prev, [id]: 'copied' }))
      setTimeout(() => {
        setCopyStatus((prev) => ({ ...prev, [id]: 'idle' }))
      }, 3000)
    } catch {
      setCopyStatus((prev) => ({ ...prev, [id]: 'error' }))
    }
  }

  return (
    <div className="lesson-tutor-container" aria-label={`Tutor for ${lessonTitle}`}>
      <div className="lesson-tutor-header">
        <div>
          <span className="eyebrow">CONTEXTUAL TUTOR</span>
          <h4>Ask about: {lessonTitle}</h4>
        </div>
        {onClose && (
          <Button
            type="button"
            variant="ghost"
            className="tutor-close-btn"
            onClick={onClose}
            aria-label="Dismiss tutor panel"
          >
            ✕ Close
          </Button>
        )}
      </div>

      <p className="tutor-privacy-notice">
        The tutor answers questions about this lesson using only the lesson text, your explicitly
        selected exercise attempts, and this lesson conversation. Prior turns may repeat information
        from previously selected attempts even when the current selection changes. No other lessons,
        course sources, or unselected attempts outside prior conversation are sent. Feedback is
        advisory; the tutor never executes code.
      </p>

      {loading && <p role="status" className="muted">Loading conversation…</p>}

      {/* Attempt selection */}
      <div className="tutor-attempts-section">
        <label className="section-label">
          <strong>Exercise attempts to include ({selectedAttemptIds.length} selected)</strong>
        </label>
        <p className="attempt-help-text">
          Exercises are module-wide and not automatically linked to any lesson. Select zero or more
          recorded attempts from this module to provide context for your question:
        </p>

        {moduleAttempts.length === 0 ? (
          <p className="muted tutor-attempts-empty">
            No exercise attempts recorded in this module yet. You can still ask questions about the
            lesson text.
          </p>
        ) : (
          <div className="tutor-attempts-list" role="group" aria-label="Module exercise attempts">
            {moduleAttempts.map((attempt) => {
              const isSelected = selectedAttemptIds.includes(attempt.id)
              const exercise =
                moduleExercises.find((e) => e.id === attempt.exercise_id) ??
                moduleExercises[attempt.exercise_index]
              const promptText = exercise?.prompt ?? `Exercise ${attempt.exercise_index + 1}`
              const isCorrect = attempt.correct === 1
              const isIncorrect = attempt.correct === 0

              return (
                <label
                  key={attempt.id}
                  className={`tutor-attempt-card ${isSelected ? 'selected' : ''}`}
                >
                  <input
                    type="checkbox"
                    className="attempt-checkbox"
                    checked={isSelected}
                    onChange={() => toggleAttempt(attempt.id)}
                  />
                  <div className="attempt-card-body">
                    <div className="attempt-card-header">
                      <span className="attempt-prompt">
                        <strong>Exercise {attempt.exercise_index + 1}:</strong> {promptText}
                      </span>
                      <span
                        className={`grade-badge ${
                          isCorrect
                            ? 'grade-correct'
                            : isIncorrect
                            ? 'grade-incorrect'
                            : 'grade-unscored'
                        }`}
                      >
                        {isCorrect
                          ? 'Correct'
                          : isIncorrect
                          ? 'Incorrect'
                          : 'AI feedback · advisory'}
                      </span>
                    </div>
                    <div className="attempt-text-preview">
                      <p>
                        <strong>Your answer:</strong> {attempt.answer}
                      </p>
                      <p className="attempt-feedback-text">
                        <strong>Feedback:</strong> {attempt.feedback}
                      </p>
                      {attempt.owner_note && (
                        <p className="attempt-owner-note">
                          <strong>Your note:</strong> {attempt.owner_note}
                        </p>
                      )}
                    </div>
                  </div>
                </label>
              )
            })}
          </div>
        )}
      </div>

      {/* Disclosed context preview before sending */}
      <div className="tutor-preview-disclosure">
        <span className="disclosure-title">Context to be sent with your question:</span>
        <ul className="disclosure-list">
          <li>
            <strong>Lesson:</strong> &ldquo;{lessonTitle}&rdquo; ({lessonBody.length.toLocaleString()} characters)
          </li>
          <li>
            <strong>Selected attempts:</strong> {selectedAttemptIds.length} of{' '}
            {moduleAttempts.length} module attempts selected
          </li>
          <li>
            <strong>Prior lesson conversation:</strong>{' '}
            {turns.length === 0
              ? '0 prior turns (new conversation)'
              : `Up to ${turns.length} prior turns may be included (subject to trimming to fit context limit)`}
          </li>
          <li>
            <strong>Course sources:</strong> None (<code>sourceIds: []</code>)
          </li>
        </ul>
      </div>

      {/* Input form */}
      <form onSubmit={handleAsk} className="tutor-ask-form">
        <label htmlFor={`tutor-question-${lessonIndex}`}>
          <strong>Your question about this lesson</strong>
        </label>
        <Textarea
          id={`tutor-question-${lessonIndex}`}
          rows={3}
          maxLength={4000}
          placeholder="Ask the tutor to clarify a concept or explain your attempt…"
          value={draftQuestion}
          onChange={(e) => onDraftQuestionChange(e.target.value)}
          disabled={busy}
          required
        />

        <div className="proposal-option">
          <label className="proposal-checkbox-label">
            <input
              type="checkbox"
              checked={isProposal}
              onChange={(e) => setIsProposal(e.target.checked)}
              disabled={busy}
            />
            <span>Request reviewable proposal for future material</span>
          </label>
          <p className="proposal-hint">
            Proposals are advisory suggestions for future material. They are not applied
            automatically and do not modify accepted lessons or exercises.
          </p>
          {isProposal && currentDraftHash && (
            <p className="proposal-draft-note">
              Targeting current unaccepted draft (content hash: <code>{currentDraftHash.slice(0, 8)}…</code>).
            </p>
          )}
        </div>

        <Button
          className="primary tutor-submit-btn"
          disabled={busy || !draftQuestion.trim()}
          type="submit"
        >
          {busy
            ? 'Tutor is thinking…'
            : isProposal
            ? 'Request proposal'
            : 'Ask tutor'} <span aria-hidden="true">↗</span>
        </Button>

        {error && (
          <p role="alert" className="error tutor-error">
            {error}
          </p>
        )}
      </form>

      {/* Conversation history */}
      {turns.length > 0 && (
        <div className="tutor-turns-section">
          <span className="section-label">
            <strong>Lesson conversation ({turns.length} turns)</strong>
          </span>
          <div className="tutor-turns-list">
            {turns.map((turn, index) => {
              const isAssistant = turn.role === 'assistant'
              return (
                <div
                  key={turn.id || index}
                  className={`tutor-turn-card ${isAssistant ? 'assistant-turn' : 'user-turn'}`}
                >
                  <div className="turn-meta">
                    <strong className="turn-sender">
                      {isAssistant ? 'Tutor (advisory)' : 'You'}
                    </strong>
                    <time className="turn-time">
                      {new Date(turn.createdAt).toLocaleTimeString()}
                    </time>
                  </div>
                  <div className="turn-text">{turn.content}</div>

                  {/* Persisted context inspection for assistant responses */}
                  {isAssistant && turn.context && (
                    <details className="tutor-context-details">
                      <summary>
                        Inspect sent context ({turn.context.contextChars.toLocaleString()} characters sent)
                      </summary>
                      <div className="context-inspector-content">
                        <div className="inspector-row">
                          <strong>Lesson Title:</strong> {turn.context.lessonTitle}
                        </div>
                        <div className="inspector-row">
                          <strong>Lesson Text Sent:</strong>
                          <pre className="inspector-pre">{turn.context.lessonText}</pre>
                        </div>
                        <div className="inspector-row">
                          <strong>Selected Attempts Sent ({turn.context.attempts.length}):</strong>
                          {turn.context.attempts.length === 0 ? (
                            <p className="muted">None selected</p>
                          ) : (
                            <ul className="inspector-attempts-list">
                              {turn.context.attempts.map((att) => (
                                <li key={att.id}>
                                  <strong>Exercise {att.exerciseIndex + 1}:</strong> {att.prompt}
                                  <br />
                                  <span>Answer: {att.answer}</span>
                                  <br />
                                  <span>Feedback: {att.feedback}</span>
                                  {att.ownerNote && (
                                    <>
                                      <br />
                                      <span>Learner Note: {att.ownerNote}</span>
                                    </>
                                  )}
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                        <div className="inspector-row">
                          <strong>Source IDs:</strong>{' '}
                          {turn.context.sourceIds.length === 0 ? (
                            <span>Empty (<code>sourceIds: []</code>)</span>
                          ) : (
                            turn.context.sourceIds.join(', ')
                          )}
                        </div>
                        <div className="inspector-row">
                          <strong>
                            Prior Conversation Sent ({turn.context.historyTurnsIncluded} included
                            {turn.context.historyTurnsDropped > 0
                              ? `, ${turn.context.historyTurnsDropped} omitted due to context budget`
                              : ''}):
                          </strong>
                          {turn.context.history && turn.context.history.length > 0 ? (
                            <ul className="inspector-history-list">
                              {turn.context.history.map((histTurn) => (
                                <li key={histTurn.id} className="inspector-history-item">
                                  <strong className="inspector-history-role">
                                    {histTurn.role === 'user' ? 'User' : 'Assistant / Tutor'}:
                                  </strong>{' '}
                                  <span className="inspector-history-text">{histTurn.content}</span>
                                </li>
                              ))}
                            </ul>
                          ) : (
                            <p className="muted">None (initial turn for this lesson)</p>
                          )}
                        </div>
                        <div className="inspector-row">
                          <strong>Trimming / Dropped Turns:</strong>{' '}
                          {turn.context.historyTurnsDropped > 0 ? (
                            <span className="dropped-warning">
                              {turn.context.historyTurnsDropped} older turns dropped to fit 120,000 char budget
                            </span>
                          ) : (
                            '0 turns dropped (no trimming needed)'
                          )}
                        </div>
                        <div className="inspector-row">
                          <strong>Context Limit:</strong>{' '}
                          {turn.context.contextLimit.toLocaleString()} characters
                        </div>
                        <div className="inspector-row">
                          <strong>Conversation Revision:</strong>{' '}
                          {turn.context.conversationRevision}
                        </div>
                      </div>
                    </details>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Proposals section */}
      {proposals.length > 0 && (
        <div className="tutor-proposals-section">
          <span className="section-label">
            <strong>Reviewable proposals ({proposals.length})</strong>
          </span>
          <p className="proposals-disclaimer">
            <strong>Advisory text only:</strong> Proposals are suggestions generated by the tutor.
            They are never applied automatically to accepted modules or drafts. You can copy the
            proposal text below and edit future drafts explicitly in the course workspace.
          </p>
          <div className="proposals-list">
            {proposals.map((proposal) => (
              <div key={proposal.id} className="tutor-proposal-card">
                <div className="proposal-card-header">
                  <span className="proposal-badge">Reviewable Proposal</span>
                  <span className="proposal-draft-tag">
                    {proposal.draft
                      ? `Target: Module ${proposal.draft.position} (hash: ${proposal.draft.contentHash.slice(0, 8)}…)`
                      : 'General proposal (no active draft)'}
                  </span>
                  <time className="proposal-time">
                    {new Date(proposal.createdAt).toLocaleTimeString()}
                  </time>
                </div>
                <div className="proposal-content-text">{proposal.content}</div>
                <div className="proposal-actions">
                  <Button
                    type="button"
                    variant="outline"
                    className="copy-proposal-btn"
                    onClick={() => void copyProposal(proposal.id, proposal.content)}
                  >
                    {copyStatus[proposal.id] === 'copied'
                      ? '✓ Copied to clipboard'
                      : 'Copy proposal'}
                  </Button>
                  {copyStatus[proposal.id] === 'error' && (
                    <span role="alert" className="copy-error">
                      Could not copy to clipboard.
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
