import { chromium } from 'playwright';
import { Browser, Page, BrowserContext } from 'playwright';
import { globalState } from '../state/globalState';
import { EmailProvider } from '../types';
import { createEmailClient } from '../tempMail/client';
import * as accountStore from '../store/accountStore';

const CYCLE_TIMEOUT_MS = 8 * 60 * 1_000;
const EXTRA_DELAY = 500;

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

/** Delay humano: base ± até 40% de jitter aleatório */
function humanDelay(baseMs: number): number {
  const jitter = baseMs * 0.4;
  return Math.round(baseMs - jitter + Math.random() * jitter * 2);
}

async function hasElement(p: Page, sel: string, timeout = 600): Promise<boolean> {
  return p.locator(sel).first().isVisible({ timeout }).catch(() => false);
}

async function tryClickForward(p: Page, cycle: number, visibilityTimeoutMs = 3_000): Promise<boolean> {
  const FORWARD = '[data-testid="forward-button"]';

  if (!(await hasElement(p, FORWARD, visibilityTimeoutMs))) {
    const testids = await getTestIds(p);
    const btns = await getButtonTexts(p);
    globalState.addLog('warn', `⚠️ forward-button não encontrado. testids=[${testids}] botões=[${btns}]`, cycle);
    return false;
  }

  const enabledDeadline = Date.now() + 8_000;
  while (Date.now() < enabledDeadline) {
    const enabled = await p.locator(FORWARD).first().isEnabled({ timeout: 500 }).catch(() => false);
    if (enabled) break;
    await sleep(300);
  }

  await sleep(humanDelay(600));

  try {
    await p.locator(FORWARD).click({ timeout: 5_000 });
    globalState.addLog('info', '✔️ click: Avançar (forward-button)', cycle);
    return true;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    globalState.addLog('warn', `⚠️ forward-button existe mas click falhou: ${msg.slice(0, 120)}`, cycle);
    return false;
  }
}

// ─── MOBILE CONTEXT ────────────────────────────────────────────────────────────
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

interface KycRule {
  pattern: RegExp;
  provider: string;
  weight: (url: string) => number;
}

const KYC_RULES: KycRule[] = [
  { pattern: /socure\.com/i,       provider: 'Socure',  weight: (url) => /\/dv\/|\/sv\/|document/i.test(url) ? 10 : 6 },
  { pattern: /magic\.veriff\.me/i, provider: 'Veriff',  weight: () => 10 },
  { pattern: /veriff\.com/i,       provider: 'Veriff',  weight: (url) => /\/v\d|\/attempt|\/media|magic/i.test(url) ? 10 : 7 },
  { pattern: /withpersona\.com/i,  provider: 'Persona', weight: () => 6 },
  { pattern: /getid\.company/i,    provider: 'GetID',   weight: () => 6 },
  { pattern: /iproov\.com/i,       provider: 'iProov',  weight: () => 6 },
  { pattern: /onfido\.com/i,       provider: 'Onfido',  weight: (url) => /\/sdk|\/applicants|\/checks/i.test(url) ? 10 : 6 },
  { pattern: /jumio\.com/i,        provider: 'Jumio',   weight: (url) => /\/netverify|\/initiate|\/acquire/i.test(url) ? 10 : 6 },
];

function detectKycFromUrl(url: string, cycle: number, source: string): void {
  if (!url || url === 'about:blank' || url.startsWith('chrome')) return;
  for (const rule of KYC_RULES) {
    if (rule.pattern.test(url)) {
      const weight = rule.weight(url);
      globalState.addKycSignal(rule.provider, source, weight, cycle, url);
      globalState.addLog('kyc', `🔎 KYC detectado: ${rule.provider} via ${source} | ${url.substring(0, 100)}`, cycle);
      return;
    }
  }
}

function attachPageListeners(page: Page, cycle: number, label: string): void {
  page.on('framenavigated', (frame) => { try { detectKycFromUrl(frame.url(), cycle, `${label}:frame-navigate`); } catch { } });
  page.on('response',       (res)   => { try { detectKycFromUrl(res.url(),   cycle, `${label}:network`);       } catch { } });
  page.on('request',        (req)   => { try { detectKycFromUrl(req.url(),   cycle, `${label}:request`);       } catch { } });
  try { detectKycFromUrl(page.url(), cycle, `${label}:page-open`); } catch { }
}

function installKycInterceptor(context: BrowserContext, cycle: number): void {
  context.on('page', (newPage) => {
    attachPageListeners(newPage, cycle, 'popup');
    newPage.once('load', () => { try { detectKycFromUrl(newPage.url(), cycle, 'popup:load'); } catch { } });
  });
  context.on('response', (res) => { try { detectKycFromUrl(res.url(), cycle, 'ctx:network'); } catch { } });
  context.on('request',  (req) => { try { detectKycFromUrl(req.url(), cycle, 'ctx:request'); } catch { } });
}

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
      await sleep(humanDelay(800));
      return;
    }
    await sleep(400);
  }
  globalState.addLog('warn', '⚠️ Spinner timeout — continuando mesmo assim', cycle);
}

