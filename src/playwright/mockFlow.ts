import { chromium } from 'playwright';
import { Browser, Page, BrowserContext } from 'playwright';
import { globalState } from '../state/globalState';
import { EmailProvider } from '../types';
import { createEmailClient } from '../tempMail/client';
import * as accountStore from '../store/accountStore';

// NOTE: playwright-extra + stealth removidos — o plugin stealth/evasions/user-agent-override
// crashava com "Cannot read properties of null (reading '1')" ao criar a página.
// O userAgent é injetado diretamente via context options + addInitScript.

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

// ─── MOBILE CONTEXT ──────────────────────────────────────────────────────────────
const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';

const MOBILE_W   = 390;
const MOBILE_H   = 844;
const MOBILE_DPR = 3;

const MOBILE_HEADERS: Record<string, string> = {
  'Sec-CH-UA-Mobile':   '?1',
  'Sec-CH-UA-Platform': '"iOS"',
  'Sec-CH-UA':          '"Not/A)Brand";v="8", "Chromium";v="126", "Mobile Safari";v="17"',
  'Accept-Language':    'pt-BR,pt;q=0.9,en;q=0.8',
};

const MOBILE_INIT_SCRIPT = `
(function() {
  const ua = ${JSON.stringify(MOBILE_UA)};
  Object.defineProperty(navigator, 'userAgent',      { get: () => ua,       configurable: true });
  Object.defineProperty(navigator, 'appVersion',     { get: () => ua.replace('Mozilla/', ''), configurable: true });
  Object.defineProperty(navigator, 'platform',       { get: () => 'iPhone', configurable: true });
  Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 5,        configurable: true });
  Object.defineProperty(navigator, 'vendor',         { get: () => 'Apple Computer, Inc.', configurable: true });
  window.ontouchstart = null;
  window.ontouchmove  = null;
  window.ontouchend   = null;
})();
`;

// ─── KYC DETECTOR ───────────────────────────────────────────────────────────────────
//
// PROBLEMA ANTERIOR: O Veriff abre numa nova aba/popup — o interceptor antigo
// só escutava 'response' e 'framenavigated' na aba principal.
// CORREÇÃO v2:
//   1. installKycInterceptor agora escuta context.on('page') para registrar novas abas.
//   2. Adicionado context.on('request') para capturar URLs ANTES da resposta chegar —
//      isso cobre o Veriff que redireciona via JS antes de emitir uma 'response'.
//   3. Adicionados padrões para Onfido e Jumio.

interface KycRule {
  pattern: RegExp;
  provider: string;
  weight: (url: string) => number;
}

const KYC_RULES: KycRule[] = [
  {
    pattern: /socure\.com/i,
    provider: 'Socure',
    weight: (url) => /\/dv\/|\/sv\/|document/i.test(url) ? 10 : 6,
  },
  // Veriff — padrões reais observados
  {
    pattern: /magic\.veriff\.me/i,
    provider: 'Veriff',
    weight: () => 10,
  },
  {
    pattern: /veriff\.com/i,
    provider: 'Veriff',
    weight: (url) => /\/v\d|\/attempt|\/media|magic/i.test(url) ? 10 : 7,
  },
  // Persona
  {
    pattern: /withpersona\.com/i,
    provider: 'Persona',
    weight: () => 6,
  },
  // GetID
  {
    pattern: /getid\.company/i,
    provider: 'GetID',
    weight: () => 6,
  },
  // iProov
  {
    pattern: /iproov\.com/i,
    provider: 'iProov',
    weight: () => 6,
  },
  // Onfido
  {
    pattern: /onfido\.com/i,
    provider: 'Onfido',
    weight: (url) => /\/sdk|\/applicants|\/checks/i.test(url) ? 10 : 6,
  },
  // Jumio
  {
    pattern: /jumio\.com/i,
    provider: 'Jumio',
    weight: (url) => /\/netverify|\/initiate|\/acquire/i.test(url) ? 10 : 6,
  },
];

function detectKycFromUrl(url: string, cycle: number, source: string): void {
  if (!url || url === 'about:blank' || url.startsWith('chrome')) return;

  for (const rule of KYC_RULES) {
    if (rule.pattern.test(url)) {
      const weight = rule.weight(url);
      globalState.addKycSignal(rule.provider, source, weight, cycle, url);
      globalState.addLog(
        'kyc',
        `🔎 KYC detectado: ${rule.provider} via ${source} | ${url.substring(0, 100)}`,
        cycle
      );
      return;
    }
  }
}

function attachPageListeners(page: Page, cycle: number, label: string): void {
  page.on('framenavigated', (frame) => {
    try { detectKycFromUrl(frame.url(), cycle, `${label}:frame-navigate`); } catch { /* ignora */ }
  });
  page.on('response', (response) => {
    try { detectKycFromUrl(response.url(), cycle, `${label}:network`); } catch { /* ignora */ }
  });
  // captura URL antes da resposta chegar (cobre redirects JS do Veriff)
  page.on('request', (request) => {
    try { detectKycFromUrl(request.url(), cycle, `${label}:request`); } catch { /* ignora */ }
  });
  try { detectKycFromUrl(page.url(), cycle, `${label}:page-open`); } catch { /* ignora */ }
}

