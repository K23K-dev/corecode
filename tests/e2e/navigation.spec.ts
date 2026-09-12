import { test, expect, type Page, type Route } from '@playwright/test';
import { fixtureDecks, fixtureExercises } from '../database-fixtures';
import type { StateSnapshot } from '../../src/lib/database-client';
import { practiceClock, summarizeActivity } from '../../shared/practice-activity.mjs';

// This narrow migration smoke test never calls a database or code runner. The
// default E2E suite still uses its separately authorized, guarded Neon schema.
test.skip(process.env.CODE_PRACTICE_E2E_OFFLINE !== '1', 'Explicit offline mode only.');

const exercises = fixtureExercises.map((exercise) => ({
  ...exercise,
  version: 'a'.repeat(64),
  explanation: 'Return the value unchanged.',
  examples: [{ input: '(1,)', output: '1' }],
  requirements: [],
}));
const problem = exercises[0];
const origin = 'http://127.0.0.1:5173';
const problemPath = `/problems/${problem.id}`;

async function mockApi(page: Page) {
  let state: StateSnapshot = {
    revision: 0,
    progress: { version: 1, exercises: {} },
    stars: [],
    migrations: [],
    writes: [],
  };
  const unexpected: string[] = [];
  const runs: Array<{ mode: string; code: string }> = [];
  let pending: Route | undefined;
  let holdRun = false;
  await page.route('**/api/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const method = route.request().method();
    if (pathname === '/api/catalog' && method === 'GET')
      return route.fulfill({ json: { version: 'b'.repeat(64), decks: fixtureDecks, exercises } });
    if (pathname === '/api/state') {
      if (method === 'PUT') {
        const update = route.request().postDataJSON();
        state = {
          revision: state.revision + 1,
          progress: update.progress,
          stars: update.stars,
          migrations: [...state.migrations, ...(update.migrationId ? [update.migrationId] : [])],
          writes: [...state.writes, ...update.writeIds],
        };
      } else if (method !== 'GET') {
        unexpected.push(`${method} ${pathname}`);
        return route.abort('blockedbyclient');
      }
      return route.fulfill({ json: state });
    }
    if (pathname === '/api/activity' && method === 'GET') {
      const now = new Date();
      const clock = practiceClock(now);
      return route.fulfill({
        json: {
          ...clock,
          timeZone: 'America/New_York',
          resetHour: 20,
          serverNow: now.toISOString(),
          days: [],
          repairs: [],
          streak: summarizeActivity([], [], clock.today),
        },
      });
    }
    if (pathname === '/api/run' && method === 'POST') {
      runs.push(route.request().postDataJSON());
      if (holdRun) {
        pending = route;
        return;
      }
      return route.fulfill({
        json: {
          cases: [{ name: 'Identity', input: '(1,)', expected: '1', actual: '1', passed: true }],
          stdout: '',
          durationMs: 1,
        },
      });
    }
    unexpected.push(`${method} ${pathname}`);
    await route.abort('blockedbyclient');
  });
  return {
    unexpected,
    runs,
    state: () => state,
    hold: () => {
      holdRun = true;
    },
    release: async () => {
      await pending?.abort('aborted').catch(() => {});
    },
  };
}

async function expectCode(page: Page, code: string) {
  await expect
    .poll(() =>
      page
        .locator('.editor-area .cm-line')
        .evaluateAll((lines) => lines.map((line) => line.textContent ?? '').join('\n')),
    )
    .toBe(code);
}

