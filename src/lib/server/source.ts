import { extractText, getDocumentProxy } from 'unpdf'

export async function parseSource(request: Request): Promise<{ name: string; bytes: Uint8Array; text: string }> {
  const limit = 5 * 1024 * 1024
  const length = Number(request.headers.get('content-length') || 0)
  if (length > limit + 8192 || !request.body) throw new Error('Choose a file smaller than 5 MB.')
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.length
    if (total > limit + 8192) { await reader.cancel(); throw new Error('Choose a file smaller than 5 MB.') }
    chunks.push(value)
  }
  const data = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length }
  const form = await new Request('http://localhost', { method: 'POST', headers: { 'content-type': request.headers.get('content-type') || '' }, body: data }).formData()
  const file = form.get('file')
  if (!(file instanceof File) || file.size === 0 || file.size > limit || file.name.length > 200) throw new Error('Choose a Markdown or PDF file under 5 MB.')
  const bytes = new Uint8Array(await file.arrayBuffer())
  let text: string
  if (/\.pdf$/i.test(file.name)) {
    if (new TextDecoder().decode(bytes.slice(0, 5)) !== '%PDF-') throw new Error('This file is not a valid PDF.')
    const pdf = await getDocumentProxy(bytes, { maxImageSize: 16777216 })
    if (pdf.numPages > 50) throw new Error('PDFs must be 50 pages or fewer.')
    const pages = await extractText(pdf)
    text = (pages.text as string[]).map((page, index) => `[Page ${index + 1}]\n${page}`).join('\n\n')
  } else if (/\.(md|markdown|txt)$/i.test(file.name)) {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } else throw new Error('Only Markdown, text and PDF files are supported.')
  if (!text.trim()) throw new Error('No text was found. Scanned PDFs need OCR before upload.')
  if (text.length > 100000) throw new Error('This file contains too much text. Use a shorter document (up to 100,000 characters).')
  return { name: file.name, bytes, text }
}