async function waitForNextScreen(p: Page, cycle: number, selectors: string[], maxMs = 60_000): Promise<void> {
  globalState.addLog('info', '⏳ Aguardando próxima tela...', cycle);
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    if (isStopped()) throw new Error('Parado pelo usuário');
    for (const sel of selectors) {
      if (await hasElement(p, sel, 400)) {
        globalState.addLog('info', '✔️ Próxima tela detectada', cycle);
        await sleep(humanDelay(600));
        return;
      }
    }
    await waitForSpinner(p, cycle, 5_000);
    await sleep(500);
  }
  globalState.addLog('warn', '⚠️ Timeout aguardando próxima tela — continuando mesmo assim', cycle);
}

async function waitOrReload(p: Page, cycle: number, selectors: string[], quickMs = 8_000, afterReloadMs = 30_000): Promise<boolean> {
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
  await sleep(humanDelay(2_000));
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

async function dismissCookieBanner(p: Page, cycle: number): Promise<void> {
  const BANNER_SEL = '#privacy-cookie-banners-root';
  if (!(await hasElement(p, BANNER_SEL, 1_500))) return;
  globalState.addLog('info', '🍪 Banner de cookies detectado — fechando...', cycle);
  const ACCEPT_CANDIDATES = [
    `${BANNER_SEL} button:has-text("Aceitar")`,
    `${BANNER_SEL} button:has-text("Aceitar tudo")`,
    `${BANNER_SEL} button:has-text("Accept")`,
    `${BANNER_SEL} button:has-text("Accept all")`,
    `${BANNER_SEL} button:has-text("Concordo")`,
    `${BANNER_SEL} button:has-text("OK")`,
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
    } catch { }
  }
  if (!dismissed) {
    const removed = await p.evaluate((s: string) => { const el = document.querySelector(s); if (el) { el.remove(); return true; } return false; }, BANNER_SEL);
    globalState.addLog(removed ? 'info' : 'warn', removed ? '✔️ Cookie banner removido via JS' : '⚠️ Cookie banner não removido', cycle);
  }
  await sleep(humanDelay(600));
}

// ─── FAKE DATA ──────────────────────────────────────────────────────────────────

const FIRST_NAMES = ['Ana','Bruno','Carlos','Daniela','Eduardo','Fernanda','Gabriel','Helena','Igor','Juliana','Kevin','Larissa','Marcos','Natalia','Otavio','Patricia','Rafael','Sabrina','Thiago','Valentina','William','Xavier','Yasmin','Zelia','Adriana','Beatriz','Caio','Diana','Elias','Fabio','Giovana','Hugo','Isabela','Joao','Kaio','Leticia','Murilo','Nina','Oscar','Paula','Rodrigo','Silvia','Tiago','Ursula','Vitor','Wanda','Ximena','Yago'];
const LAST_NAMES  = ['Silva','Santos','Oliveira','Souza','Rodrigues','Ferreira','Alves','Pereira','Lima','Gomes','Costa','Ribeiro','Martins','Carvalho','Almeida','Lopes','Sousa','Fernandes','Vieira','Barbosa','Rocha','Dias','Nascimento','Andrade','Moreira','Nunes','Marques','Machado','Mendes','Freitas','Cardoso','Ramos','Moraes','Teixeira','Monteiro','Araujo','Xavier','Castro','Correia','Campos'];

function pick<T>(arr: T[]): T { return arr[Math.floor(Math.random() * arr.length)]!; }

function randomBrazilPhone(): { formatted: string; digits: string } {
  const DDDs = ['11','21','31','41','51','61','71','81','91','19','27','48','85','92'];
  const ddd  = pick(DDDs);
  const n1   = String(Math.floor(Math.random() * 9) + 1);
  const rest = String(Math.floor(Math.random() * 100_000_000)).padStart(8, '0');
  const digits    = `${ddd}9${n1}${rest}`.slice(0, 11);
  const formatted = `(${digits.slice(0,2)}) 9${digits.slice(3,7)}-${digits.slice(7,11)}`;
  return { formatted, digits };
}

const PASSWORD = 'Secure@2024!';

// ─── HELPERS ────────────────────────────────────────────────────────────────────

async function getTestIds(p: Page): Promise<string> {
  try {
    return await p.evaluate(() =>
      Array.from(document.querySelectorAll('[data-testid]'))
        .map(e => e.getAttribute('data-testid')).filter(Boolean).slice(0, 20).join(','));
  } catch { return '(erro)'; }
}

async function getButtonTexts(p: Page): Promise<string> {
  try {
    return await p.evaluate(() =>
      Array.from(document.querySelectorAll('button'))
        .map(b => b.textContent?.trim()).filter(Boolean).slice(0, 10).join(','));
  } catch { return '(erro)'; }
}

