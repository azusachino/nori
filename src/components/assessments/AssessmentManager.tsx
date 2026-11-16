import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useEffect, useState, type FormEvent } from 'react'
import type { ModuleData } from '../ModuleView'
import type { AssessmentMode, AssessmentSummaryData } from './types'

export function AssessmentManager({
  courseId,
  acceptedModules,
  onSelectAssessment,
}: {
  courseId: string
  acceptedModules: ModuleData[]
  onSelectAssessment: (id: string) => void
}) {
  const [assessments, setAssessments] = useState<AssessmentSummaryData[]>([])
  const [showCreate, setShowCreate] = useState(false)
  const [title, setTitle] = useState('')
  const [mode, setMode] = useState<AssessmentMode>('untimed')
  const [durationValue, setDurationValue] = useState(15)
  const [durationUnit, setDurationUnit] = useState<'minutes' | 'seconds'>('minutes')
  const [selectedModuleIds, setSelectedModuleIds] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function load() {
    try {
      const res = await fetch(`/api/courses/${courseId}/assessments`)
      if (!res.ok) throw new Error('Could not load assessments.')
      const data = (await res.json()) as { assessments: AssessmentSummaryData[] }
      setAssessments(data.assessments)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load assessments.')
    }
  }

  useEffect(() => {
    void load()
    // Select all accepted modules by default for creation
    if (acceptedModules.length > 0 && selectedModuleIds.length === 0) {
      setSelectedModuleIds(acceptedModules.map((m) => m.id))
    }
  }, [courseId, acceptedModules])

  async function handleCreate(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (selectedModuleIds.length === 0) {
      setError('Select at least one accepted module to assess.')
      return
    }
    setBusy(true)
    setError('')
    try {
      const payload: Record<string, unknown> = {
        title: title.trim() || 'Course assessment',
        mode,
        moduleIds: selectedModuleIds,
      }
      if (mode === 'timed') {
        payload.durationSeconds = durationUnit === 'seconds' ? durationValue : durationValue * 60
      }
      const res = await fetch(`/api/courses/${courseId}/assessments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const data = (await res.json()) as { error?: string; assessment?: { id: string } }
      if (!res.ok) throw new Error(data.error || 'Failed to create assessment.')
      setShowCreate(false)
      setTitle('')
      await load()
      if (data.assessment) {
        onSelectAssessment(data.assessment.id)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create assessment.')
    } finally {
      setBusy(false)
    }
  }

  function toggleModule(id: string) {
    if (selectedModuleIds.includes(id)) {
      setSelectedModuleIds(selectedModuleIds.filter((item) => item !== id))
    } else {
      setSelectedModuleIds([...selectedModuleIds, id])
    }
  }

  return (
    <section className="assessment-manager">
      <div className="section-heading">
        <div>
          <p className="eyebrow">CHECK UNDERSTANDING</p>
          <h2>Course assessments</h2>
        </div>
        <Button
          className={showCreate ? 'secondary' : 'primary'}
          type="button"
          onClick={() => setShowCreate(!showCreate)}
        >
          {showCreate ? 'Cancel' : '+ New assessment'}
        </Button>
      </div>

      <p className="muted">
        Review what you’ve learned across your accepted modules. Choose timed or untimed, examine your scope before starting, and get deterministic scoring on multiple choice alongside advisory feedback on written work.
      </p>

      {error && <p className="error" role="alert">{error}</p>}

      {showCreate && (
        <form className="create-assessment-form" onSubmit={(e) => void handleCreate(e)}>
          <p className="eyebrow">CREATE NEW ASSESSMENT</p>
          <h3>Design your assessment</h3>

          <label htmlFor="assessment-title">Title</label>
          <Input
            id="assessment-title"
            value={title}
            placeholder="e.g. Midpoint Check: Modules 1–2"
            maxLength={160}
            onChange={(e) => setTitle(e.target.value)}
          />

          <fieldset className="mode-fieldset">
            <legend>Assessment Mode</legend>
            <div className="mode-options">
              <label className="choice">
                <input
                  type="radio"
                  name="assessment-mode"
                  value="untimed"
                  checked={mode === 'untimed'}
                  onChange={() => setMode('untimed')}
                />
                <span>Untimed (Take your time, resume anytime)</span>
              </label>
              <label className="choice">
                <input
                  type="radio"
                  name="assessment-mode"
                  value="timed"
                  checked={mode === 'timed'}
                  onChange={() => setMode('timed')}
                />
                <span>Timed (Fixed deadline enforced by server)</span>
              </label>
            </div>
          </fieldset>

          {mode === 'timed' && (
            <div className="duration-picker">
              <label htmlFor="duration-value">Duration</label>
              <div className="duration-inputs">
                <Input
                  id="duration-value"
                  type="number"
                  min={1}
                  max={durationUnit === 'seconds' ? 86400 : 1440}
                  value={durationValue}
                  onChange={(e) => setDurationValue(Math.max(1, parseInt(e.target.value, 10) || 1))}
                  required
                />
                <select
                  id="duration-unit"
                  aria-label="Duration unit"
                  value={durationUnit}
                  onChange={(e) => setDurationUnit(e.target.value as 'minutes' | 'seconds')}
                  className="duration-unit-select"
                >
                  <option value="minutes">minutes</option>
                  <option value="seconds">seconds</option>
                </select>
              </div>
            </div>
          )}

          <fieldset className="modules-fieldset">
            <legend>Modules in Scope (Accepted only)</legend>
            <div className="module-checkbox-list">
              {acceptedModules.map((m) => (
                <label key={m.id} className="choice">
                  <input
                    type="checkbox"
                    checked={selectedModuleIds.includes(m.id)}
                    onChange={() => toggleModule(m.id)}
                  />
                  <span>
                    <strong>Module {m.position ?? 1}: {m.title}</strong> · {m.exercises.length} exercises ({m.lessons.length} lessons)
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          <Button className="primary" disabled={busy || selectedModuleIds.length === 0}>
            {busy ? 'Creating…' : 'Create assessment'} <span aria-hidden="true">↗</span>
          </Button>
        </form>
      )}

      {assessments.length === 0 && !showCreate ? (
        <div className="empty-assessments">
          <p className="muted">No assessments created yet for this course.</p>
          <p>Create an assessment to test your knowledge across your accepted modules.</p>
        </div>
      ) : (
        <ul className="assessment-card-list">
          {assessments.map((a) => {
            const isFinalized = a.status === 'submitted' || a.status === 'expired'
            return (
              <li key={a.id} className="assessment-card">
                <div className="card-top">
                  <span className={`badge-${a.mode}`}>
                    {a.mode === 'timed' ? `Timed (${Math.round((a.durationSeconds || 0) / 60)}m)` : 'Untimed'}
                  </span>
                  <span className={`badge-status badge-${a.status}`}>
                    {a.status === 'planned' && 'Scope planned'}
                    {a.status === 'active' && 'In progress'}
                    {a.status === 'submitted' && 'Submitted'}
                    {a.status === 'expired' && 'Deadline passed'}
                  </span>
                </div>
                <h4>{a.title}</h4>
                <p className="scope-summary">
                  {a.scope.exerciseCount} exercises across {a.scope.modules.length} modules
                </p>
                {isFinalized && a.summary && (
                  <p className="card-score">
                    Multiple choice: {a.summary.deterministicCorrect ?? 0}/{a.summary.deterministicTotal ?? 0} correct · {a.summary.unscoredCount ?? 0} unscored
                  </p>
                )}
                <Button
                  className="secondary select-assessment-btn"
                  type="button"
                  onClick={() => onSelectAssessment(a.id)}
                >
                  {a.status === 'planned' && 'Review scope & start →'}
                  {a.status === 'active' && 'Continue assessment →'}
                  {isFinalized && 'View results & feedback →'}
                </Button>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