function installKycInterceptor(context: BrowserContext, cycle: number): void {
  context.on('page', (newPage) => {
    attachPageListeners(newPage, cycle, 'popup');
    newPage.once('load', () => {
      try { detectKycFromUrl(newPage.url(), cycle, 'popup:load'); } catch { /* ignora */ }
    });
  });

  context.on('response', (response) => {
    try { detectKycFromUrl(response.url(), cycle, 'ctx:network'); } catch { /* ignora */ }
  });

  // FIX v2: requisições do contexto inteiro — captura antes da resposta (Veriff usa redirect JS)
  context.on('request', (request) => {
    try { detectKycFromUrl(request.url(), cycle, 'ctx:request'); } catch { /* ignora */ }
  });
}

// ─── SPINNER ──────────────────────────────────────────────────────────────────────
const SPINNER_SEL = [
  '[data-testid="loading_component"]',
  '[data-testid="spinner"]',
  '[data-testid="loading_component_SessionVerification"]',
  '[data-testid="loader"]',
].join(', ');

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

async function waitForNextScreen(
  p: Page,
  cycle: number,
  selectors: string[],
  maxMs = 60_000
): Promise<void> {
  globalState.addLog('info', '⏳ Aguardando próxima tela...', cycle);
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    if (isStopped()) throw new Error('Parado pelo usuário');
    for (const sel of selectors) {
      if (await hasElement(p, sel, 400)) {
        globalState.addLog('info', '✔️ Próxima tela detectada', cycle);
        await sleep(400);
        return;
      }
    }
    await waitForSpinner(p, cycle, 5_000);
    await sleep(500);
  }
  globalState.addLog('warn', '⚠️ Timeout aguardando próxima tela — continuando mesmo assim', cycle);
}

async function waitOrReload(
  p: Page,
  cycle: number,
  selectors: string[],
  quickMs = 8_000,
  afterReloadMs = 30_000
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < quickMs) {
    if (isStopped()) throw new Error('Parado pelo usuário');
    for (const sel of selectors) {
      if (await hasElement(p, sel, 400)) return true;
    }
    await sleep(500);
  }

  globalState.addLog('warn', '⚠️ Tela presa no spinner — recarregando página...', cycle);
  await p.reload({ waitUntil: 'domcontentloaded', timeout: 20_000 }).catch(() => {});
  globalState.addLog('info', '🔄 Página recarregada', cycle);
  await sleep(1_500);

  const start2 = Date.now();
  while (Date.now() - start2 < afterReloadMs) {
    if (isStopped()) throw new Error('Parado pelo usuário');
    for (const sel of selectors) {
      if (await hasElement(p, sel, 400)) {
        globalState.addLog('info', '✔️ Tela detectada após reload', cycle);
        return true;
      }
    }
    await waitForSpinner(p, cycle, 5_000);
    await sleep(500);
  }

  globalState.addLog('warn', '⚠️ Tela não apareceu nem após reload — continuando mesmo assim', cycle);
  return false;
}

// ─── COOKIE BANNER ────────────────────────────────────────────────────────────────

