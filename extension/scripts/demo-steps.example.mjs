// Paste the body of a `npx playwright codegen` recording here (the `page` object is already open on --url and ReproDesk is armed).
export default async function steps(page) {
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.mouse.wheel(0, 600);
  await page.waitForTimeout(1500);
  // await page.getByRole('link', { name: 'Combination Pliers' }).click();
  // await page.getByRole('button', { name: 'Add to cart' }).click();
}
