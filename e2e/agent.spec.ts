import { test, expect } from '@playwright/test'

test('agent draft routes preserve the review workflow', async ({ request, page }) => {
  const headers = { 'X-Nori-Agent': '1' }
  expect((await request.post('/api/agent/courses', { data: { title: 'Denied', goal: 'Denied' } })).status()).toBe(403)
  const title = `Agent course ${crypto.randomUUID()}`
  const created = await request.post('/api/agent/courses', { headers, data: { title, goal: 'Study this topic.' } })
  expect(created.status()).toBe(201)
  const course = await created.json() as { id: string }
  expect((await request.post(`/api/agent/courses/${course.id}/outline`, { headers, data: { outline: 'Module 1: Foundations' } })).status()).toBe(200)
  expect((await request.post(`/api/agent/courses/${course.id}/approve`, { headers, data: {} })).status()).toBe(404)
  await page.goto('/')
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
  await page.getByLabel('Module title').fill('Edited before save')
  let releaseSave!: () => void
  const saveGate = new Promise<void>((resolve) => { releaseSave = resolve })
  await page.route('**/save-module', async (route) => { await saveGate; await route.continue() })
  await page.getByRole('button', { name: 'Save draft changes' }).click()
  await expect(page.getByLabel('Module title')).toBeDisabled()
  releaseSave()
  await expect(page.getByRole('button', { name: 'Accept module' })).toBeEnabled()
  await page.unroute('**/save-module')
  await page.getByLabel('Module title').fill('My unsaved edit')
  const latest = await (await request.get(`/api/agent/courses/${course.id}`, { headers })).json() as { draft: { content: typeof content; contentHash: string } }
  latest.draft.content.title = 'Changed elsewhere'
  expect((await request.post(`/api/agent/courses/${course.id}/module`, { headers, data: { content: latest.draft.content, expectedContentHash: latest.draft.contentHash } })).status()).toBe(200)
  await page.getByLabel('Your message').fill('Please explain.')
  await page.getByRole('button', { name: 'Send message' }).click()
  await expect(page.getByRole('alert')).toContainText('draft changed elsewhere')
  await expect(page.getByLabel('Module title')).toHaveValue('My unsaved edit')
  await expect(page.getByRole('button', { name: 'Save draft changes' })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Accept module' })).toBeDisabled()
  expect((await request.post(`/api/agent/courses/${course.id}/answer`, { headers, data: {} })).status()).toBe(404)
})

test('outline editor detects a newer agent revision after a refresh', async ({ page, request }) => {
  const headers = { 'X-Nori-Agent': '1' }
  const title = `Outline race ${crypto.randomUUID()}`
  const course = await (await request.post('/api/agent/courses', { headers, data: { title, goal: 'Study this topic.' } })).json() as { id: string }
  expect((await request.post(`/api/agent/courses/${course.id}/outline`, { headers, data: { outline: 'Original outline' } })).status()).toBe(200)
  await page.goto('/')
  await page.getByRole('button', { name: title }).click()
  await page.getByLabel('Edit your outline').fill('My unsaved edit')
  expect((await request.post(`/api/agent/courses/${course.id}/outline`, { headers, data: { outline: 'Agent revision', expectedOutline: 'Original outline' } })).status()).toBe(200)
  await page.getByText('Sources (optional)').click()
  await page.getByLabel('Add a source · up to 5 MB').setInputFiles({ name: 'source.txt', mimeType: 'text/plain', buffer: Buffer.from('Source text') })
  await page.getByRole('button', { name: 'Add source' }).click()
  await expect(page.getByRole('alert')).toContainText('outline changed elsewhere')
  await expect(page.getByLabel('Edit your outline')).toHaveValue('My unsaved edit')
  await expect(page.getByRole('button', { name: 'Save changes' })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Approve outline' })).toBeDisabled()
  const latest = await (await request.get(`/api/agent/courses/${course.id}`, { headers })).json() as { outline: string }
  expect(latest.outline).toBe('Agent revision')
})

test('learner can remove a source when the model context is too large', async ({ page, request, baseURL }) => {
  const headers = { Origin: baseURL! }
  const title = `Large source ${crypto.randomUUID()}`
  const created = await request.post('/api/courses', { headers, data: { title, goal: 'Study this topic.' } })
  const course = await created.json() as { id: string }
  const source = await request.post(`/api/courses/${course.id}/sources`, { headers, multipart: { file: { name: 'large.txt', mimeType: 'text/plain', buffer: Buffer.from('a'.repeat(99990)) } } })
  expect(source.status()).toBe(201)
  const outline = 'b'.repeat(19989)
  expect((await request.post(`/api/courses/${course.id}/outline`, { headers, data: { outline, expectedOutline: '' } })).status()).toBe(200)
  expect((await request.post(`/api/courses/${course.id}/approve`, { headers, data: { expectedOutline: outline } })).status()).toBe(200)
  const failed = await request.post(`/api/courses/${course.id}/module`, { headers, data: {} })
  expect(failed.status()).toBe(502)
  expect((await failed.json()).error).toContain('Remove a source')
  await page.goto('/')
  await page.getByRole('button', { name: title }).click()
  await page.getByText('Sources (1)').click()
  page.once('dialog', (dialog) => dialog.accept())
  await page.getByRole('button', { name: 'Remove', exact: true }).click()
  await expect(page.getByText('large.txt')).not.toBeVisible()
  await page.getByRole('button', { name: 'Generate first module' }).click()
  await expect(page.getByRole('button', { name: 'Accept module' })).toBeVisible()
})
