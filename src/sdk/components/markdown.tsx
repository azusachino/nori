import { Fragment, type ReactNode } from 'react'

// Matches inline tokens in priority order:
// 1. Obsidian wikilink: [[target|label]] or [[target]]
// 2. Triple-backtick inline span on a single line: ```code```
// 3. Double-backtick inline span: ``code``
// 4. Single-backtick inline span: `code`
// 5. Bold: **text** (recursively parses inline tokens inside)
// 6. Italic: *text* (recursively parses inline tokens inside)
// 7. Markdown link: [label](url)
// 8. Inline math fallback: $...$
const INLINE_TOKEN_RE =
  /(\[\[([^\]|]+)(?:\|([^\]]+))?\]\]|```([^`\n]+)```|``([^`\n]+)``|`([^`\n]+)`|\*\*([^*]+)\*\*|\*([^*\n]+)\*|\[([^\]]+)\]\((https?:\/\/[^\s)]+|\/[^\s)]+)\)|\$([^\s$][^$\n]*?[^\s$]|\S)\$)/g

export function renderInlineMarkdown(text: string): ReactNode[] {
  const nodes: ReactNode[] = []
  let lastIndex = 0
  let key = 0

  for (const match of text.matchAll(INLINE_TOKEN_RE)) {
    const idx = match.index ?? 0
    if (idx > lastIndex) {
      nodes.push(text.slice(lastIndex, idx))
    }

    if (match[2] !== undefined) {
      const rawTarget = match[2].trim()
      const label = (match[3] ?? rawTarget.split('/').pop() ?? rawTarget).trim()
      const href = `/${rawTarget.replace(/\.md$/, '').replace(/\/index$/, '')}`
      nodes.push(
        <a key={`w-${key++}`} href={href}>
          {label}
        </a>,
      )
    } else if (match[4] !== undefined) {
      nodes.push(<code key={`c3-${key++}`}>{match[4].trim()}</code>)
    } else if (match[5] !== undefined) {
      nodes.push(<code key={`c2-${key++}`}>{match[5]}</code>)
    } else if (match[6] !== undefined) {
      nodes.push(<code key={`c-${key++}`}>{match[6]}</code>)
    } else if (match[7] !== undefined) {
      nodes.push(<strong key={`b-${key++}`}>{renderInlineMarkdown(match[7])}</strong>)
    } else if (match[8] !== undefined) {
      nodes.push(<em key={`i-${key++}`}>{renderInlineMarkdown(match[8])}</em>)
    } else if (match[9] !== undefined && match[10] !== undefined) {
      nodes.push(
        <a key={`l-${key++}`} href={match[10]}>
          {renderInlineMarkdown(match[9])}
        </a>,
      )
    } else if (match[11] !== undefined) {
      nodes.push(
        <code key={`m-${key++}`} className="nori-math">
          {match[11]}
        </code>,
      )
    }

    lastIndex = idx + match[0].length
  }

  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex))
  }
  return nodes
}

function renderMarkdownBlocks(segment: string, baseKey: string): ReactNode[] {
  const trimmed = segment.replace(/^\n+|\n+$/g, '')
  if (!trimmed) return []

  const lines = trimmed.split('\n')
  const blocks: ReactNode[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]!
    if (!line.trim()) {
      i++
      continue
    }

    // Heading: # .. ####
    const headingMatch = line.match(/^\s*(#{1,4})\s+(.+)$/)
    if (headingMatch) {
      blocks.push(
        <div key={`${baseKey}-h-${i}`} className="nori-md-heading">
          {renderInlineMarkdown(headingMatch[2]!.trim())}
        </div>,
      )
      i++
      continue
    }

    // Unordered list: - item or * item
    if (/^\s*[-*]\s+/.test(line)) {
      const items: ReactNode[] = []
      const start = i
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i]!)) {
        const itemText = lines[i]!.replace(/^\s*[-*]\s+/, '')
        items.push(<li key={`${baseKey}-ul-${i}`}>{renderInlineMarkdown(itemText)}</li>)
        i++
      }
      blocks.push(
        <ul key={`${baseKey}-ul-wrap-${start}`} className="nori-md-list">
          {items}
        </ul>,
      )
      continue
    }

    // Ordered list: 1. item
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: ReactNode[] = []
      const start = i
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i]!)) {
        const itemText = lines[i]!.replace(/^\s*\d+\.\s+/, '')
        items.push(<li key={`${baseKey}-ol-${i}`}>{renderInlineMarkdown(itemText)}</li>)
        i++
      }
      blocks.push(
        <ol key={`${baseKey}-ol-wrap-${start}`} className="nori-md-list">
          {items}
        </ol>,
      )
      continue
    }

    // Blockquote: > text
    if (/^\s*>\s?/.test(line)) {
      const quoteLines: string[] = []
      const start = i
      while (i < lines.length && /^\s*>\s?/.test(lines[i]!)) {
        quoteLines.push(lines[i]!.replace(/^\s*>\s?/, ''))
        i++
      }
      blocks.push(
        <blockquote key={`${baseKey}-q-${start}`} className="nori-md-quote">
          {renderInlineMarkdown(quoteLines.join('\n'))}
        </blockquote>,
      )
      continue
    }

    // Paragraph lines up to blank line or next special block
    const paraLines: string[] = []
    const start = i
    while (
      i < lines.length &&
      lines[i]!.trim() !== '' &&
      !/^\s*(?:#{1,4}\s+|[-*]\s+|\d+\.\s+|>\s?)/.test(lines[i]!)
    ) {
      paraLines.push(lines[i]!)
      i++
    }
    blocks.push(
      <div key={`${baseKey}-p-${start}`} className="nori-md-para">
        {renderInlineMarkdown(paraLines.join('\n'))}
      </div>,
    )
  }

  return blocks
}

export function renderRichText(text: string): ReactNode {
  if (!text) return null
  const normalized = text.replace(/\r\n/g, '\n')

  // Fast path for single-line text without newlines
  if (!normalized.includes('\n')) {
    return <Fragment>{renderInlineMarkdown(normalized)}</Fragment>
  }

  const lines = normalized.split('\n')
  const out: ReactNode[] = []
  let proseLines: string[] = []
  let inFence = false
  let fenceLang = ''
  let fenceLines: string[] = []
  let segIdx = 0

  const flushProse = () => {
    if (proseLines.length > 0) {
      out.push(...renderMarkdownBlocks(proseLines.join('\n'), `seg-${segIdx++}`))
      proseLines = []
    }
  }

  const flushFence = () => {
    out.push(
      <pre key={`pre-${segIdx++}`} className="nori-codeblock" data-language={fenceLang || undefined}>
        {fenceLang && <span className="nori-codeblock__lang">{fenceLang}</span>}
        <code>{fenceLines.join('\n')}</code>
      </pre>,
    )
    inFence = false
    fenceLang = ''
    fenceLines = []
  }

  for (const line of lines) {
    if (!inFence) {
      // A multi-line code fence opening line starts with optional spaces + ``` + optional language (no closing ``` on the same line)
      const openMatch = line.match(/^[ \t]*```([^`]*)$/)
      if (openMatch) {
        flushProse()
        inFence = true
        fenceLang = openMatch[1]!.trim()
        fenceLines = []
        continue
      }
      proseLines.push(line)
    } else {
      if (/^[ \t]*```[ \t]*$/.test(line)) {
        flushFence()
      } else {
        fenceLines.push(line)
      }
    }
  }

  if (inFence) {
    flushFence()
  }
  flushProse()

  return out
}
