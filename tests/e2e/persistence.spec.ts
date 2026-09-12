import type { Page } from '@playwright/test';
import http from 'node:http';
import { expect, test, type TestCatalog, type TestDatabase } from './fixtures';
import { projectRoot } from './database-runtime.mjs';

const origin = 'http://127.0.0.1:5173';
const id = 'python-core-normalize-text-01';
let authored: TestCatalog['exercises'];
let reference: string;
const progressKey = 'coding-practice:progress:v1';
const starsKey = 'coding-practice:starred:v1';
const migrationKey = 'coding-practice:migration:postgres:v1';
const outboxPrefix = 'coding-practice:pending:postgres:v1:';

test.beforeEach(async ({ catalog }) => {
  authored = catalog.exercises;
  const problem = authored.find((item) => item.id === id);
  expect(problem, 'The persistence scenario needs its catalog problem.').toBeDefined();
  reference = problem!.referenceCode;
});

async function setCode(page: Page, code: string) {
  const editor = page.getByRole('textbox', { name: 'Python solution editor' });
  await editor.click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.insertText(code);
  await expectCode(page, code);
}

async function expectCode(page: Page, code: string) {
  // CodeMirror renders each line as a block; textContent omits the newlines.
  // Joining line nodes preserves indentation and trailing blank lines exactly.
  const lines = page.getByRole('textbox', { name: 'Python solution editor' }).locator('.cm-line');
  await expect
    .poll(() =>
      lines.evaluateAll((nodes) => nodes.map((node) => node.textContent ?? '').join('\n')),
    )
    .toBe(code);
}

async function state(database: TestDatabase) {
  return (
    await database.client.query(
      `SELECT revision, progress, stars FROM ${database.schema}.cp_state WHERE profile_id=1`,
    )
  ).rows[0];
}

async function showAll(page: Page) {
  await page.goto(origin + '/');
  await page.getByRole('button', { name: /^All problems/ }).click();
}

test('private database files are not served by the development app', async () => {
  const absolute = projectRoot.replaceAll('\\', '/');
  const manifest = `tests/.local/e2e-runtime/${process.env.CODE_PRACTICE_E2E_RUN_ID}.json`;
  const paths = [
    '/.env',
    '/%2eenv',
    '/.env?raw',
    `/@fs/${absolute}.env`,
    `/${manifest}`,
    `/${manifest.replace('.local', '%2elocal')}?raw`,
    `/@fs/${absolute}${manifest}`,
  ];
  for (const pathname of paths) {
    // Do not collect response bodies or put possible credentials into a browser
    // trace. Even a failure reports only the URL path, status, and media type.
    const response = await new Promise<{ status: number; contentType: string }>(
      (resolve, reject) => {
        const request = http.get(origin + pathname, (incoming) => {
          const result = {
            status: incoming.statusCode!,
            contentType: String(incoming.headers['content-type'] ?? ''),
          };
          incoming.resume();
          incoming.once('end', () => resolve(result));
          incoming.once('error', reject);
        });
        request.setTimeout(5_000, () =>
          request.destroy(new Error('Private-file guard request timed out.')),
        );
        request.once('error', reject);
      },
    );
    expect([403, 404], `Private path must be denied: ${pathname}`).toContain(response.status);
    expect(response.contentType).not.toMatch(/application\/json/i);
  }
});

