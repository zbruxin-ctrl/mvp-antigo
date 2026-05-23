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

// Delay adicional adicionado a cada ação para simular comportamento humano mais lento
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
  {
    pattern: /withpersona\.com/i,
    provider: 'Persona',
    weight: () => 6,
  },
  {
    pattern: /getid\.company/i,
    provider: 'GetID',
    weight: () => 6,
  },
  {
    pattern: /iproov\.com/i,
    provider: 'iProov',
    weight: () => 6,
  },
  {
    pattern: /onfido\.com/i,
    provider: 'Onfido',
    weight: (url) => /\/sdk|\/applicants|\/checks/i.test(url) ? 10 : 6,
  },
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

  context.on('request', (request) => {
    try { detectKycFromUrl(request.url(), cycle, 'ctx:request'); } catch { /* ignora */ }
  });
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
      await sleep(600 + EXTRA_DELAY);
      return;
    }
    await sleep(400 + EXTRA_DELAY);
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
        await sleep(400 + EXTRA_DELAY);
        return;
      }
    }
    await waitForSpinner(p, cycle, 5_000);
    await sleep(500 + EXTRA_DELAY);
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
    await sleep(500 + EXTRA_DELAY);
  }

  globalState.addLog('warn', '⚠️ Tela presa no spinner — recarregando página...', cycle);
  await p.reload({ waitUntil: 'domcontentloaded', timeout: 20_000 }).catch(() => {});
  globalState.addLog('info', '🔄 Página recarregada', cycle);
  await sleep(1_500 + EXTRA_DELAY);

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
    await sleep(500 + EXTRA_DELAY);
  }

  globalState.addLog('warn', '⚠️ Tela não apareceu nem após reload — continuando mesmo assim', cycle);
  return false;
}

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

  await sleep(400 + EXTRA_DELAY);
}

// ─── FAKE DATA ────────────────────────────────────────────────────────────────────

const FIRST_NAMES = [
  'Ana','Bruno','Carlos','Daniela','Eduardo','Fernanda','Gabriel','Helena',
  'Igor','Juliana','Kevin','Larissa','Marcos','Natalia','Otavio','Patricia',
  'Rafael','Sabrina','Thiago','Valentina','William','Xavier','Yasmin','Zelia',
  'Adriana','Beatriz','Caio','Diana','Elias','Fabio','Giovana','Hugo',
  'Isabela','Joao','Kaio','Leticia','Murilo','Nina','Oscar','Paula',
  'Rodrigo','Silvia','Tiago','Ursula','Vitor','Wanda','Ximena','Yago',
];

const LAST_NAMES = [
  'Silva','Santos','Oliveira','Souza','Rodrigues','Ferreira','Alves','Pereira',
  'Lima','Gomes','Costa','Ribeiro','Martins','Carvalho','Almeida','Lopes',
  'Sousa','Fernandes','Vieira','Barbosa','Rocha','Dias','Nascimento','Andrade',
  'Moreira','Nunes','Marques','Machado','Mendes','Freitas','Cardoso','Ramos',
  'Moraes','Teixeira','Monteiro','Araujo','Xavier','Castro','Correia','Campos',
];

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

function randomBrazilPhone(): { formatted: string; digits: string } {
  const DDDs = ['11','21','31','41','51','61','71','81','91','19','27','48','85','92'];
  const ddd = pick(DDDs);
  const n1 = String(Math.floor(Math.random() * 9) + 1);
  const rest = String(Math.floor(Math.random() * 100_000_000)).padStart(8, '0');
  const digits = `${ddd}9${n1}${rest}`.slice(0, 11);
  const formatted = `(${digits.slice(0,2)}) 9${digits.slice(3,7)}-${digits.slice(7,11)}`;
  return { formatted, digits };
}

const PASSWORD = 'Secure@2024!';

// ─── STEPS ────────────────────────────────────────────────────────────────────────

