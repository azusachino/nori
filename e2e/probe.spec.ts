import { expect, test } from '@playwright/test'

test('probe', async ({ page }, info) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(process.env.PROBE_ROUTE || '/')
  await expect(page.getByRole('heading', { name: 'What you’re learning' })).toBeVisible()
  await page.screenshot({ path: info.outputPath('probe.png'), fullPage: true })
  console.log(JSON.stringify({ title: await page.title(), url: page.url(), errors }))
  console.log(await page.locator('body').ariaSnapshot())
})