test('acknowledged drafts, stars, and real submissions are available in a fresh browser context', async ({
  page,
  browser,
  database,
}) => {
  const draft = '# saved in PostgreSQL, not this browser\n' + reference;
  await page.goto(`/problems/${id}`);
  await setCode(page, draft);
  await page.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(page.getByText('Accepted', { exact: true })).toBeVisible({ timeout: 45_000 });
  await expect(page.locator('.app')).toHaveAttribute('data-save-state', 'saved');
  await showAll(page);
  await page.getByRole('button', { name: 'Star Normalize text', exact: true }).click();
  await expect.poll(async () => (await state(database)).stars).toEqual([id]);
  const saved = await state(database);
  expect(saved.progress.exercises[id]).toMatchObject({ draft, solved: true });
  const submissions = (
    await database.client.query(
      `SELECT exercise_id, problem_version, grading_source, attempt FROM ${database.schema}.cp_submissions`,
    )
  ).rows;
  expect(submissions).toHaveLength(1);
  expect(submissions[0]).toMatchObject({
    exercise_id: id,
    grading_source: 'browser',
    attempt: { code: draft, status: 'accepted', passed: 8, total: 8 },
  });
  expect(submissions[0].problem_version).toMatch(/^[a-f0-9]{64}$/);

  const fresh = await browser.newContext();
  try {
    const second = await fresh.newPage();
    await second.goto(`${origin}/problems/${id}`);
    await expectCode(second, draft);
    await expect(second.locator('.solved-label')).toBeVisible();
    await expect(second.locator('.topbar-actions, .workspace-progress')).toHaveCount(0);
    await expect(second.locator('.app')).toHaveAttribute('data-save-state', 'saved');
    expect(await second.evaluate(() => localStorage.length)).toBe(0);
    await second.getByRole('tab', { name: /Submissions/ }).click();
    await expect(second.getByRole('button', { name: /Accepted.*8\/8/ })).toBeVisible();
    await showAll(second);
    await expect(
      second.getByRole('button', { name: 'Unstar Normalize text', exact: true }),
    ).toHaveAttribute('aria-pressed', 'true');
  } finally {
    await fresh.close();
  }
});

test('legacy migration archives all attempts, retains unknown IDs and original bytes, and never re-stars on replay', async ({
  page,
  database,
}) => {
  const at = '2026-09-08T12:00:00.000Z';
  const attempts = Array.from({ length: 25 }, (_, index) => ({
    id: `legacy-attempt-${String(index).padStart(2, '0')}`,
    at,
    code: reference,
    passed: 8,
    total: 8,
    status: 'accepted',
    durationMs: 1,
  }));
  const legacy = {
    version: 1,
    exercises: {
      [id]: { draft: '# migrated draft\n' + reference, updatedAt: at, solved: true, attempts },
      'legacy-removed-problem': {
        draft: '# unknown ID is still mine',
        updatedAt: at,
        solved: false,
        attempts: [],
      },
    },
  };
  const rawProgress = JSON.stringify(legacy, null, 2);
  const rawStars = JSON.stringify([id, 'legacy-removed-star'], null, 2);
  await page.addInitScript(
    ({ progressKey, starsKey, rawProgress, rawStars }) => {
      if (localStorage.getItem(progressKey) === null)
        localStorage.setItem(progressKey, rawProgress);
      if (localStorage.getItem(starsKey) === null) localStorage.setItem(starsKey, rawStars);
    },
    { progressKey, starsKey, rawProgress, rawStars },
  );
  await page.goto(`/problems/${id}`);
  await expect(page.getByRole('textbox', { name: 'Python solution editor' })).toContainText(
    '# migrated draft',
  );
  await expect(page.locator('.app')).toHaveAttribute('data-save-state', 'saved');
  await page.getByRole('tab', { name: /Submissions/ }).click();
  await expect(page.locator('.submission-row')).toHaveCount(20);
  const migrated = await state(database);
  expect(migrated.progress.exercises['legacy-removed-problem']).toEqual(
    legacy.exercises['legacy-removed-problem'],
  );
  expect(migrated.progress.exercises[id].attempts).toHaveLength(20);
  expect(migrated.stars.sort()).toEqual([id, 'legacy-removed-star'].sort());
  expect(
    Number(
      (await database.client.query(`SELECT count(*) FROM ${database.schema}.cp_submissions`))
        .rows[0].count,
    ),
  ).toBe(25);
  expect(
    Number(
      (await database.client.query(`SELECT count(*) FROM ${database.schema}.cp_migration_receipts`))
        .rows[0].count,
    ),
  ).toBe(1);
  await showAll(page);
  await page.getByRole('button', { name: 'Unstar Normalize text', exact: true }).click();
  await expect.poll(async () => (await state(database)).stars).toEqual(['legacy-removed-star']);
  // Simulate losing only the local migration receipt; the original data stays.
  await page.evaluate((key) => localStorage.removeItem(key), migrationKey);
  await page.reload();
  await page.getByRole('button', { name: /^All problems/ }).click();
  await expect(
    page.getByRole('button', { name: 'Star Normalize text', exact: true }),
  ).toHaveAttribute('aria-pressed', 'false');
  expect((await state(database)).stars).toEqual(['legacy-removed-star']);
  expect(
    await page.evaluate(
      ({ progressKey, starsKey }) => [
        localStorage.getItem(progressKey),
        localStorage.getItem(starsKey),
      ],
      { progressKey, starsKey },
    ),
  ).toEqual([rawProgress, rawStars]);
  expect(
    Number(
      (await database.client.query(`SELECT count(*) FROM ${database.schema}.cp_submissions`))
        .rows[0].count,
    ),
  ).toBe(25);
  expect(
    Number(
      (await database.client.query(`SELECT count(*) FROM ${database.schema}.cp_migration_receipts`))
        .rows[0].count,
    ),
  ).toBe(1);
});

