import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (!(key in process.env)) process.env[key] = val;
  }
}

const scriptDir = path.dirname(new URL(import.meta.url).pathname);
loadEnv(path.join(scriptDir, '.env.default'));
loadEnv(path.join(scriptDir, '.env'));

const BASE = (process.env.SHOT_BASE_URL || '').replace(/\/+$/, '');
const OUT = process.env.SHOT_OUT_DIR || './screenshots';
const VIEWPORT = { width: 1300, height: 1000 };
const ZOOM = '1.0';
const THEMES = (process.env.SHOT_THEMES || 'light,dark').split(',').map((s) => s.trim()).filter(Boolean);

const log = (...a) => console.log('[shot]', ...a);

async function goto(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
}

async function scrollToTop(page) {
  await page.evaluate(() => {
    document.documentElement.style.scrollBehavior = 'auto';
    window.scrollTo(0, 0);
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
  });
  await page.waitForTimeout(150);
}

async function newThemedContext(browser, theme) {
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
  await context.addInitScript(({ zoom, theme: forcedTheme }) => {
    const apply = () => {
      document.documentElement.style.zoom = zoom;
      document.documentElement.dataset.theme = forcedTheme;
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', apply);
    else apply();
  }, { zoom: ZOOM, theme });
  return context;
}

async function shot(page, file) {
  await scrollToTop(page);
  await page.screenshot({ path: file, fullPage: true });
  log(file);
}

const CATEGORIES = ['server', 'storage', 'database', 'qdrant', 'docling', 'embeddings', 'chat', 'vision', 'mcp', 'ui'];

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const launchOptions = { headless: true, args: ['--no-sandbox', '--disable-cache'] };
  if (process.env.SHOT_CHROME_PATH) launchOptions.executablePath = process.env.SHOT_CHROME_PATH;
  const browser = await chromium.launch(launchOptions);

  for (const theme of THEMES) {
    const context = await newThemedContext(browser, theme);
    const page = await context.newPage();

    // 1) Dashboard (default route "/")
    await goto(page, BASE + '/dashboard');
    await page.waitForSelector('.dash__grid, .dash__status', { timeout: 15000 });
    await page.waitForTimeout(900);
    await shot(page, path.join(OUT, `dashboard-${theme}.png`));

    // 2) Settings: one screenshot per category tab
    for (const cat of CATEGORIES) {
      await goto(page, BASE + `/settings/${cat}`);
      await page.waitForSelector('.settings__panel, .settings__loading', { timeout: 15000 });
      await page.waitForTimeout(400);
      await shot(page, path.join(OUT, `settings-${cat}-${theme}.png`));
    }

    // 3) Files
    await goto(page, BASE + '/files');
    await page.waitForSelector('.files, .files__loading', { timeout: 15000 });
    await page.waitForTimeout(900);
    await shot(page, path.join(OUT, `files-${theme}.png`));

    // 4) Logs
    await goto(page, BASE + '/logs');
    await page.waitForSelector('.logviewer, .logviewer__state', { timeout: 15000 });
    await page.waitForTimeout(900);
    await shot(page, path.join(OUT, `logs-${theme}.png`));

    // 5) About
    await goto(page, BASE + '/about');
    await page.waitForSelector('.about__hero', { timeout: 15000 });
    await page.waitForTimeout(400);
    await shot(page, path.join(OUT, `about-${theme}.png`));

    await context.close();
  }

  await browser.close();
})().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