test('Next routes preserve navigation, drafts, and submission feedback without external services', async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  const api = await mockApi(page);
  await page.goto('/');
  const library = page.getByRole('main', { name: 'Practice library' });
  await expect(library).toBeVisible();
  await expect(page).toHaveTitle('Code Practice');
  await expect(page.locator('[data-nextjs-dialog]')).toHaveCount(0);
  await library.getByRole('button', { name: 'Python 0 of 1 solved', exact: true }).click();
  await page.getByRole('button', { name: 'Previous month', exact: true }).click();
  const viewedMonth = await page.locator('.tracker-month-heading h2').innerText();
  const calendarDay = page.locator('.tracker-month button').first();
  const selectedDate = await calendarDay.getAttribute('data-date');
  await calendarDay.click();
  await page.screenshot({ path: testInfo.outputPath('next-library-desktop.png'), fullPage: true });
  await library.getByRole('button', { name: problem.title, exact: true }).click();
  await expect(page).toHaveURL(origin + problemPath);
  await expect(page.getByRole('heading', { name: problem.title, exact: true })).toBeVisible();
  const draft = '# draft survives Next navigation\n' + problem.referenceCode;
  const editor = page.locator('.editor-area').getByRole('textbox');
  await editor.fill(draft);
  await expectCode(page, draft);
  await expect(page.locator('.app')).toHaveAttribute('data-save-state', 'saved');
  await page.goBack();
  await expect(
    library.getByRole('button', { name: 'Python 0 of 1 solved', exact: true }),
  ).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('.tracker-month-heading h2')).toHaveText(viewedMonth);
  await expect(page.locator(`.tracker-month button[data-date="${selectedDate}"]`)).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  const search = library.getByRole('searchbox', { name: 'Search problems', exact: true });
  await search.fill(problem.title);
  await library.getByRole('button', { name: problem.title, exact: true }).click();
  await expectCode(page, draft);
  await page.goBack();
  await expect(search).toHaveValue(problem.title);
  await page.goForward();
  await expect(page).toHaveURL(origin + problemPath);
  await expectCode(page, draft);
  await page.reload();
  await expectCode(page, draft);
  await expect(page).toHaveTitle(`${problem.title} · Code Practice`);

  await page.getByRole('link', { name: 'Code Practice library', exact: true }).click();
  await library
    .getByRole('searchbox', { name: 'Search problems', exact: true })
    .fill(problem.title);
  await library
    .getByRole('button', { name: `View solution for ${problem.title}`, exact: true })
    .click();
  await expect(page).toHaveURL(origin + problemPath + '?tab=solution');
  await expect(page.getByRole('tab', { name: 'Solution', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.locator('.reference-code')).toContainText('Return the value unchanged.');
  await expectCode(page, draft);
  await page.getByRole('tab', { name: 'Question', exact: true }).click();

  await page.getByRole('button', { name: 'Run example', exact: true }).click();
  await expect(page.getByText('Example passed', { exact: true })).toBeVisible();
  await expect(page.locator('.submission-celebration')).toHaveCount(0);
  expect(api.runs.at(-1)).toMatchObject({ mode: 'example', code: draft });
  await page.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(page.getByText('Accepted', { exact: true })).toBeVisible();
  await expect(page.locator('.app')).toHaveAttribute('data-save-state', 'saved');
  expect(api.runs.at(-1)).toMatchObject({ mode: 'submit', code: draft });
  expect(api.state().progress.exercises[problem.id].attempts).toHaveLength(1);
  await expect(page.locator('.case-detail .value-block > span')).toHaveText([
    'Input',
    'Your Output',
    'Expected Output',
  ]);
  await page.screenshot({
    path: testInfo.outputPath('next-workspace-desktop.png'),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Code & results', exact: true }).click();
  await expect(editor).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('next-workspace-mobile.png'), fullPage: true });

  api.hold();
  await page.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await api.release();
  await expect(page.getByRole('button', { name: 'Submit', exact: true })).toBeEnabled();
  expect(api.state().progress.exercises[problem.id].attempts).toHaveLength(1);
  await page.goto(`/#${problem.id}`);
  await expect(page).toHaveURL(origin + problemPath);
  await expectCode(page, draft);
  await page.goto('/#library');
  await expect(page).toHaveURL(origin + '/');
  await expect(library).toBeVisible();
  expect(api.unexpected).toEqual([]);
  expect(errors).toEqual([]);
});
