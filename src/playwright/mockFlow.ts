import { chromium as chromiumExtra } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { Browser, Page, BrowserContext, devices } from 'playwright';
import type { BrowserType } from 'playwright';
import path from 'path';
import { globalState } from '../state/globalState';
import { EmailProvider } from '../types';
import { createEmailClient } from '../tempMail/client';

chromiumExtra.use(StealthPlugin());

const CADASTRO_URL = 'https://bonjour.uber.com';
const CYCLE_TIMEOUT_MS = 8 * 60 * 1_000; // 8 min — aborta de verdade via Promise.race

// ────────────────────────────────────────────────────────────────────────────────
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

// ────────────────────────────────────────────────────────────────────────────────
async function hasElement(p: Page, sel: string, timeout = 500): Promise<boolean> {
  return p.locator(sel).first().isVisible({ timeout }).catch(() => false);
}

async function safeClick(p: Page, sel: string, label: string, cycle?: number): Promise<void> {
  const el = p.locator(sel).first();
  await el.waitFor({ state: 'visible' });
  await el.scrollIntoViewIfNeeded();
  await sleep(300 + Math.random() * 200);
  await el.click();
  globalState.addLog('info', `✔️ click: ${label}`, cycle);
}

async function safeFill(
  p: Page,
  sel: string,
  value: string,
  label: string,
  cycle?: number
): Promise<void> {
  const el = p.locator(sel).first();
  await el.waitFor({ state: 'visible' });
  await el.scrollIntoViewIfNeeded();
  await sleep(200 + Math.random() * 150);
  await el.click();
  await sleep(100);
  await el.fill('');
  for (const ch of value) {
    await el.type(ch, { delay: 40 + Math.random() * 60 });
  }
  globalState.addLog('info', `✔️ fill: ${label}`, cycle);
}

// ────────────────────────────────────────────────────────────────────────────────
// Helpers de detecção de estado da página
// ────────────────────────────────────────────────────────────────────────────────

async function isOnLoginPage(p: Page): Promise<boolean> {
  const url = p.url();
  return url.includes('login') || url.includes('auth') || url.includes('signin');
}

async function detectCurrentStep(p: Page): Promise<string> {
  const url = p.url();
  if (url.includes('otp') || url.includes('verify') || url.includes('code')) return 'otp';
  if (url.includes('password')) return 'password';
  if (url.includes('phone')) return 'phone';
  if (url.includes('email')) return 'email';
  if (url.includes('name') || url.includes('profile')) return 'profile';
  if (url.includes('documents') || url.includes('docs')) return 'documents';
  if (url.includes('vehicle') || url.includes('car')) return 'vehicle';
  if (url.includes('hub') || url.includes('dashboard')) return 'complete';
  return 'unknown';
}

// ────────────────────────────────────────────────────────────────────────────────
// Passos do fluxo
// ────────────────────────────────────────────────────────────────────────────────

async function stepEmail(p: Page, email: string, cycle: number): Promise<void> {
  globalState.addLog('info', '📧 Preenchendo email...', cycle);

  const INPUT_SEL = 'input[type="email"], input[name="email"], input[placeholder*="email" i], input[autocomplete="email"]';
  await p.waitForSelector(INPUT_SEL, { state: 'visible', timeout: 10000 });
  await safeFill(p, INPUT_SEL, email, 'email', cycle);

  const BTN_SELS = [
    'button[type="submit"]',
    'button:has-text("Continue")',
    'button:has-text("Next")',
    'button:has-text("Continuer")',
    'button:has-text("Próximo")',
    '[data-testid*="submit"]',
    '[data-testid*="next"]',
    '[data-testid*="continue"]',
  ];

  for (const sel of BTN_SELS) {
    if (await hasElement(p, sel, 300)) {
      await safeClick(p, sel, 'avancar-email', cycle);
      globalState.addLog('info', `✔️ Email enviado via ${sel}`, cycle);
      return;
    }
  }
  throw new Error('Nenhum botão de avançar encontrado na etapa de email');
}