async function stepEmail(p: Page, cycle: number, email: string): Promise<void> {
  globalState.addLog('info', '📧 [1] Email...', cycle);
  await dismissCookieBanner(p, cycle);
  await sleep(2_000 + EXTRA_DELAY);

  const EMAIL_INPUT = '[data-testid="email-input"], input[type="email"], input[name="email"]';
  const FORWARD     = '[data-testid="forward-button"]';

  await p.locator(EMAIL_INPUT).fill(email, { timeout: 10_000 }).catch(async () => {
    const inp = p.locator('input').first();
    await inp.fill(email, { timeout: 10_000 });
  });
  globalState.addLog('info', '✔️ fill: email', cycle);
  await sleep(800 + EXTRA_DELAY);
  await p.locator(FORWARD).click({ timeout: 8_000 });
  globalState.addLog('info', '✔️ click: Avançar (forward-button)', cycle);

  await waitForNextScreen(p, cycle, [
    '[data-testid="otp-input"]',
    'input[name="otp"]',
    'input[placeholder*="código"]',
    'input[placeholder*="code"]',
    '[data-testid="forward-button"]',
  ]);
}

async function stepOtp(
  p: Page, cycle: number,
  emailClient: Awaited<ReturnType<typeof createEmailClient>>,
  email: string,
  config: { otpTimeout: number }
): Promise<void> {
  globalState.addLog('info', '🔢 [2] Aguardando OTP...', cycle);

  const tela = await hasElement(p, '[data-testid="otp-input"], input[name="otp"]', 2_000);
  if (!tela) {
    globalState.addLog('info', '✔️ Tela OTP detectada', cycle);
  } else {
    globalState.addLog('info', '✔️ Tela OTP detectada', cycle);
  }

  const timeoutSec = Math.round(config.otpTimeout / 1000);
  globalState.addLog('info', `⏳ [${emailClient.providerName}] Aguardando OTP para ${email} (${timeoutSec}s)...`, cycle);

  const otp = await emailClient.waitForOtp(email, config.otpTimeout);

  globalState.addLog('info', `🔢 OTP recebido: ${otp}`, cycle);

  const OTP_INPUT = '[data-testid="otp-input"], input[name="otp"], input[inputmode="numeric"]';
  const inputs = await p.locator(OTP_INPUT).all();

  if (inputs.length > 1) {
    for (let i = 0; i < Math.min(inputs.length, otp.length); i++) {
      await inputs[i]!.fill(otp[i]!);
      await sleep(120 + EXTRA_DELAY);
    }
    globalState.addLog('info', '✔️ OTP preenchido (inputs separados)', cycle);
  } else {
    const inp = p.locator(OTP_INPUT).first();
    await inp.fill(otp, { timeout: 8_000 });
    globalState.addLog('info', '✔️ OTP preenchido (input único)', cycle);
  }

  await sleep(500 + EXTRA_DELAY);

  const FORWARD = '[data-testid="forward-button"]';
  if (await hasElement(p, FORWARD, 1_500)) {
    await p.locator(FORWARD).click({ timeout: 8_000 });
    globalState.addLog('info', '✔️ click: Avançar (forward-button)', cycle);
  }

  await waitForNextScreen(p, cycle, [
    '[data-testid="forward-button"]',
    '[data-testid="password-input"]',
    'input[name="password"]',
    '[data-testid="PHONE_NUMBER"]',
    '#PHONE_NUMBER',
  ]);
}

async function stepPhone(p: Page, cycle: number): Promise<{ formatted: string; digits: string }> {
  globalState.addLog('info', '📱 [3] Telefone...', cycle);

  const phone = randomBrazilPhone();
  globalState.addLog('info', `📞 Telefone gerado: ${phone.formatted} (enviando: ${phone.digits})`, cycle);

  const PHONE_CANDIDATES = [
    '[data-testid="PHONE_NUMBER"]',
    '#PHONE_NUMBER',
    'input[name="phone"]',
    'input[type="tel"]',
    'input[placeholder*="telefone" i]',
    'input[placeholder*="celular" i]',
    'input[placeholder*="phone" i]',
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
    const inp = p.locator('input').first();
    await inp.fill(phone.digits, { timeout: 8_000 });
    globalState.addLog('info', '✔️ fill telefone via: input genérico', cycle);
  }

  await sleep(600 + EXTRA_DELAY);

  const FORWARD = '[data-testid="forward-button"]';
  await p.locator(FORWARD).click({ timeout: 8_000 });
  globalState.addLog('info', '✔️ click: Avançar (forward-button)', cycle);

  await waitForNextScreen(p, cycle, [
    'input[name="password"]',
    '[data-testid="password-input"]',
    'input[type="password"]',
    '[data-testid="forward-button"]',
  ]);

  return phone;
}