test('failed network saves stay visibly pending across reload and recover only after database acknowledgement', async ({
  page,
  context,
  database,
}) => {
  // Chromium can send pagehide fetches outside Playwright's route interception.
  // Fail the data transport in every document (including the outgoing one),
  // while still allowing the app and read-only hydration requests to load.
  await context.addInitScript(() => {
    const transport = window as Window & { __e2eDataOnline?: boolean };
    transport.__e2eDataOnline = false;
    const originalFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      const method = (
        init?.method ?? (input instanceof Request ? input.method : 'GET')
      ).toUpperCase();
      if (!transport.__e2eDataOnline && url.endsWith('/api/state') && method === 'PUT') {
        return Promise.reject(new TypeError('Failed to fetch'));
      }
      return originalFetch(input, init);
    };
  });
  await page.goto(`/problems/${id}`);
  await expect(page.locator('.app')).toHaveAttribute('data-save-state', 'saved');
  const draft = '# survives an interrupted connection\n' + reference;
  await setCode(page, draft);
  await expect(page.locator('.app')).toHaveAttribute('data-save-state', 'offline');
  await expect(page.locator('.warning-banner')).toBeVisible();
  expect((await state(database)).progress.exercises[id]).toBeUndefined();
  expect(
    await page.evaluate(
      (prefix) =>
        Object.keys(localStorage).some(
          (key) =>
            key.startsWith(prefix) &&
            JSON.parse(localStorage.getItem(key)!).progress?.exercises[
              'python-core-normalize-text-01'
            ],
        ),
      outboxPrefix,
    ),
  ).toBe(true);
  await page.reload();
  await expectCode(page, draft);
  await expect(page.locator('.app')).toHaveAttribute('data-save-state', 'offline');
  expect((await state(database)).progress.exercises[id]).toBeUndefined();
  await page.evaluate(() => {
    (window as Window & { __e2eDataOnline?: boolean }).__e2eDataOnline = true;
  });
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.locator('.app')).toHaveAttribute('data-save-state', 'saved');
  expect((await state(database)).progress.exercises[id].draft).toBe(draft);
  await page.reload();
  await expectCode(page, draft);
  await expect(page.locator('.app')).toHaveAttribute('data-save-state', 'saved');
});

test('saving status is not successful while the database request is still unacknowledged', async ({
  page,
  database,
}) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started!: () => void;
  const requestStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  await page.goto(`/problems/${id}`);
  await expect(page.locator('.app')).toHaveAttribute('data-save-state', 'saved');
  await page.route('**/api/state', async (route) => {
    if (route.request().method() !== 'PUT') {
      await route.continue();
      return;
    }
    started();
    await gate;
    await route.continue();
  });
  try {
    await setCode(page, reference);
    await requestStarted;
    await expect(page.locator('.app')).toHaveAttribute('data-save-state', 'saving');
    expect((await state(database)).progress.exercises[id]).toBeUndefined();
  } finally {
    release();
  }
  await expect(page.locator('.app')).toHaveAttribute('data-save-state', 'saved');
  expect((await state(database)).progress.exercises[id].draft).toBe(reference);
});

