import type { Page } from '@playwright/test';
import { expect, test, type TestCatalog } from './fixtures';
import type { ProgressData } from '../../src/lib/progress';
import type { ActivityDay, ActivitySnapshot } from '../../src/lib/practice-activity';
import { practiceClock, summarizeActivity } from '../../shared/practice-activity.mjs';

const timeZone = 'America/New_York';
// Midday Eastern, safely inside the September 7 practice day.
const fixedTime = '2026-09-07T16:30:00.000Z';
const today = '2026-09-07';
const activityPath = /\/api\/activity(?:\?.*)?$/;
const repairsPath = '**/api/activity/repairs';
const difficulties = ['Easy', 'Medium', 'Hard'] as const;
let authored: TestCatalog['exercises'];

test.use({ timezoneId: timeZone, locale: 'en-US' });
test.beforeEach(async ({ page, catalog }) => {
  authored = catalog.exercises;
  await page.clock.setFixedTime(fixedTime);
});

function activitySnapshot(
  days: ActivityDay[],
  repairs: string[] = [],
  serverNow = fixedTime,
): ActivitySnapshot {
  const clock = practiceClock(new Date(serverNow));
  return {
    timeZone,
    resetHour: 20,
    ...clock,
    serverNow,
    days,
    repairs,
    streak: summarizeActivity(days, repairs, clock.today),
  };
}

