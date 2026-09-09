import { test, expect } from './fixtures';

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

test('editable and reference editors have no active-row or gutter highlight', async ({ page }) => {
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
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