async function dismissCookieBanner(p: Page, cycle: number): Promise<void> {
  const BANNER_SEL = '#privacy-cookie-banners-root';
  const bannerVisible = await hasElement(p, BANNER_SEL, 1_500);
  if (!bannerVisible) return;

  globalState.addLog('info', '🍪 Banner de cookies detectado — fechando...', cycle);

  const ACCEPT_CANDIDATES = [
    `${BANNER_SEL} button:has-text("Aceitar")`,
    `${BANNER_SEL} button:has-text("Aceitar tudo")`,
    `${BANNER_SEL} button:has-text("Concordo")`,
    `${BANNER_SEL} button:has-text("OK")`,
    `${BANNER_SEL} button:has-text("Confirmar")`,
    `${BANNER_SEL} button:has-text("Salvar preferências")`,
    `${BANNER_SEL} button:has-text("Accept")`,
    `${BANNER_SEL} button:has-text("Accept all")`,
    `${BANNER_SEL} button:has-text("Allow all")`,
    `${BANNER_SEL} button:has-text("Save preferences")`,
    `${BANNER_SEL} button:has-text("Confirm")`,
    `${BANNER_SEL} button[data-testid*="accept"]`,
    `${BANNER_SEL} button[data-testid*="confirm"]`,
    `${BANNER_SEL} button[data-testid*="allow"]`,
    `${BANNER_SEL} button`,
  ];

  let dismissed = false;
  for (const sel of ACCEPT_CANDIDATES) {
    try {
      const btn = p.locator(sel).first();
      if (await btn.isVisible({ timeout: 600 }).catch(() => false)) {
        await btn.click({ force: true, timeout: 5_000 });
        globalState.addLog('info', `✔️ Cookie banner fechado via: ${sel}`, cycle);
        dismissed = true;
        break;
      }
    } catch { /* tenta próximo */ }
  }

  if (!dismissed) {
    const removed = await p.evaluate((bannerSel: string) => {
      const el = document.querySelector(bannerSel);
      if (el) { el.remove(); return true; }
      return false;
    }, BANNER_SEL);
    globalState.addLog(
      removed ? 'info' : 'warn',
      removed ? '✔️ Cookie banner removido via JS (DOM remove)' : '⚠️ Cookie banner não encontrado para remover',
      cycle
    );
  }

  await sleep(400);
  const stillThere = await hasElement(p, BANNER_SEL, 800);
  if (stillThere) {
    await p.evaluate((bannerSel: string) => {
      const el = document.querySelector(bannerSel) as HTMLElement | null;
      if (el) el.style.display = 'none';
    }, BANNER_SEL);
    globalState.addLog('warn', '⚠️ Banner persistente — ocultado via display:none', cycle);
  }
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────────

async function reactFill(p: Page, selector: string, value: string): Promise<void> {
  await p.evaluate(({ sel, val }: { sel: string; val: string }) => {
    const el = document.querySelector(sel) as HTMLInputElement | null;
    if (!el) throw new Error(`reactFill: elemento não encontrado — "${sel}"`);
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype, 'value'
    )?.set;
    if (nativeInputValueSetter) {
      nativeInputValueSetter.call(el, val);
    } else {
      el.value = val;
    }
    el.dispatchEvent(new Event('input',  { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, { sel: selector, val: value });
}

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
}

function gerarTelefoneBR(): { display: string; digits: string } {
  const ddds = ['11','21','31','41','51','61','71','81','85','91'];
  const ddd = ddds[Math.floor(Math.random() * ddds.length)];
  const rest = Array.from({ length: 8 }, () => Math.floor(Math.random() * 10)).join('');
  const digits = `${ddd}9${rest}`;
  const display = `(${ddd}) 9${rest.slice(0,4)}-${rest.slice(4)}`;
  return { display, digits };
}

// ─── ETAPAS ────────────────────────────────────────────────────────────────────

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
  await waitForNextScreen(p, cycle, [
    'input[autocomplete="one-time-code"]',
    'input[inputmode="numeric"][maxlength]',
    'input[maxlength="1"]',
    SPINNER_SEL,
  ]);
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

  const fwdVisible = await hasElement(p, '[data-testid="forward-button"]', 1500);
  if (fwdVisible) {
    await clickForward(p, cycle);
  } else {
    const btn = p.locator('button[type="submit"]:not([disabled])').first();
    if (await btn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await btn.click();
      globalState.addLog('info', '✔️ confirmar-otp via submit', cycle);
    }
  }

  await waitForNextScreen(p, cycle, [
    '#PHONE_NUMBER',
    'input[autocomplete="tel-national"]',
    'input[type="tel"]',
    '#PASSWORD',
    SPINNER_SEL,
  ]);
}

async function stepPhone(p: Page, cycle: number): Promise<{ display: string; digits: string }> {
  globalState.addLog('info', '📱 [3] Telefone...', cycle);
  await waitForSpinner(p, cycle, 10_000);

  const PHONE_CANDIDATES = [
    '#PHONE_NUMBER',
    'input[autocomplete="tel-national"]',
    '[data-testid="PHONE_COUNTRY_CODE"] ~ input',
    '[data-testid="PHONE_COUNTRY_CODE"] + input',
    'input[data-testid*="phone" i]',
    'input[placeholder*="telefone" i]',
    'input[placeholder*="phone" i]',
    'input[type="tel"]',
  ];

  let phoneInput: string | null = null;
  for (const sel of PHONE_CANDIDATES) {
    if (await hasElement(p, sel, 2000)) { phoneInput = sel; break; }
  }

  if (!phoneInput) {
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

  const phoneData = gerarTelefoneBR();

  if (!phoneInput) {
    const testIds = await p.evaluate(() =>
      Array.from(document.querySelectorAll('[data-testid]'))
        .map(el => (el as HTMLElement).dataset['testid'])
        .filter(Boolean).slice(0, 20)
    ).catch(() => []);
    globalState.addLog('warn', `⏩ Tela de telefone não encontrada. testids: ${JSON.stringify(testIds)}`, cycle);
    return phoneData;
  }

  const { display, digits } = phoneData;
  globalState.addLog('info', `📞 Telefone gerado: ${display} (enviando: ${digits})`, cycle);

  const el = p.locator(phoneInput).first();
  await el.scrollIntoViewIfNeeded();
  await el.click();
  await sleep(150);
  await p.keyboard.press('Control+a');
  await p.keyboard.press('Delete');
  await sleep(80);
  await reactFill(p, phoneInput, digits);
  await sleep(150);
  await el.evaluate((node: HTMLInputElement) => { node.blur(); node.focus(); });
  await sleep(200);
  globalState.addLog('info', `✔️ fill telefone via: ${phoneInput}`, cycle);

  const hasError = await hasElement(p, '[data-testid="phone-number-error"]', 800);
  if (hasError) {
    const errMsg = await p.locator('[data-testid="phone-number-error"]').first().innerText().catch(() => '');
    globalState.addLog('warn', `⚠️ Erro no telefone: "${errMsg.trim()}" — abortando ciclo`, cycle);
    throw new Error(`Telefone rejeitado pelo Uber: ${errMsg.trim()}`);
  }

  await clickForward(p, cycle);

  await sleep(600);
  const hasErrorAfter = await hasElement(p, '[data-testid="phone-number-error"]', 800);
  if (hasErrorAfter) {
    const errMsg = await p.locator('[data-testid="phone-number-error"]').first().innerText().catch(() => '');
    globalState.addLog('warn', `⚠️ Erro pós-submit no telefone: "${errMsg.trim()}" — abortando ciclo`, cycle);
    throw new Error(`Telefone rejeitado pós-submit: ${errMsg.trim()}`);
  }

  await waitForNextScreen(p, cycle, [
    '#PASSWORD',
    'input[autocomplete="new-password"]',
    'input[type="password"]',
    '#FIRST_NAME',
    SPINNER_SEL,
  ]);

  return phoneData;
}

const PASSWORD = 'connect@10';

async function stepPassword(p: Page, cycle: number): Promise<void> {
  globalState.addLog('info', '🔒 [4] Senha...', cycle);
  await waitForSpinner(p, cycle, 10_000);

  const PWD_SEL = '#PASSWORD, input[autocomplete="new-password"], input[type="password"]';
  const visible = await hasElement(p, PWD_SEL, 8000);
  if (!visible) {
    globalState.addLog('info', '⏩ Tela de senha não encontrada — pulando', cycle);
    return;
  }

  const hasPwdId = await hasElement(p, '#PASSWORD', 500);
  const el = hasPwdId
    ? p.locator('#PASSWORD').first()
    : p.locator('input[autocomplete="new-password"], input[type="password"]').first();

  await el.waitFor({ state: 'visible', timeout: 10_000 });
  await el.scrollIntoViewIfNeeded();
  await el.click();
  await sleep(100);
  await p.keyboard.press('Control+a');
  await p.keyboard.press('Delete');
  await sleep(80);
  await el.pressSequentially(PASSWORD, { delay: 60 + Math.random() * 40 });
  globalState.addLog('info', '✔️ fill [password]: senha digitada', cycle);

  await clickForward(p, cycle);
  await waitForNextScreen(p, cycle, [
    '#FIRST_NAME',
    'input[autocomplete="given-name"]',
    '#LAST_NAME',
    SPINNER_SEL,
  ]);
}

async function stepPersonalInfo(p: Page, cycle: number): Promise<{ nome: string; sobrenome: string }> {
  globalState.addLog('info', '👤 [5] Nome...', cycle);
  await waitForSpinner(p, cycle, 10_000);

  const firstNames = ['Lucas', 'Pedro', 'Matheus', 'Gabriel', 'Rafael', 'Felipe', 'Bruno'];
  const lastNames  = ['Silva', 'Santos', 'Oliveira', 'Souza', 'Lima', 'Ferreira', 'Costa'];
  const fn = firstNames[Math.floor(Math.random() * firstNames.length)];
  const ln = lastNames[Math.floor(Math.random() * lastNames.length)];

  const visible = await hasElement(p, '#FIRST_NAME, input[autocomplete="given-name"]', 8000);
  if (!visible) {
    globalState.addLog('info', '⏩ Tela de nome não encontrada — pulando', cycle);
    return { nome: fn, sobrenome: ln };
  }

  await fillById(p, 'FIRST_NAME', fn, 'primeiro nome', cycle);
  const hasLast = await hasElement(p, '#LAST_NAME, input[autocomplete="family-name"]', 1000);
  if (hasLast) await fillById(p, 'LAST_NAME', ln, 'sobrenome', cycle);

  await clickForward(p, cycle);
  await waitForNextScreen(p, cycle, [
    'input[type="checkbox"]',
    '[role="checkbox"]',
    '[data-testid="accept-terms"]',
    'text=Concordo',
    '[data-testid*="city"]',
    'input[placeholder*="cidade" i]',
    SPINNER_SEL,
  ]);

  return { nome: fn, sobrenome: ln };
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

  await waitForNextScreen(p, cycle, [
    '[data-testid="flow-type-city-selector-v2-input"]',
    '[data-testid="city-selector-input"]',
    '[data-testid*="city"]',
    'input[placeholder*="cidade" i]',
    'input[placeholder*="city" i]',
    '[data-testid="step-bottom-navigation"]',
    '[data-testid="hub"]',
    '[data-testid*="profilePhoto"]',
    SPINNER_SEL,
  ], 20_000);
}

const CITY_INPUT_SELS = [
  '[data-testid="flow-type-city-selector-v2-input"]',
  '[data-testid="city-selector-input"]',
  '[data-testid*="city"]',
  'input[placeholder*="cidade" i]',
  'input[placeholder*="city" i]',
  'input[placeholder*="ville" i]',
  'input[aria-label*="cidade" i]',
  'input[aria-label*="city" i]',
];

async function stepCity(
  p: Page,
  inviteCode: string,
  cycle: number,
  cityName = 'São Paulo'
): Promise<void> {
  globalState.addLog('info', '🏢 [7] Cidade...', cycle);

  const found = await waitOrReload(p, cycle, CITY_INPUT_SELS, 8_000, 30_000);

  if (!found) {
    const testIds = await p.evaluate(() =>
      Array.from(document.querySelectorAll('[data-testid]'))
        .map(el => (el as HTMLElement).dataset['testid'])
        .filter(Boolean).slice(0, 20)
    ).catch(() => []);
    globalState.addLog('warn', `⏩ Cidade não encontrada após reload. testids: ${JSON.stringify(testIds)}`, cycle);
    return;
  }

  await dismissCookieBanner(p, cycle);

  let cityInput: string | null = null;
  for (const sel of CITY_INPUT_SELS) {
    if (await hasElement(p, sel, 3_000)) { cityInput = sel; break; }
  }

  if (!cityInput) {
    globalState.addLog('warn', '⏩ Input de cidade não encontrado após detecção — pulando', cycle);
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

  await sleep(1500);

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
  } else {
    await clickForward(p, cycle);
  }

  await waitForNextScreen(p, cycle, [
    '[data-testid="step flowTypes"]',
    '[data-testid="step-button-primary"]',
    '[data-testid="step-bottom-navigation"]',
    '[data-testid="hub"]',
    '[data-testid*="profilePhoto"]',
    '[data-testid*="stepItem"]',
    SPINNER_SEL,
  ]);
}

// ─── [7b] TIPO DE FLUXO (veículo/moto/bicicleta) ─────────────────────────────────
async function stepFlowType(p: Page, cycle: number): Promise<void> {
  globalState.addLog('info', '🚗 [7b] Tipo de fluxo...', cycle);
  await waitForSpinner(p, cycle, 10_000);

  const FLOW_TYPE_SEL = '[data-testid="step flowTypes"], [data-testid="flow-selector"]';
  const visible = await hasElement(p, FLOW_TYPE_SEL, 8_000);
  if (!visible) {
    globalState.addLog('info', '⏩ Tela de tipo de fluxo não encontrada — pulando', cycle);
    return;
  }

  await dismissCookieBanner(p, cycle);

  const P2P_CANDIDATES = [
    '[data-testid="P2P:default"]',
    'button:has-text("Viagens de carro")',
    'div:has-text("Viagens de carro")',
  ];

  let p2pClicked = false;
  for (const sel of P2P_CANDIDATES) {
    const el = p.locator(sel).first();
    if (await el.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await el.scrollIntoViewIfNeeded();
      await sleep(300);
      await el.click({ force: true });
      globalState.addLog('info', `✔️ card P2P clicado via: ${sel}`, cycle);
      p2pClicked = true;

      const selectedConfirmed = await p.waitForFunction(
        (selector: string) => {
          const node = document.querySelector(selector);
          if (!node) return false;
          if (node.getAttribute('aria-checked') === 'true') return true;
          if (node.getAttribute('aria-selected') === 'true') return true;
          if (node.getAttribute('aria-pressed') === 'true') return true;
          if (node.hasAttribute('data-selected')) return true;
          const cls = (node as HTMLElement).className || '';
          return /\bselected\b|\bactive\b|\bchecked\b/i.test(cls);
        },
        sel,
        { timeout: 3_000 }
      ).then(() => true).catch(() => false);

      if (selectedConfirmed) {
        globalState.addLog('info', '✔️ card P2P confirmado como selecionado', cycle);
      } else {
        globalState.addLog('warn', '⚠️ card P2P: estado selecionado não confirmado — re-clicando', cycle);
        await el.click({ force: true }).catch(() => {});
        await sleep(400);
      }
      break;
    }
  }

  if (!p2pClicked) {
    globalState.addLog('warn', '⚠️ Card P2P não encontrado — tentando continuar mesmo assim', cycle);
  }

  await sleep(400);

  const CONTINUE_CANDIDATES = [
    '[data-testid="step-button-primary"]',
    'button:has-text("Continuar")',
  ];

  for (const sel of CONTINUE_CANDIDATES) {
    const btn = p.locator(sel).first();
    if (await btn.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await btn.scrollIntoViewIfNeeded();
      await sleep(200);
      await btn.click();
      globalState.addLog('info', `✔️ click: Continuar (flowType) via: ${sel}`, cycle);
      break;
    }
  }

  await waitForNextScreen(p, cycle, [
    '[data-testid="vehicle-with-solutions"]',
    '[data-testid="step vehicleWithSolutions"]',
    '[data-testid="step-submit-button"]',
    '[data-testid="step-bottom-navigation"]',
    '[data-testid="hub"]',
    '[data-testid*="profilePhoto"]',
    SPINNER_SEL,
  ]);
}

// ─── [7c] TIPO DE VEÍCULO ─────────────────────────────────────────────────────────
async function stepVehicleType(p: Page, cycle: number): Promise<void> {
  globalState.addLog('info', '🚘 [7c] Tipo de veículo...', cycle);
  await waitForSpinner(p, cycle, 10_000);

  const VEHICLE_SEL = '[data-testid="vehicle-with-solutions"], [data-testid="step vehicleWithSolutions"]';
  const visible = await hasElement(p, VEHICLE_SEL, 8_000);
  if (!visible) {
    globalState.addLog('info', '⏩ Tela de veículo não encontrada — pulando', cycle);
    return;
  }

  await dismissCookieBanner(p, cycle);

  const NEED_VEHICLE_CANDIDATES = [
    'label:has-text("Preciso de um veículo")',
    '[role="radio"]:has-text("Preciso de um veículo")',
    'div[role="radio"]:has-text("Preciso de um veículo")',
    'span:has-text("Preciso de um veículo")',
    'div:has-text("Preciso de um veículo")',
  ];

  let radioClicked = false;
  for (const sel of NEED_VEHICLE_CANDIDATES) {
    const el = p.locator(sel).first();
    if (await el.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await el.scrollIntoViewIfNeeded();
      await sleep(300);
      await el.click({ force: true });
      globalState.addLog('info', `✔️ "Preciso de um veículo" selecionado via: ${sel}`, cycle);
      radioClicked = true;
      break;
    }
  }

  if (!radioClicked) {
    const jsClicked = await p.evaluate(() => {
      const radios = Array.from(document.querySelectorAll('[role="radio"]')) as HTMLElement[];
      const target = radios.find(r =>
        r.offsetParent !== null && r.textContent?.includes('Preciso de um veículo')
      );
      if (target) { target.click(); return 'by-text'; }
      const visible = radios.filter(r => r.offsetParent !== null);
      if (visible.length >= 2) { visible[1].click(); return 'by-index'; }
      return null;
    });
    if (jsClicked) {
      globalState.addLog('info', `✔️ "Preciso de um veículo" via JS fallback (${jsClicked})`, cycle);
      radioClicked = true;
    } else {
      globalState.addLog('warn', '⚠️ Opção "Preciso de um veículo" não encontrada — continuando mesmo assim', cycle);
    }
  }

  await sleep(400);

  const SUBMIT_CANDIDATES = [
    '[data-testid="step-submit-button"]',
    'button:has-text("Continuar")',
  ];

  for (const sel of SUBMIT_CANDIDATES) {
    const btn = p.locator(sel).first();
    if (await btn.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await btn.scrollIntoViewIfNeeded();
      await sleep(200);
      await btn.click();
      globalState.addLog('info', `✔️ click: Continuar (vehicleType) via: ${sel}`, cycle);
      break;
    }
  }

  await waitForNextScreen(p, cycle, [
    '[data-testid="step-bottom-navigation"]',
    '[data-testid="hub"]',
    '[data-testid*="profilePhoto"]',
    '[data-testid*="stepItem"]',
    SPINNER_SEL,
  ]);
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
  }
  await waitForNextScreen(p, cycle, [
    '[data-testid="hub"]',
    '[data-testid*="profilePhoto"]',
    '[data-testid*="stepItem"]',
    SPINNER_SEL,
  ]);
}

const PHOTO_ITEM_SELS = [
  '[data-testid="stepItem profilePhoto"]',
  '[data-testid*="profilePhoto"]',
  '[data-testid*="profile-photo"]',
  '[data-testid*="profile_photo"]',
  'div:has-text("Foto do perfil")',
  'div:has-text("Photo de profil")',
  'span:has-text("Foto do perfil")',
  'li:has-text("Foto do perfil")',
  'button:has-text("Foto do perfil")',
];

const PHOTO_SCREEN_SELS = [
  '[data-testid="step profilePhoto"]',
  '[data-testid="docUploadButton"]',
  'button:has-text("Tirar foto")',
  'button:has-text("Prendre une photo")',
  'button:has-text("Capturar foto")',
  'button:has-text("Foto")',
  '[data-testid*="camera"]',
  '[data-testid*="upload"]',
];

async function stepHubPhotoClick(p: Page, cycle: number): Promise<void> {
  globalState.addLog('info', '🏠 [9] Hub — aguardando...', cycle);

  const HUB_CANDIDATES = [
    '[data-testid="hub"]',
    '[data-testid="stepItem profilePhoto"]',
    '[data-testid*="profilePhoto"]',
    '[data-testid*="profile-photo"]',
    '[data-testid*="profile_photo"]',
    '[data-testid*="stepItem"]',
    'text=Foto do perfil',
    'text=Photo de profil',
  ];

  let hubFound = false;
  const start = Date.now();
  while (Date.now() - start < 45_000) {
    if (isStopped()) throw new Error('Parado pelo usuário');
    await waitForSpinner(p, cycle, 5_000);
    for (const sel of HUB_CANDIDATES) {
      if (await hasElement(p, sel, 500)) {
        hubFound = true;
        globalState.addLog('info', `✔️ Hub encontrado via: ${sel}`, cycle);
        break;
      }
    }
    if (hubFound) break;
    await sleep(800);
  }

  if (!hubFound) {
    const testIds = await p.evaluate(() =>
      Array.from(document.querySelectorAll('[data-testid]'))
        .map(el => (el as HTMLElement).dataset['testid'])
        .filter(Boolean).slice(0, 20)
    ).catch(() => []);
    globalState.addLog('info', `⏩ Hub não encontrado. testids: ${JSON.stringify(testIds)}`, cycle);
    return;
  }

  await sleep(800);
  await dismissCookieBanner(p, cycle);

  let photoItemClicked = false;
  for (const sel of PHOTO_ITEM_SELS) {
    const el = p.locator(sel).first();
    if (await el.isVisible({ timeout: 2000 }).catch(() => false)) {
      try {
        await el.scrollIntoViewIfNeeded();
        await sleep(300);
        await el.click({ timeout: 5_000 });
      } catch {
        await el.click({ force: true, timeout: 5_000 }).catch(async () => {
          await p.evaluate((sel2: string) => {
            const node = document.querySelector(sel2) as HTMLElement | null;
            if (node) node.click();
          }, sel);
        });
      }
      globalState.addLog('info', `✔️ click: item Foto do perfil via: ${sel}`, cycle);
      photoItemClicked = true;
      break;
    }
  }

  if (!photoItemClicked) {
    const jsClicked = await p.evaluate(() => {
      const all = Array.from(document.querySelectorAll('*')) as HTMLElement[];
      const el = all.find(e =>
        e.offsetParent !== null &&
        (e.textContent?.trim() === 'Foto do perfil' || e.textContent?.trim() === 'Photo de profil')
      );
      if (el) { el.click(); return true; }
      return false;
    });
    globalState.addLog(
      jsClicked ? 'info' : 'warn',
      jsClicked ? '✔️ click: Foto do perfil via JS text search' : '⚠️ Item "Foto do perfil" não encontrado no hub',
      cycle
    );
    if (!jsClicked) return;
    photoItemClicked = true;
  }

  if (!photoItemClicked) return;

  await waitForNextScreen(p, cycle, PHOTO_SCREEN_SELS, 15_000);
}

// ─── [10] TIRAR FOTO + AGUARDAR KYC ──────────────────────────────────────────────
async function stepProfilePhoto(p: Page, cycle: number): Promise<void> {
  globalState.addLog('info', '📸 [10] Tirar foto do perfil...', cycle);

  await waitForSpinner(p, cycle, 10_000);

  const diagInfo = await p.evaluate(() => {
    const testIds = Array.from(document.querySelectorAll('[data-testid]'))
      .map(el => (el as HTMLElement).dataset['testid'])
      .filter(Boolean);
    const buttons = Array.from(document.querySelectorAll('button'))
      .filter(b => (b as HTMLElement).offsetParent !== null)
      .map(b => b.textContent?.trim())
      .filter(Boolean);
    return { testIds: testIds.slice(0, 30), buttons: buttons.slice(0, 20) };
  }).catch(() => ({ testIds: [], buttons: [] }));
  globalState.addLog('info', `🔍 [foto] testids: ${JSON.stringify(diagInfo.testIds)}`, cycle);
  globalState.addLog('info', `🔍 [foto] botões: ${JSON.stringify(diagInfo.buttons)}`, cycle);

  const visible = await hasElement(p, PHOTO_SCREEN_SELS.join(', '), 8_000);
  if (!visible) {
    globalState.addLog('info', '⏩ Tela de foto não encontrada — pulando', cycle);
    return;
  }

  await dismissCookieBanner(p, cycle);

  const TAKE_PHOTO_SELS = [
    '[data-testid="docUploadButton"]',
    'button:has-text("Tirar foto")',
    'button:has-text("Prendre une photo")',
    'button:has-text("Capturar foto")',
    'button:has-text("Foto")',
    '[data-testid*="camera"]',
  ];

  for (const sel of TAKE_PHOTO_SELS) {
    const btn = p.locator(sel).first();
    if (await btn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await btn.scrollIntoViewIfNeeded();
      await sleep(300);
      try {
        await btn.click({ timeout: 5_000 });
      } catch {
        await btn.click({ force: true, timeout: 5_000 }).catch(async () => {
          await p.evaluate((sel2: string) => {
            const node = document.querySelector(sel2) as HTMLElement | null;
            if (node) node.click();
          }, sel);
        });
      }
      globalState.addLog('info', `✔️ click: Tirar foto via: ${sel}`, cycle);
      break;
    }
  }

  globalState.addLog('info', '⏳ [KYC] Aguardando abertura do KYC provider (popup/nova aba)...', cycle);
  const KYC_WAIT_MS = 90_000;
  const kycStart = Date.now();
  while (Date.now() - kycStart < KYC_WAIT_MS) {
    if (isStopped()) break;
    const signals = globalState.getKycSignals(cycle);
    if (signals.length > 0) {
      globalState.addLog('info', `✅ [KYC] ${signals.length} sinal(is) detectado(s) — encerrando espera`, cycle);
      break;
    }
    await new Promise<void>(r => setTimeout(r, 500));
  }

  const finalSignals = globalState.getKycSignals(cycle);
  if (finalSignals.length === 0) {
    globalState.addLog('warn', '⚠️ [KYC] Nenhum provedor detectado neste ciclo', cycle);
  } else {
    const providers = [...new Set(finalSignals.map(s => s.provider))];
    globalState.addLog('kyc', `🏁 [KYC] Ciclo ${cycle} — provedores: ${providers.join(', ')}`, cycle);
  }
}

// ─── DISMISS MODALS ─────────────────────────────────────────────────────────────────

async function dismissModals(p: Page, cycle: number): Promise<void> {
  const DISMISS = [
    'button:has-text("Accept")', 'button:has-text("Accepter")',
    'button:has-text("OK")', 'button:has-text("Got it")',
    '[data-testid*="dismiss"]', '[aria-label*="close" i]',
    '#privacy-cookie-banners-root button:has-text("Aceitar")',
    '#privacy-cookie-banners-root button:has-text("Aceitar tudo")',
    '#privacy-cookie-banners-root button:has-text("Accept")',
    '#privacy-cookie-banners-root button:has-text("Accept all")',
    '#privacy-cookie-banners-root button',
  ];
  for (const sel of DISMISS) {
    if (await hasElement(p, sel, 400)) {
      await p.locator(sel).first().click({ force: true }).catch(() => {});
      globalState.addLog('info', `🚪 modal: ${sel}`, cycle);
      await sleep(400);
    }
  }
}

// ─── BROWSER ──────────────────────────────────────────────────────────────────────

let browserInstance: Browser | null = null;
let lastProxyConfig: string | null = null;
let lastHeadless: boolean | null = null;

const BRAVE_CANDIDATES = [
  process.env.BRAVE_PATH,
  'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
  'C:\\Program Files (x86)\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
  `${process.env.LOCALAPPDATA}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe`,
  '/usr/bin/brave-browser',
  '/usr/bin/brave',
  '/snap/bin/brave',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
  '/snap/bin/chromium',
].filter(Boolean) as string[];

export class MockPlaywrightFlow {
  static async init(headless = true): Promise<void> {
    const proxy0 = globalState.getProxyForCycle(0);
    const proxyKey = proxy0 ? proxy0.server : '';

    if (browserInstance && (lastProxyConfig !== proxyKey || lastHeadless !== headless)) {
      globalState.addLog('info', '🔄 Configuração mudou — reiniciando browser...');
      await browserInstance.close().catch(() => {});
      browserInstance = null;
    }
    if (browserInstance) return;

    const { existsSync } = await import('fs');
    let executablePath: string | undefined;
    for (const c of BRAVE_CANDIDATES) {
      if (existsSync(c)) { executablePath = c; break; }
    }

    if (executablePath) {
      globalState.addLog('info', `🦁 Usando Brave: ${executablePath}`);
    } else {
      globalState.addLog('warn', '⚠️ Brave não encontrado — usando Playwright Chromium');
    }

    globalState.addLog('info', `🚀 Iniciando browser (headless=${headless})...`);

    const launchArgs = [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--no-default-browser-check',
      `--window-size=${MOBILE_W},${MOBILE_H}`,
      '--window-position=0,0',
      `--user-agent=${MOBILE_UA}`,
    ];

    if (proxyKey) launchArgs.push(`--proxy-server=${proxyKey}`);

    browserInstance = await chromium.launch({
      headless,
      ...(executablePath ? { executablePath } : {}),
      args: launchArgs,
    });
    lastProxyConfig = proxyKey;
    lastHeadless = headless;
    globalState.addLog('info', `✅ Browser iniciado`);
  }

  static async cleanup(): Promise<void> {
    if (browserInstance) {
      await browserInstance.close().catch(() => {});
      browserInstance = null;
    }
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
    const proxyConfig = globalState.getProxyForCycle(cycle);

    const ctxOpts: Parameters<Browser['newContext']>[0] = {
      userAgent: MOBILE_UA,
      viewport: { width: MOBILE_W, height: MOBILE_H },
      deviceScaleFactor: MOBILE_DPR,
      isMobile: true,
      hasTouch: true,
      locale: 'pt-BR',
      timezoneId: 'America/Sao_Paulo',
      permissions: ['geolocation'],
      geolocation: { latitude: -23.5505, longitude: -46.6333 },
      extraHTTPHeaders: MOBILE_HEADERS,
    };

    if (proxyConfig) {
      ctxOpts.proxy = {
        server:   proxyConfig.server,
        username: proxyConfig.username,
        password: proxyConfig.password,
      };
      globalState.addLog('info', `🌐 Proxy: ${proxyConfig.server}`, cycle);
    } else {
      globalState.addLog('info', '🌐 Sem proxy (VPN)', cycle);
    }

    const context = await browserInstance!.newContext(ctxOpts);

    installKycInterceptor(context, cycle);

    await context.addInitScript(MOBILE_INIT_SCRIPT);

    const p = await context.newPage();
    p.setDefaultTimeout(20_000);
    p.setDefaultNavigationTimeout(30_000);

    attachPageListeners(p, cycle, 'main');

    let email = '';
    let telefone = '';
    let telefoneFmt = '';
    let nome = '';
    let sobrenome = '';

    try {
      const emailClient = createEmailClient(config.emailProvider, config.tempMailApiKey);
      const created = await emailClient.createRandomEmail();
      email = created.email;
      globalState.addLog('info', `📧 Email: ${email}`, cycle);

      globalState.addLog('info', `🌐 Navegando para ${cadastroUrl}...`, cycle);
      await p.goto(cadastroUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      globalState.addLog('info', '✔️ Página carregada', cycle);

      await dismissModals(p, cycle);
      await dismissCookieBanner(p, cycle);

      await stepEmail(p, email, cycle);
      await stepOTP(p, emailClient, email, config.otpTimeout, cycle);
      const phoneData = await stepPhone(p, cycle);
      telefone    = phoneData.digits;
      telefoneFmt = phoneData.display;
      await stepPassword(p, cycle);
      const nameData = await stepPersonalInfo(p, cycle);
      nome      = nameData.nome;
      sobrenome = nameData.sobrenome;
      await stepTerms(p, cycle);
      await stepCity(p, config.inviteCode, cycle, config.cityName);
      await stepFlowType(p, cycle);
      await stepVehicleType(p, cycle);
      await stepWhatsApp(p, cycle);
      await stepHubPhotoClick(p, cycle);
      await stepProfilePhoto(p, cycle);

      if (config.extraDelay > 0) {
        globalState.addLog('info', `⏳ Extra delay: ${config.extraDelay}ms`, cycle);
        await sleep(config.extraDelay);
      }

      const kycSignals = globalState.getKycSignals(cycle);
      const topSignal  = kycSignals.length > 0 ? kycSignals[0] : null;

      const kycLevel = topSignal
        ? (globalState.getKycByCycleEntry(cycle)?.[topSignal.provider]?.level ?? undefined)
        : undefined;

      const cookies = await context.cookies().catch(() => []);

      // FIX TS2345: adicionados os campos obrigatórios provider, senha e codigoIndicacao
      // que estavam faltando no objeto passado para accountStore.save().
      accountStore.save({
        email,
        telefone,
        nome,
        sobrenome,
        cycle,
        provider:          config.emailProvider,
        senha:             PASSWORD,
        codigoIndicacao:   config.inviteCode,
        kycProvider:       topSignal?.provider ?? undefined,
        kycLevel,
        localizacao:       config.cityName ?? 'São Paulo',
        cookies,
      });
      globalState.addLog('success', `✅ Ciclo ${cycle} concluído — conta: ${email}`, cycle);

    } finally {
      await context.close().catch(() => {});
    }
  }
}