test('a committed save with a lost acknowledgement cannot resurrect a star removed by another browser', async ({
  page,
  browser,
  database,
}) => {
  await showAll(page);
  let committed = false;
  await page.route('**/api/state', async (route) => {
    if (route.request().method() !== 'PUT') {
      await route.continue();
      return;
    }
    if (!committed) {
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      committed = true;
    }
    await route.abort('failed');
  });
  await page.getByRole('button', { name: 'Star Normalize text', exact: true }).click();
  await expect(page.locator('.warning-banner')).toBeVisible();
  await expect.poll(async () => (await state(database)).stars).toEqual([id]);
  expect(
    Number(
      (await database.client.query(`SELECT count(*) FROM ${database.schema}.cp_write_receipts`))
        .rows[0].count,
    ),
  ).toBe(1);
  const fresh = await browser.newContext();
  try {
    const second = await fresh.newPage();
    await showAll(second);
    await second.getByRole('button', { name: 'Unstar Normalize text', exact: true }).click();
    await expect.poll(async () => (await state(database)).stars).toEqual([]);
    await page.unroute('**/api/state');
    await page.reload();
    await page.getByRole('button', { name: /^All problems/ }).click();
    await expect(
      page.getByRole('button', { name: 'Star Normalize text', exact: true }),
    ).toHaveAttribute('aria-pressed', 'false');
    await page.getByRole('button', { name: 'Normalize text', exact: true }).click();
    await setCode(page, '# newer draft after lost acknowledgement\n' + reference);
    await expect(page.locator('.app')).toHaveAttribute('data-save-state', 'saved');
    const saved = await state(database);
    expect(saved.stars).toEqual([]);
    expect(saved.progress.exercises[id].draft).toContain(
      '# newer draft after lost acknowledgement',
    );
  } finally {
    await fresh.close();
  }
});

test('stale browser revisions merge unrelated drafts and preserve another browser’s star', async ({
  page,
  browser,
  database,
}) => {
  const actualOther = authored.find(
    (problem) => problem.id !== id && problem.language === 'Python',
  )!;
  expect(actualOther).toBeDefined();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started!: () => void;
  const requestStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  await page.goto(`/problems/${id}`);
  await expect(page.locator('.app')).toHaveAttribute('data-save-state', 'saved');
  const fresh = await browser.newContext();
  try {
    const second = await fresh.newPage();
    await second.goto(`${origin}/problems/${actualOther.id}`);
    await expect(second.locator('.app')).toHaveAttribute('data-save-state', 'saved');
    const statuses: number[] = [];
    second.on('response', (response) => {
      if (response.url().endsWith('/api/state') && response.request().method() === 'PUT')
        statuses.push(response.status());
    });
    await second.route('**/api/state', async (route) => {
      if (route.request().method() === 'PUT') {
        started();
        await gate;
      }
      await route.continue();
    });
    await setCode(second, '# second browser draft\n' + actualOther.starterCode);
    await requestStarted;
    await setCode(page, '# first browser draft\n' + reference);
    await expect(page.locator('.app')).toHaveAttribute('data-save-state', 'saved');
    await showAll(page);
    await page.getByRole('button', { name: 'Star Normalize text', exact: true }).click();
    await expect.poll(async () => (await state(database)).stars).toEqual([id]);
    release();
    await expect(second.locator('.app')).toHaveAttribute('data-save-state', 'saved');
    expect(statuses).toContain(409);
    expect(statuses).toContain(200);
    const saved = await state(database);
    expect(saved.progress.exercises[id].draft).toContain('# first browser draft');
    expect(saved.progress.exercises[actualOther.id].draft).toContain('# second browser draft');
    expect(saved.stars).toEqual([id]);
  } finally {
    release();
    await fresh.close();
  }
});

for (const unavailable of ['catalog', 'state']) {
  test(`unavailable database ${unavailable} prevents fabricated startup and Retry recovers`, async ({
    page,
    database,
  }) => {
    await page.route(`**/api/${unavailable}`, (route) => route.abort('failed'));
    await page.goto(`/problems/${id}`);
    await expect(
      page.getByRole('heading', { name: 'Practice could not be loaded', exact: true }),
    ).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Python solution editor' })).toHaveCount(0);
    await expect(page.getByRole('main', { name: 'Practice library' })).toHaveCount(0);
    expect(Number((await state(database)).revision)).toBe(0);
    await page.unroute(`**/api/${unavailable}`);
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Normalize text', exact: true })).toBeVisible();
    await expect(page.locator('.app')).toHaveAttribute('data-save-state', 'saved');
  });
}
