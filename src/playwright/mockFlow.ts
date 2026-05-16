import { chromium as chromiumExtra } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { Browser, Page, devices } from 'playwright';
import type { BrowserType } from 'playwright';
import { globalState } from '../state/globalState';
import { EmailProvider } from '../types';
import { createEmailClient } from '../tempMail/client';

chromiumExtra.use(StealthPlugin());

const CYCLE_TIMEOUT_MS = 8 * 60 * 1_000;

type State = ReturnType<typeof globalState.getState>;

function isStopped(): boolean {
  return !!(globalState.getState() as State & { shouldStop?: boolean }).shouldStop;
}

async function sleep(ms: number): Promise<void> {
  const step = 200;
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (isStopped()) throw new Error('Parado pelo usuário');
    await new Promise<void>(r => setTimeout(r, Math.min(step, end - Date.now())));
  }
}

async function hasElement(p: Page, sel: string, timeout = 600): Promise<boolean> {
  return p.locator(sel).first().isVisible({ timeout }).catch(() => false);
}

// ─── SPINNER ──────────────────────────────────────────────────────────────────

const SPINNER_SEL = [
  '[data-testid="loading_component"]',
  '[data-testid="spinner"]',
  '[data-testid="loading_component_SessionVerification"]',
].join(', ');

/**
 * Aguarda todos os spinners/loadings do Uber sumirem.
 * O Uber usa polling XHR — networkidle nunca dispara.
 */
async function waitForSpinner(p: Page, cycle: number, maxMs = 30_000): Promise<void> {
  const visible = await hasElement(p, SPINNER_SEL, 1200);
  if (!visible) return;

  globalState.addLog('info', '⏳ Aguardando spinner...', cycle);
  const start = Date.now();

  while (Date.now() - start < maxMs) {
    if (!(await hasElement(p, SPINNER_SEL, 400))) {
      globalState.addLog('info', '✔️ Spinner sumiu', cycle);
      await sleep(600);
      return;
    }
    await sleep(400);
  }
  globalState.addLog('warn', '⚠️ Spinner timeout — continuando mesmo assim', cycle);
}

async function waitForPageSettle(p: Page, cycle: number, ms = 3000): Promise<void> {
  await Promise.race([
    p.waitForLoadState('networkidle', { timeout: ms }).catch(() => {}),
    sleep(ms),
  ]);
  await waitForSpinner(p, cycle);
  await sleep(300);
}

// ─── DETECÇÃO DE TELA ATUAL ───────────────────────────────────────────────────

/**
 * Retorna qual tela o Uber está mostrando agora.
 * Usado para decidir qual step executar, independente da ordem.
 */
