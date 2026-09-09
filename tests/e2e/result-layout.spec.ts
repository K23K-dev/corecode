import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import type { RunResult } from '../../src/lib/runner';

const problemId = 'python-core-rectangle-metrics-01';
const cases = [
  { name: 'Rectangle', input: '(3, 4)', expected: '(12, 14)', actual: '(12, 14)', passed: true },
  { name: 'Zero width', input: '(0, 7)', expected: '(0, 14)', actual: '(0, 14)', passed: true },
  {
    name: 'Fractional dimensions',
    input: '(2.5, 4.0)',
    expected: '(10.0, 13.0)',
    actual: '(10.0, 13.0)',
    passed: true,
  },
];

async function expectStackedValues(page: Page, labels: string[]) {
  const detail = page.locator('.case-detail');
  const blocks = detail.locator('.value-block');
  await expect(blocks.locator(':scope > span')).toHaveText(labels);
  for (const outputBox of await blocks.locator('pre').all()) {
    await expect(outputBox).toHaveCSS('background-color', 'rgb(32, 32, 32)');
    await expect(outputBox).toHaveCSS('font-size', '16px');
    await expect(outputBox).toHaveCSS('line-height', '24px');
  }
  const layout = await detail.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return {
      x: bounds.x,
      width: bounds.width,
      blocks: [...element.querySelectorAll('.value-block')].map((block) => {
        const rect = block.getBoundingClientRect();
        return { x: rect.x, top: rect.top, bottom: rect.bottom, width: rect.width };
      }),
    };
  });
  for (const [index, block] of layout.blocks.entries()) {
    expect(Math.abs(block.x - layout.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(block.width - layout.width)).toBeLessThanOrEqual(1);
    expect(block.bottom).toBeGreaterThan(block.top);
    if (index > 0) expect(block.top).toBeGreaterThanOrEqual(layout.blocks[index - 1].bottom);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

for (const width of [1440, 390]) {
  test(`graded results retain case controls with full-width ordered values at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    // Only layout scenarios are stubbed. workspace.spec.ts separately executes
    // real Python pass/fail/custom runs against these same value-label contracts.
    let result: RunResult = { cases, stdout: 'checked rectangle dimensions\n', durationMs: 1 };
    await page.route('**/api/run', (route) => route.fulfill({ json: result }));
    await page.goto(`/#${problemId}`);
    if (width < 700)
      await page.getByRole('button', { name: 'Code & results', exact: true }).click();
    await page.getByRole('button', { name: 'Submit', exact: true }).click();
    await expect(page.getByText('Accepted', { exact: true })).toBeVisible();
    await expect(page.locator('.result-heading')).toContainText('3 / 3 cases passed');
    await expectStackedValues(page, ['Input', 'Your Output', 'Expected Output']);
    await expect(page.locator('.case-detail .case-name')).toHaveCount(0);
    await expect(page.locator('.case-detail .value-block pre')).toHaveText([
      '(3, 4)',
      '(12, 14)',
      '(12, 14)',
    ]);
    await expect(page.locator('.case-detail .correct-output')).toHaveCount(1);
    await expect(page.locator('.correct-output pre')).toHaveCSS(
      'border-left-color',
      'rgb(74, 173, 104)',
    );
    await expect(page.getByRole('button', { name: 'Case 1: passed', exact: true })).toHaveAttribute(
      'title',
      'Rectangle',
    );
    await expect(page.locator('.stdout summary')).toHaveText('Console output');
    await expect(page.locator('.stdout pre')).toHaveText('checked rectangle dimensions\n');
    await page.screenshot({
      path: testInfo.outputPath(`passed-results-${width}px.png`),
      fullPage: true,
    });
    await page.locator('.expected-output pre').scrollIntoViewIfNeeded();
    await expect(page.locator('.expected-output pre')).toBeInViewport({ ratio: 1 });
    await page.screenshot({
      path: testInfo.outputPath(`passed-results-values-${width}px.png`),
      fullPage: true,
    });

    await page.getByRole('button', { name: 'Case 2: passed', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Case 2: passed', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(page.locator('.case-detail .value-block pre')).toHaveText([
      '(0, 7)',
      '(0, 14)',
      '(0, 14)',
    ]);

    result = {
      cases: [{ ...cases[0], actual: '(0, 0)', passed: false }, ...cases.slice(1)],
      stdout: '',
      durationMs: 1,
    };
    await page.getByRole('button', { name: 'Submit', exact: true }).click();
    await expect(page.getByText('Not quite yet', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Case 1: failed', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expectStackedValues(page, ['Input', 'Your Output', 'Expected Output']);
    await expect(page.locator('.case-detail .value-block pre')).toHaveText([
      '(3, 4)',
      '(0, 0)',
      '(12, 14)',
    ]);
    await expect(page.locator('.case-detail .wrong-output')).toHaveCount(1);
    await expect(page.locator('.case-detail .correct-output')).toHaveCount(0);
    await expect(page.locator('.case-detail .expected-output')).toHaveCount(1);
    await expect(page.locator('.wrong-output pre')).toHaveCSS(
      'border-left-color',
      'rgb(225, 100, 112)',
    );
    await expect(page.locator('.expected-output pre')).toHaveCSS(
      'border-left-color',
      'rgb(74, 173, 104)',
    );
    await expect(page.locator('.stdout')).toHaveCount(0);

    result = {
      cases: [
        {
          ...cases[0],
          actual: undefined,
          passed: false,
          error: 'ZeroDivisionError: division by zero',
        },
        ...cases.slice(1),
      ],
      stdout: '',
      durationMs: 1,
    };
    await page.getByRole('button', { name: 'Submit', exact: true }).click();
    await expect(page.locator('.case-detail .wrong-output')).toContainText(
      'ZeroDivisionError: division by zero',
    );
    await expectStackedValues(page, ['Input', 'Error', 'Expected Output']);
    await expect(page.locator('.app')).toHaveAttribute('data-save-state', 'saved');
  });
}

test('custom results stay ungraded and runner failures remain actionable', async ({ page }) => {
  // Custom mode must remain neutral even if a runner supplies grading fields.
  let result: RunResult = {
    cases: [
      {
        name: 'Custom input',
        input: '(3, 4)',
        actual: '(12, 14)',
        expected: '(12, 14)',
        passed: true,
      },
    ],
    stdout: '',
    durationMs: 1,
  };
  await page.route('**/api/run', (route) => route.fulfill({ json: result }));
  await page.goto(`/#${problemId}`);
  await page.getByRole('button', { name: 'Console', exact: true }).click();
  await page.getByRole('tab', { name: 'Custom input', exact: true }).click();
  await page.getByLabel('Function arguments', { exact: true }).fill('(3, 4)');
  await page.getByRole('button', { name: 'Run input', exact: true }).click();
  await expect(page.getByText('Custom run', { exact: true })).toBeVisible();
  await expect(page.getByText('Not graded', { exact: true })).toBeVisible();
  await expectStackedValues(page, ['Input', 'Your Output']);
  await expect(page.locator('.case-tabs')).toHaveCount(0);
  await expect(
    page.locator('.case-detail .correct-output, .case-detail .wrong-output'),
  ).toHaveCount(0);
  await expect(page.locator('.case-detail .value-block').nth(1).locator('pre')).toHaveCSS(
    'border-left-color',
    'rgba(0, 0, 0, 0)',
  );
  await expect(page.locator('.result-heading')).not.toHaveClass(/success|failure/);
  await expect(page.locator('.solved-label')).toHaveCount(0);

  result = {
    cases: [],
    stdout: '',
    durationMs: 1,
    error: 'The isolated runner is unavailable. Restart the local runner, then try again.',
  };
  await page.getByRole('button', { name: 'Run example', exact: true }).click();
  const error = page.getByRole('alert').filter({ hasText: 'Run stopped' });
  await expect(error).toContainText(
    'The isolated runner is unavailable. Restart the local runner, then try again.',
  );
  await expect(error).toContainText('This run has not been marked as solved.');
  await expect(page.locator('.case-detail')).toHaveCount(0);
  await expect(page.locator('.solved-label')).toHaveCount(0);
});
