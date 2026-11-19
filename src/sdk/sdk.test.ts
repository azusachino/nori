import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { openDatabase } from '../lib/server/database'
import { createSidecarApi, hashExerciseSnapshot } from '../lib/server/sidecar'
import {
  checkMultipleChoice,
  computeContentHash,
  formatAttemptsAsMarkdown,
  NoriApiError,
  NoriClient,
  resolveNoriIslandProps,
  type ExerciseSnapshot,
} from './index'
import { renderInlineMarkdown, renderRichText } from './react'

const dirs: string[] = []

function tempDbPath() {
  const dir = mkdtempSync(join(tmpdir(), 'nori-sdk-'))
  dirs.push(dir)
  return join(dir, 'nori.sqlite')
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
})

const snapshot: ExerciseSnapshot = {
  type: 'written',
  prompt: 'Identify b(y), eta, and a(eta) for the Poisson distribution.',
  options: [],
  answer: 'b(y)=1/y!, eta=log(lambda), a(eta)=exp(eta).',
  explanation: 'a\'(eta)=exp(eta)=lambda.',
}

describe('Nori SDK client and helpers', () => {
  test('computeContentHash matches server hashExerciseSnapshot', async () => {
    expect(await computeContentHash(snapshot)).toBe(hashExerciseSnapshot(snapshot))
  })

  test('checkMultipleChoice matches exact option text', () => {
    const mcq: ExerciseSnapshot = {
      type: 'multiple_choice',
      prompt: 'Pick one',
      options: ['A', 'B'],
      answer: 'A',
      explanation: 'A is right.',
    }
    expect(checkMultipleChoice(mcq, 'A')).toBe(true)
    expect(checkMultipleChoice(mcq, 'B')).toBe(false)
    expect(checkMultipleChoice(mcq, 'C')).toBe(false)
  })

  test('NoriClient roundtrips against sidecar API and surfaces 409 conflicts', async () => {
    const db = openDatabase(tempDbPath())
    try {
      const api = createSidecarApi(db, {
        completeFn: async () => 'Advisory: good identification of natural parameter.',
      })
      const client = new NoriClient({
        baseUrl: 'http://127.0.0.1:3001/api/nori/v1',
        fetchFn: (input, init) => api(new Request(input instanceof Request ? input : String(input), init)),
      })

      const health = await client.health()
      expect(health.ok).toBe(true)
      expect(health.apiVersion).toBe(1)

      const contentHash = await computeContentHash(snapshot)
      const created = await client.createAttempt({
        courseKey: 'ai/stanford-cs229-ml',
        lessonKey: '01-exponential-families-and-glms',
        exerciseKey: 'ex-poisson',
        contentHash,
        exerciseSnapshot: snapshot,
        answer: 'b(y) = 1/y!, eta = log(lambda), a(eta) = e^eta',
      })
      expect(created.version).toBe(0)

      const withFeedback = await client.requestFeedback(created.id, 0)
      expect(withFeedback.advisory).toBe(true)
      expect(withFeedback.version).toBe(1)

      const corrected = await client.saveCorrection(created.id, 'Remember to check a\'(eta)=lambda.', 1)
      expect(corrected.version).toBe(2)
      expect(corrected.ownerNote).toBe("Remember to check a'(eta)=lambda.")

      let caught: unknown = null
      try {
        await client.saveCorrection(created.id, 'stale', 0)
      } catch (err) {
        caught = err
      }
      expect(caught).toBeInstanceOf(NoriApiError)
      expect((caught as NoriApiError).status).toBe(409)
      expect((caught as NoriApiError).attempt?.version).toBe(2)

      const listed = await client.listPractice({
        courseKey: 'ai/stanford-cs229-ml',
        lessonKey: '01-exponential-families-and-glms',
      })
      expect(listed.attempts).toHaveLength(1)

      const md = formatAttemptsAsMarkdown({
        courseKey: 'ai/stanford-cs229-ml',
        lessonKey: '01-exponential-families-and-glms',
        attempts: listed.attempts,
      })
      expect(md).toContain('## practice attempts: ai/stanford-cs229-ml — 01-exponential-families-and-glms')
      expect(md).toContain('**Advisory feedback (AI):**')
      expect(md).toContain('**Correction / takeaway:**')
    } finally {
      db.close()
    }
  })

  test('resolveNoriIslandProps infers courseKey, lessonKey, bank, and lessonAsset from vault path', () => {
    const lessonPath = 'courses/ai/build-llm-from-scratch/lessons/01-understanding-large-language-models.md'
    expect(resolveNoriIslandProps('NoriPractice', { title: 'Lesson 1 practice' }, lessonPath)).toEqual({
      title: 'Lesson 1 practice',
      courseKey: 'ai/build-llm-from-scratch',
      lessonKey: '01-understanding-large-language-models',
      bank: '/practice-banks/ai/build-llm-from-scratch/01-understanding-large-language-models.json',
    })
    expect(resolveNoriIslandProps('NoriTutor', {}, lessonPath)).toEqual({
      courseKey: 'ai/build-llm-from-scratch',
      lessonKey: '01-understanding-large-language-models',
      lessonAsset: '/lesson-context/ai/build-llm-from-scratch/01-understanding-large-language-models.json',
    })
    expect(resolveNoriIslandProps('NoriAssessment', {}, 'courses/ai/build-llm-from-scratch/practice/index.md')).toEqual({
      courseKey: 'ai/build-llm-from-scratch',
      bank: '/practice-banks/ai/build-llm-from-scratch/all.json',
    })
  })

  test('renderRichText and renderInlineMarkdown render fenced code blocks, inline triple backticks, nested code in bold, lists, and wikilinks', () => {
    const html = renderToStaticMarkup(
      createElement(
        'div',
        null,
        renderRichText(
          [
            '### Step 1: **Tensor shape in `calc`**',
            '',
            'Use ```emb = nn.Embedding(50257, 64)``` or a fenced block:',
            '',
            '```python',
            'emb = torch.nn.Embedding(50257, 64)',
            'h = emb(x)',
            '```',
            '',
            '- First item with `float32` and [[note/columns/ai-llm-systems-in-practice|AI LLM systems]]',
            '- Second item with $O(1)$ lookup',
          ].join('\n'),
        ),
      ),
    )
    expect(html).toContain('<div class="nori-md-heading">Step 1: <strong>Tensor shape in <code>calc</code></strong></div>')
    expect(html).toContain('<code>emb = nn.Embedding(50257, 64)</code>')
    expect(html).toContain('<pre class="nori-codeblock" data-language="python"><span class="nori-codeblock__lang">python</span><code>emb = torch.nn.Embedding(50257, 64)\nh = emb(x)</code></pre>')
    expect(html).toContain('<ul class="nori-md-list"><li>First item with <code>float32</code> and <a href="/note/columns/ai-llm-systems-in-practice">AI LLM systems</a></li>')
    expect(html).toContain('<code class="nori-math">O(1)</code>')

    const inlineHtml = renderToStaticMarkup(createElement('span', null, renderInlineMarkdown('`32,768` floats (`~128 KB` in `float32`)')))
    expect(inlineHtml).toBe('<span><code>32,768</code> floats (<code>~128 KB</code> in <code>float32</code>)</span>')
  })
})