async function findAsync(sels: string[], check: (sel: string) => Promise<boolean>): Promise<string | undefined> {
  for (const sel of sels) {
    if (await check(sel)) return sel;
  }
  return undefined;
}

async function waitForUrlChange(p: Page, cycle: number, currentUrlContains: string, maxMs = 15_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    if (isStopped()) break;
    const url = p.url();
    if (!url.includes(currentUrlContains)) {
      globalState.addLog('info', `✔️ URL mudou: ${url.slice(0, 80)}`, cycle);
      return true;
    }
    await sleep(400);
  }
  globalState.addLog('warn', `⚠️ URL não mudou de "${currentUrlContains}" em ${maxMs}ms`, cycle);
  return false;
}

/**
 * Aguarda um testid desaparecer do DOM (React desmontou o componente anterior).
 * Usado após transições de tela para garantir que o DOM foi atualizado.
 */
async function waitForTestIdGone(p: Page, testid: string, maxMs = 10_000): Promise<void> {
  const sel = `[data-testid="${testid}"]`;
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const present = await hasElement(p, sel, 400);
    if (!present) return;
    await sleep(300);
  }
  // Não desapareceu — loga mas não bloqueia
  globalState.addLog('warn', `⚠️ [DOM] ${testid} ainda presente após ${maxMs}ms`, 0);
}

/**
 * Verifica se há algum checkbox marcado na página.
 */
async function isAnyCheckboxChecked(p: Page): Promise<boolean> {
  try {
    return await p.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll('input[type="checkbox"]')) as HTMLInputElement[];
      if (inputs.some(i => i.checked)) return true;
      const roles = Array.from(document.querySelectorAll('[role="checkbox"]'));
      if (roles.some(r => r.getAttribute('aria-checked') === 'true')) return true;
      return false;
    });
  } catch {
    return false;
  }
}

// ─── STEPS ──────────────────────────────────────────────────────────────────────

async function stepEmail(p: Page, cycle: number, email: string): Promise<void> {
  globalState.addLog('info', '📧 [1] Email...', cycle);
  await dismissCookieBanner(p, cycle);
  await sleep(humanDelay(2_500));
  const EMAIL_INPUT = '[data-testid="email-input"], input[type="email"], input[name="email"]';
  await p.locator(EMAIL_INPUT).fill(email, { timeout: 10_000 }).catch(async () => {
    await p.locator('input').first().fill(email, { timeout: 10_000 });
  });
  globalState.addLog('info', '✔️ fill: email', cycle);
  await sleep(humanDelay(1_200));
  await tryClickForward(p, cycle, 5_000);
  await waitForNextScreen(p, cycle, [
    '[data-testid="otp-input"]', 'input[name="otp"]',
    'input[placeholder*="código"]', 'input[placeholder*="code"]',
    '[data-testid="forward-button"]',
  ]);
}

async function stepOtp(p: Page, cycle: number, emailClient: Awaited<ReturnType<typeof createEmailClient>>, email: string, config: { emailProvider: EmailProvider; otpTimeout: number }): Promise<void> {
  globalState.addLog('info', '🔢 [2] Aguardando OTP...', cycle);
  globalState.addLog('info', '✔️ Tela OTP detectada', cycle);
  const timeoutSec = Math.round(config.otpTimeout / 1000);
  globalState.addLog('info', `⏳ [${config.emailProvider}] Aguardando OTP para ${email} (${timeoutSec}s)...`, cycle);
  const otp = await emailClient.waitForOTP(email, config.otpTimeout, cycle);
  globalState.addLog('info', `🔢 OTP recebido: ${otp}`, cycle);
  await sleep(humanDelay(800));
  const OTP_INPUT = '[data-testid="otp-input"], input[name="otp"], input[inputmode="numeric"]';
  const inputs = await p.locator(OTP_INPUT).all();
  if (inputs.length > 1) {
    for (let i = 0; i < Math.min(inputs.length, otp.length); i++) {
      await inputs[i]!.fill(otp[i]!);
      await sleep(humanDelay(200));
    }
    globalState.addLog('info', '✔️ OTP preenchido (inputs separados)', cycle);
  } else {
    await p.locator(OTP_INPUT).first().fill(otp, { timeout: 8_000 });
    globalState.addLog('info', '✔️ OTP preenchido (input único)', cycle);
  }
  await sleep(humanDelay(1_000));
  await tryClickForward(p, cycle, 1_500);
  await waitForNextScreen(p, cycle, [
    '[data-testid="forward-button"]', '[data-testid="password-input"]',
    'input[name="password"]', '[data-testid="PHONE_NUMBER"]', '#PHONE_NUMBER',
  ]);
}

