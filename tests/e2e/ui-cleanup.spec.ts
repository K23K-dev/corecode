import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

const problemId = 'python-core-normalize-text-01';
const removedEditorMetadata = '.save-status, .editor-auto, .editor-filebar';
const removedLibraryMetadata = '.pl-deck-summary, .pl-preferences-note, .pl-course-count';

async function expectNoOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

async function expectCode(page: Page, code: string) {
  await expect
    .poll(() =>
      page
        .locator('.editor-area .cm-line')
        .evaluateAll((nodes) => nodes.map((node) => node.textContent ?? '').join('\n')),
    )
    .toBe(code);
}

test('library uses a compact centered width and clearer progress bars without footnotes', async ({
  page,
}) => {
  await page.goto('/#library');
  const library = page.getByRole('main', { name: 'Practice library' });
  await expect(library).toBeVisible();
  await expect(library.locator('.pl-content')).toHaveCSS('max-width', '870px');
  await expect(library.locator(removedLibraryMetadata)).toHaveCount(0);
  const progressBars = library.locator('.pl-topic-progress');
  await expect(progressBars).toHaveCount(14);
  for (const progressBar of await progressBars.all())
    await expect(progressBar).toHaveCSS('height', '8px');
  await expect(page.getByTestId('library-solved-count')).toHaveText('0/359');
  await expect(page.getByTestId('library-starred-count')).toHaveText('0');
  const bounds = await library.locator('.pl-layout').boundingBox();
  expect(bounds).not.toBeNull();
  expect(
    Math.abs(bounds!.x - (page.viewportSize()!.width - bounds!.width) / 2),
  ).toBeLessThanOrEqual(1);
  await expectNoOverflow(page);
});

test('problem tables order their columns and provide sortable headers and direct solutions', async ({
  page,
}) => {
  const draft = '# keep this draft when opening a solution\ndef normalize_text(text):\n    pass\n';
  await page.goto(`/#${problemId}`);
  const editor = page.locator('.editor-area').getByRole('textbox');
  await editor.click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.insertText(draft);
  await expectCode(page, draft);
  await expect(page.locator('.app')).toHaveAttribute('data-save-state', 'saved');
  await page.getByRole('link', { name: 'Code Practice library', exact: true }).click();
  const library = page.getByRole('main', { name: 'Practice library' });
  await library.getByRole('button', { name: /^All problems/ }).click();
  const table = library.getByRole('table', { name: 'All problems', exact: true });
  await expect(table.locator('thead th')).toHaveText([
    'Status',
    'Star',
    'Problem',
    'Difficulty',
    'Solution',
  ]);
  const row = table.locator(`tr[data-problem-id="${problemId}"]`);
  const cells = row.locator('td');
  await expect(cells).toHaveCount(5);
  await expect(cells.nth(0).getByRole('button', { name: /^Mark .* complete$/ })).toBeVisible();
  await expect(
    cells.nth(1).getByRole('button', { name: 'Star Normalize text', exact: true }),
  ).toBeVisible();
  await expect(
    cells.nth(2).getByRole('button', { name: 'Normalize text', exact: true }),
  ).toBeVisible();
  await expect(cells.nth(2).getByRole('button', { name: 'Normalize text', exact: true })).toHaveCSS(
    'font-weight',
    '600',
  );
  await expect(cells.nth(3)).toHaveText('Easy');
  const problemHeader = table.locator('thead th').nth(2);
  await problemHeader.getByRole('button').click();
  await expect(problemHeader).toHaveAttribute('aria-sort', 'ascending');
  const titles = await table.locator('tbody .pl-problem-link').allTextContents();
  expect(titles).toEqual([...titles].sort((left, right) => left.localeCompare(right)));
  await problemHeader.getByRole('button').click();
  await expect(problemHeader).toHaveAttribute('aria-sort', 'descending');
  await expect(table.locator('tbody .pl-problem-link')).toHaveText([...titles].reverse());
  const difficultyHeader = table.locator('thead th').nth(3);
  await difficultyHeader.getByRole('button').click();
  await expect(difficultyHeader).toHaveAttribute('aria-sort', 'ascending');
  const difficulties = await table.locator('tbody .pl-difficulty').allTextContents();
  const order = ['Easy', 'Medium', 'Hard'];
  expect(difficulties).toEqual(
    [...difficulties].sort((left, right) => order.indexOf(left) - order.indexOf(right)),
  );
  await cells
    .nth(4)
    .getByRole('button', { name: 'View solution for Normalize text', exact: true })
    .click();
  await expect(page).toHaveURL(new RegExp(`#${problemId}$`));
  await expect(page.getByRole('tab', { name: 'Solution', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.locator('.reference-code')).toContainText('return text.strip().lower()');
  await expectCode(page, draft);
  await expect(page.locator(removedEditorMetadata)).toHaveCount(0);
});

test('workspace retains useful controls and result details without editor metadata or result boilerplate', async ({
  page,
}) => {
  // Stub only this UI test's runner response; no learner code is executed.
  await page.route('**/api/run', (route) =>
    route.fulfill({
      json: {
        cases: [
          {
            name: 'Rectangle example',
            input: '(3, 4)',
            expected: '(12, 14)',
            actual: '(12, 14)',
            passed: true,
          },
        ],
        stdout: '',
        durationMs: 123,
      },
    }),
  );
  await page.goto('/#python-core-rectangle-metrics-01');
  await expect(page.locator('.app')).toHaveAttribute('data-save-state', 'saved');
  await expect(page.locator(removedEditorMetadata)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Reset', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Submit', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Run example', exact: true }).click();
  await expect(page.getByText('Example passed', { exact: true })).toBeVisible();
  await expect(page.locator('.result-heading')).toContainText('1 / 1 cases passed');
  await expect(page.locator('.result-heading > small, .result-note')).toHaveCount(0);
  await expect(page.locator('.case-detail')).toContainText('(12, 14)');
  await expect(page.getByRole('button', { name: 'Case 1: passed', exact: true })).toBeVisible();
});

for (const width of [320, 390]) {
  test(`cleaned-up library and solution view fit a ${width}px mobile viewport`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto('/#library');
    const library = page.getByRole('main', { name: 'Practice library' });
    await expect(library).toBeVisible();
    await expect(library.locator(removedLibraryMetadata)).toHaveCount(0);
    await expectNoOverflow(page);
    await library.getByRole('button', { name: /^All problems/ }).click();
    await expect(
      library.getByRole('table', { name: 'All problems', exact: true }).locator('thead th'),
    ).toHaveText(['Status', 'Star', 'Problem', 'Difficulty', 'Solution']);
    await expectNoOverflow(page);
    await library
      .getByRole('searchbox', { name: 'Search problems', exact: true })
      .fill('Normalize text');
    await library
      .getByRole('button', { name: 'View solution for Normalize text', exact: true })
      .click();
    await expect(page.getByRole('tab', { name: 'Solution', exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(page.locator('.reference-code')).toBeVisible();
    await expectNoOverflow(page);
    await page.getByRole('button', { name: 'Code & results', exact: true }).click();
    await expect(page.locator('.editor-area .cm-editor')).toBeVisible();
    await expect(page.locator(removedEditorMetadata)).toHaveCount(0);
    await expectNoOverflow(page);
  });
}
