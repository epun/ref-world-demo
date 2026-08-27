/**
 * Re-shoot the open-graph card.
 *
 * The card is a REAL frame of the world rather than a picture of one — the
 * creatures on it are creatures somebody drew, rendered by the pipeline
 * that renders them live. That is the claim the link is making, so the
 * image should be the thing itself and not an illustration of it. Re-run
 * this and the card is the world as it is now.
 *
 *   npm run dev                  # in another terminal
 *   node scripts/og.mjs          # → public/og.png
 *
 * Shot at 2x and downsampled with sharp: the card is displayed around
 * 600px wide, and a 1x capture of a grainy render resolves badly there.
 *
 * The room's own chrome is hidden. A join code is unscannable at preview
 * size and the minimap reads as clutter — the card should be the world.
 */
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = process.env['PORT'] ?? '5173';
const OUT = join(ROOT, 'public', 'og.png');

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1200, height: 630 },
  deviceScaleFactor: 2,
});
const page = await context.newPage();

// The seeded world alone, so the card does not depend on who has drawn
// today — and so a re-shoot is reproducible.
await page.route('**/api/drawings*', (route) =>
  route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      schema: 'refworld.session',
      version: 1,
      epoch: 'og',
      room: 'zkyz',
      startedAt: new Date(0).toISOString(),
      config: {},
      events: [],
    }),
  }),
);

await page.goto(`http://localhost:${PORT}/?world=public&room=zkyz`, { waitUntil: 'commit' });
await page.waitForFunction(
  () => (globalThis.__refworldCreatures?.positions().length ?? 0) >= 30,
  null,
  { timeout: 240_000 },
);
await page.addStyleTag({
  content: `
    .join-qr, .world-minimap, .world-tray, .draw-overlay, .draw-hint, .world-say { display: none !important; }
    canvas:not(#world) { display: none !important; }
  `,
});
// Let the creatures settle and spread before the shutter.
await page.waitForTimeout(10_000);
await page.screenshot({ path: OUT });
await browser.close();

// Downsample the 2x capture in place.
const sharp = (await import('sharp').catch(() => null))?.default;
if (sharp) {
  const buf = await sharp(OUT).resize(1200, 630).png({ compressionLevel: 9 }).toBuffer();
  const { writeFile } = await import('node:fs/promises');
  await writeFile(OUT, buf);
  console.log(`og.png → 1200x630, ${Math.round(buf.length / 1024)}KB`);
} else {
  console.log('og.png shot at 2400x1260 — install sharp, or downsample to 1200x630 by hand');
}