async function mockActivity(page: Page, days: ActivityDay[]) {
  await page.route(activityPath, (route) => route.fulfill({ json: activitySnapshot(days) }));
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

const repairableDays: ActivityDay[] = [
  ...[1, 2, 3, 4, 5].map((day) => ({ date: `2026-09-0${day}`, count: 1 })),
  { date: today, count: 2 },
];
const missedDate = '2026-09-06';

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
  await expect(tracker.getByText('Five solved days in a streak earn one heart.')).toHaveCount(0);
  await expect(tracker.locator('[aria-label="Calendar legend"]')).toHaveCount(0);

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

test('calendar uses the Eastern practice day, navigates months, and distinguishes current from best streak', async ({
  page,
}) => {
  const days = [
    ...[1, 2, 3, 4, 5].map((day) => ({ date: `2026-08-0${day}`, count: 1 })),
    { date: '2026-09-05', count: 1 },
    { date: '2026-09-06', count: 3 },
  ];
  const requestedQueries: string[] = [];
  await page.route(activityPath, (route) => {
    requestedQueries.push(new URL(route.request().url()).search);
    return route.fulfill({ json: activitySnapshot(days) });
  });
  await page.goto('/#library');
  const tracker = page.getByRole('complementary', { name: 'Practice tracker' });
  await expect(tracker.getByTestId('current-streak')).toHaveText('2 days');
  await expect(tracker.getByTestId('best-streak')).toHaveText('5 days');
  expect(requestedQueries.length).toBeGreaterThan(0);
  expect(requestedQueries.every((query) => query === '')).toBe(true);
  await expect(tracker.getByTestId('tracker-day')).toHaveText('Day 7');
  // The synchronized clock continues ticking while the other assertions run.
  await expect(tracker.getByTestId('tracker-reset-countdown')).toHaveText(
    /^07:(?:30:00|29:\d{2}) left$/,
  );
  await expect(tracker.getByTestId('tracker-hearts')).toHaveText('1');
  await expect(tracker.getByTestId('tracker-heart-progress')).toHaveText('2/5 to next');

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

for (const boundary of [
  { before: '2026-09-07T23:59:58.000Z', after: '2026-09-08T00:00:00.000Z' },
  // The fall DST transition has ended: 8 PM Eastern is now 01:00 UTC, not 00:00.
  { before: '2026-11-02T00:59:58.000Z', after: '2026-11-02T01:00:00.000Z' },
]) {
  test(`tracker rolls over at 20:00 Eastern from ${boundary.before}`, async ({ page }) => {
    await page.clock.pauseAt(new Date(boundary.before));
    await page.clock.setSystemTime(new Date(boundary.before));
    let serverNow = boundary.before;
    let requests = 0;
    const previousDay = practiceClock(new Date(boundary.before)).today;
    const nextDay = practiceClock(new Date(boundary.after)).today;
    await page.route(activityPath, (route) => {
      requests++;
      return route.fulfill({ json: activitySnapshot([], [], serverNow) });
    });
    await page.goto('/#library');
    const tracker = page.getByRole('complementary', { name: 'Practice tracker' });
    await expect(tracker.getByTestId('tracker-reset-countdown')).toHaveText('00:00:02 left');
    await expect(tracker.getByTestId('tracker-day')).toHaveText(
      `Day ${Number(previousDay.slice(-2))}`,
    );
    await expect(tracker.locator(`[data-date="${previousDay}"]`)).toHaveAttribute(
      'aria-current',
      'date',
    );
    await expect(tracker.getByTestId('tracker-reset-countdown')).toHaveAttribute(
      'title',
      'Day resets at 8 PM Eastern time',
    );
    const beforeRollover = requests;
    await page.clock.runFor(1_000);
    await expect(tracker.getByTestId('tracker-reset-countdown')).toHaveText('00:00:01 left');
    serverNow = boundary.after;
    await page.clock.runFor(1_000);
    await expect.poll(() => requests).toBeGreaterThan(beforeRollover);
    await expect(tracker.getByTestId('tracker-day')).toHaveText(`Day ${Number(nextDay.slice(-2))}`);
    await expect(tracker.locator(`[data-date="${nextDay}"]`)).toHaveAttribute(
      'aria-current',
      'date',
    );
    await expect(tracker.getByTestId('tracker-reset-countdown')).toHaveText('24:00:00 left');
  });
}

test('repair confirmation spends one heart, preserves accepted counts, and survives reload', async ({
  page,
}) => {
  let repairs: string[] = [];
  const posts: { date: string }[] = [];
  let stateWrites = 0;
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/state' && request.method() === 'PUT')
      stateWrites++;
  });
  await page.route(activityPath, (route) =>
    route.fulfill({ json: activitySnapshot(repairableDays, repairs) }),
  );
  await page.route(repairsPath, (route) => {
    expect(route.request().method()).toBe('POST');
    expect(route.request().headers()['x-code-practice-client']).toBe('1');
    posts.push(route.request().postDataJSON());
    repairs = [missedDate];
    return route.fulfill({ json: activitySnapshot(repairableDays, repairs) });
  });
  await page.goto('/#library');
  const tracker = page.getByRole('complementary', { name: 'Practice tracker' });
  const missed = tracker.locator(`[data-date="${missedDate}"]`);
  await expect(missed).toHaveClass(/is-missed-day/);
  await expect(missed).toHaveAccessibleName('September 6, 2026: missed day');
  await expect(tracker.getByTestId('tracker-hearts')).toHaveText('1');
  await expect(tracker.getByTestId('tracker-heart-progress')).toHaveText('1/5 to next');
  await missed.click();
  const dialog = page.getByRole('dialog', { name: 'Repair streak', exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(posts).toEqual([]);
  await expect(missed).toHaveClass(/is-missed-day/);
  await missed.click();
  await dialog.getByRole('button', { name: 'Use 1 heart', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(posts).toEqual([{ date: missedDate }]);
  await expect(missed).toHaveAccessibleName('September 6, 2026: repaired day');
  await expect(missed).toHaveClass(/is-repaired-day/);
  await expect(missed).not.toHaveClass(/is-active-day|is-missed-day/);
  await expect(missed).toHaveAttribute('data-count', '0');
  await expect(tracker.getByTestId('tracker-hearts')).toHaveText('0');
  await expect(tracker.getByTestId('current-streak')).toHaveText('7 days');
  await expect(tracker.getByTestId('best-streak')).toHaveText('7 days');
  await expect(tracker.locator(`[data-date="${today}"]`)).toHaveAttribute('data-count', '2');
  await expect(
    tracker.getByRole('img', { name: `0 of ${authored.length} problems solved`, exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(missed).toHaveAccessibleName('September 6, 2026: repaired day');
  await expect(tracker.getByTestId('tracker-hearts')).toHaveText('0');
  await expect(tracker.getByTestId('current-streak')).toHaveText('7 days');
  expect(posts).toHaveLength(1);
  expect(stateWrites).toBe(0);
});

test('only missed days since practice began offer repair and no hearts means no request', async ({
  page,
}) => {
  let posts = 0;
  await mockActivity(page, [
    { date: '2026-09-05', count: 1 },
    { date: today, count: 1 },
  ]);
  await page.route(repairsPath, (route) => {
    posts++;
    return route.fulfill({ status: 409, json: { error: 'No hearts available.' } });
  });
  await page.goto('/#library');
  const tracker = page.getByRole('complementary', { name: 'Practice tracker' });
  await expect(tracker.getByTestId('tracker-hearts')).toHaveText('0');
  const beforePractice = tracker.locator('[data-date="2026-09-01"]');
  await expect(beforePractice).not.toHaveClass(/is-missed-day/);
  await beforePractice.click();
  await expect(page.getByRole('dialog', { name: 'Repair streak', exact: true })).toHaveCount(0);
  await expect(tracker.locator(`[data-date="${today}"]`)).not.toHaveClass(/is-missed-day/);
  await expect(tracker.locator('[data-date="2026-09-08"]')).toBeDisabled();
  await tracker.locator(`[data-date="${missedDate}"]`).click();
  const dialog = page.getByRole('dialog', { name: 'Repair streak', exact: true });
  await expect(dialog).toContainText(
    'No hearts available. Solve on five days in a streak to earn one.',
  );
  await expect(dialog.getByRole('button', { name: 'Use 1 heart', exact: true })).toBeDisabled();
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    const layout = await dialog.evaluate((element) => {
      const heading = element.querySelector('.modal-header h2')!.getBoundingClientRect();
      const paragraphs = [...element.querySelectorAll('.tracker-repair-dialog > p')].map(
        (paragraph) => paragraph.getBoundingClientRect(),
      );
      const close = element.querySelector('.modal-header button')!.getBoundingClientRect();
      const confirm = element.querySelector('.modal-actions .primary')!.getBoundingClientRect();
      return {
        leftOffsets: paragraphs.map((paragraph) => Math.abs(paragraph.left - heading.left)),
        paragraphGaps: paragraphs
          .slice(1)
          .map((paragraph, index) => paragraph.top - paragraphs[index].bottom),
        actionOffset: Math.abs(confirm.right - close.right),
        inset: paragraphs[0].left - element.getBoundingClientRect().left,
        fits: element.scrollWidth <= element.clientWidth,
      };
    });
    expect(layout.leftOffsets.every((offset) => offset <= 1)).toBe(true);
    expect(layout.paragraphGaps.every((gap) => gap >= 10)).toBe(true);
    expect(layout.actionOffset).toBeLessThanOrEqual(1);
    expect(layout.inset).toBeGreaterThanOrEqual(18);
    expect(layout.fits).toBe(true);
  }
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(posts).toBe(0);
});

test('a failed repair leaves the day and heart unchanged and permits a safe retry', async ({
  page,
}) => {
  let failing = true;
  let posts = 0;
  let repairs: string[] = [];
  await page.route(activityPath, (route) =>
    route.fulfill({ json: activitySnapshot(repairableDays, repairs) }),
  );
  await page.route(repairsPath, (route) => {
    posts++;
    if (failing) return route.fulfill({ status: 503, json: { error: 'Temporarily unavailable' } });
    repairs = [missedDate];
    return route.fulfill({ json: activitySnapshot(repairableDays, repairs) });
  });
  await page.goto('/#library');
  const tracker = page.getByRole('complementary', { name: 'Practice tracker' });
  const missed = tracker.locator(`[data-date="${missedDate}"]`);
  await expect(tracker.getByTestId('tracker-hearts')).toHaveText('1');
  await missed.click();
  const dialog = page.getByRole('dialog', { name: 'Repair streak', exact: true });
  await dialog.getByRole('button', { name: 'Use 1 heart', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Repair could not be confirmed.');
  await expect(dialog.getByRole('button', { name: 'Use 1 heart', exact: true })).toBeEnabled();
  await expect(tracker.getByTestId('tracker-hearts')).toHaveText('1');
  await expect(missed).toHaveClass(/is-missed-day/);
  await expect(tracker.getByTestId('current-streak')).toHaveText('1 day');
  failing = false;
  await dialog.getByRole('button', { name: 'Use 1 heart', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(missed).toHaveClass(/is-repaired-day/);
  await expect(tracker.getByTestId('tracker-hearts')).toHaveText('0');
  expect(posts).toBe(2);
});

test('a lost last-heart repair response is reconciled by the next activity read without another charge', async ({
  page,
}) => {
  let repairs: string[] = [];
  let posts = 0;
  let confirmedReads = 0;
  await page.route(activityPath, (route) => {
    if (repairs.includes(missedDate)) confirmedReads++;
    return route.fulfill({ json: activitySnapshot(repairableDays, repairs) });
  });
  await page.route(repairsPath, (route) => {
    posts++;
    expect(route.request().postDataJSON()).toEqual({ date: missedDate });
    // The write committed, but the client never received its successful response.
    repairs = [missedDate];
    return route.fulfill({ status: 503, json: { error: 'Response unavailable' } });
  });
  await page.goto('/#library');
  const tracker = page.getByRole('complementary', { name: 'Practice tracker' });
  await expect(tracker.getByTestId('tracker-hearts')).toHaveText('1');
  const missed = tracker.locator(`[data-date="${missedDate}"]`);
  await missed.click();
  const dialog = page.getByRole('dialog', { name: 'Repair streak', exact: true });
  await dialog.getByRole('button', { name: 'Use 1 heart', exact: true }).click();
  await expect.poll(() => confirmedReads).toBeGreaterThan(0);
  await expect(dialog).toHaveCount(0);
  await expect(missed).toHaveAccessibleName('September 6, 2026: repaired day');
  await expect(missed).toHaveClass(/is-repaired-day/);
  await expect(missed).toHaveAttribute('data-count', '0');
  await expect(tracker.getByTestId('tracker-hearts')).toHaveText('0');
  await expect(tracker.getByTestId('current-streak')).toHaveText('7 days');
  expect(posts).toBe(1);
});

test('pending repairs cannot double-submit and late activity reads cannot undo a confirmed repair', async ({
  page,
}) => {
  let holdRead = false;
  let readStarted = false;
  let posts = 0;
  let repairs: string[] = [];
  const oldRead = deferred();
  const oldReadFinished = deferred();
  const repairResponse = deferred();
  await page.route(activityPath, async (route) => {
    const snapshot = activitySnapshot(repairableDays, repairs);
    if (holdRead) {
      holdRead = false;
      readStarted = true;
      await oldRead.promise;
      // A correctly invalidated fetch may already be aborted when it is released.
      await route.fulfill({ json: snapshot }).catch(() => {});
      oldReadFinished.resolve();
      return;
    }
    await route.fulfill({ json: snapshot });
  });
  await page.route(repairsPath, async (route) => {
    posts++;
    expect(route.request().postDataJSON()).toEqual({ date: missedDate });
    await repairResponse.promise;
    repairs = [missedDate];
    await route.fulfill({ json: activitySnapshot(repairableDays, repairs) });
  });
  await page.goto('/#library');
  const tracker = page.getByRole('complementary', { name: 'Practice tracker' });
  await expect(tracker.getByTestId('tracker-hearts')).toHaveText('1');
  holdRead = true;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect.poll(() => readStarted).toBe(true);
  await tracker.locator(`[data-date="${missedDate}"]`).click();
  const dialog = page.getByRole('dialog', { name: 'Repair streak', exact: true });
  try {
    await dialog.getByRole('button', { name: 'Use 1 heart', exact: true }).dblclick();
    await expect.poll(() => posts).toBe(1);
    await expect(dialog.getByRole('button', { name: 'Repairing…', exact: true })).toBeDisabled();
    repairResponse.resolve();
    await expect(dialog).toHaveCount(0);
    await expect(tracker.getByTestId('current-streak')).toHaveText('7 days');
    oldRead.resolve();
    await oldReadFinished.promise;
    await page.evaluate(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
    );
    await expect(tracker.getByTestId('tracker-hearts')).toHaveText('0');
    await expect(tracker.getByTestId('current-streak')).toHaveText('7 days');
    await expect(tracker.locator(`[data-date="${missedDate}"]`)).toHaveClass(/is-repaired-day/);
    expect(posts).toBe(1);
  } finally {
    oldRead.resolve();
    repairResponse.resolve();
  }
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
      return route.fulfill({ json: activitySnapshot([{ date: today, count: 2 }]) });
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
  request,
}) => {
  // This one case reads the real guarded test API. Align its submission timestamp
  // to the server clock rather than the other tests' deliberately historical clock.
  const initial = await request.get('/api/activity');
  expect(initial.ok()).toBe(true);
  const initialActivity = (await initial.json()) as ActivitySnapshot;
  const submissionTime = initialActivity.serverNow;
  const submissionDay = initialActivity.today;
  await page.clock.setFixedTime(submissionTime);
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
    await expect(tracker.locator(`button[data-date="${submissionDay}"]`)).toHaveAttribute(
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
  await expect(tracker.locator(`button[data-date="${submissionDay}"]`)).toHaveAttribute(
    'data-count',
    '1',
  );
  await expect(tracker.getByTestId('current-streak')).toHaveText('1 day');
  await expect(tracker.getByTestId('best-streak')).toHaveText('1 day');
  await expect(
    tracker.getByRole('img', { name: `1 of ${authored.length} problems solved`, exact: true }),
  ).toBeVisible();
  expect(activityRequests).toBeGreaterThan(requestsBeforeSubmission);
  const { rows } = await database.client.query(
    `SELECT attempt->>'status' AS status, attempt->>'at' AS at FROM ${database.schema}.cp_submissions`,
  );
  expect(rows).toEqual([{ status: 'accepted', at: submissionTime }]);
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
  await page.route(activityPath, (route) => route.fulfill({ json: activitySnapshot(days) }));
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
      ? route.fulfill({ json: activitySnapshot([{ date: today, count: 1 }]) })
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
