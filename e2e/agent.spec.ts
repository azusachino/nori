import { test, expect } from '@playwright/test'

test('agent can create drafts but cannot approve or record learner work', async ({ request, page }) => {
  const headers = { Authorization: `Bearer ${'a'.repeat(64)}` }
  expect((await request.post('/api/agent/courses', { data: { title: 'Denied', goal: 'Denied' } })).status()).toBe(401)
  const title = `Agent course ${crypto.randomUUID()}`
  const created = await request.post('/api/agent/courses', { headers, data: { title, goal: 'Study this topic.' } })
  expect(created.status()).toBe(201)
  const course = await created.json() as { id: string }
  expect((await request.post(`/api/agent/courses/${course.id}/outline`, { headers, data: { outline: 'Module 1: Foundations' } })).status()).toBe(200)
  expect((await request.post(`/api/agent/courses/${course.id}/approve`, { headers, data: {} })).status()).toBe(404)
  expect((await request.post(`/api/courses/${course.id}/approve`, { headers, data: {} })).status()).toBe(401)
  await page.goto('/')
  await page.getByLabel('Password').fill('test-password-only')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.getByRole('button', { name: title }).click()
  await expect(page.getByLabel('Edit your outline')).toHaveValue('Module 1: Foundations')
  await page.getByRole('button', { name: 'Approve outline' }).click()
  await expect(page.getByText('Outline approved')).toBeVisible()
  expect((await request.post(`/api/agent/courses/${course.id}/outline`, { headers, data: { outline: 'Changed' } })).status()).toBe(409)
  const content = { title: 'Agent module', lessons: [{ title: 'Lesson', body: 'Some content.' }], exercises: [
    { type: 'multiple_choice', prompt: 'Choose', options: ['Yes', 'No'], answer: 'Yes', explanation: 'Yes is correct.' },
    { type: 'written', prompt: 'Explain', options: [], answer: 'Reference', explanation: 'Review it.' },
    { type: 'code', prompt: 'Write code', options: [], answer: 'Reference', explanation: 'Review it.' },
  ] }
  expect((await request.post(`/api/agent/courses/${course.id}/module`, { headers, data: { content } })).status()).toBe(201)
  const detail = await (await request.get(`/api/agent/courses/${course.id}`, { headers })).json() as { draft: { content: typeof content; contentHash: string } }
  detail.draft.content.title = 'Agent module revised'
  expect((await request.post(`/api/agent/courses/${course.id}/module`, { headers, data: { content: detail.draft.content, expectedContentHash: detail.draft.contentHash } })).status()).toBe(200)
  expect((await request.post(`/api/agent/courses/${course.id}/module`, { headers, data: { content: detail.draft.content, expectedContentHash: detail.draft.contentHash } })).status()).toBe(409)
  await page.reload()
  await page.getByRole('button', { name: title }).click()
  await expect(page.getByRole('heading', { name: 'Agent module revised' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Accept module' })).toBeVisible()
  expect((await request.post(`/api/agent/courses/${course.id}/answer`, { headers, data: {} })).status()).toBe(404)
})
