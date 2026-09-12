import type { Page } from '@playwright/test';
import { expect, test, type TestCatalog } from './fixtures';

const defaultId = 'python-core-normalize-text-01';
const storageKey = 'coding-practice:progress:v1';
let readyExercises: TestCatalog['exercises'];
let studyDecks: TestCatalog['decks'];
let reference: string;
let catalogCount: number;
let deckCounts: Record<string, number>;

test.beforeEach(async ({ catalog }) => {
  readyExercises = catalog.exercises;
  studyDecks = catalog.decks;
  const defaultProblem = readyExercises.find((item) => item.id === defaultId);
  expect(defaultProblem, 'The workspace scenario needs its catalog problem.').toBeDefined();
  reference = defaultProblem!.referenceCode;
  catalogCount = readyExercises.length;
  deckCounts = Object.fromEntries(
    studyDecks.map((deck) => [
      deck.id,
      readyExercises.filter((item) => item.deckId === deck.id).length,
    ]),
  );
});
const matching = (query: string) =>
  readyExercises.filter((item) =>
    `${item.title} ${item.deck} ${item.topic ?? ''} ${item.prompt}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );

async function setCode(page: Page, code: string) {
  const editor = page.locator('.editor-area').getByRole('textbox');
  await editor.click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.insertText(code);
  await expectCode(page, code);
}
async function expectCode(page: Page, code: string) {
  // Read the code itself rather than relying on an auxiliary line-count label.
  const lines = page.locator('.editor-area .cm-line');
  await expect
    .poll(() =>
      lines.evaluateAll((nodes) => nodes.map((node) => node.textContent ?? '').join('\n')),
    )
    .toBe(code);
}
async function submit(page: Page) {
  await page.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Submit', exact: true })).toBeVisible({
    timeout: 45_000,
  });
}

test('homepage library shows authored problems and opens the workspace without losing drafts', async ({
  page,
}) => {
  await page.goto('/');
  const library = page.getByRole('main', { name: 'Practice library' });
  await expect(library).toBeVisible();
  await expect(library.getByRole('heading', { name: /^Code Practice/ })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Python solution editor' })).toHaveCount(0);
  await expect(library).not.toContainText(/Anki|Imported/i);
  expect(catalogCount).toBeGreaterThan(0);
  await expect(page.getByTestId('library-solved-count')).toHaveText(`0/${catalogCount}`);
  await expect(library.getByRole('button', { name: 'By deck', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(
    library.getByRole('button', { name: 'Normalize text', exact: true }),
  ).not.toBeVisible();
  await library.getByRole('button', { name: 'Expand all decks', exact: true }).click();
  await expect(library.getByRole('button', { name: 'Normalize text', exact: true })).toBeVisible();
  await library.getByRole('button', { name: 'Collapse all decks', exact: true }).click();
  await expect(
    library.getByRole('button', { name: 'Normalize text', exact: true }),
  ).not.toBeVisible();
  await library.getByRole('button', { name: /^All problems/ }).click();
  const table = library.getByRole('table', { name: 'All problems', exact: true });
  await expect(table.locator('tbody tr')).toHaveCount(catalogCount);
  expect(
    await table
      .locator('tbody tr')
      .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-problem-id'))),
  ).toEqual(readyExercises.map((exercise) => exercise.id));
  await library
    .getByRole('searchbox', { name: 'Search problems', exact: true })
    .fill('Normalize text');
  await expect(table.locator('tbody tr')).toHaveCount(matching('Normalize text').length);
  await expect(library.locator('.pl-content').getByRole('status')).toHaveText(
    `${matching('Normalize text').length} of ${catalogCount} problems match your filters.`,
  );
  await library.getByRole('button', { name: 'Normalize text', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`#${defaultId}$`));
  await expect(page.getByRole('heading', { name: 'Normalize text', exact: true })).toBeVisible();
  await setCode(page, reference);
  await page.getByRole('link', { name: 'Code Practice library', exact: true }).click();
  await expect(page).toHaveURL(/#library$/);
  await expect(library).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await library.getByRole('searchbox', { name: 'Search problems', exact: true }).fill('normalize');
  await library.getByRole('button', { name: 'Normalize text', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Python solution editor' })).toContainText(
    'return text.strip().lower()',
  );
  await page.goBack();
  await expect(library).toBeVisible();
  await page.reload();
  await expect(library).toBeVisible();
});

test('catalog decks expose their real counts and filter runnable problems', async ({ page }) => {
  await page.goto('/');
  const library = page.getByRole('main', { name: 'Practice library' });
  await expect(library.getByRole('group', { name: 'Filter by topic' })).toHaveCount(0);
  await expect(library.locator('.pl-topic-name')).toHaveText(studyDecks.map((deck) => deck.name));
  expect(studyDecks.length).toBeGreaterThan(0);
  for (const deck of studyDecks) {
    expect(deckCounts[deck.id]).toBeGreaterThan(0);
    await expect(
      library.getByRole('button', {
        name: `${deck.name} 0 of ${deckCounts[deck.id]} solved`,
        exact: true,
      }),
    ).toBeVisible();
  }
  await expect(library).not.toContainText('No problems yet');
  await library
    .getByRole('button', { name: `Frontend 0 of ${deckCounts.frontend} solved`, exact: true })
    .click();
  await expect(
    library.getByRole('table', { name: 'Frontend problems', exact: true }).locator('tbody tr'),
  ).toHaveCount(deckCounts.frontend);
  await expect(page.getByTestId('library-solved-count')).toHaveText(`0/${catalogCount}`);
  await library.getByRole('button', { name: /^All problems/ }).click();
  await expect(
    library.getByRole('table', { name: 'All problems', exact: true }).locator('tbody tr'),
  ).toHaveCount(catalogCount);
  await library.getByRole('button', { name: 'Filter problems', exact: true }).click();
  const deckFilter = library.getByLabel('Filter by deck', { exact: true });
  await expect(deckFilter.locator('option')).toHaveText([
    'All decks',
    ...studyDecks.map((deck) => deck.name),
  ]);
  await deckFilter.selectOption('frontend');
  await expect(library.locator('tr[data-problem-id]')).toHaveCount(deckCounts.frontend);
  await expect(
    library.getByRole('button', { name: 'Shuffle filtered problems', exact: true }),
  ).toBeEnabled();
  await expect(library.locator('.pl-content').getByRole('status')).toHaveText(
    `${deckCounts.frontend} of ${catalogCount} problems match your filters.`,
  );
  await deckFilter.selectOption('python');
  await expect(
    library.getByRole('table', { name: 'All problems', exact: true }).locator('tbody tr'),
  ).toHaveCount(deckCounts.python);
  await deckFilter.selectOption('all');
  await library.getByRole('searchbox', { name: 'Search problems', exact: true }).fill('Frontend');
  await expect(library.locator('tr[data-problem-id]')).toHaveCount(matching('Frontend').length);
  await library.getByRole('button', { name: 'Clear all filters', exact: true }).click();
  expect(
    await library
      .locator('tr[data-problem-id]')
      .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-problem-id'))),
  ).toEqual(readyExercises.map((exercise) => exercise.id));
});

test('deck regrouping preserves previously saved drafts, solved status, and submissions', async ({
  page,
}) => {
  const draft = '# Kept across deck regrouping\n' + reference;
  const at = '2026-09-08T12:00:00.000Z';
  const previousProgress = {
    version: 1,
    exercises: {
      [defaultId]: {
        draft,
        updatedAt: at,
        solved: true,
        attempts: [
          {
            id: 'existing-submission',
            at,
            code: reference,
            passed: 8,
            total: 8,
            status: 'accepted',
            durationMs: 1,
          },
        ],
      },
    },
  };
  await page.addInitScript(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), {
    key: storageKey,
    value: previousProgress,
  });
  await page.goto('/');
  const library = page.getByRole('main', { name: 'Practice library' });
  await expect(page.getByTestId('library-solved-count')).toHaveText(`1/${catalogCount}`);
  await library.getByRole('button', { name: 'Filter problems', exact: true }).click();
  await library.getByLabel('Filter by completion', { exact: true }).selectOption('solved');
  await expect(
    library.getByRole('button', { name: `Python 1 of ${deckCounts.python} solved`, exact: true }),
  ).toHaveAttribute('aria-expanded', 'true');
  await expect(
    library.getByRole('button', { name: 'Python 1 of 1 solved', exact: true }),
  ).toHaveCount(0);
  await expect(
    library.getByRole('table', { name: 'Python problems', exact: true }).locator('tbody tr'),
  ).toHaveCount(1);
  await expect(
    library
      .locator(`tr[data-problem-id="${defaultId}"]`)
      .getByRole('button', { name: 'Mark Normalize text incomplete', exact: true }),
  ).toBeVisible();
  await library.getByRole('button', { name: 'Normalize text', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Python solution editor' })).toContainText(
    '# Kept across deck regrouping',
  );
  await page.getByRole('tab', { name: /Submissions/ }).click();
  await expect(page.getByRole('button', { name: /Accepted.*8\/8/ })).toBeVisible();
  expect(await page.evaluate((key) => JSON.parse(localStorage.getItem(key)!), storageKey)).toEqual(
    previousProgress,
  );
});

test('homepage filters, empty states, saved stars, and filtered shuffle work', async ({ page }) => {
  await page.goto('/#library');
  const library = page.getByRole('main', { name: 'Practice library' });
  await library.getByRole('button', { name: /^All problems/ }).click();
  const table = library.getByRole('table', { name: 'All problems', exact: true });
  await library.getByRole('button', { name: 'Filter problems', exact: true }).click();
  await library.getByLabel('Filter by difficulty', { exact: true }).selectOption('Medium');
  const mediumCount = readyExercises.filter((item) => item.difficulty === 'Medium').length;
  await expect(table.locator('tbody tr')).toHaveCount(mediumCount);
  await expect(table.locator('tbody .pl-difficulty')).toHaveText(Array(mediumCount).fill('Medium'));
  await library
    .getByRole('searchbox', { name: 'Search problems', exact: true })
    .fill('no such problem xyz');
  await expect(
    library.getByRole('heading', { name: 'No matching problems', exact: true }),
  ).toBeVisible();
  await expect(
    library.getByRole('button', { name: 'Shuffle filtered problems', exact: true }),
  ).toBeDisabled();
  await library.getByRole('button', { name: 'Clear filters', exact: true }).click();
  await expect(table.locator('tbody tr')).toHaveCount(catalogCount);
  await library.getByLabel('Filter by completion', { exact: true }).selectOption('solved');
  await expect(
    library.getByRole('heading', { name: 'No matching problems', exact: true }),
  ).toBeVisible();
  await library.getByRole('button', { name: 'Clear filters', exact: true }).click();
  await library.getByRole('button', { name: 'Star Normalize text', exact: true }).click();
  await expect(page.getByTestId('library-starred-count')).toHaveText('1');
  await library.getByRole('checkbox', { name: 'Starred only', exact: true }).check();
  await expect(table.locator('tbody tr')).toHaveCount(1);
  await page.reload();
  await expect(page.getByTestId('library-starred-count')).toHaveText('1');
  await library.getByRole('button', { name: /^All problems/ }).click();
  await expect(
    library.getByRole('button', { name: 'Unstar Normalize text', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await library.getByRole('button', { name: 'Filter problems', exact: true }).click();
  await library.getByRole('checkbox', { name: 'Starred only', exact: true }).check();
  await expect(table.locator('tbody tr')).toHaveCount(1);
  await library.getByRole('button', { name: 'Shuffle filtered problems', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`#${defaultId}$`));
  await expect(page.getByRole('heading', { name: 'Normalize text', exact: true })).toBeVisible();
});

test('mobile homepage fits the viewport and opens a searched problem', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  const library = page.getByRole('main', { name: 'Practice library' });
  await expect(library).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await library.getByRole('searchbox', { name: 'Search problems', exact: true }).fill('normalize');
  await expect(library.getByRole('button', { name: 'Normalize text', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await library.getByRole('button', { name: 'Normalize text', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Normalize text', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Code & results', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Python solution editor' })).toBeVisible();
});

for (const acceptanceKey of ['Tab', 'Enter']) {
  test(`Python autocomplete suggests print while typing and accepts with ${acceptanceKey}`, async ({
    page,
  }) => {
    await page.goto(`/#${defaultId}`);
    const editor = page.getByRole('textbox', { name: 'Python solution editor' });
    const prefix = 'def normalize_text(text):\n    ';
    await setCode(page, prefix);
    await editor.pressSequentially('pri', { delay: 35 });
    const popup = page.locator('.cm-tooltip-autocomplete');
    await expect(popup.getByRole('option', { name: /^print\b/ })).toBeVisible();
    await expect(popup.getByRole('option', { name: /^print\b/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await page.keyboard.press(acceptanceKey);
    await expect(editor).toHaveText(prefix + 'print');
    await expect(popup).not.toBeVisible();
    await expectCode(page, prefix + 'print');
  });
}

test('Python autocomplete uses current parameters and locals, with Escape and normal indentation intact', async ({
  page,
}) => {
  await page.goto(`/#${defaultId}`);
  const editor = page.getByRole('textbox', { name: 'Python solution editor' });
  const popup = page.locator('.cm-tooltip-autocomplete');
  const prefix = 'def normalize_text(text):\n    ';
  await setCode(page, prefix);
  await editor.pressSequentially('tex', { delay: 35 });
  await expect(popup.getByRole('option', { name: 'text', exact: true })).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(editor).toHaveText(prefix + 'text');
  const withLocal = 'def normalize_text(text):\n    draft_value = text\n    ';
  await setCode(page, withLocal);
  await editor.pressSequentially('draft_v', { delay: 35 });
  await expect(popup.getByRole('option', { name: 'draft_value', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(popup).not.toBeVisible();
  await expect(editor).toHaveText(withLocal + 'draft_v');
  await page.keyboard.press('Tab');
  await expect(editor).not.toBeFocused();
  await page.reload();
  await setCode(page, prefix);
  await page.keyboard.press('Tab');
  await expect(editor).toBeFocused();
  expect(await editor.locator('.cm-line').last().textContent()).toBe('        ');
  await expect(popup).not.toBeVisible();
});

test('Python autocomplete ranks common names and accepts fuzzy print matches', async ({ page }) => {
  await page.goto(`/#${defaultId}`);
  const editor = page.getByRole('textbox', { name: 'Python solution editor' });
  const popup = page.locator('.cm-tooltip-autocomplete');
  const prefix = 'def normalize_text(text):\n    ';
  for (const input of ['p', 'prn']) {
    await setCode(page, prefix);
    await editor.pressSequentially(input, { delay: 35 });
    const first = popup.getByRole('option').first();
    await expect(first).toHaveAccessibleName('print');
    await expect(first).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Tab');
    await expect(editor).toHaveText(prefix + 'print');
  }
});

test('autocomplete uses readable symbols and a blue selection without overflowing mobile', async ({
  page,
}) => {
  await page.goto(`/#${defaultId}`);
  const editor = page.getByRole('textbox', { name: 'Python solution editor' });
  const popup = page.locator('.cm-tooltip-autocomplete');
  const prefix = 'def normalize_text(text):\n    ';
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    if (width === 390)
      await page.getByRole('button', { name: 'Code & results', exact: true }).click();
    await setCode(page, prefix);
    await editor.pressSequentially('prn', { delay: 35 });
    await expect(popup).toBeVisible();
    await expect(popup).toHaveCSS('font-size', '16px');
    await expect(popup).toHaveCSS('border-radius', '0px');
    const selected = popup.getByRole('option', { name: 'print', exact: true });
    await expect(selected).toHaveCSS('background-color', 'rgb(4, 57, 94)');
    await expect(selected.locator('.cm-completionIcon')).toHaveCSS('color', 'rgb(197, 134, 244)');
    await expect(selected.locator('.cm-completionMatchedText').first()).toHaveCSS(
      'color',
      'rgb(79, 193, 255)',
    );
    const icon = await selected.locator('.cm-completionIcon').evaluate((element) => {
      const style = getComputedStyle(element, '::after');
      return { content: style.content, mask: style.maskImage };
    });
    expect(icon.content).toBe('""');
    expect(icon.mask).toContain('data:image/svg+xml');
    const bounds = await popup.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
    const info = popup.locator('.cm-completionInfo');
    await expect(info).toContainText('print(');
    const infoBounds = await info.boundingBox();
    expect(infoBounds!.x).toBeGreaterThanOrEqual(0);
    expect(infoBounds!.x + infoBounds!.width).toBeLessThanOrEqual(width);
    expect(infoBounds!.y + infoBounds!.height).toBeLessThanOrEqual(900);
    // A positioned signature can exist in the DOM yet be clipped by the list.
    await expect
      .poll(() =>
        info.evaluate((element) => {
          const bounds = element.getBoundingClientRect();
          const hit = document.elementFromPoint(
            bounds.x + bounds.width / 2,
            bounds.y + bounds.height / 2,
          );
          return element === hit || element.contains(hit);
        }),
      )
      .toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.keyboard.press('Escape');
  }
});

test('Python autocomplete does not expose names from the hidden reference solution', async ({
  page,
}) => {
  await page.goto('/#python-core-unique-in-order-01');
  const editor = page.getByRole('textbox', { name: 'Python solution editor' });
  await setCode(page, 'def unique_in_order(values):\n    ');
  await editor.pressSequentially('se', { delay: 35 });
  const popup = page.locator('.cm-tooltip-autocomplete');
  await expect(popup.getByRole('listbox')).toBeVisible();
  await expect(popup.getByRole('option', { name: /^set\b/ })).toBeVisible();
  await expect(popup.locator('.cm-completionLabel').filter({ hasText: /^seen$/ })).toHaveCount(0);
  await expect(popup.locator('.cm-completionLabel').filter({ hasText: /^result$/ })).toHaveCount(0);
  await expect(page.locator('.reference-code')).toHaveCount(0);
  await expect(editor).not.toContainText('seen = set()');
  await page.keyboard.press('Escape');
  await page.getByRole('tab', { name: 'Solution', exact: true }).click();
  const referenceEditor = page.locator('.reference-code .cm-content');
  await expect(referenceEditor).toHaveAttribute('contenteditable', 'false');
  await expect(page.locator('.reference-code')).toContainText('seen = set()');
  await expect(popup).not.toBeVisible();
});

test('running with pending or open autocomplete leaves no browser errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.stack ?? error.message));
  await page.goto(`/#${defaultId}`);
  const editor = page.getByRole('textbox', { name: 'Python solution editor' });
  // The expression after return is unreachable, so typing a partial name still
  // leaves a valid solution while exercising the editor's lock/unlock lifecycle.
  const prefix = reference.trimEnd() + '\n        ';
  await setCode(page, prefix);
  await editor.pressSequentially('pri');
  await page.getByRole('button', { name: 'Run example', exact: true }).click();
  await expect(page.getByText('Example passed', { exact: true })).toBeVisible({ timeout: 45_000 });
  await expect(editor).toHaveAttribute('contenteditable', 'true');
  await setCode(page, prefix);
  await editor.pressSequentially('pri', { delay: 35 });
  await expect(
    page.locator('.cm-tooltip-autocomplete').getByRole('option', { name: /^print\b/ }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Run example', exact: true }).click();
  await expect(page.getByText('Example passed', { exact: true })).toBeVisible({ timeout: 45_000 });
  await expect(editor).toHaveAttribute('contenteditable', 'true');
  await expect(page.locator('.cm-tooltip-autocomplete')).not.toBeVisible();
  expect(errors).toEqual([]);
});

test('real run, full submit, failed case details, custom input, and persisted history', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.stack ?? error.message));
  await page.goto(`/#${defaultId}`);
  await expect(page.getByRole('heading', { name: 'Normalize text', exact: true })).toBeVisible();
  await expect(page.locator('.topbar-actions, .workspace-progress')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'My progress', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Library', exact: true })).toHaveCount(0);
  await expect(page.getByText('Reference solution', { exact: true })).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'Console', exact: true })).toHaveAttribute(
    'aria-expanded',
    'false',
  );
  await setCode(page, reference);
  await page.getByRole('button', { name: 'Run example', exact: true }).click();
  await expect(page.getByText('Example passed', { exact: true })).toBeVisible({ timeout: 45_000 });
  await expect(page.getByRole('button', { name: 'Console', exact: true })).toHaveAttribute(
    'aria-expanded',
    'true',
  );
  await expect(page.locator('.case-detail .value-block > span')).toHaveText([
    'Input',
    'Your Output',
    'Expected Output',
  ]);
  await expect(page.locator('.solved-label')).toHaveCount(0);
  await submit(page);
  await expect(page.getByText('Accepted', { exact: true })).toBeVisible();
  await expect(page.locator('.solved-label')).toBeVisible();
  await expect(page.locator('.app')).toHaveAttribute('data-save-state', 'saved');
  await page.reload();
  await expect(page.getByRole('textbox', { name: 'Python solution editor' })).toContainText(
    'return text.strip().lower()',
  );
  await expect(page.locator('.solved-label')).toBeVisible();
  await page.getByRole('tab', { name: /Submissions/ }).click();
  await expect(page.getByRole('button', { name: /Accepted.*8\/8/ })).toBeVisible();
  await setCode(page, 'def normalize_text(text):\n    return text.lower()\n');
  await submit(page);
  await expect(page.getByText('Not quite yet', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Case 1: failed' })).toBeVisible();
  await expect(page.locator('.case-detail .value-block > span')).toHaveText([
    'Input',
    'Your Output',
    'Expected Output',
  ]);
  await expect(page.getByText('Your Output', { exact: true })).toBeVisible();
  await expect(page.getByText('Expected Output', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Custom input' }).click();
  await page.getByLabel('Function arguments', { exact: true }).fill("('Hi!',)");
  await page.getByRole('button', { name: 'Run input' }).click();
  await expect(page.getByText('Custom run', { exact: true })).toBeVisible({ timeout: 45_000 });
  await expect(page.getByText('Not graded', { exact: true })).toBeVisible();
  await expect(page.locator('.case-detail')).toContainText("'hi!'");
  await expect(page.locator('.case-detail .value-block > span')).toHaveText([
    'Input',
    'Your Output',
  ]);
  await expect(
    page.locator('.case-detail .correct-output, .case-detail .wrong-output'),
  ).toHaveCount(0);
  await page.getByRole('tab', { name: /Submissions/ }).click();
  await expect(page.locator('.submission-row')).toHaveCount(2);
  await page.getByRole('link', { name: 'Code Practice library', exact: true }).click();
  await expect(page.getByTestId('library-solved-count')).toHaveText(`1/${catalogCount}`);
  await page
    .getByRole('main', { name: 'Practice library' })
    .getByRole('button', { name: /^All problems/ })
    .click();
  await expect(
    page
      .locator(`tr[data-problem-id="${defaultId}"]`)
      .getByRole('button', { name: 'Mark Normalize text incomplete', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  expect(errors).toEqual([]);
});

test('infinite loop times out, Stop cancels, and the next run succeeds', async ({ page }) => {
  await page.goto(`/#${defaultId}`);
  await setCode(page, 'def normalize_text(text):\n    while True:\n        pass\n');
  await submit(page);
  await expect(page.getByText(/exceeded 20 seconds/)).toBeVisible();
  await page.getByRole('button', { name: 'Run example', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(page.getByText('Run canceled. Your code is still in the editor.')).toBeVisible();
  await setCode(page, reference);
  await submit(page);
  await expect(page.getByText('Accepted', { exact: true })).toBeVisible();
});

test('navigation, drafts, reference, reset confirmation, and manually authored library', async ({
  page,
}) => {
  await page.goto(`/#${defaultId}`);
  await setCode(page, reference);
  await page.getByRole('button', { name: 'Next exercise', exact: true }).click();
  const nextExercise =
    readyExercises[readyExercises.findIndex((item) => item.id === defaultId) + 1];
  await expect(page.getByRole('heading', { name: nextExercise.title, exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Previous exercise', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Python solution editor' })).toContainText(
    'strip',
  );
  await expect(page.getByRole('heading', { name: 'Environment', exact: true })).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'View reference solution', exact: true }),
  ).toHaveCount(0);
  await expect(page.locator('.problem-panel')).not.toContainText(/grading cases|execution limit/);
  await page.getByRole('tab', { name: 'Solution', exact: true }).click();
  await expect(page.locator('.reference-code')).toContainText('return text.strip().lower()');
  await expect(page.locator('.reference-code > .solution-explanation')).toHaveText(
    readyExercises.find((item) => item.id === defaultId)!.explanation!,
  );
  await expect(page.locator('.reference-code .solution-alternative')).toHaveCount(0);
  await expect(
    page.getByText('One valid approach, not the only accepted answer.', { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Hide reference solution', exact: true }),
  ).toHaveCount(0);
  await page.getByRole('tab', { name: 'Question', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Normalize text', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Reset', exact: true }).click();
  await page.getByRole('button', { name: 'Keep editing', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Python solution editor' })).toContainText(
    'strip',
  );
  await page.getByRole('button', { name: 'Reset', exact: true }).click();
  await page.getByRole('button', { name: 'Reset code', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Python solution editor' })).toContainText('pass');
  await expect(page.getByRole('button', { name: 'Browse exercises', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Back to practice', exact: true }).click();
  const library = page.getByRole('main', { name: 'Practice library' });
  await expect(library).toBeVisible();
  await expect(page).toHaveURL(/#library$/);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(library).not.toContainText(/Anki|Imported/i);
  await expect(page.getByLabel('Filter by availability')).toHaveCount(0);
  await library.getByRole('button', { name: /^All problems/ }).click();
  await expect(
    library.getByRole('table', { name: 'All problems', exact: true }).locator('tbody tr'),
  ).toHaveCount(catalogCount);
  await library.getByRole('button', { name: 'Normalize text', exact: true }).click();
  await expect(library).not.toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Not runnable yet', exact: true }),
  ).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'Submit', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Run example', exact: true })).toBeEnabled();
  await expect(page.locator('body')).not.toContainText(/Anki|Imported/i);
});

test('warning recovery still allows backup export and explicit restore, with invalid files rejected', async ({
  page,
}) => {
  await page.addInitScript((key) => localStorage.setItem(key, '{broken'), storageKey);
  await page.goto(`/#${defaultId}`);
  await setCode(page, reference);
  await page.getByRole('button', { name: 'Export your progress', exact: true }).click();
  const dialog = page.getByRole('dialog');
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export progress', exact: true }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^code-practice-progress-.*\.json$/);
  await page.locator('input[type="file"]').setInputFiles({
    name: 'invalid.json',
    mimeType: 'application/json',
    buffer: Buffer.from('{"version":99,"exercises":{}}'),
  });
  await expect(dialog.getByRole('alert')).toBeVisible();
  const backup = {
    version: 1,
    exercises: {
      [defaultId]: {
        draft: '# restored\n' + reference,
        updatedAt: new Date().toISOString(),
        solved: false,
        attempts: [],
      },
    },
  };
  await page.locator('input[type="file"]').setInputFiles({
    name: 'backup.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(backup)),
  });
  await expect(page.getByRole('heading', { name: 'Restore this progress?' })).toBeVisible();
  await page.getByRole('button', { name: 'Restore progress', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Python solution editor' })).toContainText(
    '# restored',
  );
  await expect(page.locator('.app')).toHaveAttribute('data-save-state', 'saved');
  await page.reload();
  await expect(page.getByRole('textbox', { name: 'Python solution editor' })).toContainText(
    '# restored',
  );
});

test('corrupt existing storage survives and a clear warning is shown', async ({ page }) => {
  await page.addInitScript((key) => localStorage.setItem(key, '{broken'), storageKey);
  await page.goto(`/#${defaultId}`);
  await expect(page.locator('.warning-banner')).toBeVisible();
  await setCode(page, reference);
  await expect(page.locator('.warning-banner')).toContainText('original backup was left untouched');
  await expect(page.locator('.app')).toHaveAttribute('data-save-state', 'saved');
  expect(await page.evaluate((key) => localStorage.getItem(key), storageKey)).toBe('{broken');
});

test('mobile layout, tabs, library, and keyboard shortcut', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/#${defaultId}`);
  await expect(page.getByRole('heading', { name: 'Normalize text', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('mobile-problem.png'), fullPage: true });
  await page.getByRole('button', { name: 'Code & results', exact: true }).click();
  await setCode(page, reference);
  await page.keyboard.press('Control+Enter');
  await expect(page.getByText('Example passed', { exact: true })).toBeVisible({ timeout: 45_000 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('mobile-code.png'), fullPage: true });
  await page.getByRole('button', { name: 'Back to practice', exact: true }).click();
  await page
    .getByRole('searchbox', { name: 'Search problems', exact: true })
    .fill('no such exercise xyz');
  await expect(page.getByRole('heading', { name: 'No matching problems' })).toBeVisible();
  await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
  await expect(page.getByLabel('Filter by availability')).toHaveCount(0);
  await page
    .getByRole('main', { name: 'Practice library' })
    .getByRole('button', { name: /^All problems/ })
    .click();
  await expect(
    page.getByRole('table', { name: 'All problems', exact: true }).locator('tbody tr'),
  ).toHaveCount(catalogCount);
  await page.screenshot({ path: testInfo.outputPath('mobile-library.png'), fullPage: true });
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.goBack();
  await expect(page.getByRole('heading', { name: 'Normalize text', exact: true })).toBeVisible();
});

test('oversized edits never desynchronize displayed code from the executed draft', async ({
  page,
}) => {
  await page.goto(`/#${defaultId}`);
  await setCode(page, reference);
  const editor = page.getByRole('textbox', { name: 'Python solution editor' });
  await editor.click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.insertText('x'.repeat(40_000));
  await expect(page.getByRole('alert')).toContainText('exceeds the code size limit');
  await expect(editor).toContainText('return text.strip().lower()');
  await submit(page);
  await expect(page.getByText('Accepted', { exact: true })).toBeVisible();
});

test('tabs support arrows, editor escapes Tab focus, and dialogs restore focus', async ({
  page,
}) => {
  await page.goto(`/#${defaultId}`);
  const problemTabs = page.getByRole('tablist', { name: 'Problem details' });
  await problemTabs.getByRole('tab', { name: 'Question', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(problemTabs.getByRole('tab', { name: 'Solution', exact: true })).toBeFocused();
  await expect(problemTabs.getByRole('tab', { name: 'Solution', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.locator('.reference-code')).toBeVisible();
  await page.keyboard.press('End');
  await expect(problemTabs.getByRole('tab', { name: 'Submissions', exact: true })).toBeFocused();
  await expect(page.getByRole('heading', { name: 'Your submissions', exact: true })).toBeVisible();
  await page.keyboard.press('Home');
  await expect(problemTabs.getByRole('tab', { name: 'Question', exact: true })).toBeFocused();
  const consoleToggle = page.getByRole('button', { name: 'Console', exact: true });
  await expect(consoleToggle).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('tab', { name: 'Results', exact: true })).toHaveCount(0);
  await consoleToggle.click();
  await expect(consoleToggle).toHaveAttribute('aria-expanded', 'true');
  await page.getByRole('tab', { name: 'Results', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: 'Custom input' })).toBeFocused();
  await expect(page.getByRole('tab', { name: 'Custom input' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.keyboard.press('End');
  await expect(page.getByRole('tab', { name: 'Custom input' })).toBeFocused();
  await page.keyboard.press('Home');
  await expect(page.getByRole('tab', { name: 'Results', exact: true })).toBeFocused();
  const editor = page.getByRole('textbox', { name: 'Python solution editor' });
  await editor.focus();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Tab');
  await expect(editor).not.toBeFocused();
  const reset = page.getByRole('button', { name: 'Reset', exact: true });
  await reset.click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(reset).toBeFocused();
});

test('edited solutions label previous results and resetting clears them without deleting history', async ({
  page,
}) => {
  await page.goto(`/#${defaultId}`);
  await setCode(page, reference);
  await submit(page);
  await expect(page.getByText('Accepted', { exact: true })).toBeVisible();
  await setCode(page, 'def normalize_text(text):\n    return None\n');
  await expect(
    page.getByText('Your code has changed. These results are from the previous run.'),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Reset', exact: true }).click();
  await page.getByRole('button', { name: 'Reset code', exact: true }).click();
  await expect(page.getByText('Accepted', { exact: true })).not.toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Python solution editor' })).toContainText('pass');
  await expect(page.locator('.solved-label')).toBeVisible();
  await page.getByRole('tab', { name: /Submissions/ }).click();
  await expect(page.locator('.submission-row')).toHaveCount(1);
});

test('Solution explains its approach and shows only available useful alternatives without changing the draft', async ({
  page,
}) => {
  const exercise = readyExercises.find((item) => item.id === 'python-core-flatten-grid-01')!;
  const alternatives = (
    'solutionAlternatives' in exercise ? exercise.solutionAlternatives : undefined
  ) as { title: string; explanation: string; code: string; complexity?: string }[] | undefined;
  expect(alternatives?.length).toBeGreaterThan(0);
  await page.goto(`/#${exercise.id}`);
  const draft = '# this remains my own solution\n' + exercise.starterCode;
  await setCode(page, draft);
  await page.getByRole('tab', { name: 'Solution', exact: true }).click();
  const solution = page.locator('.reference-code');
  await expect(
    solution.getByRole('heading', { name: 'Reference solution', exact: true }),
  ).toBeVisible();
  expect(exercise.explanation).toBeTruthy();
  await expect(solution.locator(':scope > .solution-explanation')).toHaveText(
    exercise.explanation!,
  );
  await expect(solution.locator('.solution-alternative')).toHaveCount(alternatives!.length);
  for (const [index, alternative] of alternatives!.entries()) {
    const section = solution.locator('.solution-alternative').nth(index);
    await expect(
      section.getByRole('heading', { name: alternative.title, exact: true }),
    ).toBeVisible();
    await expect(section.locator('.solution-explanation')).toHaveText(alternative.explanation);
    if (alternative.complexity)
      await expect(section.locator('.solution-complexity')).toHaveText(alternative.complexity);
  }
  for (const editor of await solution.locator('.cm-content').all()) {
    await expect(editor).toHaveAttribute('contenteditable', 'false');
    await expect(editor).toContainText('class Solution:');
  }
  await expect(page.locator('.editor-area .cm-content')).toContainText(
    '# this remains my own solution',
  );
  await expect(
    page.getByRole('button', { name: 'Hide reference solution', exact: true }),
  ).toHaveCount(0);
  await page.getByRole('tab', { name: 'Question', exact: true }).click();
  await expect(solution).toHaveCount(0);
  await expect(page.locator('.editor-area .cm-content')).toContainText(
    '# this remains my own solution',
  );
});

const containerExamples = [
  ['original Python', 'python-core-normalize-text-01'],
  ['JavaScript data function', 'frontend-js-002-active-user-ids'],
  ['React interaction', 'frontend-react-003-counter'],
  ['responsive CSS', 'frontend-css-002-responsive-product-grid'],
  ['Express backend', 'backend-express-000-app-wiring'],
  ['SQL query', 'sql-select-filter-products'],
  ['native Python', 'python-core-rectangle-metrics-01'],
  ['NumPy array', 'numpy-make-canvas-01'],
  ['shell command', 'linux-practice-create-and-enter-01'],
] as const;

for (const [label, problemId] of containerExamples) {
  test(`real Docker Submit grades and persists a ${label} exercise`, async ({ page, database }) => {
    const exercise = readyExercises.find((item) => item.id === problemId)!;
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.stack ?? error.message));
    await page.goto(`/#${problemId}`);
    await expect(page.getByRole('heading', { name: exercise.title, exact: true })).toBeVisible();
    await expect(page.locator('.topbar-actions, .workspace-progress')).toHaveCount(0);
    await setCode(page, exercise.referenceCode);
    const responsePromise = page.waitForResponse(
      (response) => response.url().endsWith('/api/run') && response.request().method() === 'POST',
    );
    await submit(page);
    const response = await responsePromise;
    expect(response.status()).toBe(200);
    expect(response.request().postDataJSON()).toMatchObject({
      problemId,
      mode: 'submit',
      code: exercise.referenceCode,
    });
    const result = (await response.json()) as { cases: { passed?: boolean }[]; error?: string };
    expect(result.error).toBeUndefined();
    expect(result.cases).toHaveLength(exercise.cases.length);
    expect(result.cases.every((item) => item.passed === true)).toBe(true);
    await expect(page.getByText('Accepted', { exact: true })).toBeVisible();
    await expect
      .poll(
        async () =>
          (
            await database.client.query(
              `SELECT progress FROM ${database.schema}.cp_state WHERE profile_id=1`,
            )
          ).rows[0].progress.exercises[problemId]?.solved,
      )
      .toBe(true);
    const attempts = (
      await database.client.query(
        `SELECT attempt,problem_version FROM ${database.schema}.cp_submissions WHERE exercise_id=$1`,
        [problemId],
      )
    ).rows;
    expect(attempts).toHaveLength(1);
    expect(attempts[0].problem_version).toMatch(/^[a-f0-9]{64}$/);
    expect(attempts[0].attempt).toMatchObject({
      code: exercise.referenceCode,
      status: 'accepted',
      passed: exercise.cases.length,
      total: exercise.cases.length,
    });
    await page.reload();
    await expect(page.locator('.solved-label')).toBeVisible();
    await page.getByRole('tab', { name: /Submissions/ }).click();
    await expect(page.locator('.submission-row')).toHaveCount(1);
    expect(errors).toEqual([]);
  });
}
