import { describe, expect, test } from 'bun:test'
import { withRecentHistory } from './ai'

describe('model context budget', () => {
  test('keeps the latest history that fits after the prompt and new message', () => {
    const prefix = [{ role: 'system' as const, content: 'p'.repeat(100000) }]
    const history = [
      { role: 'user' as const, content: 'old'.repeat(4000) },
      { role: 'assistant' as const, content: 'recent'.repeat(2000) },
    ]
    const suffix = [{ role: 'user' as const, content: 'new question' }]
    expect(withRecentHistory(prefix, history, suffix)).toEqual([...prefix, history[1], ...suffix])
  })

  test('drops oversized history instead of stranding a conversation', () => {
    const history = Array.from({ length: 20 }, () => ({ role: 'assistant' as const, content: 'x'.repeat(8000) }))
    const result = withRecentHistory([{ role: 'system', content: 'Instructions' }], history, [{ role: 'user', content: 'Continue' }])
    expect(result.reduce((total, message) => total + message.content.length, 0)).toBeLessThanOrEqual(120000)
    expect(result.at(-1)?.content).toBe('Continue')
    expect(result.length).toBeLessThan(history.length + 2)
  })
})
