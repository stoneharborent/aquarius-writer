/**
 * Theme screenshots for review.
 *
 * Boots nothing itself — start the dev server first (`npm run dev`), then:
 *
 *   npm install --no-save playwright-core
 *   node scripts/screenshot-theme.mjs [theme] [outDir]
 *
 * Defaults to the `aquarius` theme and `docs/screenshots/<theme>/`. It drives
 * the real app through the `?theme=` query override, so what lands in the PNGs
 * is the same CSS the shipped app uses. playwright-core is installed with
 * --no-save on purpose: it is review tooling, not a dependency of the product,
 * and it uses the Chrome already on the machine instead of downloading one.
 */
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const theme = process.argv[2] ?? "aquarius";
const outDir = process.argv[3] ?? join("docs", "screenshots", theme);
const base = process.env.AQ_DEV_URL ?? "http://localhost:1420";

mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });

async function shot(name) {
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(outDir, `${name}.png`) });
  console.log("→", join(outDir, `${name}.png`));
}

await page.goto(`${base}/?theme=${theme}`, { waitUntil: "networkidle" });
await page.evaluate(() => document.fonts.ready);

// 1. The main window: sidebar, editor, Spark panel.
await shot("01-main-window");

// 2. An overlay on top of it — the command palette.
await page.keyboard.press("Meta+P");
await shot("02-command-palette");
await page.keyboard.press("Escape");

// 3. Settings, on the Appearance tab, where the theme picker lives.
await page.keyboard.press("Meta+Comma");
await shot("03-settings-appearance");
await page.keyboard.press("Escape");

// 4. Today — the one screen that uses ancient gold (the streak line).
await page.keyboard.press("Meta+T");
await shot("04-today-gold-streak");
await page.keyboard.press("Escape");

// Sanity check for the bundled variable fonts: if the weight axis were dead,
// 400 and 700 would measure the same width.
const weights = await page.evaluate(async () => {
  const probe = document.createElement("span");
  probe.style.cssText = "position:fixed;left:-9999px;font-size:64px;white-space:pre;";
  probe.textContent = "Handgloves 123";
  document.body.appendChild(probe);
  const measure = async (family, weight) => {
    probe.style.fontFamily = family;
    probe.style.fontWeight = String(weight);
    await document.fonts.ready;
    return probe.getBoundingClientRect().width;
  };
  const out = {
    soraLoaded: document.fonts.check('600 16px "AQ Sora"'),
    interLoaded: document.fonts.check('400 16px "AQ Inter"'),
    monoLoaded: document.fonts.check('400 16px "AQ JetBrains Mono"'),
    sora600: await measure('"AQ Sora"', 600),
    sora700: await measure('"AQ Sora"', 700),
    inter400: await measure('"AQ Inter"', 400),
    inter600: await measure('"AQ Inter"', 600),
    mono400: await measure('"AQ JetBrains Mono"', 400),
    mono500: await measure('"AQ JetBrains Mono"', 500),
  };
  probe.remove();
  return out;
});
console.log("font check:", weights);

await browser.close();