async function stepPassword(p: Page, cycle: number): Promise<void> {
  globalState.addLog('info', '🔒 [4] Senha...', cycle);

  const PWD_CANDIDATES = [
    'input[name="password"]',
    '[data-testid="password-input"]',
    'input[type="password"]',
  ];

  for (const sel of PWD_CANDIDATES) {
    if (await hasElement(p, sel, 800)) {
      await p.locator(sel).first().fill(PASSWORD, { timeout: 8_000 });
      globalState.addLog('info', '✔️ fill [password]: senha digitada', cycle);
      break;
    }
  }

  await sleep(600 + EXTRA_DELAY);

  const FORWARD = '[data-testid="forward-button"]';
  await p.locator(FORWARD).click({ timeout: 8_000 });
  globalState.addLog('info', '✔️ click: Avançar (forward-button)', cycle);

  await waitForNextScreen(p, cycle, [
    '[data-testid="FIRST_NAME"]',
    '#FIRST_NAME',
    'input[name="firstName"]',
    'input[placeholder*="nome" i]',
    '[data-testid="forward-button"]',
  ]);
}

async function stepName(p: Page, cycle: number): Promise<{ nome: string; sobrenome: string }> {
  globalState.addLog('info', '👤 [5] Nome...', cycle);

  const nome      = pick(FIRST_NAMES);
  const sobrenome = pick(LAST_NAMES);

  const FIRST_CANDIDATES = [
    '[data-testid="FIRST_NAME"]', '#FIRST_NAME',
    'input[name="firstName"]', 'input[placeholder*="primeiro" i]',
    'input[placeholder*="first" i]',
  ];
  const LAST_CANDIDATES = [
    '[data-testid="LAST_NAME"]', '#LAST_NAME',
    'input[name="lastName"]', 'input[placeholder*="sobrenome" i]',
    'input[placeholder*="last" i]',
  ];

  for (const sel of FIRST_CANDIDATES) {
    if (await hasElement(p, sel, 800)) {
      await p.locator(sel).first().fill(nome, { timeout: 8_000 });
      globalState.addLog('info', `✔️ fill [#FIRST_NAME]: primeiro nome`, cycle);
      break;
    }
  }
  await sleep(400 + EXTRA_DELAY);
  for (const sel of LAST_CANDIDATES) {
    if (await hasElement(p, sel, 800)) {
      await p.locator(sel).first().fill(sobrenome, { timeout: 8_000 });
      globalState.addLog('info', `✔️ fill [#LAST_NAME]: sobrenome`, cycle);
      break;
    }
  }

  await sleep(600 + EXTRA_DELAY);

  const FORWARD = '[data-testid="forward-button"]';
  await p.locator(FORWARD).click({ timeout: 8_000 });
  globalState.addLog('info', '✔️ click: Avançar (forward-button)', cycle);

  await waitForNextScreen(p, cycle, [
    '[data-testid="forward-button"]',
    'input[type="checkbox"]',
    'label:has-text("Concordo")',
    'label:has-text("Agree")',
  ]);

  return { nome, sobrenome };
}