async function stepPassword(p: Page, password: string, cycle: number): Promise<void> {
  globalState.addLog('info', '🔒 Preenchendo senha...', cycle);

  const INPUT_SEL = 'input[type="password"]';
  const visible = await hasElement(p, INPUT_SEL, 1500);
  if (!visible) {
    globalState.addLog('info', '⏩ Campo de senha não encontrado — pulando', cycle);
    return;
  }

  await safeFill(p, INPUT_SEL, password, 'senha', cycle);

  const BTN_SELS = [
    'button[type="submit"]',
    'button:has-text("Continue")',
    'button:has-text("Sign in")',
    'button:has-text("Login")',
    'button:has-text("Entrar")',
  ];

  for (const sel of BTN_SELS) {
    if (await hasElement(p, sel, 300)) {
      await safeClick(p, sel, 'avancar-senha', cycle);
      return;
    }
  }
  throw new Error('Nenhum botão de avançar encontrado na etapa de senha');
}

async function stepOTP(
  p: Page,
  emailClient: ReturnType<typeof createEmailClient>,
  email: string,
  otpTimeout: number,
  cycle: number
): Promise<void> {
  globalState.addLog('info', '🔢 Aguardando tela de OTP...', cycle);

  const OTP_INPUT_SELS = [
    'input[autocomplete="one-time-code"]',
    'input[inputmode="numeric"]',
    'input[type="number"]',
    'input[name*="otp" i]',
    'input[name*="code" i]',
    'input[name*="token" i]',
    'input[placeholder*="code" i]',
    'input[placeholder*="otp" i]',
  ];

  let otpInputFound = false;
  for (const sel of OTP_INPUT_SELS) {
    if (await hasElement(p, sel, 2000)) {
      otpInputFound = true;
      globalState.addLog('info', `✔️ Campo OTP encontrado: ${sel}`, cycle);
      break;
    }
  }

  if (!otpInputFound) {
    globalState.addLog('warn', '⚠️ Campo OTP não detectado — tentando mesmo assim...', cycle);
  }

  const otp = await emailClient.waitForOTP(email, otpTimeout, cycle);
  globalState.addLog('info', `🔢 Preenchendo OTP: ${otp}`, cycle);

  for (const sel of OTP_INPUT_SELS) {
    if (await hasElement(p, sel, 500)) {
      await safeFill(p, sel, otp, 'OTP', cycle);

      const BTN_SELS = [
        'button[type="submit"]',
        'button:has-text("Verify")',
        'button:has-text("Confirm")',
        'button:has-text("Continue")',
        'button:has-text("Verificar")',
      ];

      for (const btnSel of BTN_SELS) {
        if (await hasElement(p, btnSel, 300)) {
          await safeClick(p, btnSel, 'confirmar-otp', cycle);
          break;
        }
      }
      return;
    }
  }
  throw new Error('Não foi possível preencher o OTP');
}

async function stepCitySelection(p: Page, cycle: number): Promise<void> {
  globalState.addLog('info', '🏡 Verificando seleção de cidade...', cycle);

  const CITY_SELS = [
    '[data-testid="city-selector"]',
    '[data-testid*="city"]',
    'select[name*="city" i]',
    'button:has-text("Paris")',
    'button:has-text("London")',
    'button:has-text("Berlin")',
    '[role="combobox"]',
  ];

  for (const sel of CITY_SELS) {
    if (await hasElement(p, sel, 1000)) {
      globalState.addLog('info', `🏡 Seletor de cidade encontrado: ${sel}`, cycle);
      await safeClick(p, sel, 'cidade', cycle);
      await sleep(1000);
      return;
    }
  }
  globalState.addLog('info', '⏩ Seleção de cidade não encontrada — pulando', cycle);
}

