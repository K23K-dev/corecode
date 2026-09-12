import type { Locator, Page } from '@playwright/test';
import { expect, test, type TestDatabase } from './fixtures';
import type { Attempt, ProgressData } from '../../src/lib/progress';
import { practiceClock, summarizeActivity } from '../../shared/practice-activity.mjs';

test.describe('Row interaction', () => {
  type LibraryView = 'expanded deck' | 'all problems';
  type Edge = 'start' | 'center' | 'end';

  const problems = [
    { id: 'python-core-rectangle-metrics-01', title: 'Rectangle metrics' },
    { id: 'python-core-quotient-remainder-01', title: 'Quotient remainder' },
  ];

  async function openTable(page: Page, view: LibraryView) {
    await page.goto('/');
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
    await expect(page).toHaveURL(new RegExp(`/problems/${problem.id}$`));
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
          {
            label: 'just above the adjacent row divider',
            row: 0,
            column: 2,
            x: 'center',
            y: 'end',
          },
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
        await expect(page).toHaveURL('http://127.0.0.1:5173/');
        await expect(library).toBeVisible();
        await completion.click();
        await expect(completion).toHaveAttribute('aria-pressed', 'false');
        await expect(row).not.toHaveClass(/is-solved/);
        for (const key of ['Enter', 'Space']) {
          await completion.focus();
          await page.keyboard.press(key);
          await expect(completion).toHaveAttribute('aria-pressed', 'true');
          await expect(page).toHaveURL('http://127.0.0.1:5173/');
          await page.keyboard.press(key);
          await expect(completion).toHaveAttribute('aria-pressed', 'false');
          await expect(page).toHaveURL('http://127.0.0.1:5173/');
        }
        await expect(page.locator('.app')).toHaveAttribute('data-save-state', 'saved');

        await row.getByRole('button', { name: `Star ${problem.title}`, exact: true }).click();
        const unstar = row.getByRole('button', { name: `Unstar ${problem.title}`, exact: true });
        await expect(unstar).toHaveAttribute('aria-pressed', 'true');
        await expect(completion).toHaveAttribute('aria-pressed', 'false');
        await expect(page.getByTestId('library-starred-count')).toHaveText('1');
        await expect(page).toHaveURL('http://127.0.0.1:5173/');
        await expect(library).toBeVisible();

        // A nested SVG target must be recognized as part of its button too.
        await unstar.locator('svg').click();
        await expect(
          row.getByRole('button', { name: `Star ${problem.title}`, exact: true }),
        ).toHaveAttribute('aria-pressed', 'false');
        await expect(page.getByTestId('library-starred-count')).toHaveText('0');
        await expect(completion).toHaveAttribute('aria-pressed', 'false');
        await expect(page).toHaveURL('http://127.0.0.1:5173/');
        await expect(library).toBeVisible();
        await expect(page.locator('.app')).toHaveAttribute('data-save-state', 'saved');

        await row
          .getByRole('button', { name: `View solution for ${problem.title}`, exact: true })
          .locator('svg')
          .click();
        await expect(page).toHaveURL(`http://127.0.0.1:5173/problems/${problem.id}?tab=solution`);
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
});

test.describe('Manual completion', () => {
  const problemId = 'python-core-rectangle-metrics-01';
  const fixedTime = '2026-09-06T16:00:00.000Z';

  test.use({ timezoneId: 'America/New_York', locale: 'en-US' });

  async function mockActivity(page: Page, days: { date: string; count: number }[]) {
    const clock = practiceClock(new Date(fixedTime));
    await page.clock.setFixedTime(fixedTime);
    await page.route(/\/api\/activity(?:\?.*)?$/, (route) =>
      route.fulfill({
        json: {
          timeZone: 'America/New_York',
          resetHour: 20,
          ...clock,
          serverNow: fixedTime,
          days,
          repairs: [],
          streak: summarizeActivity(days, [], clock.today),
        },
      }),
    );
  }

  async function showAll(page: Page) {
    const library = page.getByRole('main', { name: 'Practice library' });
    await expect(library).toBeVisible();
    await library.getByRole('button', { name: 'All problems', exact: true }).click();
    return library;
  }

  async function savedState(database: TestDatabase) {
    return (
      await database.client.query(
        `SELECT progress, stars FROM ${database.schema}.cp_state WHERE profile_id=1`,
      )
    ).rows[0] as { progress: ProgressData; stars: string[] };
  }

  test('manual completion updates counts and filters, saves, and creates no submission', async ({
    page,
    database,
    catalog,
  }) => {
    const problem = catalog.exercises.find((item) => item.id === problemId)!;
    const deckTotal = catalog.exercises.filter((item) => item.deckId === problem.deckId).length;
    const difficultyTotal = catalog.exercises.filter(
      (item) => item.difficulty === problem.difficulty,
    ).length;
    await mockActivity(page, []);
    const unintendedRequests: string[] = [];
    page.on('request', (request) => {
      const path = new URL(request.url()).pathname;
      if (path === '/api/run' || path === '/api/activity/repairs') unintendedRequests.push(path);
    });
    await page.goto('/');
    const library = await showAll(page);
    const tracker = page.getByRole('complementary', { name: 'Practice tracker' });
    const row = library.locator(`tr[data-problem-id="${problemId}"]`);
    await library
      .getByRole('searchbox', { name: 'Search problems', exact: true })
      .fill(problem.title);
    await library.getByRole('button', { name: 'Filter problems', exact: true }).click();
    const filter = library.getByLabel('Filter by completion', { exact: true });
    await filter.selectOption('unsolved');
    await row.getByRole('button', { name: `Mark ${problem.title} complete`, exact: true }).click();
    await expect(row).toHaveCount(0);
    await expect(
      library.getByRole('heading', { name: 'No matching problems', exact: true }),
    ).toBeVisible();
    await expect(page).toHaveURL('http://127.0.0.1:5173/');
    await expect(page.getByTestId('library-solved-count')).toHaveText(
      `1/${catalog.exercises.length}`,
    );
    await expect(
      tracker.getByTestId(`tracker-${problem.difficulty.toLowerCase()}-count`),
    ).toHaveText(`1/${difficultyTotal}`);
    await filter.selectOption('solved');
    await expect(row).toHaveClass(/is-solved/);
    await expect(row.locator('.pl-problem-status')).toHaveAttribute('aria-pressed', 'true');
    await library.getByRole('button', { name: 'By deck', exact: true }).click();
    await expect(
      library.getByRole('button', {
        name: `${problem.deck} 1 of ${deckTotal} solved`,
        exact: true,
      }),
    ).toBeVisible();
    await expect
      .poll(async () => (await savedState(database)).progress.exercises[problemId]?.solved)
      .toBe(true);
    await expect(page.locator('.app')).toHaveAttribute('data-save-state', 'saved');
    await page.reload();
    await showAll(page);
    await expect(row.locator('.pl-problem-status')).toHaveAccessibleName(
      `Mark ${problem.title} incomplete`,
    );
    await expect(row.locator('.pl-problem-status')).toHaveAttribute('aria-pressed', 'true');
    await expect(tracker.getByTestId('current-streak')).toHaveText('0 days');
    await expect(tracker.getByTestId('tracker-hearts')).toHaveText('0');
    const saved = (await savedState(database)).progress.exercises[problemId];
    expect(saved).toMatchObject({ draft: problem.starterCode, solved: true, attempts: [] });
    expect(
      (await database.client.query(`SELECT id FROM ${database.schema}.cp_submissions`)).rows,
    ).toEqual([]);
    expect(
      (await database.client.query(`SELECT date FROM ${database.schema}.cp_streak_repairs`)).rows,
    ).toEqual([]);
    expect(unintendedRequests).toEqual([]);

    await row
      .getByRole('button', { name: `Mark ${problem.title} incomplete`, exact: true })
      .click();
    await expect(row).not.toHaveClass(/is-solved/);
    await expect
      .poll(async () => (await savedState(database)).progress.exercises[problemId]?.solved)
      .toBe(false);
    await expect(page.locator('.app')).toHaveAttribute('data-save-state', 'saved');
    await page.reload();
    await showAll(page);
    await expect(row.locator('.pl-problem-status')).toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByTestId('library-solved-count')).toHaveText(
      `0/${catalog.exercises.length}`,
    );
  });

  test('unmarking an accepted problem preserves its draft, stars, archive, streak, and hearts', async ({
    page,
    database,
    catalog,
  }) => {
    const problem = catalog.exercises.find((item) => item.id === problemId)!;
    const draft = '# Keep this unfinished revision exactly\n' + problem.starterCode;
    const days = [1, 2, 3, 4, 5].map((day) => ({ date: `2026-09-0${day}`, count: 1 }));
    const attempts: Attempt[] = days.map(({ date }, index) => ({
      id: `manual-completion-existing-${index}`,
      at: `${date}T16:00:00.000Z`,
      code: problem.referenceCode,
      passed: problem.cases.length,
      total: problem.cases.length,
      status: 'accepted',
      durationMs: 1,
      problemVersion: problem.version,
    }));
    const progress: ProgressData = {
      version: 1,
      exercises: {
        [problemId]: { draft, updatedAt: attempts.at(-1)!.at, solved: true, attempts },
      },
    };
    // Only the explicitly guarded E2E schema receives these existing-history fixtures.
    await database.client.query(
      `UPDATE ${database.schema}.cp_state SET progress=$1::jsonb, stars=$2::jsonb WHERE profile_id=1`,
      [JSON.stringify(progress), JSON.stringify([problemId])],
    );
    for (const attempt of attempts) {
      await database.client.query(
        `INSERT INTO ${database.schema}.cp_submissions(id, exercise_id, problem_version, attempt)
         VALUES($1, $2, $3, $4::jsonb)`,
        [attempt.id, problemId, problem.version, JSON.stringify(attempt)],
      );
    }
    const readArchive = async () =>
      (
        await database.client.query(
          `SELECT id, exercise_id, problem_version, attempt, received_at
           FROM ${database.schema}.cp_submissions ORDER BY id`,
        )
      ).rows;
    const archive = await readArchive();
    await mockActivity(page, days);
    const unintendedRequests: string[] = [];
    page.on('request', (request) => {
      const path = new URL(request.url()).pathname;
      if (path === '/api/run' || path === '/api/activity/repairs') unintendedRequests.push(path);
    });
    await page.goto('/');
    const library = await showAll(page);
    const row = library.locator(`tr[data-problem-id="${problemId}"]`);
    const tracker = page.getByRole('complementary', { name: 'Practice tracker' });
    const assertPreserved = async (solved: boolean) => {
      await expect
        .poll(async () => (await savedState(database)).progress.exercises[problemId]?.solved)
        .toBe(solved);
      await expect(page.locator('.app')).toHaveAttribute('data-save-state', 'saved');
      const saved = await savedState(database);
      expect(saved.progress.exercises[problemId]).toMatchObject({ draft, solved, attempts });
      expect(saved.stars).toEqual([problemId]);
      expect(await readArchive()).toEqual(archive);
      await expect(tracker.getByTestId('current-streak')).toHaveText('5 days');
      await expect(tracker.getByTestId('best-streak')).toHaveText('5 days');
      await expect(tracker.getByTestId('tracker-hearts')).toHaveText('1');
      await expect(tracker.getByTestId('tracker-heart-progress')).toHaveText('0/5 to next');
      await expect(tracker.locator('[data-date="2026-09-06"]')).toHaveAttribute('data-count', '0');
      expect(unintendedRequests).toEqual([]);
    };
    await row
      .getByRole('button', { name: `Mark ${problem.title} incomplete`, exact: true })
      .click();
    await expect(page).toHaveURL('http://127.0.0.1:5173/');
    await expect(row).not.toHaveClass(/is-solved/);
    await assertPreserved(false);
    await page.reload();
    await showAll(page);
    await expect(row.locator('.pl-problem-status')).toHaveAccessibleName(
      `Mark ${problem.title} complete`,
    );
    await expect(
      row.getByRole('button', { name: `Unstar ${problem.title}`, exact: true }),
    ).toHaveAttribute('aria-pressed', 'true');
    await assertPreserved(false);
    await row.getByRole('button', { name: `Mark ${problem.title} complete`, exact: true }).click();
    await assertPreserved(true);
    await row.getByRole('button', { name: problem.title, exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'Python solution editor' })).toContainText(
      '# Keep this unfinished revision exactly',
    );
    await page.getByRole('tab', { name: /Submissions/ }).click();
    await expect(page.getByRole('button', { name: /Accepted/ })).toHaveCount(attempts.length);
  });
});