async function stepTerms(p: Page, cycle: number): Promise<void> {
  globalState.addLog('info', '📝 [6] Termos...', cycle);

  const CHECKBOX_CANDIDATES = [
    'label:has-text("Concordo")',
    'label:has-text("Agree")',
    'label:has-text("Aceito")',
    'label:has-text("I agree")',
    'input[type="checkbox"]',
    '[data-testid*="checkbox"]',
    '[role="checkbox"]',
  ];

  for (const sel of CHECKBOX_CANDIDATES) {
    if (await hasElement(p, sel, 1_000)) {
      await p.locator(sel).first().click({ force: true, timeout: 8_000 });
      globalState.addLog('info', `✔️ checkbox clicado via: ${sel}`, cycle);
      break;
    }
  }

  await sleep(600 + EXTRA_DELAY);

  const FORWARD = '[data-testid="forward-button"]';
  await p.locator(FORWARD).click({ timeout: 8_000 });
  globalState.addLog('info', '✔️ click: Avançar (forward-button)', cycle);

  await waitForNextScreen(p, cycle, [
    '[data-testid="forward-button"]',
    '[data-testid="city-input"]',
    'input[name="city"]',
    '[data-testid="location"]',
  ]);
}

async function stepCity(p: Page, cycle: number, cityName?: string): Promise<void> {
  globalState.addLog('info', '🏢 [7] Cidade...', cycle);

  const CITY_SELS = [
    '[data-testid="city-input"]',
    'input[name="city"]',
    'input[placeholder*="cidade" i]',
    'input[placeholder*="city" i]',
    '[data-testid="location"]',
    'input[placeholder*="localiza" i]',
  ];

  const FORWARD = '[data-testid="forward-button"]';

  const found = await waitOrReload(p, cycle, CITY_SELS, 8_000, 30_000);

  if (!found) {
    globalState.addLog('warn', `⚠️ Cidade não encontrada após reload. testids: ${await getTestIds(p)}`, cycle);
    return;
  }

  const targetCity = cityName ?? 'São Paulo';
  for (const sel of CITY_SELS) {
    if (await hasElement(p, sel, 800)) {
      await p.locator(sel).first().fill(targetCity, { timeout: 8_000 });
      globalState.addLog('info', `✔️ fill cidade: ${targetCity}`, cycle);
      await sleep(800 + EXTRA_DELAY);

      const option = p.locator(`[role="option"]:has-text("${targetCity}")`).first();
      if (await option.isVisible({ timeout: 3_000 }).catch(() => false)) {
        await option.click({ timeout: 5_000 });
        globalState.addLog('info', `✔️ Opção de cidade selecionada: ${targetCity}`, cycle);
      }
      break;
    }
  }

  await sleep(600 + EXTRA_DELAY);
  await p.locator(FORWARD).click({ timeout: 8_000 });
  globalState.addLog('info', '✔️ click: Avançar (forward-button)', cycle);

  await waitForNextScreen(p, cycle, [
    '[data-testid="forward-button"]',
    '[data-testid="vehicle-type"]',
    '[data-testid="flow-type"]',
  ]);
}

async function getTestIds(p: Page): Promise<string> {
  try {
    return await p.evaluate(() => {
      const els = document.querySelectorAll('[data-testid]');
      return Array.from(els).map(e => e.getAttribute('data-testid')).filter(Boolean).slice(0, 20).join(',');
    });
  } catch {
    return '(erro)';
  }
}

async function getButtonTexts(p: Page): Promise<string> {
  try {
    return await p.evaluate(() => {
      const btns = document.querySelectorAll('button');
      return Array.from(btns).map(b => b.textContent?.trim()).filter(Boolean).slice(0, 10).join(',');
    });
  } catch {
    return '(erro)';
  }
}