async function stepPhoneNumber(p: Page, cycle: number): Promise<void> {
  globalState.addLog('info', '📱 Verificando etapa de telefone...', cycle);

  const PHONE_SEL = 'input[type="tel"], input[name*="phone" i], input[placeholder*="phone" i]';
  if (!(await hasElement(p, PHONE_SEL, 2000))) {
    globalState.addLog('info', '⏩ Campo de telefone não encontrado — pulando', cycle);
    return;
  }

  // Gera número francês válido (formato: 06XXXXXXXX ou 07XXXXXXXX)
  const prefix = Math.random() < 0.5 ? '06' : '07';
  const rest = Array.from({ length: 8 }, () => Math.floor(Math.random() * 10)).join('');
  const phone = prefix + rest;

  await safeFill(p, PHONE_SEL, phone, 'telefone', cycle);

  const BTN_SELS = [
    'button[type="submit"]',
    'button:has-text("Continue")',
    'button:has-text("Next")',
    'button:has-text("Send code")',
  ];
  for (const sel of BTN_SELS) {
    if (await hasElement(p, sel, 500)) {
      await safeClick(p, sel, 'avancar-telefone', cycle);
      return;
    }
  }
}

async function stepPersonalInfo(p: Page, cycle: number): Promise<void> {
  globalState.addLog('info', '👤 Verificando etapa de informações pessoais...', cycle);

  const FIRST_NAME_SEL = 'input[name*="first" i], input[name*="fname" i], input[placeholder*="first name" i], input[placeholder*="prénom" i]';
  const LAST_NAME_SEL  = 'input[name*="last" i],  input[name*="lname" i], input[placeholder*="last name" i],  input[placeholder*="nom" i]';

  const hasFirst = await hasElement(p, FIRST_NAME_SEL, 2000);
  if (!hasFirst) {
    globalState.addLog('info', '⏩ Campos de nome não encontrados — pulando', cycle);
    return;
  }

  const firstNames = ['Thomas', 'Lucas', 'Hugo', 'Maxime', 'Antoine', 'Nicolas', 'Alexandre'];
  const lastNames  = ['Martin', 'Bernard', 'Dubois', 'Laurent', 'Fontaine', 'Girard', 'Rousseau'];
  const firstName = firstNames[Math.floor(Math.random() * firstNames.length)];
  const lastName  = lastNames[Math.floor(Math.random() * lastNames.length)];

  await safeFill(p, FIRST_NAME_SEL, firstName, 'primeiro-nome', cycle);
  if (await hasElement(p, LAST_NAME_SEL, 1000)) {
    await safeFill(p, LAST_NAME_SEL, lastName, 'sobrenome', cycle);
  }

  const BTN_SELS = ['button[type="submit"]', 'button:has-text("Continue")', 'button:has-text("Next")', 'button:has-text("Suivant")', '[data-testid*="next"]'];
  for (const sel of BTN_SELS) {
    if (await hasElement(p, sel, 500)) {
      await safeClick(p, sel, 'avancar-info-pessoal', cycle);
      return;
    }
  }
}

async function dismissModals(p: Page, cycle: number): Promise<void> {
  const DISMISS_SELS = [
    'button:has-text("Accept")',
    'button:has-text("Accepter")',
    'button:has-text("Agree")',
    'button:has-text("OK")',
    'button:has-text("Got it")',
    'button:has-text("Close")',
    '[data-testid*="accept"]',
    '[data-testid*="dismiss"]',
    '[aria-label*="close" i]',
    '[aria-label*="dismiss" i]',
  ];
  for (const sel of DISMISS_SELS) {
    if (await hasElement(p, sel, 500)) {
      globalState.addLog('info', `🚪 Fechando modal: ${sel}`, cycle);
      await safeClick(p, sel, 'fechar-modal', cycle);
      await sleep(500);
    }
  }
}

