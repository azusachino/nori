export type Exercise = { type: 'multiple_choice' | 'written' | 'code'; prompt: string; options: string[]; answer: string; explanation: string }
export type Module = { title: string; lessons: { title: string; body: string }[]; exercises: Exercise[] }

export function parseModule(input: string): Module {
  const raw = input.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('The model returned an invalid module.')
  const value: unknown = JSON.parse(raw.slice(start, end + 1))
  if (!value || typeof value !== 'object') throw new Error('The model returned an invalid module.')
  const item = value as Record<string, unknown>
  const text = (v: unknown, limit: number): v is string => typeof v === 'string' && !!v.trim() && v.length <= limit
  if (!text(item.title, 160) || !Array.isArray(item.lessons) || item.lessons.length < 1 || item.lessons.length > 10 || !Array.isArray(item.exercises) || item.exercises.length < 3 || item.exercises.length > 20) throw new Error('The module must include lessons and exercises.')
  const lessons = item.lessons.map((value: unknown) => {
    if (!value || typeof value !== 'object') throw new Error('Invalid lesson.')
    const lesson = value as Record<string, unknown>
    if (!text(lesson.title, 160) || !text(lesson.body, 12000)) throw new Error('Invalid lesson title or body.')
    return { title: lesson.title, body: lesson.body }
  })
  const exercises = item.exercises.map((value: unknown): Exercise => {
    if (!value || typeof value !== 'object') throw new Error('Invalid exercise.')
    const exercise = value as Record<string, unknown>
    if (!['multiple_choice', 'written', 'code'].includes(String(exercise.type)) || !text(exercise.prompt, 4000) || !text(exercise.answer, 4000) || !text(exercise.explanation, 4000)) throw new Error('Invalid exercise fields.')
    const options = exercise.options === undefined && exercise.type !== 'multiple_choice' ? [] : exercise.options
    if (!Array.isArray(options) || !options.every((option: unknown) => text(option, 500))) throw new Error('Invalid exercise options.')
    let answer = exercise.answer
    if (exercise.type === 'multiple_choice' && !options.includes(answer) && /^[A-H]$/.test(answer)) {
      const position = answer.charCodeAt(0) - 65
      const option = options[position] as string | undefined
      if (option && new RegExp(`^${answer}[.)]\\s`).test(option)) answer = option
    }
    if (exercise.type === 'multiple_choice' && (options.length < 2 || options.length > 8 || !options.includes(answer))) throw new Error('Multiple choice needs options and a matching answer.')
    return { type: exercise.type as Exercise['type'], prompt: exercise.prompt, options: options as string[], answer, explanation: exercise.explanation }
  })
  if (!['multiple_choice', 'written', 'code'].every((type) => exercises.some((exercise) => exercise.type === type))) throw new Error('The module needs multiple-choice, written and code exercises.')
  return { title: item.title, lessons, exercises }
}