async function stepPhone(p: Page, cycle: number): Promise<{ formatted: string; digits: string }> {
  globalState.addLog('info', '📱 [3] Telefone...', cycle);
  const phone = randomBrazilPhone();
  globalState.addLog('info', `📞 Telefone gerado: ${phone.formatted} (enviando: ${phone.digits})`, cycle);
  await sleep(humanDelay(800));
  const PHONE_CANDIDATES = [
    '[data-testid="PHONE_NUMBER"]', '#PHONE_NUMBER',
    'input[name="phone"]', 'input[type="tel"]',
    'input[placeholder*="telefone" i]', 'input[placeholder*="celular" i]', 'input[placeholder*="phone" i]',
  ];
  let filled = false;
  for (const sel of PHONE_CANDIDATES) {
    if (await hasElement(p, sel, 800)) {
      await p.locator(sel).first().fill(phone.digits, { timeout: 8_000 });
      globalState.addLog('info', `✔️ fill telefone via: ${sel}`, cycle);
      filled = true;
      break;
    }
  }
  if (!filled) {
    await p.locator('input').first().fill(phone.digits, { timeout: 8_000 });
    globalState.addLog('info', '✔️ fill telefone via: input genérico', cycle);
  }
  await sleep(humanDelay(1_200));
  await tryClickForward(p, cycle, 5_000);
  await waitForNextScreen(p, cycle, [
    'input[name="password"]', '[data-testid="password-input"]',
    'input[type="password"]', '[data-testid="forward-button"]',
  ]);
  return phone;
}

async function stepPassword(p: Page, cycle: number): Promise<void> {
  globalState.addLog('info', '🔒 [4] Senha...', cycle);
  await sleep(humanDelay(800));
  const PWD_CANDIDATES = [
    'input[name="password"]', '[data-testid="password-input"]', 'input[type="password"]',
  ];
  for (const sel of PWD_CANDIDATES) {
    if (await hasElement(p, sel, 800)) {
      await p.locator(sel).first().fill(PASSWORD, { timeout: 8_000 });
      globalState.addLog('info', '✔️ fill [password]: senha digitada', cycle);
      break;
    }
  }
  await sleep(humanDelay(1_200));
  await tryClickForward(p, cycle, 5_000);
  await waitForNextScreen(p, cycle, [
    '[data-testid="FIRST_NAME"]', '#FIRST_NAME',
    'input[name="firstName"]', 'input[placeholder*="nome" i]', '[data-testid="forward-button"]',
  ]);
}

async function stepName(p: Page, cycle: number): Promise<{ nome: string; sobrenome: string }> {
  globalState.addLog('info', '👤 [5] Nome...', cycle);
  await sleep(humanDelay(800));
  const nome      = pick(FIRST_NAMES);
  const sobrenome = pick(LAST_NAMES);
  const FIRST_CANDIDATES = ['[data-testid="FIRST_NAME"]', '#FIRST_NAME', 'input[name="firstName"]', 'input[placeholder*="primeiro" i]', 'input[placeholder*="first" i]'];
  const LAST_CANDIDATES  = ['[data-testid="LAST_NAME"]',  '#LAST_NAME',  'input[name="lastName"]',  'input[placeholder*="sobrenome" i]', 'input[placeholder*="last" i]'];
  for (const sel of FIRST_CANDIDATES) {
    if (await hasElement(p, sel, 800)) {
      await p.locator(sel).first().fill(nome, { timeout: 8_000 });
      globalState.addLog('info', '✔️ fill [#FIRST_NAME]: primeiro nome', cycle);
      break;
    }
  }
  await sleep(humanDelay(600));
  for (const sel of LAST_CANDIDATES) {
    if (await hasElement(p, sel, 800)) {
      await p.locator(sel).first().fill(sobrenome, { timeout: 8_000 });
      globalState.addLog('info', '✔️ fill [#LAST_NAME]: sobrenome', cycle);
      break;
    }
  }
  await sleep(humanDelay(1_200));
  await tryClickForward(p, cycle, 5_000);
  await waitForNextScreen(p, cycle, [
    '[data-testid="forward-button"]', 'input[type="checkbox"]',
    'label:has-text("Concordo")', 'label:has-text("Agree")',
  ]);
  return { nome, sobrenome };
}