async function detectScreen(p: Page): Promise<string> {
  const checks: Array<[string, string]> = [
    ['otp',      'input[autocomplete="one-time-code"], input[inputmode="numeric"][maxlength]'],
    ['phone',    '[data-testid="PHONE_COUNTRY_CODE"], [data-testid="country-code"], #PHONE_NUMBER, input[autocomplete="tel-national"]'],
    ['password', '#PASSWORD, input[autocomplete="new-password"], input[type="password"]'],
    ['name',     '#FIRST_NAME, input[autocomplete="given-name"]'],
    ['terms',    'input[type="checkbox"], [role="checkbox"], [data-testid="accept-terms"]'],
    ['city',     '[data-testid*="city"], input[placeholder*="city" i], input[placeholder*="ville" i], input[placeholder*="cidade" i]'],
    ['whatsapp', '[data-testid="step-bottom-navigation"]'],
    ['hub',      '[data-testid="hub"], [data-testid*="profilePhoto"], [data-testid*="stepItem"]'],
    ['photo',    '[data-testid="step profilePhoto"], [data-testid="docUploadButton"]'],
    ['email',    'input[type="email"], input[autocomplete="email"], #EMAIL'],
  ];
  for (const [name, sel] of checks) {
    if (await hasElement(p, sel, 800)) return name;
  }
  return 'unknown';
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

async function fillById(p: Page, id: string, value: string, label: string, cycle: number): Promise<void> {
  const el = p.locator(`#${id}, [id="${id}"]`).first();
  await el.waitFor({ state: 'visible', timeout: 15_000 });
  await el.scrollIntoViewIfNeeded();
  await sleep(150 + Math.random() * 100);
  await el.click();
  await sleep(80);
  await el.click({ clickCount: 3 });
  await p.keyboard.press('Delete');
  await sleep(60);
  await el.pressSequentially(value, { delay: 55 + Math.random() * 45 });
  globalState.addLog('info', `✔️ fill [#${id}]: ${label}`, cycle);
}

async function clickForward(p: Page, cycle: number): Promise<void> {
  const el = p.locator('[data-testid="forward-button"]').first();
  await el.waitFor({ state: 'visible', timeout: 15_000 });
  for (let i = 0; i < 25; i++) {
    if (await el.isEnabled({ timeout: 200 }).catch(() => false)) break;
    await sleep(200);
  }
  await el.scrollIntoViewIfNeeded();
  await sleep(200 + Math.random() * 100);
  await el.click();
  globalState.addLog('info', '✔️ click: Avançar (forward-button)', cycle);
  await waitForPageSettle(p, cycle, 3000);
}

function gerarTelefoneFixoBR(): string {
  const ddds = ['11','21','22','24','27','28','31','32','33','34','35','37','38',
                '41','42','43','44','45','46','47','48','49','51','53','54','55',
                '61','62','63','64','65','66','67','68','69','71','73','74','75',
                '77','79','81','82','83','84','85','86','87','88','89','91','92',
                '93','94','95','96','97','98','99'];
  const ddd = ddds[Math.floor(Math.random() * ddds.length)];
  const primeiro = String(2 + Math.floor(Math.random() * 4));
  const resto = Array.from({ length: 7 }, () => Math.floor(Math.random() * 10)).join('');
  return `(${ddd}) ${primeiro}${resto.slice(0, 3)}-${resto.slice(3)}`;
}

// ─── ETAPAS ──────────────────────────────────────────────────────────────────

async function stepEmail(p: Page, email: string, cycle: number): Promise<void> {
  globalState.addLog('info', '📧 [1] Email...', cycle);
  const EMAIL_SEL = 'input[type="email"], input[autocomplete="email"], #EMAIL, #EMAIL_ADDRESS';
  await p.waitForSelector(EMAIL_SEL, { state: 'visible', timeout: 15_000 });
  const el = p.locator(EMAIL_SEL).first();
  await el.click();
  await sleep(80);
  await el.pressSequentially(email, { delay: 55 + Math.random() * 45 });
  globalState.addLog('info', '✔️ fill: email', cycle);
  await clickForward(p, cycle);
}

async function stepOTP(
  p: Page,
  emailClient: ReturnType<typeof createEmailClient>,
  email: string,
  otpTimeout: number,
  cycle: number
): Promise<void> {
  globalState.addLog('info', '🔢 [2] Aguardando OTP...', cycle);
  const OTP_SEL = 'input[autocomplete="one-time-code"], input[inputmode="numeric"][maxlength], input[maxlength="1"]';
  await p.waitForSelector(OTP_SEL, { state: 'visible', timeout: 20_000 });
  globalState.addLog('info', '✔️ Tela OTP detectada', cycle);

  const otp = await emailClient.waitForOTP(email, otpTimeout, cycle);
  globalState.addLog('info', `🔢 OTP recebido: ${otp}`, cycle);

  const splitInputs = p.locator('input[maxlength="1"]');
  const splitCount = await splitInputs.count().catch(() => 0);

  if (splitCount >= 4) {
    globalState.addLog('info', `✔️ OTP split: ${splitCount} boxes`, cycle);
    for (let i = 0; i < Math.min(splitCount, otp.length); i++) {
      const box = splitInputs.nth(i);
      await box.click();
      await sleep(60);
      await box.pressSequentially(otp[i], { delay: 70 });
      await sleep(50);
    }
  } else {
    const el = p.locator(OTP_SEL).first();
    await el.click();
    await sleep(80);
    await el.click({ clickCount: 3 });
    await p.keyboard.press('Delete');
    await sleep(60);
    await el.pressSequentially(otp, { delay: 70 + Math.random() * 40 });
    globalState.addLog('info', '✔️ OTP preenchido (input único)', cycle);
  }

  await sleep(800);

  // Tenta forward-button; se não existir, tenta submit
  const fwdVisible = await hasElement(p, '[data-testid="forward-button"]', 1500);
  if (fwdVisible) {
    await clickForward(p, cycle);
  } else {
    const btn = p.locator('button[type="submit"]:not([disabled])').first();
    if (await btn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await btn.click();
      globalState.addLog('info', '✔️ confirmar-otp via submit', cycle);
      await waitForPageSettle(p, cycle, 4000);
    }
  }

  // CRÍTICO: após OTP o Uber redireciona para telefone — esperar spinner sumir
  await waitForSpinner(p, cycle, 20_000);
}

async function stepPhone(p: Page, cycle: number): Promise<void> {
  globalState.addLog('info', '📱 [3] Telefone...', cycle);
  await waitForSpinner(p, cycle, 10_000);

  // Uber usa PHONE_COUNTRY_CODE (testid) + campo de número separado
  const PHONE_CANDIDATES = [
    '#PHONE_NUMBER',
    'input[autocomplete="tel-national"]',
    '[data-testid="PHONE_COUNTRY_CODE"] ~ input',
    '[data-testid="PHONE_COUNTRY_CODE"] + input',
    // campo de número ao lado do seletor de país
    'input[data-testid*="phone" i]',
    'input[placeholder*="phone" i]',
    'input[placeholder*="téléphone" i]',
    'input[placeholder*="telefone" i]',
    'input[type="tel"]',
  ];

  let phoneInput: string | null = null;
  for (const sel of PHONE_CANDIDATES) {
    if (await hasElement(p, sel, 2000)) { phoneInput = sel; break; }
  }

  if (!phoneInput) {
    // Último recurso: pega qualquer input numérico visível que não seja OTP
    const found = await p.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll('input')) as HTMLInputElement[];
      const tel = inputs.find(i =>
        (i.type === 'tel' || i.inputMode === 'tel' || i.inputMode === 'numeric') &&
        i.maxLength !== 1 &&
        i.offsetParent !== null
      );
      return tel ? (tel.id ? `#${tel.id}` : null) : null;
    });
    if (found) phoneInput = found;
  }

  if (!phoneInput) {
    const testIds = await p.evaluate(() =>
      Array.from(document.querySelectorAll('[data-testid]'))
        .map(el => (el as HTMLElement).dataset['testid'])
        .filter(Boolean).slice(0, 20)
    ).catch(() => []);
    globalState.addLog('warn', `⏩ Tela de telefone não encontrada. testids: ${JSON.stringify(testIds)}`, cycle);
    return;
  }

  const telefone = gerarTelefoneFixoBR();
  globalState.addLog('info', `📞 Telefone gerado: ${telefone}`, cycle);

  // Extrai só os dígitos (sem DDD formatado) para preencher no campo
  const digitosApenas = telefone.replace(/\D/g, '').slice(2); // remove DDD, mantém 8 dígitos
  const el = p.locator(phoneInput).first();
  await el.scrollIntoViewIfNeeded();
  await sleep(200);
  await el.click({ clickCount: 3 });
  await p.keyboard.press('Delete');
  await sleep(80);
  await el.pressSequentially(digitosApenas, { delay: 60 + Math.random() * 40 });
  globalState.addLog('info', `✔️ fill telefone via: ${phoneInput}`, cycle);

  await clickForward(p, cycle);
}

