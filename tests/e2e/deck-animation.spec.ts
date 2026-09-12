import { expect, test } from './fixtures';

test.use({ timezoneId: 'America/New_York', locale: 'en-US' });

// These checks only navigate the library; they do not submit code or change progress.
test('deck reveal uses natural height, rotates its chevron, and excludes collapsed controls', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('/');
  const group = page
    .locator('.pl-topic-group')
    .filter({ has: page.locator('.pl-topic-name', { hasText: /^Python$/ }) });
  const heading = group.locator('.pl-topic-heading');
  const panel = group.locator('.pl-topic-reveal');
  const chevron = heading.locator('svg');

  await expect(heading).toHaveAttribute('aria-expanded', 'false');
  await expect(panel).toHaveAttribute('inert', '');
  await expect(panel).toHaveAttribute('aria-hidden', 'true');
  await expect(panel).toHaveCSS('height', '0px');

  await heading.click();
  await expect(heading).toHaveAttribute('aria-expanded', 'true');
  await expect(panel).not.toHaveAttribute('inert');
  await expect(panel).toHaveAttribute('aria-hidden', 'false');
  await expect(panel).toBeVisible();
  await expect(chevron).toHaveCSS('transform', 'matrix(0, 1, -1, 0, 0, 0)');
  await expect
    .poll(() =>
      panel.evaluate((element) => {
        const body = element.querySelector('.pl-topic-body')!;
        return Math.abs(
          element.getBoundingClientRect().height - body.getBoundingClientRect().height,
        );
      }),
    )
    .toBeLessThan(1);

  await heading.click();
  await expect(panel).toHaveAttribute('inert', '');
  await expect(panel).toHaveAttribute('aria-hidden', 'true');
  await panel
    .locator('.pl-problem-link')
    .first()
    .evaluate((element) => (element as HTMLButtonElement).focus());
  await expect(heading).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.locator('.pl-topic-heading').nth(1)).toBeFocused();
  await expect(panel).toHaveCSS('height', '0px');
  await expect(panel).toHaveCSS('visibility', 'hidden');
  await expect(chevron).toHaveCSS('transform', 'none');
});

test('quick deck toggles and expand/collapse all settle at the latest requested state', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('/');
  const heading = page.locator('.pl-topic-heading').first();
  const panel = page.locator('.pl-topic-reveal').first();
  await expect(heading).toBeVisible();
  await heading.evaluate(async (element) => {
    // Reverse the transition on successive frames, while it is still in flight.
    for (let index = 0; index < 5; index += 1) {
      (element as HTMLButtonElement).click();
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  });
  await expect(heading).toHaveAttribute('aria-expanded', 'true');
  await expect(panel).not.toHaveAttribute('inert');
  await expect(panel).toHaveCSS('visibility', 'visible');

  await page.getByRole('button', { name: 'Expand all decks', exact: true }).click();
  await expect(page.locator('.pl-topic-heading[aria-expanded="false"]')).toHaveCount(0);
  await expect(page.locator('.pl-topic-reveal[inert]')).toHaveCount(0);
  await page.getByRole('button', { name: 'Collapse all decks', exact: true }).click();
  await expect(page.locator('.pl-topic-heading[aria-expanded="true"]')).toHaveCount(0);
  await expect(page.locator('.pl-topic-reveal:not([inert])')).toHaveCount(0);
  await expect
    .poll(() =>
      page
        .locator('.pl-topic-reveal')
        .evaluateAll((elements) =>
          elements.every((element) => element.getBoundingClientRect().height === 0),
        ),
    )
    .toBe(true);
});

test('reduced motion disables both panel and chevron transitions', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  const heading = page.locator('.pl-topic-heading').first();
  const panel = page.locator('.pl-topic-reveal').first();
  await expect(panel).toHaveCSS('transition-duration', '0s');
  await expect(heading.locator('svg')).toHaveCSS('transition-duration', '0s');
  await expect(page.locator('.pl-expand-button > svg')).toHaveCSS('transition-duration', '0s');
  await heading.click();
  await expect(panel).toHaveCSS('visibility', 'visible');
  await heading.click();
  await expect(panel).toHaveCSS('height', '0px');
  await expect(panel).toHaveCSS('visibility', 'hidden');
});
