import type { Page } from '@playwright/test';
import { expect, test, type TestCatalog } from './fixtures';
import type { ProgressData } from '../../src/lib/progress';

const timeZone = 'America/New_York';
// September 8 in UTC is still September 7 for this browser.
const fixedTime = '2026-09-08T02:30:00.000Z';
const today = '2026-09-07';
const activityPath = '**/api/activity?*';
const difficulties = ['Easy', 'Medium', 'Hard'] as const;
let authored: TestCatalog['exercises'];

test.use({ timezoneId: timeZone, locale: 'en-US' });
test.beforeEach(async ({ page, catalog }) => {
  authored = catalog.exercises;
  await page.clock.setFixedTime(fixedTime);
});

async function mockActivity(page: Page, days: { date: string; count: number }[]) {
  await page.route(activityPath, (route) => route.fulfill({ json: { timeZone, days } }));
}

test('tracker uses all catalog difficulty totals and saved solved state, independent of filters', async ({
  page,
  database,
}) => {
  const solvedProblems = difficulties.map((difficulty) =>
    authored.find((problem) => problem.difficulty === difficulty)!,
  );
  const progress: ProgressData = { version: 1, exercises: {} };
  for (const problem of solvedProblems) {
    progress.exercises[problem.id] = {
      draft: problem.referenceCode,
      updatedAt: fixedTime,
      solved: true,
      attempts: [],
    };
  }
  await database.client.query(
    `UPDATE ${database.schema}.cp_state SET progress=$1::jsonb WHERE profile_id=1`,
    [JSON.stringify(progress)],
  );
  await mockActivity(page, []);
  await page.goto('/#library');
  const tracker = page.getByRole('complementary', { name: 'Practice tracker' });
  await expect(tracker).toBeVisible();

  async function expectTotals() {
    for (const difficulty of difficulties) {
      const total = authored.filter((problem) => problem.difficulty === difficulty).length;
      await expect(tracker.getByTestId(`tracker-${difficulty.toLowerCase()}-count`)).toHaveText(
        `1/${total}`,
      );
    }
    await expect(
      tracker.getByRole('img', { name: `3 of ${authored.length} problems solved`, exact: true }),
    ).toBeVisible();
  }
  await expectTotals();
  await page
    .getByRole('searchbox', { name: 'Search problems', exact: true })
    .fill('no matching tracker test problem');
  await expect(
    page.getByRole('heading', { name: 'No matching problems', exact: true }),
  ).toBeVisible();
  await expectTotals();
  await expect(tracker.getByTestId('current-streak')).toHaveText('0 days');
  await expect(tracker.getByTestId('best-streak')).toHaveText('0 days');
});

