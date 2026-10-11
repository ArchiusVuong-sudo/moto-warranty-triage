import { expect, test } from '@playwright/test';

test('dealer files a claim, the agent triages it in replay mode, an engineer approves with an edit', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto('/');
  await expect(page.getByText('Synthetic data')).toBeVisible();
  await expect(page.getByText('Replay mode')).toBeVisible();
  await expect(page.getByTestId('inbox-row').first()).toBeVisible();
  await expect(page.getByTestId('health-circuit')).toContainText('Closed');

  await page.getByTestId('open-file-claim').click();
  await page.locator('[data-scenario="cell-imbalance"]').click();
  await expect(page.getByTestId('request-preview')).toContainText('Idempotency-Key');
  await page.getByTestId('submit-claim').click();
  await expect(page.getByTestId('file-response').first()).toContainText('201');
  await page.getByTestId('send-again').click();
  await expect(page.getByTestId('file-response').nth(1)).toContainText('Idempotent-Replayed: true');
  await expect(page.getByTestId('file-response').nth(1)).toContainText('no duplicate filed');
  await page.getByTestId('open-claim').click();

  const claimNumber = (await page.getByTestId('claim-number').textContent())!.trim();
  await expect(page.locator(`[data-testid="inbox-row"][data-claim-number="${claimNumber}"]`)).toHaveCount(1);

  // Tool spans stream into the timeline, then the triage card appears.
  await expect(page.locator('[data-testid="timeline-span"][data-kind="tool"]').first()).toBeVisible();
  await expect(page.getByTestId('triage-card')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('root-cause-code')).toHaveText('BATTERY_CELL_IMBALANCE');
  await expect(page.getByTestId('warranty-decision')).toContainText('Covered under W2');
  await expect(page.locator('[data-testid="timeline-span"][data-kind="tool"]')).toHaveCount(5);

  await page.getByTestId('labour-input').fill('2.0');
  await expect(page.getByTestId('approve')).toHaveText(/Approve with edits/);
  await page.getByTestId('approve').click();

  const row = page.locator(`[data-testid="inbox-row"][data-claim-number="${claimNumber}"]`);
  await expect(row).toContainText('Approved', { timeout: 10_000 });
  await expect(page.locator('[data-testid="timeline-span"][data-kind="decision"]')).toContainText('TriageApproved with 1 edit');
  expect(errors).toEqual([]);
});

test('a corrupt export is answered 422 and lands in the dead-letter list', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('open-file-claim').click();
  await page.locator('[data-scenario="corrupt-export"]').click();
  await page.getByTestId('submit-claim').click();
  await page.getByTestId('open-claim').click();
  await expect(page.getByTestId('dead-reason')).toContainText('422', { timeout: 20_000 });
  await expect(page.getByTestId('health-dlq')).toContainText('1');
  await page.getByTestId('open-drills').click();
  await expect(page.getByTestId('dead-letters')).toContainText('Ride log failed validation');
});
