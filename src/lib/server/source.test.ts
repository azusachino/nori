import { describe, expect, test } from 'bun:test'
import { parseSource } from './source'

function pdfFixture() {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Length 44 >>\nstream\nBT /F1 18 Tf 10 100 Td (Hello Same) Tj ET\nendstream',
  ]
  let pdf = '%PDF-1.4\n'
  const offsets = [0]
  for (const [index, object] of objects.entries()) { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n` }
  const start = Buffer.byteLength(pdf)
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`
  return new TextEncoder().encode(pdf)
}
function request(file: File) {
  const data = new FormData(); data.set('file', file)
  return new Request('http://localhost', { method: 'POST', body: data })
}
describe('source ingestion', () => {
  test('extracts text from a real PDF', async () => {
    const source = await parseSource(request(new File([pdfFixture()], 'lesson.pdf', { type: 'application/pdf' })))
    expect(source.text).toContain('Hello Same')
    expect(source.text).toContain('[Page 1]')
  })
  test('rejects a PDF without PDF contents', async () => {
    await expect(parseSource(request(new File(['not a pdf'], 'lesson.pdf')))).rejects.toThrow('not a valid PDF')
  })
})