async function stepTerms(p: Page, cycle: number): Promise<void> {
  globalState.addLog('info', '📝 [6] Termos...', cycle);
  await sleep(humanDelay(1_000));

  const CHECKBOX_CANDIDATES = [
    'label:has-text("Concordo")', 'label:has-text("Agree")',
    'label:has-text("Aceito")', 'label:has-text("I agree")',
    'input[type="checkbox"]', '[data-testid*="checkbox"]', '[role="checkbox"]',
  ];

  let clicked = false;
  for (const sel of CHECKBOX_CANDIDATES) {
    if (await hasElement(p, sel, 1_000)) {
      await p.locator(sel).first().click({ force: true, timeout: 8_000 });
      globalState.addLog('info', `✔️ checkbox clicado via: ${sel}`, cycle);
      clicked = true;
      break;
    }
  }

  if (clicked) {
    const checkDeadline = Date.now() + 12_000;
    let confirmed = false;
    while (Date.now() < checkDeadline) {
      if (await isAnyCheckboxChecked(p)) { confirmed = true; break; }
      await sleep(400);
    }
    if (confirmed) {
      globalState.addLog('info', '✔️ Checkbox confirmado como marcado no DOM', cycle);
    } else {
      globalState.addLog('warn', '⚠️ Checkbox não marcado após 12s — tentando novamente', cycle);
      for (const sel of CHECKBOX_CANDIDATES) {
        if (await hasElement(p, sel, 600)) {
          await p.locator(sel).first().click({ force: true, timeout: 5_000 }).catch(() => {});
          break;
        }
      }
      await sleep(humanDelay(1_000));
      if (await isAnyCheckboxChecked(p)) {
        globalState.addLog('info', '✔️ Checkbox marcado na segunda tentativa', cycle);
      } else {
        globalState.addLog('warn', '⚠️ Checkbox pode não estar marcado — avançando mesmo assim', cycle);
      }
    }
  } else {
    await sleep(humanDelay(1_000));
  }

  await sleep(humanDelay(1_500));
  await tryClickForward(p, cycle, 5_000);
  await waitForNextScreen(p, cycle, [
    '[data-testid="forward-button"]', '[data-testid="city-input"]',
    '[data-testid="flow-type-city-selector-v2"]', '[data-testid="flow-type-city-selector-v2-input"]',
    'input[name="city"]', '[data-testid="location"]',
  ]);
}

async function stepCity(p: Page, cycle: number, cityName?: string): Promise<void> {
  globalState.addLog('info', '🏢 [7] Cidade...', cycle);

  const PAGE_HAS_CONTENT = '[data-testid], input, button';
  const contentDeadline = Date.now() + 10_000;
  while (Date.now() < contentDeadline) {
    if (await hasElement(p, PAGE_HAS_CONTENT, 600)) break;
    await sleep(500);
  }

  const CITY_SELS = [
    '[data-testid="flow-type-city-selector-v2-input"]',
    '[data-testid="flow-type-city-selector-v2"] input',
    '[data-testid="carbonInput__input"]',
    '[data-testid="city-input"]',
    'input[name="city"]',
    'input[placeholder*="cidade" i]',
    'input[placeholder*="city" i]',
    '[data-testid="location"]',
    'input[placeholder*="localiza" i]',
  ];

  const found = await waitOrReload(p, cycle, CITY_SELS, 8_000, 30_000);
  if (!found) {
    globalState.addLog('warn', `⚠️ Cidade não encontrada após reload. testids: ${await getTestIds(p)}`, cycle);
    return;
  }

  await sleep(humanDelay(800));
  const targetCity = cityName ?? 'São Paulo';
  const activeSel = await findAsync(CITY_SELS, sel => hasElement(p, sel, 800));
  if (activeSel) {
    await p.locator(activeSel).first().fill(targetCity, { timeout: 8_000 });
    globalState.addLog('info', `✔️ fill cidade: ${targetCity}`, cycle);
    await sleep(humanDelay(1_200));
    const option = p.locator(`[role="option"]:has-text("${targetCity}")`).first();
    if (await option.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await option.click({ timeout: 5_000 });
      globalState.addLog('info', `✔️ Opção de cidade selecionada: ${targetCity}`, cycle);
    }
  }

  await sleep(humanDelay(1_000));

  const ADVANCE_BTN = 'button:has-text("Avançar"), button:has-text("Next"), button:has-text("Continue")';
  if (await hasElement(p, ADVANCE_BTN, 1_500)) {
    await sleep(humanDelay(600));
    await p.locator(ADVANCE_BTN).first().click({ timeout: 5_000 }).catch(() => {});
    globalState.addLog('info', '✔️ Cidade: clicou botão Avançar por texto', cycle);
  } else {
    const fwClicked = await tryClickForward(p, cycle, 1_500);
    if (!fwClicked) globalState.addLog('info', '⏩ Cidade: sem forward-button — tela avançou automaticamente', cycle);
  }

  // 1) Aguarda URL sair de "city"
  const urlChanged = await waitForUrlChange(p, cycle, 'city', 15_000);
  if (!urlChanged) {
    globalState.addLog('warn', '⚠️ Cidade: URL não mudou — tentando Avançar novamente', cycle);
    await tryClickForward(p, cycle, 3_000);
    await waitForUrlChange(p, cycle, 'city', 10_000);
  }

  // 2) FIX: aguarda React desmontar o componente da cidade (signup-step-city-select)
  //    antes de continuar para stepFlowType — evita o próximo step ler DOM antigo
  await waitForTestIdGone(p, 'signup-step-city-select', 12_000);
  // Pausa extra para React montar o próximo componente
  await sleep(humanDelay(1_200));

  globalState.addLog('info', `✔️ Cidade concluída. testids: ${await getTestIds(p)}`, cycle);
}