async function stepPassword(p: Page, cycle: number): Promise<void> {
  globalState.addLog('info', '🔒 [4] Senha...', cycle);
  await waitForSpinner(p, cycle, 10_000);
  const visible = await hasElement(p, '#PASSWORD, input[autocomplete="new-password"], input[type="password"]', 8000);
  if (!visible) {
    globalState.addLog('info', '⏩ Tela de senha não encontrada — pulando', cycle);
    return;
  }
  // tenta #PASSWORD primeiro, depois qualquer password input
  const hasPwdId = await hasElement(p, '#PASSWORD', 500);
  if (hasPwdId) {
    await fillById(p, 'PASSWORD', 'Uber2024@', 'senha', cycle);
  } else {
    const el = p.locator('input[autocomplete="new-password"], input[type="password"]').first();
    await el.click({ clickCount: 3 });
    await p.keyboard.press('Delete');
    await sleep(60);
    await el.pressSequentially('Uber2024@', { delay: 60 });
    globalState.addLog('info', '✔️ fill [password]: senha', cycle);
  }
  await clickForward(p, cycle);
}

async function stepPersonalInfo(p: Page, cycle: number): Promise<void> {
  globalState.addLog('info', '👤 [5] Nome...', cycle);
  await waitForSpinner(p, cycle, 10_000);
  const visible = await hasElement(p, '#FIRST_NAME, input[autocomplete="given-name"]', 8000);
  if (!visible) {
    globalState.addLog('info', '⏩ Tela de nome não encontrada — pulando', cycle);
    return;
  }
  const firstNames = ['Thomas', 'Lucas', 'Hugo', 'Maxime', 'Antoine', 'Nicolas', 'Alexandre'];
  const lastNames  = ['Martin', 'Bernard', 'Dubois', 'Laurent', 'Fontaine', 'Girard', 'Rousseau'];
  const fn = firstNames[Math.floor(Math.random() * firstNames.length)];
  const ln = lastNames[Math.floor(Math.random() * lastNames.length)];
  await fillById(p, 'FIRST_NAME', fn, 'primeiro nome', cycle);
  const hasLast = await hasElement(p, '#LAST_NAME, input[autocomplete="family-name"]', 1000);
  if (hasLast) await fillById(p, 'LAST_NAME', ln, 'sobrenome', cycle);
  await clickForward(p, cycle);
}