test('calendar uses the local day, navigates months, and distinguishes current from best streak', async ({
  page,
}) => {
  const days = [
    ...[1, 2, 3, 4, 5].map((day) => ({ date: `2026-08-0${day}`, count: 1 })),
    { date: '2026-09-05', count: 1 },
    { date: '2026-09-06', count: 3 },
  ];
  const requestedZones: string[] = [];
  await page.route(activityPath, (route) => {
    requestedZones.push(new URL(route.request().url()).searchParams.get('timeZone') ?? '');
    return route.fulfill({ json: { timeZone, days } });
  });
  await page.goto('/#library');
  const tracker = page.getByRole('complementary', { name: 'Practice tracker' });
  await expect(tracker.getByTestId('current-streak')).toHaveText('2 days');
  await expect(tracker.getByTestId('best-streak')).toHaveText('5 days');
  expect(requestedZones.length).toBeGreaterThan(0);
  expect(requestedZones.every((zone) => zone === timeZone)).toBe(true);

  const september = tracker.getByRole('table', { name: 'September 2026', exact: true });
  const todayButton = september.getByRole('button', {
    name: 'September 7, 2026: 0 accepted submissions',
    exact: true,
  });
  await expect(todayButton).toHaveAttribute('aria-current', 'date');
  await expect(todayButton).toHaveAttribute('aria-pressed', 'true');
  await expect(todayButton).toBeEnabled();
  await expect(
    september.getByRole('button', {
      name: 'September 8, 2026: 0 accepted submissions',
      exact: true,
    }),
  ).toBeDisabled();
  await expect(tracker.getByRole('button', { name: 'Next month', exact: true })).toBeDisabled();
  const previousDay = september.getByRole('button', {
    name: 'September 6, 2026: 3 accepted submissions',
    exact: true,
  });
  await previousDay.click();
  await expect(previousDay).toHaveAttribute('aria-pressed', 'true');
  await expect(todayButton).toHaveAttribute('aria-pressed', 'false');
  await expect(tracker.locator('.tracker-day-detail')).toHaveText('September 6 · 3 accepted');

  await tracker.getByRole('button', { name: 'Previous month', exact: true }).click();
  const august = tracker.getByRole('table', { name: 'August 2026', exact: true });
  await expect(august).toBeVisible();
  await expect(
    august.getByRole('button', { name: 'August 1, 2026: 1 accepted submission', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await expect(august.locator('button:disabled')).toHaveCount(0);
  await expect(tracker.getByRole('button', { name: 'Next month', exact: true })).toBeEnabled();
  await tracker.getByRole('button', { name: 'Next month', exact: true }).click();
  await expect(september).toBeVisible();
  await expect(todayButton).toHaveAttribute('aria-pressed', 'true');
  await expect(tracker.getByTestId('current-streak')).toHaveText('2 days');
  await expect(tracker.getByTestId('best-streak')).toHaveText('5 days');
});

for (const failure of ['unavailable API', 'invalid activity response']) {
  test(`tracker reports ${failure} honestly and retries successfully`, async ({ page }) => {
    let failing = true;
    let requests = 0;
    await page.route(activityPath, (route) => {
      requests++;
      if (failing)
        return failure === 'unavailable API'
          ? route.fulfill({ status: 503, json: { error: 'Temporarily unavailable' } })
          : route.fulfill({ json: { days: [{ date: today, count: 'not a count' }] } });
      return route.fulfill({ json: { timeZone, days: [{ date: today, count: 2 }] } });
    });
    await page.goto('/#library');
    const tracker = page.getByRole('complementary', { name: 'Practice tracker' });
    await expect(tracker.getByRole('alert')).toContainText('Activity could not be loaded.');
    await expect(tracker.getByTestId('current-streak')).toHaveText('—');
    await expect(tracker.getByTestId('best-streak')).toHaveText('—');
    await expect(tracker.locator(`button[data-date="${today}"]`)).toHaveAccessibleName(
      'September 7, 2026: activity unavailable',
    );
    const beforeRetry = requests;
    failing = false;
    await tracker.getByRole('button', { name: 'Retry activity', exact: true }).click();
    await expect(tracker.getByRole('alert')).toHaveCount(0);
    await expect(tracker.getByTestId('current-streak')).toHaveText('1 day');
    await expect(tracker.getByTestId('best-streak')).toHaveText('1 day');
    await expect(tracker.locator('.tracker-day-detail')).toHaveText('September 7 · 2 accepted');
    expect(requests).toBeGreaterThan(beforeRetry);
  });
}

for (const width of [1440, 390]) {
  test(`tracker and library fit together without overflow at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    await mockActivity(page, []);
    await page.goto('/#library');
    const library = page.getByRole('main', { name: 'Practice library' });
    const tracker = library.getByRole('complementary', { name: 'Practice tracker' });
    await expect(tracker.getByTestId('current-streak')).toHaveText('0 days');
    const contentBounds = await library.locator('.pl-content').boundingBox();
    const trackerBounds = await tracker.boundingBox();
    expect(contentBounds).not.toBeNull();
    expect(trackerBounds).not.toBeNull();
    if (width === 1440) {
      expect(trackerBounds!.x).toBeGreaterThan(contentBounds!.x + contentBounds!.width);
      expect(Math.abs(trackerBounds!.y - contentBounds!.y)).toBeLessThanOrEqual(1);
    } else {
      expect(trackerBounds!.y).toBeGreaterThanOrEqual(contentBounds!.y + contentBounds!.height);
      expect(Math.abs(trackerBounds!.x - contentBounds!.x)).toBeLessThanOrEqual(1);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await library.getByRole('button', { name: 'All problems', exact: true }).click();
    await library
      .getByRole('searchbox', { name: 'Search problems', exact: true })
      .fill('Normalize text');
    await tracker.scrollIntoViewIfNeeded();
    await expect(tracker.getByRole('table', { name: 'September 2026', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  });
}

test('accepted activity refreshes only after the real isolated submission is acknowledged', async ({
  page,
  database,
}) => {
  const problem = authored.find((item) => item.id === 'python-core-normalize-text-01')!;
  let activityRequests = 0;
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/activity') activityRequests++;
  });
  await page.goto('/#library');
  const tracker = page.getByRole('complementary', { name: 'Practice tracker' });
  await expect(tracker.getByTestId('current-streak')).toHaveText('0 days');
  await page.getByRole('searchbox', { name: 'Search problems', exact: true }).fill(problem.title);
  await page.getByRole('button', { name: problem.title, exact: true }).click();
  const editor = page.getByRole('textbox', { name: 'Python solution editor' });
  await editor.click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.insertText(problem.referenceCode);
  await expect(page.locator('.app')).toHaveAttribute('data-save-state', 'saved');

  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let writeStarted = false;
  await page.route('**/api/state', async (route) => {
    if (route.request().method() === 'PUT') {
      writeStarted = true;
      await gate;
    }
    await route.continue();
  });
  const requestsBeforeSubmission = activityRequests;
  try {
    await page.getByRole('button', { name: 'Submit', exact: true }).click();
    await expect(page.getByText('Accepted', { exact: true })).toBeVisible({ timeout: 45_000 });
    await expect.poll(() => writeStarted).toBe(true);
    await expect(page.locator('.app')).toHaveAttribute('data-save-state', 'saving');
    await page.getByRole('link', { name: 'Code Practice library', exact: true }).click();
    await expect(tracker).toBeVisible();
    await expect(tracker.locator(`button[data-date="${today}"]`)).toHaveAttribute(
      'data-count',
      '0',
    );
    await expect(tracker.getByTestId('current-streak')).toHaveText('0 days');
    expect(
      (
        await database.client.query(
          `SELECT count(*)::int AS count FROM ${database.schema}.cp_submissions`,
        )
      ).rows[0].count,
    ).toBe(0);
  } finally {
    release();
  }

  await expect(page.locator('.app')).toHaveAttribute('data-save-state', 'saved');
  await expect(tracker.locator(`button[data-date="${today}"]`)).toHaveAttribute('data-count', '1');
  await expect(tracker.getByTestId('current-streak')).toHaveText('1 day');
  await expect(tracker.getByTestId('best-streak')).toHaveText('1 day');
  await expect(
    tracker.getByRole('img', { name: `1 of ${authored.length} problems solved`, exact: true }),
  ).toBeVisible();
  expect(activityRequests).toBeGreaterThan(requestsBeforeSubmission);
  const { rows } = await database.client.query(
    `SELECT attempt->>'status' AS status, attempt->>'at' AS at FROM ${database.schema}.cp_submissions`,
  );
  expect(rows).toEqual([{ status: 'accepted', at: fixedTime }]);
});

test('same-day focus refreshes archived activity even when the latest twenty attempts are unchanged', async ({
  page,
  database,
}) => {
  const problem = authored.find((item) => item.id === 'python-core-normalize-text-01')!;
  const progress: ProgressData = {
    version: 1,
    exercises: {
      [problem.id]: {
        draft: problem.referenceCode,
        updatedAt: fixedTime,
        solved: true,
        attempts: Array.from({ length: 20 }, (_, index) => ({
          id: `unchanged-attempt-${index}`,
          at: fixedTime,
          code: problem.referenceCode,
          passed: problem.cases.length,
          total: problem.cases.length,
          status: 'accepted',
          durationMs: 1,
        })),
      },
    },
  };
  await database.client.query(
    `UPDATE ${database.schema}.cp_state SET progress=$1::jsonb WHERE profile_id=1`,
    [JSON.stringify(progress)],
  );
  let days = [{ date: today, count: 20 }];
  await page.route(activityPath, (route) => route.fulfill({ json: { timeZone, days } }));
  await page.goto('/#library');
  const tracker = page.getByRole('complementary', { name: 'Practice tracker' });
  await expect(tracker.getByTestId('current-streak')).toHaveText('1 day');
  await expect(tracker.locator(`button[data-date="${today}"]`)).toHaveAttribute('data-count', '20');

  // An older accepted submission was archived elsewhere. The current browser's
  // date, saved progress, and twenty visible attempt IDs remain identical.
  days = [
    { date: '2026-09-06', count: 1 },
    { date: today, count: 20 },
  ];
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(tracker.getByTestId('current-streak')).toHaveText('2 days');
  await expect(tracker.getByTestId('best-streak')).toHaveText('2 days');
  await expect(tracker.locator('button[data-date="2026-09-06"]')).toHaveAttribute(
    'data-count',
    '1',
  );
  await expect(tracker.locator(`button[data-date="${today}"]`)).toHaveAttribute(
    'aria-current',
    'date',
  );
  expect(
    (
      await database.client.query(
        `SELECT progress FROM ${database.schema}.cp_state WHERE profile_id=1`,
      )
    ).rows[0].progress,
  ).toEqual(progress);
});

test('activity retry works while an unrelated draft remains offline and unacknowledged', async ({
  page,
  database,
}) => {
  const problem = authored.find((item) => item.id === 'python-core-normalize-text-01')!;
  // Block only state writes in every document; activity reads remain available.
  // This also catches pagehide writes outside Playwright's route interception.
  await page.addInitScript(() => {
    const originalFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      const method = (
        init?.method ?? (input instanceof Request ? input.method : 'GET')
      ).toUpperCase();
      if (url.endsWith('/api/state') && method === 'PUT')
        return Promise.reject(new TypeError('Failed to fetch'));
      return originalFetch(input, init);
    };
  });
  let activityAvailable = false;
  await page.route(activityPath, (route) =>
    activityAvailable
      ? route.fulfill({ json: { timeZone, days: [{ date: today, count: 1 }] } })
      : route.fulfill({ status: 503, json: { error: 'Temporarily unavailable' } }),
  );
  await page.goto(`/#${problem.id}`);
  await expect(page.locator('.app')).toHaveAttribute('data-save-state', 'saved');
  const editor = page.getByRole('textbox', { name: 'Python solution editor' });
  await editor.click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.insertText(
    '# This draft has not reached the database\n' + problem.referenceCode,
  );
  await expect(page.locator('.app')).toHaveAttribute('data-save-state', 'offline');
  await page.getByRole('link', { name: 'Code Practice library', exact: true }).click();
  const tracker = page.getByRole('complementary', { name: 'Practice tracker' });
  await expect(tracker.getByRole('alert')).toContainText('Activity could not be loaded.');
  await expect(tracker.getByTestId('current-streak')).toHaveText('—');

  activityAvailable = true;
  await tracker.getByRole('button', { name: 'Retry activity', exact: true }).click();
  await expect(tracker.getByRole('alert')).toHaveCount(0);
  await expect(tracker.getByTestId('current-streak')).toHaveText('1 day');
  await expect(tracker.locator(`button[data-date="${today}"]`)).toHaveAttribute('data-count', '1');
  await expect(page.locator('.app')).toHaveAttribute('data-save-state', 'offline');
  expect(
    (
      await database.client.query(
        `SELECT progress FROM ${database.schema}.cp_state WHERE profile_id=1`,
      )
    ).rows[0].progress.exercises[problem.id],
  ).toBeUndefined();
});