async function stepFlowType(p: Page, cycle: number): Promise<void> {
  globalState.addLog('info', '🚗 [7b] Tipo de fluxo...', cycle);

  const FLOW_SELS = [
    '[data-testid="flow-type-car"]',
    '[data-testid="flow-type-DRIVER"]',
    '[data-testid="flow-type-MOTO"]',
    'button:has-text("Carro")',
    'button:has-text("Car")',
    'button:has-text("Moto")',
    '[data-testid^="flow-type-"]',
  ];

  if (!(await hasElement(p, FLOW_SELS.join(', '), 3_000))) {
    globalState.addLog('info', '⏩ Tela de tipo de fluxo não encontrada — pulando', cycle);
    return;
  }

  await sleep(humanDelay(800));
  const CAR_SELS = [
    '[data-testid="flow-type-car"]',
    '[data-testid="flow-type-DRIVER"]',
    'button:has-text("Carro")',
    'button:has-text("Car")',
  ];
  for (const sel of CAR_SELS) {
    if (await hasElement(p, sel, 800)) {
      await p.locator(sel).first().click({ timeout: 8_000 });
      globalState.addLog('info', `✔️ Tipo de fluxo: Carro via ${sel}`, cycle);
      break;
    }
  }
  await sleep(humanDelay(1_000));
  await tryClickForward(p, cycle, 1_500);
  await waitForNextScreen(p, cycle, ['[data-testid="forward-button"]','[data-testid="vehicle-type"]','[data-testid^="vehicle-type-"]']);
}

async function stepVehicleType(p: Page, cycle: number): Promise<void> {
  globalState.addLog('info', '🚘 [7c] Tipo de veículo...', cycle);
  const VEHICLE_SELS = ['[data-testid="vehicle-type"]','[data-testid^="vehicle-type-"]','button:has-text("UberX")','button:has-text("Comfort")'];
  if (!(await hasElement(p, VEHICLE_SELS.join(', '), 2_000))) {
    globalState.addLog('info', '⏩ Tela de veículo não encontrada — pulando', cycle);
    return;
  }
  await sleep(humanDelay(800));
  const UBERX_SELS = ['[data-testid="vehicle-type-uberx"]','button:has-text("UberX")','[data-testid^="vehicle-type-"]'];
  for (const sel of UBERX_SELS) {
    if (await hasElement(p, sel, 800)) {
      await p.locator(sel).first().click({ timeout: 8_000 });
      globalState.addLog('info', `✔️ Veículo: UberX via ${sel}`, cycle);
      break;
    }
  }
  await sleep(humanDelay(1_000));
  await tryClickForward(p, cycle, 1_500);
  await waitForNextScreen(p, cycle, ['[data-testid="forward-button"]','[data-testid="whatsapp"]','button:has-text("WhatsApp")']);
}

async function stepWhatsApp(p: Page, cycle: number): Promise<void> {
  globalState.addLog('info', '📲 [8] WhatsApp opt-in...', cycle);
  const WA_SELS = ['[data-testid="whatsapp"]','button:has-text("WhatsApp")','[data-testid*="whatsapp"]'];
  if (!(await hasElement(p, WA_SELS.join(', '), 2_000))) {
    globalState.addLog('info', '⏩ Tela WhatsApp não encontrada — pulando', cycle);
    return;
  }
  const clicked = await tryClickForward(p, cycle, 1_500);
  if (clicked) globalState.addLog('info', '✔️ WhatsApp: pulando via Avançar', cycle);
  await waitForNextScreen(p, cycle, ['[data-testid="hub"]','[data-testid*="stepItem"]','[data-testid="forward-button"]','[data-testid="profile-photo"]']);
}

async function stepHubPhotoClick(p: Page, cycle: number): Promise<void> {
  globalState.addLog('info', '🏠 [9] Hub — aguardando...', cycle);
  const HUB_SELS = ['[data-testid="hub"]','[data-testid*="stepItem"]','[data-testid="home"]'];
  const hubFound = await hasElement(p, HUB_SELS.join(', '), 4_000);
  if (!hubFound) {
    globalState.addLog('info', `⏩ Hub não encontrado. testids: ${await getTestIds(p)}`, cycle);
    return;
  }
  const PHOTO_STEP_SELS = ['[data-testid*="photo" i]','[data-testid*="foto" i]','[data-testid*="picture" i]'];
  for (const sel of PHOTO_STEP_SELS) {
    if (await hasElement(p, sel, 800)) {
      await sleep(humanDelay(600));
      await p.locator(sel).first().click({ timeout: 5_000 }).catch(() => {});
      globalState.addLog('info', `✔️ Hub: clicou no passo de foto via ${sel}`, cycle);
      await sleep(humanDelay(1_000));
      break;
    }
  }
}