async function stepTerms(p: Page, cycle: number): Promise<void> {
  globalState.addLog('info', '📝 [6] Termos...', cycle);
  await waitForSpinner(p, cycle, 10_000);

  const TELA_SEL = [
    '[data-testid="accept-terms"]',
    'text=Concordo',
    'text=Aceite os Termos',
    'input[type="checkbox"]',
    '[role="checkbox"]',
  ];
  let telaFound = false;
  for (const sel of TELA_SEL) {
    if (await hasElement(p, sel, 5000)) { telaFound = true; break; }
  }
  if (!telaFound) {
    globalState.addLog('info', '⏩ Tela de termos não encontrada — pulando', cycle);
    return;
  }

  await sleep(500);

  const CHECKBOX_CANDIDATES = [
    'input[type="checkbox"]',
    '[role="checkbox"]',
    'label:has-text("Concordo")',
    'text=Concordo',
    '[data-testid="accept-terms"] ~ * input',
    '[data-testid="accept-terms"] ~ * label',
  ];

  let clicked = false;
  for (const sel of CHECKBOX_CANDIDATES) {
    try {
      const el = p.locator(sel).first();
      if (await el.isVisible({ timeout: 800 }).catch(() => false)) {
        await el.scrollIntoViewIfNeeded();
        await sleep(200);
        await el.click({ force: true });
        globalState.addLog('info', `✔️ checkbox clicado via: ${sel}`, cycle);
        clicked = true;
        break;
      }
    } catch { /* tenta próximo */ }
  }

  if (!clicked) {
    const jsClicked = await p.evaluate(() => {
      const cb = document.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
      if (cb) { cb.click(); return true; }
      const role = document.querySelector('[role="checkbox"]') as HTMLElement | null;
      if (role) { role.click(); return true; }
      const labels = Array.from(document.querySelectorAll('label, span, p, div'));
      const concordo = labels.find(el => el.textContent?.trim() === 'Concordo') as HTMLElement | null;
      if (concordo) { concordo.click(); return true; }
      return false;
    });
    globalState.addLog(jsClicked ? 'info' : 'warn',
      jsClicked ? '✔️ checkbox clicado via JS evaluate' : '⚠️ Não encontrou checkbox — tentando forward mesmo assim',
      cycle);
  }

  await sleep(600);
  await clickForward(p, cycle);
  // Após termos o Uber faz verificação de sessão — pode demorar até 45s
  await waitForSpinner(p, cycle, 45_000);
}

