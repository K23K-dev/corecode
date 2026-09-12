import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import type { RunResult } from '../../src/lib/practice-runner';

const removedEditorMetadata = '.save-status, .editor-auto, .editor-filebar';

test.describe('Library presentation', () => {
  const problemId = 'python-core-normalize-text-01';
  const removedLibraryMetadata = '.pl-deck-summary, .pl-preferences-note, .pl-course-count';

  async function expectNoOverflow(page: Page) {
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
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
    catalog,
  }) => {
    await page.goto('/#library');
    const library = page.getByRole('main', { name: 'Practice library' });
    await expect(library).toBeVisible();
    await expect(library.locator('.pl-content')).toHaveCSS('max-width', '870px');
    await expect(library.locator(removedLibraryMetadata)).toHaveCount(0);
    const progressBars = library.locator('.pl-topic-progress');
    await expect(progressBars).toHaveCount(catalog.decks.length);
    for (const progressBar of await progressBars.all())
      await expect(progressBar).toHaveCSS('height', '8px');
    await expect(page.getByTestId('library-solved-count')).toHaveText(
      `0/${catalog.exercises.length}`,
    );
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
    const draft =
      '# keep this draft when opening a solution\ndef normalize_text(text):\n    pass\n';
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
    await expect(
      cells.nth(2).getByRole('button', { name: 'Normalize text', exact: true }),
    ).toHaveCSS('font-weight', '600');
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
});

test.describe('Editor typography', () => {
  test('problem tabs retain the reference text and icon scale across viewport sizes', async ({
    page,
  }) => {
    await page.goto('/#python-core-flatten-grid-01');
    const tabs = page.getByRole('tablist', { name: 'Problem details' }).getByRole('tab');

    for (const width of [1440, 980, 390, 320]) {
      await page.setViewportSize({ width, height: 1000 });
      await expect(tabs).toHaveCount(3);
      for (const tab of await tabs.all()) {
        await expect(tab).toHaveCSS('font-size', '14px');
        await expect(tab).toHaveCSS('font-weight', '600');
        await expect(tab).toHaveCSS('min-height', '40px');
        await expect(tab.locator('svg')).toHaveCSS('width', '16px');
        await expect(tab.locator('svg')).toHaveCSS('height', '16px');
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
    }
  });

  test('editable and reference editors have no active-row or gutter highlight', async ({
    page,
  }) => {
    await page.goto('/#python-core-flatten-grid-01');
    const input = page.locator('.editor-area').getByRole('textbox');
    await input.click();
    await page.keyboard.press('ArrowDown');
    await expect(
      page.locator('.editor-area .cm-activeLine, .editor-area .cm-activeLineGutter'),
    ).toHaveCount(0);
    await expect(page.locator('.editor-area .cm-cursor')).toBeVisible();
    await expect(page.locator('.editor-area .cm-cursor')).toHaveCSS(
      'border-left-color',
      'rgb(245, 245, 245)',
    );
    await page.keyboard.press('ControlOrMeta+A');
    await expect(page.locator('.editor-area .cm-selectionBackground').first()).toBeVisible();
    await expect(page.locator('.editor-area .cm-selectionBackground').first()).toHaveCSS(
      'background-color',
      'rgb(73, 73, 73)',
    );

    await page.getByRole('tab', { name: 'Solution', exact: true }).click();
    await expect(page.locator('.reference-code .cm-editor').first()).toBeVisible();
    await expect(
      page.locator('.reference-code .cm-activeLine, .reference-code .cm-activeLineGutter'),
    ).toHaveCount(0);
  });

  test('editor and reference use the same readable NeetCode-style code scale', async ({ page }) => {
    await page.goto('/#python-core-flatten-grid-01');
    const editor = page.locator('.editor-area .cm-editor');
    await expect(editor).toHaveCSS('font-size', '16px');
    await expect(page.locator('.editor-area .cm-scroller')).toHaveCSS('line-height', '24px');
    expect(
      await page
        .locator('.editor-area .cm-scroller')
        .evaluate((el) => getComputedStyle(el).fontFamily),
    ).toContain('Consolas');
    await page.getByRole('tab', { name: 'Solution', exact: true }).click();
    for (const view of await page.locator('.reference-code .cm-editor').all())
      await expect(view).toHaveCSS('font-size', '16px');
    await expect(page.locator('.reference-code > .solution-explanation')).toHaveCSS(
      'font-size',
      '15px',
    );
    await expect(page.locator('.topbar-actions')).toHaveCount(0);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: 'Code & results', exact: true }).click();
    await expect(editor).toHaveCSS('font-size', '16px');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  });
});

test.describe('Execution results', () => {
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
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
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
      await expect(page.locator('.app')).toHaveAttribute('data-save-state', 'saved');
      await expect(page.locator(removedEditorMetadata)).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Reset', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Submit', exact: true })).toBeEnabled();
      await page.getByRole('button', { name: 'Submit', exact: true }).click();
      await expect(page.getByText('Accepted', { exact: true })).toBeVisible();
      await expect(page.locator('.result-heading')).toContainText('3 / 3 cases passed');
      await expect(page.locator('.result-heading > small, .result-note')).toHaveCount(0);
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
      await expect(
        page.getByRole('button', { name: 'Case 1: passed', exact: true }),
      ).toHaveAttribute('title', 'Rectangle');
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
      await expect(
        page.getByRole('button', { name: 'Case 2: passed', exact: true }),
      ).toHaveAttribute('aria-pressed', 'true');
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
      await expect(
        page.getByRole('button', { name: 'Case 1: failed', exact: true }),
      ).toHaveAttribute('aria-pressed', 'true');
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
});
