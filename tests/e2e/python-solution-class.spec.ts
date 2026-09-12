import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import type { ProgressData } from '../../src/lib/progress';

const scenarios = [
  {
    label: 'original Python',
    id: 'python-core-normalize-text-01',
    runtime: 'browser-python',
    method: 'normalize_text',
    custom: "('  MiXeD  ',)",
    output: "'mixed'",
    code: [
      'class Solution:',
      '    def normalize_text(self, text):',
      '        return self._trim(text).lower()',
      '',
      '    def _trim(self, text):',
      '        if text and text[0].isspace():',
      '            return self._trim(text[1:])',
      '        if text and text[-1].isspace():',
      '            return self._trim(text[:-1])',
      '        return text',
      '',
    ].join('\n'),
    legacy:
      '# Keep my original standalone draft byte-for-byte\ndef normalize_text(text):\n    return text.strip().lower()\n',
  },
  {
    label: 'native Python',
    id: 'python-core-rectangle-metrics-01',
    runtime: 'python',
    method: 'rectangle_metrics',
    custom: '(5, 6)',
    output: '(30, 22)',
    code: [
      'class Solution:',
      '    def rectangle_metrics(self, width, height):',
      '        return self._area(width, height), self._perimeter(width, height)',
      '',
      '    def _area(self, width, height):',
      '        return width * height',
      '',
      '    def _perimeter(self, width, height):',
      '        return 2 * (width + height)',
      '',
    ].join('\n'),
    legacy:
      '# Keep my original standalone draft byte-for-byte\ndef rectangle_metrics(width, height):\n    return width * height, 2 * (width + height)\n',
  },
] as const;

async function expectEditorCode(page: Page, code: string) {
  await expect
    .poll(() =>
      page
        .locator('.editor-area .cm-line')
        .evaluateAll((lines) => lines.map((line) => line.textContent ?? '').join('\n')),
    )
    .toBe(code);
}

async function setCode(page: Page, code: string) {
  const editor = page.getByRole('textbox', { name: 'Python solution editor' });
  await editor.click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.insertText(code);
  await expectEditorCode(page, code);
}

for (const scenario of scenarios) {
  test(`${scenario.label} Solution methods support real Run, Submit, and custom input`, async ({
    page,
    database,
    catalog,
  }, testInfo) => {
    const exercise = catalog.exercises.find((problem) => problem.id === scenario.id)!;
    expect(exercise).toBeDefined();
    expect(exercise.runtime).toBe(scenario.runtime);
    expect(exercise.starterCode).toContain('class Solution:');
    expect(exercise.starterCode).toMatch(new RegExp(`def ${scenario.method}\\(self(?:,|\\))`));
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.stack ?? error.message));
    await page.goto(`/problems/${scenario.id}`);
    await expectEditorCode(page, exercise.starterCode);
    await page.screenshot({
      path: testInfo.outputPath(`${scenario.runtime}-wrapped-starter.png`),
      fullPage: true,
    });
    await page.getByRole('tab', { name: 'Solution', exact: true }).click();
    await expect(page.locator('.reference-code .cm-content').first()).toContainText(
      'class Solution:',
    );
    await expectEditorCode(page, exercise.starterCode);
    await page.getByRole('tab', { name: 'Question', exact: true }).click();

    // These are learner-written instance methods, not catalog reference copies.
    // The original Python exercise also checks recursive self calls in a helper.
    await setCode(page, scenario.code);
    await page.getByRole('button', { name: 'Run example', exact: true }).click();
    await expect(page.getByText('Example passed', { exact: true })).toBeVisible({
      timeout: 45_000,
    });
    await expect(page.locator('.solved-label')).toHaveCount(0);
    await page.getByRole('button', { name: 'Submit', exact: true }).click();
    await expect(page.getByText('Accepted', { exact: true })).toBeVisible({ timeout: 45_000 });
    await expect(page.locator('.result-heading')).toContainText(
      `${exercise.cases.length} / ${exercise.cases.length} cases passed`,
    );
    await expect(page.locator('.app')).toHaveAttribute('data-save-state', 'saved');
    const submitted = (
      await database.client.query(
        `SELECT attempt FROM ${database.schema}.cp_submissions WHERE exercise_id=$1`,
        [scenario.id],
      )
    ).rows;
    expect(submitted).toHaveLength(1);
    expect(submitted[0].attempt).toMatchObject({
      code: scenario.code,
      status: 'accepted',
      passed: exercise.cases.length,
      total: exercise.cases.length,
    });

    await page.getByRole('tab', { name: 'Custom input', exact: true }).click();
    await page.getByLabel('Function arguments', { exact: true }).fill(scenario.custom);
    await page.getByRole('button', { name: 'Run input', exact: true }).click();
    await expect(page.getByText('Custom run', { exact: true })).toBeVisible({ timeout: 45_000 });
    await expect(page.getByText('Not graded', { exact: true })).toBeVisible();
    await expect(page.locator('.case-detail [aria-label="Your Output"] pre')).toHaveText(
      scenario.output,
    );
    await expect(page.locator('.case-detail .expected-output')).toHaveCount(0);
    expect(
      (
        await database.client.query(
          `SELECT count(*)::int AS count FROM ${database.schema}.cp_submissions WHERE exercise_id=$1`,
          [scenario.id],
        )
      ).rows[0].count,
    ).toBe(1);
    await page.reload();
    await expectEditorCode(page, scenario.code);
    await expect(page.locator('.solved-label')).toBeVisible();
    expect(errors).toEqual([]);
  });
}

test('previous standalone Python drafts survive wrapped catalog loading and still submit successfully', async ({
  page,
  database,
}) => {
  const updatedAt = '2026-09-01T12:00:00.000Z';
  const progress: ProgressData = { version: 1, exercises: {} };
  for (const scenario of scenarios) {
    progress.exercises[scenario.id] = {
      draft: scenario.legacy,
      updatedAt,
      solved: false,
      attempts: [],
    };
  }
  await database.client.query(
    `UPDATE ${database.schema}.cp_state SET progress=$1::jsonb WHERE profile_id=1`,
    [JSON.stringify(progress)],
  );
  for (const scenario of scenarios) {
    await page.goto(`/problems/${scenario.id}`);
    await expectEditorCode(page, scenario.legacy);
    await page.getByRole('tab', { name: 'Solution', exact: true }).click();
    await expect(page.locator('.reference-code .cm-content').first()).toContainText(
      'class Solution:',
    );
    await expectEditorCode(page, scenario.legacy);
    await page.reload();
    await expectEditorCode(page, scenario.legacy);
    await page.getByRole('button', { name: 'Submit', exact: true }).click();
    await expect(page.getByText('Accepted', { exact: true })).toBeVisible({ timeout: 45_000 });
    await expect(page.locator('.app')).toHaveAttribute('data-save-state', 'saved');
    const saved = (
      await database.client.query(
        `SELECT progress FROM ${database.schema}.cp_state WHERE profile_id=1`,
      )
    ).rows[0].progress;
    for (const preserved of scenarios)
      expect(saved.exercises[preserved.id].draft).toBe(preserved.legacy);
    expect(saved.exercises[scenario.id]).toMatchObject({ solved: true, draft: scenario.legacy });
    const archived = (
      await database.client.query(
        `SELECT attempt FROM ${database.schema}.cp_submissions WHERE exercise_id=$1`,
        [scenario.id],
      )
    ).rows;
    expect(archived).toHaveLength(1);
    expect(archived[0].attempt).toMatchObject({ code: scenario.legacy, status: 'accepted' });
  }
});