async function stepCity(
  p: Page,
  inviteCode: string,
  cycle: number,
  cityName = 'Paris'
): Promise<void> {
  globalState.addLog('info', '🏢 [7] Cidade...', cycle);
  await waitForSpinner(p, cycle, 20_000);

  const CITY_CANDIDATES = [
    '[data-testid="flow-type-city-selector-v2-input"]',
    '[data-testid="city-selector-input"]',
    '[data-testid*="city"]',
    'input[placeholder*="cidade" i]',
    'input[placeholder*="city" i]',
    'input[placeholder*="ville" i]',
    'input[aria-label*="cidade" i]',
    'input[aria-label*="city" i]',
  ];

  let cityInput: string | null = null;
  for (const sel of CITY_CANDIDATES) {
    if (await hasElement(p, sel, 12_000)) { cityInput = sel; break; }
  }

  if (!cityInput) {
    const testIds = await p.evaluate(() =>
      Array.from(document.querySelectorAll('[data-testid]'))
        .map(el => (el as HTMLElement).dataset['testid'])
        .filter(Boolean).slice(0, 20)
    ).catch(() => []);
    globalState.addLog('warn', `⏩ Cidade não encontrada. testids: ${JSON.stringify(testIds)}`, cycle);
    return;
  }

  globalState.addLog('info', `✔️ Campo cidade encontrado: ${cityInput}`, cycle);

  const el = p.locator(cityInput).first();
  await el.scrollIntoViewIfNeeded();
  await sleep(300);
  await el.click({ clickCount: 3 });
  await p.keyboard.press('Delete');
  await sleep(200);
  await el.pressSequentially(cityName, { delay: 60 + Math.random() * 40 });
  globalState.addLog('info', `✔️ fill cidade: ${cityName}`, cycle);

  // Aguarda o dropdown aparecer (até 5s)
  await sleep(1500);

  // Seleciona a PRIMEIRA opção do dropdown do Uber
  const OPTION_CANDIDATES = [
    '[data-testid="flow-type-city-selector-v2-option"]',
    '[data-testid*="city-selector"][data-testid*="option"]',
    '[role="option"]',
    '[role="listitem"]',
    '[data-testid*="suggestion"]',
    '[data-testid*="option"]',
    'li[data-value]',
    'ul li',
  ];

  let optionClicked = false;
  for (const sel of OPTION_CANDIDATES) {
    const opt = p.locator(sel).first();
    if (await opt.isVisible({ timeout: 2500 }).catch(() => false)) {
      await opt.click();
      globalState.addLog('info', `✔️ cidade selecionada (1ª opção) via: ${sel}`, cycle);
      optionClicked = true;
      break;
    }
  }

  if (!optionClicked) {
    globalState.addLog('warn', '⚠️ Dropdown de cidade não apareceu — tentando continuar sem selecionar', cycle);
  }

  await sleep(500);

  if (inviteCode) {
    const CODE_CANDIDATES = [
      '[data-testid="signup-step::invite-code-input"]',
      '[data-testid*="invite"]', '[data-testid*="referral"]',
      'input[placeholder*="código" i]', 'input[placeholder*="code" i]',
    ];
    for (const sel of CODE_CANDIDATES) {
      if (await hasElement(p, sel, 1000)) {
        const codeEl = p.locator(sel).first();
        await codeEl.click({ clickCount: 3 });
        await codeEl.pressSequentially(inviteCode, { delay: 60 });
        globalState.addLog('info', `✔️ invite code preenchido via: ${sel}`, cycle);
        break;
      }
    }
    await sleep(300);
  }

  const submitBtn = p.locator('[data-testid="submit-button"]').first();
  if (await submitBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
    await submitBtn.click();
    globalState.addLog('info', '✔️ click: submit-button (cidade)', cycle);
    await waitForPageSettle(p, cycle, 4000);
  } else {
    await clickForward(p, cycle);
  }
}

async function stepWhatsApp(p: Page, cycle: number): Promise<void> {
  globalState.addLog('info', '📲 [8] WhatsApp opt-in...', cycle);
  await waitForSpinner(p, cycle, 10_000);
  const visible = await hasElement(p, '[data-testid="step-bottom-navigation"]', 8000);
  if (!visible) {
    globalState.addLog('info', '⏩ Tela WhatsApp não encontrada — pulando', cycle);
    return;
  }
  const naoAtivar = p.locator('button:has-text("NÃO ATIVAR"), button:has-text("Nao ativar"), button:has-text("NOT NOW")');
  if (await naoAtivar.first().isVisible({ timeout: 1500 }).catch(() => false)) {
    await naoAtivar.first().click();
    globalState.addLog('info', '✔️ click: NÃO ATIVAR (WhatsApp)', cycle);
    await waitForPageSettle(p, cycle, 3000);
  }
}

