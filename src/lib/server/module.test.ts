import { describe, expect, test } from 'bun:test'
import { parseModule } from './module'

const valid = {
  title: 'Foundations', lessons: [{ title: 'One', body: 'Lesson' }], exercises: [
    { type: 'multiple_choice', prompt: 'Pick', options: ['A', 'B'], answer: 'A', explanation: 'A is right' },
    { type: 'written', prompt: 'Explain', options: [], answer: 'Example', explanation: 'Reason' },
    { type: 'code', prompt: 'Code', options: [], answer: 'Example', explanation: 'Reason' },
  ],
}
describe('generated module validation', () => {
  test('accepts a complete module', () => { expect(parseModule(JSON.stringify(valid)).title).toBe('Foundations') })
  test('rejects a multiple-choice answer outside the options', () => {
    const invalid = structuredClone(valid)
    invalid.exercises[0]!.answer = 'C'
    expect(() => parseModule(JSON.stringify(invalid))).toThrow()
  })
  test('accepts prose around JSON and missing options on free-response items', () => {
    const input = structuredClone(valid) as typeof valid
    const written = input.exercises[1] as { options?: string[] }
    delete written.options
    expect(parseModule(`Here is the module:\n${JSON.stringify(input)}\nDone.`).exercises[1]?.options).toEqual([])
  })
  test('maps a letter answer only when options use matching letter labels', () => {
    const input = structuredClone(valid)
    input.exercises[0]!.options = ['A. One', 'B. Two']
    input.exercises[0]!.answer = 'A'
    expect(parseModule(JSON.stringify(input)).exercises[0]?.answer).toBe('A. One')
  })
  test('rejects a missing exercise kind', () => {
    expect(() => parseModule(JSON.stringify({ ...valid, exercises: valid.exercises.slice(0, 2) }))).toThrow()
  })
})
