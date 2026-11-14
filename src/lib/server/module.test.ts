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
  test('rejects a missing exercise kind', () => {
    expect(() => parseModule(JSON.stringify({ ...valid, exercises: valid.exercises.slice(0, 2) }))).toThrow()
  })
})