async function stepHubPhotoClick(p: Page, cycle: number): Promise<void> {
  globalState.addLog('info', '🏠 [9] Hub — aguardando...', cycle);
  await waitForSpinner(p, cycle, 15_000);

  const HUB_CANDIDATES = [
    '[data-testid="hub"]',
    '[data-testid="stepItem profilePhoto"]',
    '[data-testid*="profilePhoto"]',
    '[data-testid*="profile-photo"]',
    'text=Foto do perfil',
    'text=Photo de profil',
  ];

  let hubSel: string | null = null;
  for (const sel of HUB_CANDIDATES) {
    if (await hasElement(p, sel, 10_000)) { hubSel = sel; break; }
  }

  if (!hubSel) {
    const testIds = await p.evaluate(() =>
      Array.from(document.querySelectorAll('[data-testid]'))
        .map(el => (el as HTMLElement).dataset['testid'])
        .filter(Boolean).slice(0, 20)
    ).catch(() => []);
    globalState.addLog('info', `⏩ Hub não encontrado. testids: ${JSON.stringify(testIds)}`, cycle);
    return;
  }

  globalState.addLog('info', `✔️ Hub encontrado via: ${hubSel}`, cycle);

  const PHOTO_ITEM = '[data-testid="stepItem profilePhoto"], [data-testid*="profilePhoto"], text=Foto do perfil, text=Photo de profil';
  const photoItem = p.locator(PHOTO_ITEM).first();
  if (await photoItem.isVisible({ timeout: 2000 }).catch(() => false)) {
    await photoItem.click();
    globalState.addLog('info', '✔️ click: Foto do perfil', cycle);
    await waitForPageSettle(p, cycle, 3000);
  }
}

async function stepProfilePhoto(p: Page, cycle: number): Promise<void> {
  globalState.addLog('info', '📸 [10] Tirar foto do perfil...', cycle);
  const PHOTO_PAGE = '[data-testid="step profilePhoto"], [data-testid="docUploadButton"], button:has-text("Tirar foto"), button:has-text("Prendre une photo")';
  const visible = await hasElement(p, PHOTO_PAGE, 5000);
  if (!visible) {
    globalState.addLog('info', '⏩ Tela de foto não encontrada — pulando', cycle);
    return;
  }
  const btn = p.locator('[data-testid="docUploadButton"], button:has-text("Tirar foto"), button:has-text("Prendre une photo")').first();
  if (await btn.isVisible({ timeout: 3000 }).catch(() => false)) {
    await btn.click();
    globalState.addLog('info', '✔️ click: Tirar foto', cycle);
  }
  await sleep(1000);
}

// ─── DISMISS MODALS ───────────────────────────────────────────────────────────

async function dismissModals(p: Page, cycle: number): Promise<void> {
  const DISMISS = [
    'button:has-text("Accept")', 'button:has-text("Accepter")',
    'button:has-text("OK")', 'button:has-text("Got it")',
    '[data-testid*="dismiss"]', '[aria-label*="close" i]',
  ];
  for (const sel of DISMISS) {
    if (await hasElement(p, sel, 400)) {
      await p.locator(sel).first().click();
      globalState.addLog('info', `🚪 modal: ${sel}`, cycle);
      await sleep(400);
    }
  }
}

// ─── BROWSER ──────────────────────────────────────────────────────────────────

let browserInstance: Browser | null = null;
let lastProxyConfig: string | null = null;

export class MockPlaywrightFlow {
  static async init(headless = true): Promise<void> {
    const state = globalState.getState() as State & { proxies?: string[] };
    const proxies: string[] = state.proxies ?? [];
    const proxyKey = proxies[0] ?? '';

    if (browserInstance && lastProxyConfig !== proxyKey) {
      globalState.addLog('info', '🔄 Proxy mudou — reiniciando browser...');
      await browserInstance.close().catch(() => {});
      browserInstance = null;
    }
    if (browserInstance) return;

    const braveCandidates = [
      process.env.BRAVE_PATH,
      '/usr/bin/brave-browser', '/usr/bin/brave',
      '/usr/bin/chromium-browser', '/usr/bin/chromium', '/snap/bin/chromium',
    ].filter(Boolean) as string[];
    let chromiumBin: string | undefined;
    const { existsSync } = await import('fs');
    for (const c of braveCandidates) { if (existsSync(c)) { chromiumBin = c; break; } }

    globalState.addLog('info', chromiumBin ? `🚀 Usando: ${chromiumBin}` : '⚠️ Usando Playwright Chromium');
    globalState.addLog('info', `🚀 Iniciando browser (headless=${headless})...`);

    browserInstance = await (chromiumExtra as unknown as BrowserType).launch({
      headless,
      ...(chromiumBin ? { executablePath: chromiumBin } : {}),
      args: [
        '--no-sandbox', '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-infobars', '--disable-dev-shm-usage',
        '--no-first-run', '--no-default-browser-check',
        `--proxy-server=${proxyKey}`,
      ],
    });
    lastProxyConfig = proxyKey;
    globalState.addLog('info', '✅ Browser iniciado');
  }

