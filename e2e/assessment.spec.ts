import { test, expect } from '@playwright/test'

test.describe('Learner assessments', () => {
  test('untimed assessment lifecycle: create, planned preview, answer, resume, submit, advisory feedback and note', async ({ page }, info) => {
    const title = `Untimed Course ${crypto.randomUUID()}`
    await page.goto('/')
    await page.getByLabel('Topic').fill(title)
    await page.getByLabel('Your learning goal').fill('Understand foundational assessment mechanics.')
    await page.getByRole('button', { name: 'Save learning goal' }).click()
    await page.getByRole('button', { name: title }).click()

    // 1. Generate and approve outline, then generate and accept Module 1
    await page.getByRole('button', { name: 'Generate outline' }).click()
    await expect(page.getByLabel('Edit your outline')).toBeVisible()
    await page.getByRole('button', { name: 'Approve outline' }).click()
    await expect(page.getByText('Outline approved')).toBeVisible()

    await page.getByRole('button', { name: 'Generate first module' }).click()
    await expect(page.getByLabel('Module title')).toHaveValue('First principles')
    await page.getByRole('button', { name: 'Accept module' }).click()
    await expect(page.getByRole('heading', { name: 'First principles' })).toBeVisible()

    // 2. Open Assessments via section navigation
    const assessmentsNavBtn = page.getByRole('button', { name: 'Assessments', exact: true })
    await expect(assessmentsNavBtn).toBeVisible()
    await assessmentsNavBtn.click()

    await expect(page.getByRole('heading', { name: 'Course assessments' })).toBeVisible()
    await expect(page.getByText(/No assessments created yet/)).toBeVisible()

    // 3. Create Untimed Assessment
    await page.getByRole('button', { name: '+ New assessment' }).click()
    await page.getByLabel('Title').fill('Foundations Check')
    // Untimed is default, module checkbox is checked by default
    await page.getByRole('button', { name: 'Create assessment' }).click()

    // 4. Verify Planned Stage: Scope is visible, question prompts and answers are hidden until start
    await expect(page.getByRole('heading', { name: 'Foundations Check' })).toBeVisible()
    await expect(page.getByText('COURSE ASSESSMENT / UNTIMED · STATUS: PLANNED')).toBeVisible()
    await expect(page.getByText('Scope planned')).toBeVisible()
    await expect(page.getByText(/covers 3 exercises across 1 modules/i)).toBeVisible()
    await expect(page.getByText(/individual question-to-lesson attribution is not claimed/i)).toBeVisible()

    // Question prompts and reference answers must remain hidden before starting
    await expect(page.getByText(/Question prompt hidden until you start/i).first()).toBeVisible()
    await expect(page.getByText('Choose the correct answer')).not.toBeVisible()
    await expect(page.getByText('A is correct.')).not.toBeVisible()
    await expect(page.getByText('A good explanation')).not.toBeVisible()

    await page.screenshot({ path: `.tmp/nori-ui-agy/assessment-planned-${info.project.name}.png`, fullPage: true })

    // 5. Start Assessment -> Active Stage: prompts become visible
    await page.getByRole('button', { name: 'Start assessment' }).click()
    await expect(page.getByText('In progress')).toBeVisible()
    await expect(page.getByText('Choose the correct answer')).toBeVisible()

    // Answer multiple-choice question (Item 1)
    await page.getByLabel('A', { exact: true }).check()
    await page.getByRole('button', { name: 'Save answer' }).first().click()
    await expect(page.getByText('✓ Saved').first()).toBeVisible()

    // Answer written question (Item 2)
    const writtenTextarea = page.getByLabel('Your answer').first()
    await writtenTextarea.fill('The fundamental concept of the architecture.')
    await page.getByRole('button', { name: 'Save answer' }).nth(1).click()
    await expect(page.getByText('✓ Saved').nth(1)).toBeVisible()

    await page.screenshot({ path: `.tmp/nori-ui-agy/assessment-active-${info.project.name}.png`, fullPage: true })

    // 6. Test Reload & Resume
    await page.reload()
    await page.getByRole('button', { name: title }).click()
    await page.getByRole('button', { name: 'Assessments', exact: true }).click()

    await expect(page.getByRole('heading', { name: 'Course assessments' })).toBeVisible()
    await expect(page.getByText('Foundations Check')).toBeVisible()
    await expect(page.getByText('In progress')).toBeVisible()
    await page.getByRole('button', { name: /Continue assessment/ }).click()

    // Confirm saved answers were preserved
    await expect(page.getByLabel('A', { exact: true })).toBeChecked()
    await expect(writtenTextarea).toHaveValue('The fundamental concept of the architecture.')

    // 7. Submit Assessment
    await page.getByRole('button', { name: 'Submit assessment' }).click()
    await expect(page.getByRole('heading', { name: 'Assessment Submitted' })).toBeVisible()
    await expect(page.getByText('Submitted', { exact: true })).toBeVisible()

    // Performance Breakdown
    await expect(page.getByText('1 / 1 correct')).toBeVisible()
    await expect(page.getByText('2 items')).toBeVisible()

    // Detailed Review: Reference answers and explanations now revealed
    await expect(page.getByText('✓ Correct')).toBeVisible()
    await expect(page.getByText('Explanation: A is correct.')).toBeVisible()
    await expect(page.getByText('Reference answer: A good explanation')).toBeVisible()
    await expect(page.getByText('Explanation: Explain the idea.')).toBeVisible()

    await page.screenshot({ path: `.tmp/nori-ui-agy/assessment-submitted-${info.project.name}.png`, fullPage: true })

    // 8. Request Advisory AI Feedback on written response
    await page.getByRole('button', { name: 'Request advisory AI feedback' }).first().click()
    await expect(page.getByText('AI feedback · advisory')).toBeVisible()
    await expect(page.getByText('Consider the core idea and add an example.')).toBeVisible()

    // 9. Add Owner Correction Note
    const noteTextarea = page.getByPlaceholder('Add your own assessment note or correction…').first()
    await noteTextarea.fill('Learner note: Verified with real-world trace.')
    await page.getByRole('button', { name: 'Save correction' }).first().click()
    await expect(page.getByText('Saved note: Learner note: Verified with real-world trace.')).toBeVisible()
  })

  test('timed assessment lifecycle: countdown and server-enforced deadline expiry handling', async ({ page, context }, info) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    const title = `Timed Course ${crypto.randomUUID()}`
    await page.goto('/')
    await page.getByLabel('Topic').fill(title)
    await page.getByLabel('Your learning goal').fill('Verify timed assessment deadline expiry.')
    await page.getByRole('button', { name: 'Save learning goal' }).click()
    await page.getByRole('button', { name: title }).click()

    // Generate outline and accept Module 1
    await page.getByRole('button', { name: 'Generate outline' }).click()
    await expect(page.getByLabel('Edit your outline')).toBeVisible()
    await page.getByRole('button', { name: 'Approve outline' }).click()
    await expect(page.getByText('Outline approved')).toBeVisible()

    await page.getByRole('button', { name: 'Generate first module' }).click()
    await expect(page.getByLabel('Module title')).toHaveValue('First principles')
    await page.getByRole('button', { name: 'Accept module' }).click()
    await expect(page.getByRole('heading', { name: 'First principles' })).toBeVisible()

    // Navigate to Assessments
    await page.getByRole('button', { name: 'Assessments', exact: true }).click()
    await page.getByRole('button', { name: '+ New assessment' }).click()

    // Fill timed assessment with 2 seconds duration
    await page.getByLabel('Title').fill('Speed Challenge')
    await page.getByLabel(/Timed \(Fixed deadline/).check()
    await page.getByLabel('Duration unit').selectOption('seconds')
    await page.getByLabel('Duration', { exact: true }).fill('2')
    await page.getByRole('button', { name: 'Create assessment' }).click()

    // Planned State
    await expect(page.getByRole('heading', { name: 'Speed Challenge' })).toBeVisible()
    await page.getByRole('button', { name: 'Start assessment' }).click()

    // Active State
    await expect(page.getByRole('timer')).toBeVisible()
    const writtenInput = page.getByLabel('Your answer').first()
    await writtenInput.fill('Typed answer while clock was ticking.')

    // Wait for server deadline to pass and automatic expiry to trigger without any save or click
    await expect(page.getByRole('heading', { name: 'Assessment Finalized on Expiry' })).toBeVisible({ timeout: 10000 })
    await expect(page.getByText('Deadline passed', { exact: true })).toBeVisible()
    await expect(page.getByText('No manual submission recorded')).toBeVisible()

    // Unsaved draft warning banner and unsubmitted answer must be visibly preserved and copyable
    await expect(page.locator('.unsaved-warning-banner')).toContainText('Unsaved draft answers preserved')
    await expect(page.getByText('Unsaved draft at expiry')).toBeVisible()
    await expect(page.getByText('(Not recorded on server before deadline)')).toBeVisible()
    await expect(page.getByText('Typed answer while clock was ticking.')).toBeVisible()

    const copyBtn = page.getByRole('button', { name: /Copy unsaved draft/ })
    await expect(copyBtn).toBeVisible()
    await copyBtn.click()
    await expect(page.getByRole('button', { name: /Copied to clipboard/ })).toBeVisible()

    // Confirm reference answers and explanations are revealed
    await expect(page.getByText('Explanation: A is correct.')).toBeVisible()
    await page.screenshot({ path: `.tmp/nori-ui-agy/assessment-expired-${info.project.name}.png`, fullPage: true })

    // Leaving expired review with unsaved drafts prompts confirmation
    let expiredLeaveTriggered = false
    page.once('dialog', async (dialog) => {
      expiredLeaveTriggered = true
      expect(dialog.message()).toContain('unsaved local draft answers')
      await dialog.accept()
    })
    await page.getByRole('button', { name: '← All assessments' }).click()
    expect(expiredLeaveTriggered).toBe(true)
    await expect(page.getByRole('heading', { name: 'Course assessments' })).toBeVisible()
  })

  test('navigation safety: confirms leaving with unsaved answers', async ({ page }) => {
    const title = `Unsaved Confirm ${crypto.randomUUID()}`
    await page.goto('/')
    await page.getByLabel('Topic').fill(title)
    await page.getByLabel('Your learning goal').fill('Test unsaved warning on navigation.')
    await page.getByRole('button', { name: 'Save learning goal' }).click()
    await page.getByRole('button', { name: title }).click()

    await page.getByRole('button', { name: 'Generate outline' }).click()
    await expect(page.getByLabel('Edit your outline')).toBeVisible()
    await page.getByRole('button', { name: 'Approve outline' }).click()
    await expect(page.getByText('Outline approved')).toBeVisible()

    await page.getByRole('button', { name: 'Generate first module' }).click()
    await page.getByRole('button', { name: 'Accept module' }).click()

    await page.getByRole('button', { name: 'Assessments', exact: true }).click()
    await page.getByRole('button', { name: '+ New assessment' }).click()
    await page.getByLabel('Title').fill('Unsaved Warning Test')
    await page.getByRole('button', { name: 'Create assessment' }).click()

    await page.getByRole('button', { name: 'Start assessment' }).click()

    // Enter answer without clicking "Save answer"
    await page.getByLabel('Your answer').first().fill('Unsaved drafted thoughts')

    // Prepare to dismiss confirmation dialog (stay on page)
    let dialogTriggered = false
    page.once('dialog', async (dialog) => {
      dialogTriggered = true
      expect(dialog.message()).toContain('unsaved answers')
      await dialog.dismiss()
    })

    await page.getByRole('button', { name: '← All assessments' }).click()
    expect(dialogTriggered).toBe(true)
    // We should still be on the assessment detail page
    await expect(page.getByRole('heading', { name: 'Unsaved Warning Test' })).toBeVisible()

    // Submit with unsaved changes: triggers submit confirmation dialog
    page.once('dialog', async (dialog) => {
      expect(dialog.message()).toContain('unsaved changes')
      await dialog.accept()
    })
    await page.getByRole('button', { name: 'Submit assessment' }).click()

    // Status is submitted and unsaved draft is preserved with submission-specific label
    await expect(page.getByRole('heading', { name: 'Assessment Submitted' })).toBeVisible()
    await expect(page.locator('.unsaved-warning-banner')).toContainText('Unsaved draft answers preserved')
    await expect(page.getByText('Unsaved draft at submission')).toBeVisible()
    await expect(page.getByText('(Not saved before submission)')).toBeVisible()
    await expect(page.getByText('Unsaved drafted thoughts')).toBeVisible()

    // Leaving finalized review with unsaved drafts prompts confirmation
    let finalizedLeaveTriggered = false
    page.once('dialog', async (dialog) => {
      finalizedLeaveTriggered = true
      expect(dialog.message()).toContain('unsaved local draft answers')
      await dialog.dismiss()
    })
    await page.getByRole('button', { name: '← All assessments' }).click()
    expect(finalizedLeaveTriggered).toBe(true)
    await expect(page.getByRole('heading', { name: 'Assessment Submitted' })).toBeVisible()

    // Now accept dialog to actually leave
    page.once('dialog', async (dialog) => {
      await dialog.accept()
    })
    await page.getByRole('button', { name: '← All assessments' }).click()
    await expect(page.getByRole('heading', { name: 'Course assessments' })).toBeVisible()
  })

  test('exit paths safety: confirms and retains unsaved answers on Modules nav and library back', async ({ page }) => {
    const title = `Exit Paths Test ${crypto.randomUUID()}`
    await page.goto('/')
    await page.getByLabel('Topic').fill(title)
    await page.getByLabel('Your learning goal').fill('Verify every exit path from assessment.')
    await page.getByRole('button', { name: 'Save learning goal' }).click()
    await page.getByRole('button', { name: title }).click()

    await page.getByRole('button', { name: 'Generate outline' }).click()
    await expect(page.getByLabel('Edit your outline')).toBeVisible()
    await page.getByRole('button', { name: 'Approve outline' }).click()
    await expect(page.getByText('Outline approved')).toBeVisible()

    await page.getByRole('button', { name: 'Generate first module' }).click()
    await page.getByRole('button', { name: 'Accept module' }).click()

    await page.getByRole('button', { name: 'Assessments', exact: true }).click()
    await page.getByRole('button', { name: '+ New assessment' }).click()
    await page.getByLabel('Title').fill('Exit Guard Test')
    await page.getByRole('button', { name: 'Create assessment' }).click()
    await page.getByRole('button', { name: 'Start assessment' }).click()

    // 1. Enter unsaved answer in active assessment
    const writtenTextarea = page.getByLabel('Your answer').first()
    await writtenTextarea.fill('Persistent unsaved answer across module navigation')

    // 2. Test Modules nav exit path
    // Attempt to switch to Modules while unsaved: dismiss dialog to stay
    let modulesDismissTriggered = false
    page.once('dialog', async (dialog) => {
      modulesDismissTriggered = true
      expect(dialog.message()).toContain('unsaved assessment answers')
      await dialog.dismiss()
    })
    await page.getByRole('button', { name: 'Modules (1)' }).click()
    expect(modulesDismissTriggered).toBe(true)
    await expect(writtenTextarea).toBeVisible()

    // Now accept dialog to switch to Modules
    page.once('dialog', async (dialog) => {
      await dialog.accept()
    })
    await page.getByRole('button', { name: 'Modules (1)' }).click()
    await expect(page.getByRole('heading', { name: 'First principles' })).toBeVisible()

    // Switch back to Assessments and verify unsaved draft answer is retained in memory
    await page.getByRole('button', { name: 'Assessments', exact: true }).click()
    await page.getByRole('button', { name: /Continue assessment/ }).click()
    await expect(writtenTextarea).toHaveValue('Persistent unsaved answer across module navigation')

    // 3. Test Library Back exit path
    let libraryDismissTriggered = false
    page.once('dialog', async (dialog) => {
      libraryDismissTriggered = true
      expect(dialog.message()).toContain('unsaved assessment answers')
      await dialog.dismiss()
    })
    await page.getByRole('button', { name: '← Your library' }).click()
    expect(libraryDismissTriggered).toBe(true)
    await expect(writtenTextarea).toBeVisible()

    // Now accept dialog to leave to library
    page.once('dialog', async (dialog) => {
      await dialog.accept()
    })
    await page.getByRole('button', { name: '← Your library' }).click()
    await expect(page.getByRole('heading', { name: 'What you’re learning' })).toBeVisible()
  })

  test('exit paths safety: confirms unsaved module drafts when switching to assessments then leaving course', async ({ page }) => {
    const title = `Module Draft Exit ${crypto.randomUUID()}`
    await page.goto('/')
    await page.getByLabel('Topic').fill(title)
    await page.getByLabel('Your learning goal').fill('Verify unsaved module drafts guard when switching to assessments.')
    await page.getByRole('button', { name: 'Save learning goal' }).click()
    await page.getByRole('button', { name: title }).click()

    await page.getByRole('button', { name: 'Generate outline' }).click()
    await expect(page.getByLabel('Edit your outline')).toBeVisible()
    await page.getByRole('button', { name: 'Approve outline' }).click()
    await expect(page.getByText('Outline approved')).toBeVisible()

    // Generate first module and accept it so Assessments view becomes available
    await page.getByRole('button', { name: 'Generate first module' }).click()
    await page.getByRole('button', { name: 'Accept module' }).click()
    await expect(page.getByRole('heading', { name: 'First principles' })).toBeVisible()

    // Generate Module 2 draft
    await page.getByRole('button', { name: 'Generate next module' }).first().click()
    await expect(page.getByLabel('Module title')).toHaveValue('Advanced application')

    // Make unsaved edits to Module 2 draft
    await page.getByLabel('Module title').fill('Unsaved Draft Edits in Module 2')
    await expect(page.getByRole('button', { name: 'Save draft changes' })).toBeEnabled()

    // Switch to Assessments section
    await page.getByRole('button', { name: 'Assessments', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Course assessments' })).toBeVisible()

    // Attempt to leave course via ← Your library: must trigger confirmation because unsaved module draft remains
    let libraryPromptTriggered = false
    page.once('dialog', async (dialog) => {
      libraryPromptTriggered = true
      expect(dialog.message()).toContain('unsaved module draft edits')
      await dialog.dismiss()
    })
    await page.getByRole('button', { name: '← Your library' }).click()
    expect(libraryPromptTriggered).toBe(true)

    // Verify still in course and draft edits are intact when returning to Modules
    await page.getByRole('button', { name: 'Modules (2)' }).click()
    await expect(page.getByLabel('Module title')).toHaveValue('Unsaved Draft Edits in Module 2')
    await expect(page.getByRole('button', { name: 'Save draft changes' })).toBeEnabled()

    // Now accept dialog to leave to library
    page.once('dialog', async (dialog) => {
      await dialog.accept()
    })
    await page.getByRole('button', { name: '← Your library' }).click()
    await expect(page.getByRole('heading', { name: 'What you’re learning' })).toBeVisible()
  })

  test('exit paths safety: confirms unsaved outline edits when leaving course', async ({ page }) => {
    const title = `Outline Exit ${crypto.randomUUID()}`
    await page.goto('/')
    await page.getByLabel('Topic').fill(title)
    await page.getByLabel('Your learning goal').fill('Verify unsaved outline changes guard on library exit.')
    await page.getByRole('button', { name: 'Save learning goal' }).click()
    await page.getByRole('button', { name: title }).click()

    // Generate outline
    await page.getByRole('button', { name: 'Generate outline' }).click()
    const outlineTextarea = page.getByLabel('Edit your outline')
    await expect(outlineTextarea).toBeVisible()

    // Make unsaved edits to outline without clicking 'Save changes' or 'Approve outline'
    await outlineTextarea.fill('Module 1: Custom Architecture Outline (Unsaved Edits)')

    // Attempt to leave course via ← Your library: must trigger confirmation
    let outlinePromptTriggered = false
    page.once('dialog', async (dialog) => {
      outlinePromptTriggered = true
      expect(dialog.message()).toContain('unsaved outline changes')
      await dialog.dismiss()
    })
    await page.getByRole('button', { name: '← Your library' }).click()
    expect(outlinePromptTriggered).toBe(true)

    // Verify still in course and outline edits remain intact
    await expect(outlineTextarea).toHaveValue('Module 1: Custom Architecture Outline (Unsaved Edits)')

    // Now accept dialog to exit to library
    page.once('dialog', async (dialog) => {
      await dialog.accept()
    })
    await page.getByRole('button', { name: '← Your library' }).click()
    await expect(page.getByRole('heading', { name: 'What you’re learning' })).toBeVisible()
  })

  test('F2 regression: updateAnswer does not trigger React state-during-render console error', async ({ page }) => {
    const consoleErrors: string[] = []
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text())
      }
    })

    const title = `Console Check ${crypto.randomUUID()}`
    await page.goto('/')
    await page.getByLabel('Topic').fill(title)
    await page.getByLabel('Your learning goal').fill('Verify no console errors on answer updates.')
    await page.getByRole('button', { name: 'Save learning goal' }).click()
    await page.getByRole('button', { name: title }).click()

    await page.getByRole('button', { name: 'Generate outline' }).click()
    await expect(page.getByLabel('Edit your outline')).toBeVisible()
    await page.getByRole('button', { name: 'Approve outline' }).click()
    await expect(page.getByText('Outline approved')).toBeVisible()

    await page.getByRole('button', { name: 'Generate first module' }).click()
    await page.getByRole('button', { name: 'Accept module' }).click()

    await page.getByRole('button', { name: 'Assessments', exact: true }).click()
    await page.getByRole('button', { name: '+ New assessment' }).click()
    await page.getByLabel('Title').fill('Console Warning Test')
    await page.getByRole('button', { name: 'Create assessment' }).click()
    await page.getByRole('button', { name: 'Start assessment' }).click()

    // Type into written answer input to trigger updateAnswer -> onAnswersChange
    const written = page.getByLabel('Your answer').first()
    await written.fill('First update')
    await written.fill('Second update with more characters')

    // Check multiple choice radio to trigger updateAnswer
    await page.getByLabel('A', { exact: true }).check()

    // Assert answers reflected in DOM
    await expect(written).toHaveValue('Second update with more characters')
    await expect(page.getByLabel('A', { exact: true })).toBeChecked()

    // Ensure no "Cannot update a component while rendering a different component" error occurred
    const renderPhaseErrors = consoleErrors.filter(
      (err) => err.includes('Cannot update a component') || err.includes('while rendering a different component')
    )
    expect(renderPhaseErrors).toEqual([])
  })

  test('timed assessment recovers from early active GET response and retries at remainingMs', async ({ page }) => {
    const title = `Early GET Course ${crypto.randomUUID()}`
    await page.goto('/')
    await page.getByLabel('Topic').fill(title)
    await page.getByLabel('Your learning goal').fill('Verify early GET retry logic.')
    await page.getByRole('button', { name: 'Save learning goal' }).click()
    await page.getByRole('button', { name: title }).click()

    await page.getByRole('button', { name: 'Generate outline' }).click()
    await expect(page.getByLabel('Edit your outline')).toBeVisible()
    await page.getByRole('button', { name: 'Approve outline' }).click()
    await expect(page.getByText('Outline approved')).toBeVisible()

    await page.getByRole('button', { name: 'Generate first module' }).click()
    await page.getByRole('button', { name: 'Accept module' }).click()

    await page.getByRole('button', { name: 'Assessments', exact: true }).click()
    await page.getByRole('button', { name: '+ New assessment' }).click()
    await page.getByLabel('Title').fill('Early Expiry Retry Test')
    await page.getByLabel(/Timed \(Fixed deadline/).check()
    await page.getByLabel('Duration unit').selectOption('seconds')
    await page.getByLabel('Duration', { exact: true }).fill('2')
    await page.getByRole('button', { name: 'Create assessment' }).click()

    await page.getByRole('button', { name: 'Start assessment' }).click()
    await expect(page.getByRole('timer')).toBeVisible()

    // Type an answer
    await page.getByLabel('Your answer').first().fill('Early GET preserved draft text.')

    // Intercept GET /api/courses/*/assessments/*
    // When the deadline GET arrives, if the server returns expired, intercept it once
    // and return an active response with deadlineAt slightly in the future (300ms from now)
    let simulatedEarlyCount = 0
    await page.route('**/api/courses/*/assessments/*', async (route) => {
      const request = route.request()
      if (request.method() === 'GET') {
        const response = await route.fetch()
        const json = await response.json()
        if (json.assessment && json.assessment.status === 'expired' && simulatedEarlyCount === 0) {
          simulatedEarlyCount++
          const now = Date.now()
          const simulated = {
            ...json,
            assessment: {
              ...json.assessment,
              status: 'active',
              serverNow: now,
              deadlineAt: now + 300,
              submittedAt: null,
              finalizedAt: null,
            },
          }
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(simulated),
          })
          return
        }
      }
      await route.continue()
    })

    // Verify the UI recovers from the early active response, resynchronizes, retries, and finalizes
    await expect(page.getByRole('heading', { name: 'Assessment Finalized on Expiry' })).toBeVisible({ timeout: 10000 })
    expect(simulatedEarlyCount).toBe(1)
    await expect(page.getByText('Early GET preserved draft text.')).toBeVisible()
    await expect(page.getByText('Unsaved draft at expiry')).toBeVisible()
  })

  test('timed assessment displays retry banner on network failure during deadline GET and recovers on retry', async ({ page }) => {
    const title = `Network Failure Course ${crypto.randomUUID()}`
    await page.goto('/')
    await page.getByLabel('Topic').fill(title)
    await page.getByLabel('Your learning goal').fill('Verify network failure retry.')
    await page.getByRole('button', { name: 'Save learning goal' }).click()
    await page.getByRole('button', { name: title }).click()

    await page.getByRole('button', { name: 'Generate outline' }).click()
    await expect(page.getByLabel('Edit your outline')).toBeVisible()
    await page.getByRole('button', { name: 'Approve outline' }).click()
    await expect(page.getByText('Outline approved')).toBeVisible()

    await page.getByRole('button', { name: 'Generate first module' }).click()
    await page.getByRole('button', { name: 'Accept module' }).click()

    await page.getByRole('button', { name: 'Assessments', exact: true }).click()
    await page.getByRole('button', { name: '+ New assessment' }).click()
    await page.getByLabel('Title').fill('Network Failure Test')
    await page.getByLabel(/Timed \(Fixed deadline/).check()
    await page.getByLabel('Duration unit').selectOption('seconds')
    await page.getByLabel('Duration', { exact: true }).fill('2')
    await page.getByRole('button', { name: 'Create assessment' }).click()

    await page.getByRole('button', { name: 'Start assessment' }).click()
    await expect(page.getByRole('timer')).toBeVisible()

    // Type an answer
    await page.getByLabel('Your answer').first().fill('Network retry test text.')

    // Intercept deadline GET and abort it once
    let failedOnce = false
    await page.route('**/api/courses/*/assessments/*', async (route) => {
      if (route.request().method() === 'GET' && !failedOnce) {
        failedOnce = true
        await route.abort('failed')
        return
      }
      await route.continue()
    })

    // Expect the failure banner to be visible
    await expect(page.getByRole('alert')).toContainText(/Failed to finalize automatically/i, { timeout: 10000 })
    expect(failedOnce).toBe(true)

    // Unroute so subsequent fetch works
    await page.unroute('**/api/courses/*/assessments/*')

    // Click retry
    await page.getByRole('button', { name: 'Retry' }).click()

    // Now finalizes cleanly
    await expect(page.getByRole('heading', { name: 'Assessment Finalized on Expiry' })).toBeVisible({ timeout: 10000 })
    await expect(page.getByText('Network retry test text.')).toBeVisible()
  })
})
