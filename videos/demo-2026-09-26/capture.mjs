import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('/Users/sachin/.npm/_npx/e41f203b7505f1fb/node_modules/playwright');
const dir = path.dirname(new URL(import.meta.url).pathname);
const base = 'http://localhost:8899';

const reset = await fetch(`${base}/api/live`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: '{}',
});
if (!reset.ok) throw new Error(`Could not reset demo: HTTP ${reset.status}`);

const browser = await chromium.launch({
  headless: true,
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
});
const context = await browser.newContext({
  viewport: { width: 1600, height: 900 },
  deviceScaleFactor: 1,
  reducedMotion: 'reduce',
  recordVideo: { dir: path.join(dir, 'raw'), size: { width: 1600, height: 900 } },
});
const page = await context.newPage();
await page.goto(base, { waitUntil: 'networkidle' });
await page.locator('#speed').selectOption('10');
const started = Date.now();
const waitUntil = async (second) => {
  const remaining = second * 1000 - (Date.now() - started);
  if (remaining > 0) await page.waitForTimeout(remaining);
};

try {
  await waitUntil(15);
  await page.getByRole('button', { name: 'Run replay' }).click();
  console.log('15s: replay started');

  await waitUntil(35);
  await page.evaluate(() => window.scrollTo({ top: 270, behavior: 'smooth' }));
  await waitUntil(42);
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));

  await waitUntil(52);
  await page.getByRole('link', { name: /Customers/ }).click();
  await page.getByText('Ananya Iyer', { exact: true }).first().click();
  console.log('52s: silent customer evidence');
  await waitUntil(64);
  await page.evaluate(() => window.scrollTo({ top: 360, behavior: 'smooth' }));

  await waitUntil(72);
  await page.getByRole('link', { name: /Incident/ }).click();
  await page.getByRole('button', { name: /Approve ₹1,000/ }).first().scrollIntoViewIfNeeded();
  await waitUntil(80);
  await page.getByRole('button', { name: /Approve ₹1,000/ }).first().click();
  console.log('80s: first credit approved');

  await waitUntil(86);
  await page.getByPlaceholder('Other amount in ₹').first().fill('500');
  await page.getByRole('button', { name: 'Modify' }).first().click();
  console.log('86s: second credit changed to ₹500');

  await waitUntil(90);
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));

  await waitUntil(96);
  await page.getByRole('link', { name: /Traces/ }).click();
  console.log('96s: workflow map');
  await waitUntil(104);
  await page.getByRole('button', { name: 'Incident response' }).click();
  await waitUntil(112);
  await page.evaluate(() => window.scrollTo({ top: 380, behavior: 'smooth' }));
  await waitUntil(117);
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
  await waitUntil(121);
} finally {
  const recorded = await page.video().path();
  await context.close();
  await browser.close();
  await fs.copyFile(recorded, path.join(dir, 'screen-recording.webm'));
}