async function clickForwardButton(p: Page, cycle: number, label = 'avançar'): Promise<boolean> {
  const FWD_SELS = [
    'button[type="submit"]',
    '[data-testid*="forward"]',
    '[data-testid*="next"]',
    '[data-testid*="submit"]',
    '[data-testid*="continue"]',
    'button:has-text("Continue")',
    'button:has-text("Next")',
    'button:has-text("Suivant")',
    'button:has-text("Submit")',
    'button:has-text("Próximo")',
  ];
  for (const sel of FWD_SELS) {
    const el = p.locator(sel).first();
    if (await el.isVisible({ timeout: 300 }).catch(() => false)) {
      const enabled = await el.isEnabled({ timeout: 300 }).catch(() => false);
      if (enabled) {
        await el.scrollIntoViewIfNeeded();
        await sleep(200);
        await el.click();
        globalState.addLog('info', `✔️ ${label} via ${sel}`, cycle);
        return true;
      }
    }
  }
  return false;
}

// ────────────────────────────────────────────────────────────────────────────────
// Classe principal
// ────────────────────────────────────────────────────────────────────────────────

let browserInstance: Browser | null = null;
let lastProxyConfig: string | null = null;

export class MockPlaywrightFlow {
  /**
   * Inicia o browser (Brave).
   *
   * Regras de proxy no launch:
   * - Se há proxies configurados → lança com --proxy-server=<primeiro proxy>
   *   para que TODO o tráfego (incluindo DNS e requests fora dos contextos)
   *   passe pelo proxy. Cada contexto ainda pode sobrescrever com seu próprio.
   * - Se NÃO há proxies → lança com --proxy-server="" para que o Brave herde
   *   a configuração de rede do sistema operacional (inclui VPN ativa).
   *
   * Se a configuração de proxy mudar entre calls, o browser anterior é destruído
   * e um novo é lançado com as novas configurações.
   */
  static async init(headless = true): Promise<void> {
    const state = globalState.getState() as State & { proxies?: string[] };
    const proxies: string[] = state.proxies ?? [];
    const proxyServer = proxies.length > 0 ? proxies[0] : '';
    const proxyKey = proxyServer;

    if (browserInstance && lastProxyConfig !== proxyKey) {
      globalState.addLog('info', '🔄 Proxy mudou — reiniciando browser...');
      await browserInstance.close().catch(() => {});
      browserInstance = null;
    }

    if (browserInstance) return;

    const chromiumBin = process.env.BRAVE_PATH ??
      '/usr/bin/brave-browser' ?? '/usr/bin/chromium-browser';

    const launchArgs = [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-infobars',
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--no-default-browser-check',
      `--proxy-server=${proxyServer}`,
    ];

    globalState.addLog('info', `🚀 Iniciando browser (headless=${headless})...`);
    browserInstance = await (chromiumExtra as unknown as BrowserType).launch({
      headless,
      executablePath: chromiumBin,
      args: launchArgs,
    });
    lastProxyConfig = proxyKey;
    globalState.addLog('info', '✅ Browser iniciado');
  }

  static async execute(
    cadastroUrl: string,
    config: {
      emailProvider: EmailProvider;
      tempMailApiKey: string;
      otpTimeout: number;
      extraDelay: number;
      inviteCode: string;
    },
    cycle: number
  ): Promise<void> {
    if (!browserInstance) throw new Error('Browser não iniciado — chame MockPlaywrightFlow.init() primeiro');

    let cycleReject: ((e: Error) => void) | null = null;

    const cyclePromise = new Promise<void>((resolve, reject) => {
      cycleReject = reject;
      MockPlaywrightFlow._executarCiclo(cadastroUrl, config, cycle, reject)
        .then(resolve)
        .catch(reject);
    });

    const timeoutPromise = new Promise<void>((_, reject) =>
      setTimeout(
        () => reject(new Error(`⏰ CYCLE_TIMEOUT: ciclo ${cycle} excedeu ${CYCLE_TIMEOUT_MS / 1000}s`)),
        CYCLE_TIMEOUT_MS
      )
    );

    await Promise.race([cyclePromise, timeoutPromise]).catch(e => {
      globalState.addLog('error', `❌ Ciclo ${cycle} abortado: ${e instanceof Error ? e.message : e}`, cycle);
      throw e;
    });

    if (cycleReject) {
      // Não há clearTimeout direto pois usamos Promise.race — o timer vai disparar
      // mas como cycleTimedOut já foi tratado, o reject extra é silencioso
    }
  }

