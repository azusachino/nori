import type { SidecarExerciseType } from '../index'
import { IconCheckCircle, IconXCircle } from './icons'
import { renderInlineMarkdown } from './markdown'

const OPTION_KEYS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'

function lines(value: string): Set<string> {
  return new Set(
    value
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean),
  )
}

export type ExerciseAnswerFieldProps = {
  type: SidecarExerciseType
  options: string[]
  /** Pre-rendered option HTML from a practice bank, in option order. */
  optionHtmls?: string[]
  /** Radio group name; unique on the page. */
  name: string
  /** Id of the element holding the prompt, which labels the field. */
  promptId: string
  value: string
  onChange: (value: string) => void
  /** Once an answer was recorded: marks the correct options and a wrong pick. */
  reveal?: { expected: string; submitted: string } | null
  disabled?: boolean
}

/** The answer input for one exercise: options, a cloze field, or a text/code area. Shared by practice and the review queue. */
export function ExerciseAnswerField({
  type,
  options,
  optionHtmls,
  name,
  promptId,
  value,
  onChange,
  reveal,
  disabled,
}: ExerciseAnswerFieldProps) {
  if (type === 'multiple_choice' || type === 'multiple_select') {
    const multi = type === 'multiple_select'
    const picked = multi ? lines(value) : new Set(value ? [value] : [])
    const expected = reveal ? (multi ? lines(reveal.expected) : new Set([reveal.expected])) : null
    const submitted = reveal ? (multi ? lines(reveal.submitted) : new Set([reveal.submitted])) : null
    const toggle = (option: string) => {
      if (!multi) return onChange(option)
      const current = [...picked]
      onChange((current.includes(option) ? current.filter((o) => o !== option) : [...current, option]).join('\n'))
    }
    return (
      <div className="nori-options" role={multi ? 'group' : 'radiogroup'} aria-labelledby={promptId}>
        {options.map((option, optIdx) => {
          const isCorrectOption = Boolean(expected?.has(option))
          const isWrongPicked = Boolean(submitted?.has(option)) && !expected?.has(option)
          const classes = ['nori-option']
          if (!multi) classes.push('nori-option--has-key')
          if (isCorrectOption) classes.push('nori-option--correct')
          else if (isWrongPicked) classes.push('nori-option--incorrect')
          else if (picked.has(option)) classes.push('nori-option--selected')
          return (
            <label key={option} className={classes.join(' ')}>
              <input
                type={multi ? 'checkbox' : 'radio'}
                data-ui="nori"
                name={multi ? undefined : name}
                value={option}
                checked={picked.has(option)}
                disabled={disabled}
                onChange={() => toggle(option)}
              />
              <span className="nori-option__key" aria-hidden="true">
                {OPTION_KEYS[optIdx] ?? optIdx + 1}
              </span>
              {optionHtmls?.[optIdx] ? (
                <span className="nori-option__body" dangerouslySetInnerHTML={{ __html: optionHtmls[optIdx]! }} />
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
    )
  }
  if (type === 'cloze') {
    return (
      <input
        type="text"
        data-ui="nori"
        className="nori-input-inline"
        aria-labelledby={promptId}
        style={{ width: '100%', height: '38px' }}
        placeholder="Type exact answer…"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      />
    )
  }
  return (
    <textarea
      data-ui="nori"
      className={`nori-textarea${type === 'code' ? ' nori-textarea--code' : ''}`}
      aria-labelledby={promptId}
      placeholder={type === 'code' ? 'Write your code attempt…' : 'Write your explanation in your own words…'}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
    />
  )
}
