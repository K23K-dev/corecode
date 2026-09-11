import type { Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures';

type LibraryView = 'expanded deck' | 'all problems';
type Edge = 'start' | 'center' | 'end';

const problems = [
  { id: 'python-core-rectangle-metrics-01', title: 'Rectangle metrics' },
  { id: 'python-core-quotient-remainder-01', title: 'Quotient remainder' },
];

async function openTable(page: Page, view: LibraryView) {
  await page.goto('/#library');
  const library = page.getByRole('main', { name: 'Practice library' });
  await expect(library).toBeVisible();
  if (view === 'expanded deck') {
    await library.getByRole('button', { name: 'By deck', exact: true }).click();
    const deck = library.getByRole('button', { name: /^Python \d+ of \d+ solved$/ });
    if ((await deck.getAttribute('aria-expanded')) !== 'true') await deck.click();
  } else {
    await library.getByRole('button', { name: 'All problems', exact: true }).click();
  }
  const table = library.getByRole('table', {
    name: view === 'expanded deck' ? 'Python problems' : 'All problems',
    exact: true,
  });
  await expect(table).toBeVisible();
  return table;
}

async function clickNonControlPoint(
  page: Page,
  cell: Locator,
  problemId: string,
  x: Edge,
  y: Edge,
) {
  await cell.scrollIntoViewIfNeeded();
  const bounds = await cell.boundingBox();
  expect(bounds).not.toBeNull();
  // Two CSS pixels inside the top/bottom edge test the padding beside the
  // divider without relying on ambiguous collapsed-border pixel ownership.
  const point = {
    x: bounds!.x + (x === 'start' ? 1 : x === 'end' ? bounds!.width - 1 : bounds!.width / 2),
    y: bounds!.y + (y === 'start' ? 2 : y === 'end' ? bounds!.height - 2 : bounds!.height / 2),
  };
  await page.mouse.move(point.x, point.y);
  const hit = await page.evaluate(({ x, y }) => {
    const element = document.elementFromPoint(x, y);
    return {
      problemId: element?.closest('tr')?.getAttribute('data-problem-id'),
      control: element?.closest('button, a, input, select, textarea')?.tagName ?? null,
      cursor: element ? getComputedStyle(element).cursor : null,
    };
  }, point);
  expect(hit).toEqual({ problemId, control: null, cursor: 'pointer' });
  await page.mouse.click(point.x, point.y);
}

async function expectQuestion(page: Page, problem: (typeof problems)[number]) {
  await expect(page).toHaveURL(new RegExp(`#${problem.id}$`));
  await expect(page.getByRole('heading', { name: problem.title, exact: true })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Question', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.getByRole('tab', { name: 'Solution', exact: true })).toHaveAttribute(
    'aria-selected',
    'false',
  );
}

for (const width of [1440, 390]) {
  for (const view of ['expanded deck', 'all problems'] as const) {
    test(`${view} row hitboxes cover padding, dividers, and all columns at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 1000 });
      const points: { label: string; row: number; column: number; x: Edge; y: Edge }[] = [
        { label: 'above the first title', row: 0, column: 2, x: 'center', y: 'start' },
        { label: 'just above the adjacent row divider', row: 0, column: 2, x: 'center', y: 'end' },
        {
          label: 'just below the adjacent row divider',
          row: 1,
          column: 2,
          x: 'center',
          y: 'start',
        },
        { label: 'below the second title', row: 1, column: 2, x: 'center', y: 'end' },
        { label: 'left of the title', row: 0, column: 2, x: 'start', y: 'center' },
        { label: 'right of the title', row: 0, column: 2, x: 'end', y: 'center' },
        { label: 'at the far left of the row', row: 0, column: 0, x: 'start', y: 'center' },
        { label: 'above the star button', row: 0, column: 1, x: 'center', y: 'start' },
        { label: 'on the difficulty label', row: 0, column: 3, x: 'center', y: 'center' },
        {
          label: 'at the far right beside the solution button',
          row: 0,
          column: 4,
          x: 'end',
          y: 'center',
        },
      ];
      for (const point of points) {
        await test.step(point.label, async () => {
          const table = await openTable(page, view);
          // These must remain neighboring rows so both sides of their divider
          // are exercised, including when mobile titles wrap onto more lines.
          await expect(table.locator('tbody tr').nth(0)).toHaveAttribute(
            'data-problem-id',
            problems[0].id,
          );
          await expect(table.locator('tbody tr').nth(1)).toHaveAttribute(
            'data-problem-id',
            problems[1].id,
          );
          const problem = problems[point.row];
          const row = table.locator(`tr[data-problem-id="${problem.id}"]`);
          await clickNonControlPoint(
            page,
            row.locator('td').nth(point.column),
            problem.id,
            point.x,
            point.y,
          );
          await expectQuestion(page, problem);
        });
      }
    });

    test(`${view} row controls retain their own mouse and keyboard actions at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 1000 });
      const problem = problems[0];
      let table = await openTable(page, view);
      let row = table.locator(`tr[data-problem-id="${problem.id}"]`);
      const library = page.getByRole('main', { name: 'Practice library' });

      const completion = row.locator('.pl-problem-status');
      await expect(completion).toHaveAccessibleName(`Mark ${problem.title} complete`);
      await expect(completion).toHaveAttribute('aria-pressed', 'false');
      // Clicking the nested status icon toggles completion, never the row route.
      await completion.locator('svg').click();
      await expect(completion).toHaveAccessibleName(`Mark ${problem.title} incomplete`);
      await expect(completion).toHaveAttribute('aria-pressed', 'true');
      await expect(row).toHaveClass(/is-solved/);
      await expect(page).toHaveURL(/#library$/);
      await expect(library).toBeVisible();
      await completion.click();
      await expect(completion).toHaveAttribute('aria-pressed', 'false');
      await expect(row).not.toHaveClass(/is-solved/);
      for (const key of ['Enter', 'Space']) {
        await completion.focus();
        await page.keyboard.press(key);
        await expect(completion).toHaveAttribute('aria-pressed', 'true');
        await expect(page).toHaveURL(/#library$/);
        await page.keyboard.press(key);
        await expect(completion).toHaveAttribute('aria-pressed', 'false');
        await expect(page).toHaveURL(/#library$/);
      }
      await expect(page.locator('.app')).toHaveAttribute('data-save-state', 'saved');

      await row.getByRole('button', { name: `Star ${problem.title}`, exact: true }).click();
      const unstar = row.getByRole('button', { name: `Unstar ${problem.title}`, exact: true });
      await expect(unstar).toHaveAttribute('aria-pressed', 'true');
      await expect(completion).toHaveAttribute('aria-pressed', 'false');
      await expect(page.getByTestId('library-starred-count')).toHaveText('1');
      await expect(page).toHaveURL(/#library$/);
      await expect(library).toBeVisible();

      // A nested SVG target must be recognized as part of its button too.
      await unstar.locator('svg').click();
      await expect(
        row.getByRole('button', { name: `Star ${problem.title}`, exact: true }),
      ).toHaveAttribute('aria-pressed', 'false');
      await expect(page.getByTestId('library-starred-count')).toHaveText('0');
      await expect(completion).toHaveAttribute('aria-pressed', 'false');
      await expect(page).toHaveURL(/#library$/);
      await expect(library).toBeVisible();
      await expect(page.locator('.app')).toHaveAttribute('data-save-state', 'saved');

      await row
        .getByRole('button', { name: `View solution for ${problem.title}`, exact: true })
        .locator('svg')
        .click();
      await expect(page).toHaveURL(new RegExp(`#${problem.id}$`));
      await expect(page.getByRole('tab', { name: 'Solution', exact: true })).toHaveAttribute(
        'aria-selected',
        'true',
      );
      await expect(page.getByRole('tab', { name: 'Question', exact: true })).toHaveAttribute(
        'aria-selected',
        'false',
      );
      await expect(page.locator('.reference-code')).toBeVisible();

      for (const key of ['Enter', 'Space']) {
        table = await openTable(page, view);
        row = table.locator(`tr[data-problem-id="${problem.id}"]`);
        await expect(row.locator('.pl-problem-status')).toHaveAttribute('aria-pressed', 'false');
        const title = row.getByRole('button', { name: problem.title, exact: true });
        await expect(
          table.getByRole('row').filter({
            has: page.getByRole('button', { name: problem.title, exact: true }),
          }),
        ).toHaveCount(1);
        await row.getByRole('button', { name: `Star ${problem.title}`, exact: true }).focus();
        await page.keyboard.press('Tab');
        await expect(title).toBeFocused();
        await page.keyboard.press(key);
        await expectQuestion(page, problem);
      }
    });
  }
}
