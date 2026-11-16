import { test, expect } from '@playwright/test'

test.describe('contextual tutor', () => {
  test('learner asks about a lesson, selects attempts, inspects exact context without leakage, and reloads persisted conversation', async ({
    page,
    context,
  }, info) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    const title = `Tutor Test ${crypto.randomUUID()}`

    await page.goto('/')
    await page.getByLabel('Topic').fill(title)
    await page.getByLabel('Your learning goal').fill('Learn contextual tutoring with attempt selection.')
    await page.getByRole('button', { name: 'Save learning goal' }).click()
    await page.getByRole('button', { name: title }).click()

    // Generate outline and approve
    await page.getByRole('button', { name: 'Generate outline' }).click()
    await expect(page.getByLabel('Edit your outline')).toBeVisible()
    await page.getByRole('button', { name: 'Approve outline' }).click()
    await expect(page.getByText('Outline approved')).toBeVisible()

    // Generate first module and accept
    await page.getByRole('button', { name: 'Generate first module' }).click()
    await expect(page.getByLabel('Title', { exact: true })).toHaveValue('Foundations')
    await page.getByRole('button', { name: 'Accept module' }).click()
    await expect(page.getByRole('heading', { name: 'Foundations' })).toBeVisible()

    // Complete Exercise 1 (Multiple choice) -> Attempt 1
    await page.getByLabel('A', { exact: true }).check()
    await page.getByRole('button', { name: 'Check answer' }).first().click()
    await expect(page.getByText('Correct. A is correct.')).toBeVisible()

    // Complete Exercise 2 (Written answer) -> Attempt 2
    await page.getByLabel('Your answer').first().fill('My specific unselected explanation')
    await page.getByRole('button', { name: 'Check answer' }).nth(1).click()
    await expect(page.getByText('Consider the core idea and add an example.')).toBeVisible()

    // Open Tutor on Lesson 1
    const askBtn = page.getByRole('button', { name: 'Ask about this lesson' }).first()
    await expect(askBtn).toBeVisible()
    await askBtn.click()

    const tutorSection = page.locator('.lesson-tutor-container')
    await expect(tutorSection).toBeVisible()
    await expect(tutorSection.getByRole('heading', { name: /Ask about: Foundations/ })).toBeVisible()

    // Verify privacy and context notice
    const privacyNotice = tutorSection.locator('.tutor-privacy-notice')
    await expect(privacyNotice).toContainText(
      'The tutor answers questions about this lesson using only the lesson text'
    )
    await expect(privacyNotice).toContainText(
      'Prior turns may repeat information from previously selected attempts even when the current selection changes'
    )

    // Verify attempt selection list contains both attempts with correct badges and text
    const attemptCards = tutorSection.locator('.tutor-attempt-card')
    await expect(attemptCards).toHaveCount(2)
    await expect(attemptCards.first()).toContainText('Exercise 1')
    await expect(attemptCards.first()).toContainText('Correct')
    await expect(attemptCards.nth(1)).toContainText('Exercise 2')
    await expect(attemptCards.nth(1)).toContainText('AI feedback · advisory')

    // Explicitly select ONLY Attempt 1 (leave Attempt 2 unselected)
    await attemptCards.first().locator('input[type="checkbox"]').check()
    await expect(attemptCards.first()).toHaveClass(/selected/)
    await expect(attemptCards.nth(1).locator('input[type="checkbox"]')).not.toBeChecked()

    // Check pre-send disclosure
    const disclosure = tutorSection.locator('.tutor-preview-disclosure')
    await expect(disclosure).toContainText('1 of 2 module attempts selected')
    await expect(disclosure).toContainText('0 prior turns (new conversation)')
    await expect(disclosure).toContainText('sourceIds: []')

    await page.screenshot({
      path: `.tmp/nori-ui-agy/tutor-open-${info.project.name}.png`,
      fullPage: true,
    })

    // Ask first question
    const questionInput = tutorSection.getByLabel('Your question about this lesson')
    await questionInput.fill('Can you explain why option A was the right approach here?')
    await tutorSection.getByRole('button', { name: 'Ask tutor' }).click()

    // Verify assistant reply appears
    await expect(
      tutorSection.getByText('Tutor response: Here is an explanation connecting your attempt')
    ).toBeVisible()

    // Inspect sent context details
    const contextDetails = tutorSection.locator('.tutor-context-details')
    await expect(contextDetails).toBeVisible()
    await contextDetails.locator('summary').click()

    const inspector = contextDetails.locator('.context-inspector-content')
    await expect(inspector).toBeVisible()
    await expect(inspector).toContainText('Lesson Title: Foundations')
    await expect(inspector).toContainText('Lesson Text Sent:')
    await expect(inspector).toContainText('Learn the foundations.')
    await expect(inspector).toContainText('Exercise 1: Choose the correct answer')
    await expect(inspector).toContainText('Answer: A')
    await expect(inspector).toContainText('Feedback: Correct. A is correct.')

    // CRITICAL: verify unselected Attempt 2 text is strictly NOT present in sent context!
    await expect(inspector).not.toContainText('My specific unselected explanation')
    await expect(inspector).toContainText('Empty (sourceIds: [])')
    await expect(inspector).toContainText('Prior Conversation Sent (0 included):')
    await expect(inspector).toContainText('None (initial turn for this lesson)')
    await expect(inspector).toContainText('0 turns dropped (no trimming needed)')

    await page.screenshot({
      path: `.tmp/nori-ui-agy/tutor-response-${info.project.name}.png`,
      fullPage: true,
    })

    // Ask follow-up question: verify disclosure updates prior turns count stating up to N and subject to trimming
    await expect(disclosure).toContainText(
      'Up to 2 prior turns may be included (subject to trimming to fit context limit)'
    )
    await questionInput.fill('How does this foundation apply to advanced topics?')
    await tutorSection.getByRole('button', { name: 'Ask tutor' }).click()

    // Verify 4 turns exist in the conversation
    const turns = tutorSection.locator('.tutor-turn-card')
    await expect(turns).toHaveCount(4)

    // Inspect second assistant response: confirms actual count and rendered history entries with roles and text
    const secondInspector = turns.nth(3).locator('.context-inspector-content')
    await turns.nth(3).locator('.tutor-context-details summary').click()
    await expect(secondInspector).toContainText('Prior Conversation Sent (2 included):')
    const historyItems = secondInspector.locator('.inspector-history-item')
    await expect(historyItems).toHaveCount(2)
    await expect(historyItems.first()).toContainText('User:')
    await expect(historyItems.first()).toContainText(
      'Can you explain why option A was the right approach here?'
    )
    await expect(historyItems.nth(1)).toContainText('Assistant / Tutor:')
    await expect(historyItems.nth(1)).toContainText(
      'Tutor response: Here is an explanation connecting your attempt to the lesson principles.'
    )

    // Reopen course to verify persistence per lesson across page reloads
    await page.reload()
    await page.getByRole('button', { name: title }).click()
    await page.getByRole('button', { name: 'Ask about this lesson' }).first().click()

    await expect(tutorSection.locator('.tutor-turn-card')).toHaveCount(4)
    await expect(
      tutorSection.getByText('Tutor response: Here is an explanation connecting your attempt').first()
    ).toBeVisible()
  })

  test('learner creates a reviewable proposal and verifies accepted course remains immutable', async ({
    page,
    context,
  }, info) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    const title = `Proposal Test ${crypto.randomUUID()}`

    await page.goto('/')
    await page.getByLabel('Topic').fill(title)
    await page.getByLabel('Your learning goal').fill('Verify proposal generation and immutability.')
    await page.getByRole('button', { name: 'Save learning goal' }).click()
    await page.getByRole('button', { name: title }).click()

    // Outline and Module 1 setup
    await page.getByRole('button', { name: 'Generate outline' }).click()
    await page.getByRole('button', { name: 'Approve outline' }).click()
    await page.getByRole('button', { name: 'Generate first module' }).click()
    await page.getByRole('button', { name: 'Accept module' }).click()

    // Open Tutor
    await page.getByRole('button', { name: 'Ask about this lesson' }).click()
    const tutorSection = page.locator('.lesson-tutor-container')
    await expect(tutorSection).toBeVisible()

    // Toggle Proposal mode
    await tutorSection
      .getByLabel('Request reviewable proposal for future material')
      .check()
    await expect(tutorSection.getByRole('button', { name: 'Request proposal' })).toBeVisible()

    // Send proposal request
    await tutorSection
      .getByLabel('Your question about this lesson')
      .fill('Suggest improvements for the next module.')
    await tutorSection.getByRole('button', { name: 'Request proposal' }).click()

    // Verify reviewable proposal section appears
    const proposalsSection = tutorSection.locator('.tutor-proposals-section')
    await expect(proposalsSection).toBeVisible()
    await expect(proposalsSection.locator('.proposals-disclaimer')).toContainText(
      'Advisory text only: Proposals are suggestions generated by the tutor. They are never applied automatically'
    )

    const proposalCard = proposalsSection.locator('.tutor-proposal-card')
    await expect(proposalCard).toHaveCount(1)
    await expect(proposalCard).toContainText(
      'Advisory Proposal: Consider introducing a practical debugging exercise in the next module.'
    )

    // Test clipboard copy
    const copyBtn = proposalCard.getByRole('button', { name: 'Copy proposal' })
    await copyBtn.click()
    await expect(proposalCard.getByRole('button', { name: /Copied to clipboard/ })).toBeVisible()

    // Confirm that accepted module content is completely intact and unchanged
    await expect(page.getByRole('heading', { name: 'Foundations', exact: true })).toBeVisible()
    await expect(page.locator('.lesson-body').filter({ hasText: 'Learn the foundations.' })).toBeVisible()

    await page.screenshot({
      path: `.tmp/nori-ui-agy/tutor-proposal-${info.project.name}.png`,
      fullPage: true,
    })
  })

  test('tutor handles provider failures gracefully and retains unsent question in textarea', async ({
    page,
  }) => {
    const title = `Error Retention ${crypto.randomUUID()}`

    await page.goto('/')
    await page.getByLabel('Topic').fill(title)
    await page.getByLabel('Your learning goal').fill('Test tutor error handling and input retention.')
    await page.getByRole('button', { name: 'Save learning goal' }).click()
    await page.getByRole('button', { name: title }).click()

    await page.getByRole('button', { name: 'Generate outline' }).click()
    await page.getByRole('button', { name: 'Approve outline' }).click()
    await page.getByRole('button', { name: 'Generate first module' }).click()
    await page.getByRole('button', { name: 'Accept module' }).click()

    // Open tutor
    await page.getByRole('button', { name: 'Ask about this lesson' }).click()
    const tutorSection = page.locator('.lesson-tutor-container')
    const questionInput = tutorSection.getByLabel('Your question about this lesson')

    // Fill message that triggers fixture 500 error
    const testMessage = 'Please fail tutor provider for this test'
    await questionInput.fill(testMessage)
    await tutorSection.getByRole('button', { name: 'Ask tutor' }).click()

    // Expect visible error banner
    const errorBanner = tutorSection.locator('.tutor-error')
    await expect(errorBanner).toBeVisible()

    // Crucial check: verify textarea still holds the typed message!
    await expect(questionInput).toHaveValue(testMessage)
  })

  test('exit and section switching safety: confirms leaving with unsent tutor question and retains draft across toggle', async ({
    page,
  }) => {
    const title = `Tutor Exit Safety ${crypto.randomUUID()}`

    await page.goto('/')
    await page.getByLabel('Topic').fill(title)
    await page.getByLabel('Your learning goal').fill('Verify unsent tutor question guards.')
    await page.getByRole('button', { name: 'Save learning goal' }).click()
    await page.getByRole('button', { name: title }).click()

    await page.getByRole('button', { name: 'Generate outline' }).click()
    await page.getByRole('button', { name: 'Approve outline' }).click()
    await page.getByRole('button', { name: 'Generate first module' }).click()
    await page.getByRole('button', { name: 'Accept module' }).click()

    // Open tutor and type an unsent question
    await page.getByRole('button', { name: 'Ask about this lesson' }).click()
    const tutorSection = page.locator('.lesson-tutor-container')
    const questionInput = tutorSection.getByLabel('Your question about this lesson')
    await questionInput.fill('My unsent question draft for this lesson')

    // Close and reopen tutor on the same lesson: input must be retained!
    await page.getByRole('button', { name: 'Close tutor' }).click()
    await expect(tutorSection).not.toBeVisible()

    await page.getByRole('button', { name: 'Ask about this lesson' }).click()
    await expect(tutorSection).toBeVisible()
    await expect(questionInput).toHaveValue('My unsent question draft for this lesson')

    // Attempt to switch to Assessments tab: must trigger confirmation
    let switchPromptTriggered = false
    page.once('dialog', async (dialog) => {
      switchPromptTriggered = true
      expect(dialog.message()).toContain('unsent tutor question')
      await dialog.dismiss()
    })
    await page.getByRole('button', { name: 'Assessments', exact: true }).click()
    expect(switchPromptTriggered).toBe(true)

    // Verify still in modules view and question is intact
    await expect(questionInput).toHaveValue('My unsent question draft for this lesson')

    // Attempt to exit to Library: must trigger confirmation
    let exitPromptTriggered = false
    page.once('dialog', async (dialog) => {
      exitPromptTriggered = true
      expect(dialog.message()).toContain('unsent tutor question')
      await dialog.dismiss()
    })
    await page.getByRole('button', { name: '← Your library' }).click()
    expect(exitPromptTriggered).toBe(true)

    // Now accept dialog to exit
    page.once('dialog', async (dialog) => {
      await dialog.accept()
    })
    await page.getByRole('button', { name: '← Your library' }).click()
    await expect(page.getByRole('heading', { name: 'What you’re learning' })).toBeVisible()
  })
})