async function stepProfilePhoto(p: Page, cycle: number): Promise<void> {
  globalState.addLog('info', '📸 [10] Tirar foto do perfil...', cycle);
  const testids = await getTestIds(p);
  const buttons = await getButtonTexts(p);
  globalState.addLog('info', `🔍 [foto] testids: [${testids}]`, cycle);
  globalState.addLog('info', `🔍 [foto] botões: [${buttons}]`, cycle);
  const PHOTO_SELS = [
    '[data-testid="profile-photo-upload"]',
    '[data-testid="take-photo"]',
    'button:has-text("Tirar foto")',
    'button:has-text("Take photo")',
    'input[type="file"][accept*="image"]',
  ];
  const found = await findAsync(PHOTO_SELS, sel => hasElement(p, sel, 600));
  if (!found) {
    globalState.addLog('info', '⏩ Tela de foto não encontrada — pulando', cycle);
    return;
  }
  await tryClickForward(p, cycle, 1_500);
  globalState.addLog('info', '✔️ Foto: pulando via Avançar', cycle);
}

// ─── KYC FINAL ──────────────────────────────────────────────────────────────────

async function waitKycFinal(p: Page, cycle: number): Promise<void> {
  const KYC_ENTRY_SELS = [
    'iframe[src*="socure"]', 'iframe[src*="veriff"]', 'iframe[src*="persona"]',
    '[data-testid*="kyc"]', '[data-testid*="identity"]', '[data-testid*="document"]',
    'button:has-text("Verificar identidade")', 'button:has-text("Verify identity")',
    'button:has-text("Verify")', 'button:has-text("Verificar")',
    '[data-testid*="verification"]', '[data-testid*="selfie"]', '[data-testid*="scan"]',
    'a[href*="socure"]', 'a[href*="veriff"]',
  ];

  const joinedSel = KYC_ENTRY_SELS.join(', ');

  globalState.addLog('info', '🔍 [KYC] Aguardando tela de verificação...', cycle);
  const kycScreenDeadline = Date.now() + 60_000;
  let kycScreenFound = false;
  while (Date.now() < kycScreenDeadline) {
    if (isStopped()) break;
    if (await hasElement(p, joinedSel, 1_000)) { kycScreenFound = true; break; }
    if (globalState.getKycSignals(cycle).length > 0) { kycScreenFound = true; break; }
    await sleep(800);
  }

  if (!kycScreenFound) {
    globalState.addLog('warn', '⚠️ [KYC] Tela de verificação não apareceu neste ciclo', cycle);
    return;
  }

  globalState.addLog('kyc', '🔍 [KYC] Tela de verificação detectada — aguardando sinais...', cycle);
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (isStopped()) break;
    if (globalState.getKycSignals(cycle).length > 0) break;
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

async function dismissModals(p: Page, cycle: number): Promise<void> {
  const DISMISS = [
    'button:has-text("Accept")','button:has-text("Accepter")','button:has-text("OK")','button:has-text("Got it")',
    '[data-testid*="dismiss"]','[aria-label*="close" i]',
    '#privacy-cookie-banners-root button:has-text("Aceitar")','#privacy-cookie-banners-root button:has-text("Aceitar tudo")',
    '#privacy-cookie-banners-root button:has-text("Accept")','#privacy-cookie-banners-root button:has-text("Accept all")',
    '#privacy-cookie-banners-root button',
  ];
  for (const sel of DISMISS) {
    if (await hasElement(p, sel, 400)) {
      await p.locator(sel).first().click({ force: true }).catch(() => {});
      globalState.addLog('info', `🚪 modal: ${sel}`, cycle);
      await sleep(humanDelay(500));
    }
  }
}

let browserInstance: Browser | null = null;
let lastProxyConfig: string | null = null;
let lastHeadless: boolean | null = null;

const BRAVE_CANDIDATES = [
  process.env.BRAVE_PATH,
  'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
  'C:\\Program Files (x86)\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
  `${process.env.LOCALAPPDATA}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe`,
  '/usr/bin/brave-browser','/usr/bin/brave','/snap/bin/brave',
  '/usr/bin/chromium-browser','/usr/bin/chromium','/snap/bin/chromium',
].filter(Boolean) as string[];

export class MockPlaywrightFlow {
  static async init(headless = true): Promise<void> {
    const proxy0   = globalState.getProxyForCycle(1);
    const proxyKey = proxy0 ? proxy0.server : '';
    if (browserInstance && (lastProxyConfig !== proxyKey || lastHeadless !== headless)) {
      globalState.addLog('info', '🔄 Configuração mudou — reiniciando browser...');
      await browserInstance.close().catch(() => {});
      browserInstance = null;
    }
    if (browserInstance) return;
    const { existsSync } = await import('fs');
    let executablePath: string | undefined;
    for (const c of BRAVE_CANDIDATES) { if (existsSync(c)) { executablePath = c; break; } }
    if (executablePath) globalState.addLog('info', `🦁 Usando Brave: ${executablePath}`);
    else               globalState.addLog('warn', '⚠️ Brave não encontrado — usando Playwright Chromium');
    globalState.addLog('info', `🚀 Iniciando browser (headless=${headless})...`);
    const launchArgs = [
      '--no-sandbox','--disable-setuid-sandbox','--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage','--no-first-run','--no-default-browser-check',
      `--window-size=${MOBILE_W},${MOBILE_H}`,'--window-position=0,0',`--user-agent=${MOBILE_UA}`,
    ];
    if (proxyKey) launchArgs.push(`--proxy-server=${proxyKey}`);
    browserInstance = await chromium.launch({ headless, ...(executablePath ? { executablePath } : {}), args: launchArgs });
    lastProxyConfig = proxyKey;
    lastHeadless    = headless;
    globalState.addLog('info', '✅ Browser iniciado');
  }

  static async cleanup(): Promise<void> {
    if (browserInstance) { await browserInstance.close().catch(() => {}); browserInstance = null; }
  }

  static async execute(cadastroUrl: string, config: { emailProvider: EmailProvider; tempMailApiKey: string; otpTimeout: number; extraDelay: number; inviteCode: string; cityName?: string }, cycle: number): Promise<void> {
    if (!browserInstance) throw new Error('Browser não iniciado');
    await Promise.race([
      MockPlaywrightFlow._run(cadastroUrl, config, cycle),
      new Promise<void>((_, reject) => setTimeout(() => reject(new Error(`⏰ CYCLE_TIMEOUT ${cycle}`)), CYCLE_TIMEOUT_MS)),
    ]).catch(e => {
      globalState.addLog('error', `❌ Ciclo ${cycle} abortado: ${e instanceof Error ? e.message : e}`, cycle);
      throw e;
    });
  }

  private static async _run(cadastroUrl: string, config: { emailProvider: EmailProvider; tempMailApiKey: string; otpTimeout: number; extraDelay: number; inviteCode: string; cityName?: string }, cycle: number): Promise<void> {
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
      ctxOpts.proxy = { server: proxyConfig.server, username: proxyConfig.username, password: proxyConfig.password };
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
    let email = '', telefone = '', nome = '', sobrenome = '';
    try {
      const emailClient = createEmailClient(config.emailProvider, config.tempMailApiKey);
      const created = await emailClient.createRandomEmail();
      email = created.email;
      globalState.addLog('info', `📧 Email: ${email}`, cycle);
      globalState.addLog('info', `🌐 Navegando para ${cadastroUrl}...`, cycle);
      await p.goto(cadastroUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      globalState.addLog('info', '✔️ Página carregada', cycle);
      await sleep(humanDelay(2_000));
      await dismissModals(p, cycle);
      await stepEmail(p, cycle, email);
      await stepOtp(p, cycle, emailClient, email, config);
      const phone = await stepPhone(p, cycle);
      telefone = phone.digits;
      await stepPassword(p, cycle);
      const nameResult = await stepName(p, cycle);
      nome = nameResult.nome; sobrenome = nameResult.sobrenome;
      await stepTerms(p, cycle);
      await stepCity(p, cycle, config.cityName);
      await stepFlowType(p, cycle);
      await stepVehicleType(p, cycle);
      await stepWhatsApp(p, cycle);
      await stepHubPhotoClick(p, cycle);
      await stepProfilePhoto(p, cycle);
      await waitKycFinal(p, cycle);
      if (config.extraDelay > 0) {
        globalState.addLog('info', `⏳ Extra delay: ${config.extraDelay}ms`, cycle);
        await sleep(config.extraDelay);
      }
      const kycSignals = globalState.getKycSignals(cycle);
      const topSignal  = kycSignals.length > 0 ? kycSignals[0] : null;
      const kycLevel   = topSignal ? (globalState.getKycByCycleEntry(cycle)?.[topSignal.provider]?.level ?? undefined) : undefined;
      const cookies = await context.cookies().catch(() => []);
      globalState.addLog('info', `🍪 ${cookies.length} cookies capturados`, cycle);
      accountStore.save({
        email, telefone, nome, sobrenome, cycle,
        provider: config.emailProvider,
        senha: PASSWORD,
        codigoIndicacao: config.inviteCode,
        kycProvider: topSignal?.provider ?? undefined,
        kycLevel,
        localizacao: config.cityName ?? 'São Paulo',
        cookies,
      });
      globalState.addLog('success', `✅ Ciclo ${cycle} concluído — conta: ${email}`, cycle);
    } finally {
      await context.close().catch(() => {});
    }
  }
}
