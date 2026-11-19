export type CodeCheckItem = {
  label: string
  passed: boolean
  detail?: string
}

export type CodeVerificationResult = {
  passed: boolean
  summary: string
  output?: string
  checks: CodeCheckItem[]
}

const STOP_IDENTIFIERS = new Set([
  'import',
  'from',
  'return',
  'const',
  'let',
  'var',
  'function',
  'def',
  'class',
  'for',
  'while',
  'if',
  'else',
  'elif',
  'true',
  'false',
  'True',
  'False',
  'None',
  'null',
  'undefined',
  'torch',
  'nn',
  'F',
  'np',
  'math',
  'self',
  'print',
  'console',
  'log',
])

export function extractReferenceCode(referenceAnswer: string): { lang: string; code: string } {
  const normalized = referenceAnswer.replace(/\r\n/g, '\n')
  const fenceMatch = normalized.match(/^[ \t]*```([^\n`]*)\n([\s\S]*?)^[ \t]*```/m)
  if (fenceMatch) {
    return {
      lang: fenceMatch[1]!.trim().toLowerCase() || 'python',
      code: fenceMatch[2]!.trim(),
    }
  }
  const inlineTicks = Array.from(normalized.matchAll(/`([^`\n]+)`/g)).map((m) => m[1]!.trim())
  return {
    lang: 'python',
    code: inlineTicks.length > 0 ? inlineTicks.join('\n') : normalized.trim(),
  }
}

export function checkBalancedDelimiters(code: string): { passed: boolean; detail?: string } {
  const stack: string[] = []
  const pairs: Record<string, string> = { '(': ')', '[': ']', '{': '}' }
  const closers = new Set([')', ']', '}'])
  let inSingle = false
  let inDouble = false
  let escaped = false

  for (let i = 0; i < code.length; i++) {
    const ch = code[i]!
    if (escaped) {
      escaped = false
      continue
    }
    if (ch === '\\') {
      escaped = true
      continue
    }
    if (ch === '#' && !inSingle && !inDouble) {
      while (i < code.length && code[i] !== '\n') i++
      continue
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle
      continue
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble
      continue
    }
    if (inSingle || inDouble) continue

    if (ch in pairs) {
      stack.push(pairs[ch]!)
    } else if (closers.has(ch)) {
      const expected = stack.pop()
      if (expected !== ch) {
        return { passed: false, detail: `Unmatched '${ch}'` }
      }
    }
  }

  if (inSingle || inDouble) {
    return { passed: false, detail: 'Unclosed string literal' }
  }
  if (stack.length > 0) {
    return { passed: false, detail: `Missing closing '${stack[stack.length - 1]}'` }
  }
  return { passed: true }
}

function extractKeyCallsAndTokens(refCode: string): string[] {
  const withoutComments = refCode
    .split('\n')
    .map((line) => line.replace(/#.*$/, '').replace(/\/\/.*$/, ''))
    .join('\n')

  const calls = Array.from(withoutComments.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g))
    .map((m) => m[1]!)
    .filter((id) => !STOP_IDENTIFIERS.has(id) && id.length >= 2)

  const numbers = Array.from(withoutComments.matchAll(/\b(\d{2,}|-1)\b/g)).map((m) => m[1]!)
  const unique = Array.from(new Set([...calls, ...numbers]))
  return unique.slice(0, 6)
}

function extractForbiddenTokens(prompt: string): string[] {
  const forbidden: string[] = []
  const withoutMatch = prompt.match(/\bwithout\s+(?:materializing\s+|using\s+|calling\s+)?`?([A-Za-z_][A-Za-z0-9_]*)`?/i)
  if (withoutMatch && withoutMatch[1]) {
    const token = withoutMatch[1]
    if (!['a', 'an', 'the', 'any', 'notes'].includes(token.toLowerCase())) {
      forbidden.push(token)
    }
  }
  return forbidden
}

async function runJsInWorker(code: string, timeoutMs = 1500): Promise<{ ok: boolean; output: string; error?: string }> {
  if (typeof Worker === 'undefined' || typeof Blob === 'undefined' || typeof URL.createObjectURL !== 'function') {
    return { ok: true, output: '' }
  }
  const workerScript = `
    self.onmessage = async (e) => {
      const logs = [];
      const customConsole = {
        log: (...args) => logs.push(args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ')),
        error: (...args) => logs.push(args.map(String).join(' ')),
      };
      try {
        const fn = new Function('console', e.data);
        const result = await fn(customConsole);
        if (result !== undefined) logs.push(String(result));
        self.postMessage({ ok: true, output: logs.join('\\n') });
      } catch (err) {
        self.postMessage({ ok: false, output: logs.join('\\n'), error: err && err.message ? err.message : String(err) });
      }
    };
  `
  const blob = new Blob([workerScript], { type: 'application/javascript' })
  const url = URL.createObjectURL(blob)
  return new Promise((resolve) => {
    const worker = new Worker(url)
    const timer = setTimeout(() => {
      worker.terminate()
      URL.revokeObjectURL(url)
      resolve({ ok: false, output: '', error: `Execution timed out after ${timeoutMs}ms` })
    }, timeoutMs)

    worker.onmessage = (e) => {
      clearTimeout(timer)
      worker.terminate()
      URL.revokeObjectURL(url)
      resolve(e.data)
    }
    worker.onerror = (err) => {
      clearTimeout(timer)
      worker.terminate()
      URL.revokeObjectURL(url)
      resolve({ ok: false, output: '', error: err.message || 'Worker execution failed' })
    }
    worker.postMessage(code)
  })
}

export async function verifyCodeInBrowser(
  learnerCode: string,
  referenceAnswer: string,
  prompt = '',
): Promise<CodeVerificationResult> {
  const trimmed = learnerCode.trim()
  if (!trimmed) {
    return {
      passed: false,
      summary: 'Enter a code attempt first.',
      checks: [{ label: 'Non-empty code snippet', passed: false }],
    }
  }

  const checks: CodeCheckItem[] = []
  const delim = checkBalancedDelimiters(trimmed)
  checks.push({
    label: 'Balanced parentheses, brackets & quotes',
    passed: delim.passed,
    detail: delim.detail,
  })

  const { lang, code: refCode } = extractReferenceCode(referenceAnswer)
  const keyTokens = extractKeyCallsAndTokens(refCode)
  for (const token of keyTokens) {
    const present = trimmed.includes(token)
    checks.push({
      label: `Includes expected call or parameter \`${token}\``,
      passed: present,
    })
  }

  const forbidden = extractForbiddenTokens(prompt)
  for (const token of forbidden) {
    const used = new RegExp(`\\b${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(trimmed)
    checks.push({
      label: `Avoids forbidden \`${token}\``,
      passed: !used,
    })
  }

  let output: string | undefined
  if (lang === 'js' || lang === 'javascript' || lang === 'ts' || lang === 'typescript') {
    const res = await runJsInWorker(trimmed)
    output = res.output || undefined
    checks.push({
      label: 'Sandboxed Web Worker execution',
      passed: res.ok,
      detail: res.error,
    })
  }

  const passedCount = checks.filter((c) => c.passed).length
  const passed = checks.every((c) => c.passed)
  const summary = passed
    ? `All ${checks.length} verification check(s) passed`
    : `${passedCount} / ${checks.length} check(s) passed`

  return {
    passed,
    summary,
    output,
    checks,
  }
}