async function stepFlowType(p: Page, cycle: number): Promise<void> {
  globalState.addLog('info', '🚗 [7b] Tipo de fluxo...', cycle);

  const FLOW_SELS = [
    '[data-testid="flow-type"]',
    '[data-testid*="flow"]',
    'button:has-text("Carro")',
    'button:has-text("Car")',
    'button:has-text("Moto")',
  ];

  if (!(await hasElement(p, FLOW_SELS.join(', '), 2_000))) {
    globalState.addLog('info', '⏩ Tela de tipo de fluxo não encontrada — pulando', cycle);
    return;
  }

  const CAR_SELS = [
    '[data-testid="flow-type-car"]',
    'button:has-text("Carro")',
    'button:has-text("Car")',
    '[data-testid*="car"]',
  ];
  for (const sel of CAR_SELS) {
    if (await hasElement(p, sel, 800)) {
      await p.locator(sel).first().click({ timeout: 8_000 });
      globalState.addLog('info', `✔️ Tipo de fluxo: Carro via ${sel}`, cycle);
      break;
    }
  }

  await sleep(600 + EXTRA_DELAY);

  const FORWARD = '[data-testid="forward-button"]';
  if (await hasElement(p, FORWARD, 1_500)) {
    await p.locator(FORWARD).click({ timeout: 8_000 });
  }

  await waitForNextScreen(p, cycle, [
    '[data-testid="forward-button"]',
    '[data-testid="vehicle-type"]',
    '[data-testid*="vehicle"]',
  ]);
}

async function stepVehicleType(p: Page, cycle: number): Promise<void> {
  globalState.addLog('info', '🚘 [7c] Tipo de veículo...', cycle);

  const VEHICLE_SELS = [
    '[data-testid="vehicle-type"]',
    '[data-testid*="vehicle"]',
    'button:has-text("UberX")',
    'button:has-text("Comfort")',
  ];

  if (!(await hasElement(p, VEHICLE_SELS.join(', '), 2_000))) {
    globalState.addLog('info', '⏩ Tela de veículo não encontrada — pulando', cycle);
    return;
  }

  const UBERX_SELS = [
    '[data-testid="vehicle-type-uberx"]',
    'button:has-text("UberX")',
    '[data-testid*="uberx"]',
  ];
  for (const sel of UBERX_SELS) {
    if (await hasElement(p, sel, 800)) {
      await p.locator(sel).first().click({ timeout: 8_000 });
      globalState.addLog('info', `✔️ Veículo: UberX via ${sel}`, cycle);
      break;
    }
  }

  await sleep(600 + EXTRA_DELAY);

  const FORWARD = '[data-testid="forward-button"]';
  if (await hasElement(p, FORWARD, 1_500)) {
    await p.locator(FORWARD).click({ timeout: 8_000 });
  }

  await waitForNextScreen(p, cycle, [
    '[data-testid="forward-button"]',
    '[data-testid="whatsapp"]',
    'button:has-text("WhatsApp")',
  ]);
}

async function stepWhatsApp(p: Page, cycle: number): Promise<void> {
  globalState.addLog('info', '📲 [8] WhatsApp opt-in...', cycle);

  const WA_SELS = [
    '[data-testid="whatsapp"]',
    'button:has-text("WhatsApp")',
    '[data-testid*="whatsapp"]',
  ];

  if (!(await hasElement(p, WA_SELS.join(', '), 2_000))) {
    globalState.addLog('info', '⏩ Tela WhatsApp não encontrada — pulando', cycle);
    return;
  }

  const FORWARD = '[data-testid="forward-button"]';
  if (await hasElement(p, FORWARD, 1_500)) {
    await p.locator(FORWARD).click({ timeout: 8_000 });
    globalState.addLog('info', '✔️ WhatsApp: pulando via Avançar', cycle);
  }

  await waitForNextScreen(p, cycle, [
    '[data-testid="hub"]',
    '[data-testid*="stepItem"]',
    '[data-testid="forward-button"]',
    '[data-testid="profile-photo"]',
  ]);
}