  static async execute(
    cadastroUrl: string,
    config: { emailProvider: EmailProvider; tempMailApiKey: string; otpTimeout: number; extraDelay: number; inviteCode: string; cityName?: string },
    cycle: number
  ): Promise<void> {
    if (!browserInstance) throw new Error('Browser não iniciado');
    const cyclePromise = MockPlaywrightFlow._run(cadastroUrl, config, cycle);
    const timeoutPromise = new Promise<void>((_, reject) =>
      setTimeout(() => reject(new Error(`⏰ CYCLE_TIMEOUT ${cycle}`)), CYCLE_TIMEOUT_MS)
    );
    await Promise.race([cyclePromise, timeoutPromise]).catch(e => {
      globalState.addLog('error', `❌ Ciclo ${cycle} abortado: ${e instanceof Error ? e.message : e}`, cycle);
      throw e;
    });
  }

  private static async _run(
    cadastroUrl: string,
    config: { emailProvider: EmailProvider; tempMailApiKey: string; otpTimeout: number; extraDelay: number; inviteCode: string; cityName?: string },
    cycle: number
  ): Promise<void> {
    const state = globalState.getState() as State & { proxies?: string[] };
    const proxies: string[] = state.proxies ?? [];
    const proxyUrl = proxies.length > 0 ? proxies[cycle % proxies.length] : undefined;

    const ctxOpts: Parameters<Browser['newContext']>[0] = {
      ...devices['Desktop Chrome'],
      locale: 'fr-FR',
      timezoneId: 'Europe/Paris',
      permissions: ['geolocation'],
      geolocation: { latitude: 48.8566, longitude: 2.3522 },
    };

    if (proxyUrl) {
      try {
        const u = new URL(proxyUrl.startsWith('http') ? proxyUrl : `http://${proxyUrl}`);
        ctxOpts.proxy = {
          server: `${u.protocol}//${u.hostname}:${u.port}`,
          username: u.username ? decodeURIComponent(u.username) : undefined,
          password: u.password ? decodeURIComponent(u.password) : undefined,
        };
        globalState.addLog('info', `🌐 Proxy: ${ctxOpts.proxy.server}`, cycle);
      } catch { ctxOpts.proxy = { server: proxyUrl }; }
    } else {
      globalState.addLog('info', '🌐 Sem proxy (VPN)', cycle);
    }

    const context = await browserInstance!.newContext(ctxOpts);
    const p = await context.newPage();
    p.setDefaultTimeout(20_000);
    p.setDefaultNavigationTimeout(30_000);

    try {
      const emailClient = createEmailClient(config.emailProvider, config.tempMailApiKey);
      const { email } = await emailClient.createRandomEmail();
      globalState.addLog('info', `📧 Email: ${email}`, cycle);

      globalState.addLog('info', `🌐 Navegando para ${cadastroUrl}...`, cycle);
      await p.goto(cadastroUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });

      await p.waitForSelector(
        'input[type="email"], input[autocomplete="email"], #EMAIL, #EMAIL_ADDRESS',
        { state: 'visible', timeout: 20_000 }
      );
      await sleep(600);
      await dismissModals(p, cycle);

      await stepEmail(p, email, cycle);                                      // 1
      await stepOTP(p, emailClient, email, config.otpTimeout, cycle);        // 2
      await stepPhone(p, cycle);                                             // 3
      await stepPassword(p, cycle);                                          // 4
      await stepPersonalInfo(p, cycle);                                      // 5
      await stepTerms(p, cycle);                                             // 6
      await stepCity(p, config.inviteCode, cycle, config.cityName);          // 7
      await stepWhatsApp(p, cycle);                                          // 8
      await stepHubPhotoClick(p, cycle);                                     // 9
      await stepProfilePhoto(p, cycle);                                      // 10

      if (config.extraDelay > 0) {
        globalState.addLog('info', `⏳ Extra delay: ${config.extraDelay}ms`, cycle);
        await sleep(config.extraDelay);
      }

      globalState.addLog('success', `✅ Ciclo ${cycle} concluído`, cycle);
    } finally {
      await context.close().catch(() => {});
    }
  }

  static async cleanup(): Promise<void> {
    if (browserInstance) {
      await browserInstance.close().catch(() => {});
      browserInstance = null;
    }
  }
}
