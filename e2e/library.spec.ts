import { test, expect } from '@playwright/test'

test('learner saves a goal, studies and resumes', async ({ page }, info) => {
  const title = `Learning ${crypto.randomUUID()}`
  await page.goto('/')
  await expect(page.getByRole('link', { name: 'Nori home' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'What you’re learning' })).toBeVisible()
  await page.screenshot({ path: `.tmp/nori-ui-agy/library-${info.project.name}.png`, fullPage: true })
  await page.getByLabel('Topic').fill(title)
  await page.getByLabel('Your learning goal').fill('Explain the concepts and apply them.')
  await page.getByRole('button', { name: 'Save learning goal' }).click()
  await expect(page.getByRole('button', { name: title })).toBeVisible()
  await page.reload()
  await page.getByRole('button', { name: title }).click()
  const courseId = (await page.getByRole('link', { name: 'Export course' }).getAttribute('href'))!.split('/')[3]
  const concurrent = await page.evaluate(async (id) => {
    const send = () => fetch(`/api/courses/${id}/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'slow test' }) }).then((response) => response.status)
    return Promise.all([send(), send()])
  }, courseId)
  expect(concurrent.sort()).toEqual([200, 409])
  await page.reload()
  await page.getByRole('button', { name: title }).click()
  await page.getByText('Sources (optional)').click()
  await page.getByLabel('Add a source · up to 5 MB').setInputFiles({ name: 'notes.md', mimeType: 'text/markdown', buffer: Buffer.from('# Notes\nA reliable foundation.') })
  await page.getByRole('button', { name: 'Add source' }).click()
  await expect(page.getByText('notes.md')).toBeVisible()
  await page.getByLabel('Your message').fill('I am a beginner.')
  await page.getByRole('button', { name: 'Send message' }).click()
  await expect(page.getByText('What experience do you already have?').last()).toBeVisible()
  await page.getByRole('button', { name: 'Generate outline' }).click()
  await expect(page.getByLabel('Edit your outline')).toHaveValue(/Source: notes\.md/)
  await page.screenshot({ path: `.tmp/nori-ui-agy/planning-${info.project.name}.png`, fullPage: true })
  await page.getByRole('button', { name: 'Approve outline' }).click()
  await expect(page.getByText('Outline approved')).toBeVisible()
  await page.getByRole('button', { name: 'Generate first module' }).click()
  await expect(page.getByLabel('Title', { exact: true })).toHaveValue('Foundations')
  await page.screenshot({ path: `.tmp/nori-ui-agy/module-draft-${info.project.name}.png`, fullPage: true })
  await page.getByLabel('Title', { exact: true }).fill('Foundations revised')
  await page.getByRole('button', { name: 'Save draft changes' }).click()
  await page.getByRole('button', { name: 'Accept module' }).click()
  await expect(page.getByRole('heading', { name: 'Foundations revised' })).toBeVisible()
  await page.getByLabel('A', { exact: true }).check()
  await page.getByRole('button', { name: 'Check answer' }).first().click()
  await expect(page.getByText('Correct. A is correct.')).toBeVisible()
  await page.getByLabel('Your answer').first().fill('The core idea.')
  await page.getByRole('button', { name: 'Check answer' }).nth(1).click()
  await expect(page.getByText('Consider the core idea and add an example.')).toBeVisible()
  await page.getByLabel('Your correction or note').fill('The answer is also valid for this case.')
  await page.getByRole('button', { name: 'Save correction' }).click()
  await expect(page.getByText('Your correction: The answer is also valid for this case.')).toBeVisible()
  await page.getByLabel('Your answer').first().fill('A second explanation.')
  await page.getByRole('button', { name: 'Check answer' }).nth(1).click()
  await expect(page.getByText('Your answer: A second explanation.')).toBeVisible()
  await page.getByRole('button', { name: '← Your library' }).click()
  await page.getByRole('button', { name: title }).click()
  await expect(page.getByRole('heading', { name: 'Foundations revised' })).toBeVisible()
  await expect(page.getByText('Correct. A is correct.')).toBeVisible()
  await expect(page.getByText('Your answer: The core idea.')).toBeVisible()
  await expect(page.getByText('Your answer: A second explanation.')).toBeVisible()
  await expect(page.getByText('Your correction: The answer is also valid for this case.')).toBeVisible()
  await page.screenshot({ path: `.tmp/visual/course-${info.project.name}.png`, fullPage: true })
  await page.screenshot({ path: `.tmp/nori-ui-agy/course-${info.project.name}.png`, fullPage: true })
  const exportUrl = await page.getByRole('link', { name: 'Export course' }).getAttribute('href')
  const exported = await page.request.get(exportUrl!)
  expect(await exported.text()).toContain('Foundations revised')
})

test('favicon and icon render properly in light and dark mode', async ({ page }) => {
  await page.goto('/')
  const favicon = page.locator('link[rel="icon"]')
  await expect(favicon).toHaveAttribute('href', '/favicon.svg')
  const iconResponse = await page.request.get('/favicon.svg')
  expect(iconResponse.status()).toBe(200)
  const iconSvg = await iconResponse.text()
  expect(iconSvg).toContain('aria-label="Nori icon"')
  expect(iconSvg).toContain('prefers-color-scheme: dark')
})

test('rejects cross-origin writes and unexpected hosts', async ({ page, request }) => {
  expect((await request.get('/api/courses')).status()).toBe(200)
  expect((await request.get('/api/courses', { headers: { host: 'attacker.invalid' } })).status()).toBe(403)
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'What you’re learning' })).toBeVisible()
  const result = await page.request.post('/api/courses', { headers: { origin: 'https://attacker.invalid' }, data: { title: 'Forbidden', goal: 'Forbidden' } })
  expect(result.status()).toBe(403)
})

test('learner creates, reviews and studies multiple modules with navigation and persistence', async ({ page }, info) => {
  const title = `Multi-Module ${crypto.randomUUID()}`
  await page.goto('/')
  await page.getByLabel('Topic').fill(title)
  await page.getByLabel('Your learning goal').fill('Master multiple modules with distinct exercises.')
  await page.getByRole('button', { name: 'Save learning goal' }).click()
  await page.getByRole('button', { name: title }).click()

  // Generate and approve outline
  await page.getByRole('button', { name: 'Generate outline' }).click()
  await expect(page.getByLabel('Edit your outline')).toBeVisible()
  await page.getByRole('button', { name: 'Approve outline' }).click()
  await expect(page.getByText('Outline approved')).toBeVisible()

  // 1. Generate, review, save, and accept Module 1
  await page.getByRole('button', { name: 'Generate first module' }).click()
  await expect(page.getByLabel('Module title')).toHaveValue('First principles')
  await page.getByLabel('Module title').fill('Foundations of Architecture')
  await page.getByRole('button', { name: 'Save draft changes' }).click()
  await page.getByRole('button', { name: 'Accept module' }).click()
  await expect(page.getByRole('heading', { name: 'Foundations of Architecture' })).toBeVisible()

  // Verify Module 1 nav button has aria-current="true"
  const mod1Nav = page.getByRole('button', { name: /Module 1/ })
  await expect(mod1Nav).toHaveAttribute('aria-current', 'true')

  // Answer multiple-choice exercise in Module 1
  await page.getByLabel('A', { exact: true }).check()
  await page.getByRole('button', { name: 'Check answer' }).first().click()
  await expect(page.getByText('Correct. A is correct.')).toBeVisible()

  // 2. Generate Module 2 and verify draft edits are retained when switching away and back
  await expect(page.getByRole('button', { name: 'Generate next module' }).first()).toBeVisible()
  await page.getByRole('button', { name: 'Generate next module' }).first().click()
  await expect(page.getByLabel('Module title')).toHaveValue('Advanced application')

  // Make unsaved edits in Module 2 draft
  await page.getByLabel('Module title').fill('Applied Systems & Performance (Draft Edits)')
  await page.getByLabel('Content', { exact: true }).fill('Deep dive with custom unsaved notes.')
  await expect(page.getByRole('button', { name: 'Save draft changes' })).toBeEnabled()

  // Verify Module 2 button shows unsaved status badge and aria-current="true"
  const mod2Nav = page.getByRole('button', { name: /Module 2/ })
  await expect(mod2Nav).toContainText('Draft · Unsaved')
  await expect(mod2Nav).toHaveAttribute('aria-current', 'true')

  // Switch away to Module 1
  await mod1Nav.click()
  await expect(page.getByRole('heading', { name: 'Foundations of Architecture' })).toBeVisible()
  await expect(mod1Nav).toHaveAttribute('aria-current', 'true')
  await expect(mod2Nav).not.toHaveAttribute('aria-current', 'true')

  // Switch back to Module 2 and confirm unsaved edits are intact
  await mod2Nav.click()
  await expect(mod2Nav).toHaveAttribute('aria-current', 'true')
  await expect(page.getByLabel('Module title')).toHaveValue('Applied Systems & Performance (Draft Edits)')
  await expect(page.getByLabel('Content', { exact: true })).toHaveValue('Deep dive with custom unsaved notes.')
  await expect(page.getByRole('button', { name: 'Save draft changes' })).toBeEnabled()

  // Save draft changes and accept Module 2
  await page.getByRole('button', { name: 'Save draft changes' }).click()
  await page.getByRole('button', { name: 'Accept module' }).click()
  await expect(page.getByRole('heading', { name: 'Applied Systems & Performance (Draft Edits)' })).toBeVisible()

  // Answer multiple-choice exercise in Module 2
  await page.getByLabel('Strategy A', { exact: true }).check()
  await page.getByRole('button', { name: 'Check answer' }).first().click()
  await expect(page.getByText('Correct. Strategy A is optimal.')).toBeVisible()

  // Screenshot Module 2
  await page.screenshot({ path: `.tmp/nori-ui-agy/multimodule-mod2-${info.project.name}.png`, fullPage: true })

  // 3. Navigate back to Module 1 via module nav buttons
  await mod1Nav.click()
  await expect(page.getByRole('heading', { name: 'Foundations of Architecture' })).toBeVisible()
  // Verify Module 1's previous attempt is preserved
  await expect(page.getByText('Correct. A is correct.')).toBeVisible()
  await expect(page.getByText('Your answer: A')).toBeVisible()

  // Screenshot Navigated Back Module 1
  await page.screenshot({ path: `.tmp/nori-ui-agy/multimodule-back-mod1-${info.project.name}.png`, fullPage: true })

  // Record an answer for written exercise in Module 1
  await page.getByLabel('Your answer').first().fill('Separation of concerns is essential.')
  await page.getByRole('button', { name: 'Check answer' }).nth(1).click()
  await expect(page.getByText('Consider the core idea and add an example.')).toBeVisible()
  await expect(page.getByText('Your answer: Separation of concerns is essential.')).toBeVisible()

  // 4. Reload the page and reopen course
  await page.reload()
  await page.getByRole('button', { name: title }).click()

  // Verify both modules exist as nav list buttons with aria-current states
  const reloadedMod1 = page.getByRole('button', { name: /Module 1/ })
  const reloadedMod2 = page.getByRole('button', { name: /Module 2/ })
  await expect(reloadedMod1).toBeVisible()
  await expect(reloadedMod2).toBeVisible()

  // Check Module 1 has both attempts preserved and sets aria-current
  await reloadedMod1.click()
  await expect(reloadedMod1).toHaveAttribute('aria-current', 'true')
  await expect(page.getByRole('heading', { name: 'Foundations of Architecture' })).toBeVisible()
  await expect(page.getByText('Correct. A is correct.')).toBeVisible()
  await expect(page.getByText('Your answer: Separation of concerns is essential.')).toBeVisible()

  // Check Module 2 has its attempt preserved and sets aria-current
  await reloadedMod2.click()
  await expect(reloadedMod2).toHaveAttribute('aria-current', 'true')
  await expect(page.getByRole('heading', { name: 'Applied Systems & Performance (Draft Edits)' })).toBeVisible()
  await expect(page.getByText('Correct. Strategy A is optimal.')).toBeVisible()
  await expect(page.getByText('Your answer: Strategy A')).toBeVisible()

  // Screenshot Reloaded Multi-Module View
  await page.screenshot({ path: `.tmp/nori-ui-agy/multimodule-reloaded-${info.project.name}.png`, fullPage: true })
})