  private static async _executarCiclo(
    cadastroUrl: string,
    config: {
      emailProvider: EmailProvider;
      tempMailApiKey: string;
      otpTimeout: number;
      extraDelay: number;
      inviteCode: string;
    },
    cycle: number,
    _onError: (e: Error) => void
  ): Promise<void> {
    const state = globalState.getState() as State & { proxies?: string[] };
    const proxies: string[] = state.proxies ?? [];

    // Seleciona proxy round-robin
    const proxyUrl = proxies.length > 0 ? proxies[cycle % proxies.length] : undefined;

    const contextOptions: Parameters<Browser['newContext']>[0] = {
      ...devices['Desktop Chrome'],
      locale: 'fr-FR',
      timezoneId: 'Europe/Paris',
      permissions: ['geolocation'],
      geolocation: { latitude: 48.8566, longitude: 2.3522 },
    };

    if (proxyUrl) {
      // Parse proxy: http://user:pass@host:port ou host:port
      let server = proxyUrl;
      let username: string | undefined;
      let password: string | undefined;
      try {
        const u = new URL(proxyUrl.startsWith('http') ? proxyUrl : `http://${proxyUrl}`);
        server = `${u.protocol}//${u.hostname}:${u.port}`;
        if (u.username) { username = decodeURIComponent(u.username); password = decodeURIComponent(u.password); }
      } catch { /* usa raw */ }
      contextOptions.proxy = { server, username, password };
      globalState.addLog('info', `🌐 Usando proxy: ${server}`, cycle);
    } else {
      globalState.addLog('info', '🌐 Sem proxy — usando rede do sistema (VPN)', cycle);
    }

    const context = await browserInstance!.newContext(contextOptions);
    const p = await context.newPage();

    // Timeouts por ação de UI — 20s
    p.setDefaultTimeout(20_000);
    p.setDefaultNavigationTimeout(20_000);

    try {
      // Cria email temporário
      const emailClient = createEmailClient(
        config.emailProvider,
        config.tempMailApiKey
      );
      const { email } = await emailClient.createRandomEmail();
      globalState.addLog('info', `📧 Email: ${email}`, cycle);

      // Navega para a URL de cadastro
      globalState.addLog('info', `🌐 Navegando para ${cadastroUrl}...`, cycle);
      await p.goto(cadastroUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await sleep(1500);

      await dismissModals(p, cycle);

      // Detecta e executa passos
      const step = await detectCurrentStep(p);
      globalState.addLog('info', `📍 Passo atual detectado: ${step}`, cycle);

      // Preenche email
      await stepEmail(p, email, cycle);
      await sleep(1000);

      // Verifica se precisa de senha
      await stepPassword(p, 'Uber2024!', cycle);
      await sleep(800);

      // OTP
      await stepOTP(p, emailClient, email, config.otpTimeout, cycle);
      await sleep(1000);

      // Pós-OTP: informações pessoais, telefone, cidade
      await dismissModals(p, cycle);
      await stepPersonalInfo(p, cycle);
      await sleep(800);
      await stepPhoneNumber(p, cycle);
      await sleep(800);
      await stepCitySelection(p, cycle);
      await sleep(800);

      // Tenta avançar até o hub
      let attempts = 0;
      while (attempts < 10) {
        const currentStep = await detectCurrentStep(p);
        if (currentStep === 'complete') break;
        await dismissModals(p, cycle);
        const advanced = await clickForwardButton(p, cycle);
        if (!advanced) break;
        await sleep(1200);
        attempts++;
      }

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
