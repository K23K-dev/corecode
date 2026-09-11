import type { Page } from '@playwright/test';
import { expect, test, type TestDatabase } from './fixtures';
import type { Attempt, ProgressData } from '../../src/lib/progress';
import { practiceClock, summarizeActivity } from '../../shared/practice-activity.mjs';

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
  await page.goto('/#library');
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
  await expect(page).toHaveURL(/#library$/);
  await expect(page.getByTestId('library-solved-count')).toHaveText(
    `1/${catalog.exercises.length}`,
  );
  await expect(tracker.getByTestId(`tracker-${problem.difficulty.toLowerCase()}-count`)).toHaveText(
    `1/${difficultyTotal}`,
  );
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

  await row.getByRole('button', { name: `Mark ${problem.title} incomplete`, exact: true }).click();
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
  await page.goto('/#library');
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
  await row.getByRole('button', { name: `Mark ${problem.title} incomplete`, exact: true }).click();
  await expect(page).toHaveURL(/#library$/);
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
