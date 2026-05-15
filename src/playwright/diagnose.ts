import { chromium as chromiumExtra } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { devices } from 'playwright';

chromiumExtra.use(StealthPlugin());

const MOBILE_DEVICE = devices['iPhone 14'];

const stealthScript = `
  (function() {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'platform',       { get: () => 'iPhone' });
    Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 5 });
  })()
`;

export interface DiagnoseResult {
  url: string;
  title: string;
  inputs: Array<{
    tag: string;
    id: string | null;
    name: string | null;
    type: string | null;
    placeholder: string | null;
    dataTestid: string | null;
    visible: boolean;
    value: string;
  }>;
  buttons: Array<{
    id: string | null;
    text: string;
    type: string | null;
    dataTestid: string | null;
    visible: boolean;
  }>;
  error?: string;
}

export async function diagnoseUberForm(cadastroUrl: string): Promise<DiagnoseResult> {
  let browser: any = null;
  try {
    browser = await chromiumExtra.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-dev-shm-usage',
        '--disable-gpu',
      ],
    });

    const context = await browser.newContext({
      ...MOBILE_DEVICE,
      locale: 'pt-BR',
      timezoneId: 'America/Sao_Paulo',
    });

    await context.addInitScript({ content: stealthScript });
    const page = await context.newPage();

    await page.goto(cadastroUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForLoadState('networkidle', { timeout: 12000 }).catch(() => {});
    await new Promise<void>((r) => setTimeout(r, 3000));

    const currentUrl = page.url();
    const title = await page.title();

    const inputs = await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll('input, textarea, [contenteditable="true"]'));
      return els.map((el: any) => ({
        tag: el.tagName.toLowerCase(),
        id: el.id || null,
        name: el.name || null,
        type: el.type || null,
        placeholder: el.placeholder || null,
        dataTestid: el.getAttribute('data-testid') || null,
        visible: el.offsetParent !== null,
        value: el.value || '',
      }));
    });

    const buttons = await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll('button, [role="button"], [data-dgui="button"]'));
      return els.map((el: any) => ({
        id: el.id || null,
        text: (el.innerText || el.textContent || '').trim().slice(0, 100),
        type: el.type || null,
        dataTestid: el.getAttribute('data-testid') || null,
        visible: el.offsetParent !== null,
      }));
    });

    await context.close();

    return { url: currentUrl, title, inputs, buttons };
  } catch (err: any) {
    return {
      url: cadastroUrl,
      title: '',
      inputs: [],
      buttons: [],
      error: err?.message ?? String(err),
    };
  } finally {
    await browser?.close().catch(() => {});
  }
}