async function stepHubPhotoClick(p: Page, cycle: number): Promise<void> {
  globalState.addLog('info', '🏠 [9] Hub — aguardando...', cycle);

  const HUB_SELS = [
    '[data-testid="hub"]',
    '[data-testid*="stepItem"]',
    '[data-testid="home"]',
  ];

  const hubFound = await hasElement(p, HUB_SELS.join(', '), 4_000);
  if (!hubFound) {
    const testids = await getTestIds(p);
    globalState.addLog('info', `⏩ Hub não encontrado. testids: ${testids}`, cycle);
    return;
  }

  const PHOTO_STEP_SELS = [
    '[data-testid*="photo" i]',
    '[data-testid*="foto" i]',
    '[data-testid*="picture" i]',
  ];

  for (const sel of PHOTO_STEP_SELS) {
    if (await hasElement(p, sel, 800)) {
      await p.locator(sel).first().click({ timeout: 5_000 }).catch(() => {});
      globalState.addLog('info', `✔️ Hub: clicou no passo de foto via ${sel}`, cycle);
      await sleep(800 + EXTRA_DELAY);
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

  const found = PHOTO_SELS.find(async sel => await hasElement(p, sel, 600));
  if (!found) {
    globalState.addLog('info', '⏩ Tela de foto não encontrada — pulando', cycle);
    return;
  }

  const FORWARD = '[data-testid="forward-button"]';
  if (await hasElement(p, FORWARD, 1_500)) {
    await p.locator(FORWARD).click({ timeout: 8_000 }).catch(() => {});
    globalState.addLog('info', '✔️ Foto: pulando via Avançar', cycle);
  }
}

// ─── KYC FINAL ────────────────────────────────────────────────────────────────────

async function waitKycFinal(p: Page, cycle: number): Promise<void> {
  const KYC_ENTRY_SELS = [
    'iframe[src*="socure"]',
    'iframe[src*="veriff"]',
    'iframe[src*="persona"]',
    '[data-testid*="kyc"]',
    '[data-testid*="identity"]',
    '[data-testid*="document"]',
    'button:has-text("Verificar identidade")',
    'button:has-text("Verify identity")',
    'button:has-text("Verify")',
  ];

  const kycVisible = await hasElement(p, KYC_ENTRY_SELS.join(', '), 3_000);
  if (!kycVisible) return;

  globalState.addLog('kyc', '🔍 [KYC] Tela de verificação detectada — aguardando sinais...', cycle);

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (isStopped()) break;
    const signals = globalState.getKycSignals(cycle);
    if (signals.length > 0) break;
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
      await sleep(400 + EXTRA_DELAY);
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
  '/usr/bin/brave-browser',
  '/usr/bin/brave',
  '/snap/bin/brave',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
  '/snap/bin/chromium',
].filter(Boolean) as string[];

export class MockPlaywrightFlow {
  static async init(headless = true): Promise<void> {
    const proxy0 = globalState.getProxyForCycle(1);
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
      await sleep(1_500 + EXTRA_DELAY);
      await dismissModals(p, cycle);

      await stepEmail(p, cycle, email);
      await stepOtp(p, cycle, emailClient, email, config);

      const phone = await stepPhone(p, cycle);
      telefone    = phone.digits;
      telefoneFmt = phone.formatted;

      await stepPassword(p, cycle);

      const nameResult = await stepName(p, cycle);
      nome      = nameResult.nome;
      sobrenome = nameResult.sobrenome;

      await stepTerms(p, cycle);
      await stepCity(p, cycle, config.cityName);
      await stepFlowType(p, cycle);
      await stepVehicleType(p, cycle);
      await stepWhatsApp(p, cycle);
      await stepHubPhotoClick(p, cycle);
      await stepProfilePhoto(p, cycle);

      // Aguarda sinais KYC finais antes de capturar cookies
      await waitKycFinal(p, cycle);

      if (config.extraDelay > 0) {
        globalState.addLog('info', `⏳ Extra delay: ${config.extraDelay}ms`, cycle);
        await sleep(config.extraDelay);
      }

      const kycSignals = globalState.getKycSignals(cycle);
      const topSignal  = kycSignals.length > 0 ? kycSignals[0] : null;

      const kycLevel = topSignal
        ? (globalState.getKycByCycleEntry(cycle)?.[topSignal.provider]?.level ?? undefined)
        : undefined;

      // Captura cookies do contexto completo (bonjour + auth + uber)
      const cookies = await context.cookies().catch(() => []);
      globalState.addLog('info', `🍪 ${cookies.length} cookies capturados`, cycle);

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
