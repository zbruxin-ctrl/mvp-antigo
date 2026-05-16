import { chromium as chromiumExtra } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { Browser, Page, devices } from 'playwright';
import type { BrowserType } from 'playwright';
import { globalState } from '../state/globalState';
import { EmailProvider } from '../types';
import { createEmailClient } from '../tempMail/client';

chromiumExtra.use(StealthPlugin());

const CADASTRO_URL = 'https://bonjour.uber.com';
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

async function fillByTestId(p: Page, testId: string, value: string, label: string, cycle: number): Promise<void> {
  const el = p.locator(`[data-testid="${testId}"]`).first();
  await el.waitFor({ state: 'visible', timeout: 15_000 });
  await el.scrollIntoViewIfNeeded();
  await sleep(150 + Math.random() * 100);
  await el.click();
  await sleep(80);
  await el.click({ clickCount: 3 });
  await p.keyboard.press('Delete');
  await sleep(60);
  await el.pressSequentially(value, { delay: 55 + Math.random() * 45 });
  globalState.addLog('info', `✔️ fill [testid=${testId}]: ${label}`, cycle);
}

async function clickForward(p: Page, cycle: number): Promise<void> {
  const el = p.locator('[data-testid="forward-button"]').first();
  await el.waitFor({ state: 'visible', timeout: 15_000 });
  let enabled = false;
  for (let i = 0; i < 25; i++) {
    enabled = await el.isEnabled({ timeout: 200 }).catch(() => false);
    if (enabled) break;
    await sleep(200);
  }
  if (!enabled) throw new Error('forward-button nunca habilitou');
  await el.scrollIntoViewIfNeeded();
  await sleep(200 + Math.random() * 100);
  await el.click();
  globalState.addLog('info', '✔️ click: Avançar (forward-button)', cycle);
}

/**
 * Gera número de telefone fixo brasileiro válido.
 * Formato: (XX) XXXX-XXXX  — 8 dígitos, primeiro entre 2-5
 */
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

/** [1] Email */
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
  await sleep(1000);
}

/** [2] OTP */
async function stepOTP(
  p: Page,
  emailClient: ReturnType<typeof createEmailClient>,
  email: string,
  otpTimeout: number,
  cycle: number
): Promise<void> {
  globalState.addLog('info', '🔢 [2] Aguardando OTP...', cycle);
  const OTP_SEL = 'input[autocomplete="one-time-code"], input[inputmode="numeric"], input[maxlength="1"]';
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
  const fwdVisible = await hasElement(p, '[data-testid="forward-button"]', 1000);
  if (fwdVisible) {
    await clickForward(p, cycle);
  } else {
    const btn = p.locator('button[type="submit"]:not([disabled])').first();
    if (await btn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await btn.click();
      globalState.addLog('info', '✔️ confirmar-otp via submit', cycle);
    }
  }
  await sleep(1000);
}

/** [3] Telefone fixo brasileiro */
async function stepPhone(p: Page, cycle: number): Promise<void> {
  globalState.addLog('info', '📱 [3] Telefone...', cycle);
  const visible = await hasElement(p, '#PHONE_NUMBER, input[autocomplete="tel-national"]', 3000);
  if (!visible) {
    globalState.addLog('info', '⏩ Tela de telefone não encontrada — pulando', cycle);
    return;
  }
  const telefone = gerarTelefoneFixoBR();
  globalState.addLog('info', `📞 Telefone gerado: ${telefone}`, cycle);
  await fillById(p, 'PHONE_NUMBER', telefone, 'telefone fixo BR', cycle);
  await clickForward(p, cycle);
  await sleep(1000);
}

/** [4] Criar senha */
async function stepPassword(p: Page, cycle: number): Promise<void> {
  globalState.addLog('info', '🔒 [4] Senha...', cycle);
  const visible = await hasElement(p, '#PASSWORD, input[autocomplete="new-password"]', 3000);
  if (!visible) {
    globalState.addLog('info', '⏩ Tela de senha não encontrada — pulando', cycle);
    return;
  }
  await fillById(p, 'PASSWORD', 'Uber2024@', 'senha', cycle);
  await clickForward(p, cycle);
  await sleep(1000);
}

/** [5] Nome e Sobrenome */
async function stepPersonalInfo(p: Page, cycle: number): Promise<void> {
  globalState.addLog('info', '👤 [5] Nome...', cycle);
  const visible = await hasElement(p, '#FIRST_NAME, input[autocomplete="given-name"]', 3000);
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
  await sleep(1000);
}

/**
 * [6] Aceitar termos
 *
 * O Uber usa um checkbox CUSTOMIZADO — não é um <input type="checkbox"> nativo.
 * O JSON mostra:
 *   { testId: "accept-terms", tag: "P" }  ← é o contêiner do texto
 *   { checkboxes: [{ label: "Concordo" }] } ← o checkbox é renderizado como div/span
 *
 * Estratégia: tentar vários seletores em ordem até um clicar com sucesso.
 */
async function stepTerms(p: Page, cycle: number): Promise<void> {
  globalState.addLog('info', '📝 [6] Termos...', cycle);

  // Detecta a tela pelos candidatos mais estáveis
  const TELA_SEL = [
    '[data-testid="accept-terms"]',
    'text=Concordo',
    'text=Aceite os Termos',
    'input[type="checkbox"]',
  ];
  let telaFound = false;
  for (const sel of TELA_SEL) {
    if (await hasElement(p, sel, 1500)) { telaFound = true; break; }
  }
  if (!telaFound) {
    globalState.addLog('info', '⏩ Tela de termos não encontrada — pulando', cycle);
    return;
  }

  await sleep(500);

  // Candidatos para o checkbox/label "Concordo" — do mais específico ao mais genérico
  const CHECKBOX_CANDIDATES = [
    // checkbox nativo
    'input[type="checkbox"]',
    // label com texto
    'label:has-text("Concordo")',
    // qualquer elemento com texto exato
    'text=Concordo',
    // div/span que é filho do bloco de termos
    '[data-testid="accept-terms"] ~ * input',
    '[data-testid="accept-terms"] ~ * label',
    // fallback: qualquer checkbox na página
    '[role="checkbox"]',
  ];

  let clicked = false;
  for (const sel of CHECKBOX_CANDIDATES) {
    try {
      const el = p.locator(sel).first();
      if (await el.isVisible({ timeout: 800 }).catch(() => false)) {
        await el.scrollIntoViewIfNeeded();
        await sleep(200);
        await el.click({ force: true }); // force ignora pointer-events bloqueados
        globalState.addLog('info', `✔️ checkbox clicado via: ${sel}`, cycle);
        clicked = true;
        break;
      }
    } catch { /* tenta próximo */ }
  }

  if (!clicked) {
    // Último recurso: clicar via JS no primeiro checkbox encontrado
    const jsClicked = await p.evaluate(() => {
      const cb = document.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
      if (cb) { cb.click(); return true; }
      const role = document.querySelector('[role="checkbox"]') as HTMLElement | null;
      if (role) { role.click(); return true; }
      // tenta clicar no label "Concordo"
      const labels = Array.from(document.querySelectorAll('label, span, p, div'));
      const concordo = labels.find(el => el.textContent?.trim() === 'Concordo') as HTMLElement | null;
      if (concordo) { concordo.click(); return true; }
      return false;
    });
    if (jsClicked) {
      globalState.addLog('info', '✔️ checkbox clicado via JS evaluate', cycle);
    } else {
      globalState.addLog('warn', '⚠️ Não encontrou checkbox — tentando forward mesmo assim', cycle);
    }
  }

  await sleep(600);
  await clickForward(p, cycle);
  await sleep(1000);
}

/** [7] Cidade + código de indicação */
async function stepCity(p: Page, inviteCode: string, cycle: number): Promise<void> {
  globalState.addLog('info', '🏢 [7] Cidade...', cycle);
  const visible = await hasElement(p, '[data-testid="flow-type-city-selector-v2-input"]', 3000);
  if (!visible) {
    globalState.addLog('info', '⏩ Tela de cidade não encontrada — pulando', cycle);
    return;
  }
  await fillByTestId(p, 'flow-type-city-selector-v2-input', '', 'limpar cidade', cycle);
  await sleep(300);
  await fillByTestId(p, 'flow-type-city-selector-v2-input', 'Paris', 'cidade', cycle);
  await sleep(1000);
  const option = p.locator('[role="option"], [role="listitem"], [data-testid*="suggestion"]').first();
  if (await option.isVisible({ timeout: 2000 }).catch(() => false)) {
    await option.click();
    globalState.addLog('info', '✔️ cidade selecionada da lista', cycle);
  }
  await sleep(500);
  if (inviteCode) {
    const codeVisible = await hasElement(p, '[data-testid="signup-step::invite-code-input"]', 1000);
    if (codeVisible) {
      await fillByTestId(p, 'signup-step::invite-code-input', inviteCode, 'invite code', cycle);
      await sleep(300);
    }
  }
  const submitBtn = p.locator('[data-testid="submit-button"]').first();
  if (await submitBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
    await submitBtn.click();
    globalState.addLog('info', '✔️ click: submit-button (cidade)', cycle);
  } else {
    await clickForward(p, cycle);
  }
  await sleep(1200);
}

/** [8] WhatsApp opt-in — clica em NÃO ATIVAR */
async function stepWhatsApp(p: Page, cycle: number): Promise<void> {
  globalState.addLog('info', '📲 [8] WhatsApp opt-in...', cycle);
  const visible = await hasElement(p, '[data-testid="step-bottom-navigation"]', 3000);
  if (!visible) {
    globalState.addLog('info', '⏩ Tela WhatsApp não encontrada — pulando', cycle);
    return;
  }
  const naoAtivar = p.locator('button:has-text("NÃO ATIVAR"), button:has-text("Nao ativar"), button:has-text("NOT NOW")');
  if (await naoAtivar.first().isVisible({ timeout: 1500 }).catch(() => false)) {
    await naoAtivar.first().click();
    globalState.addLog('info', '✔️ click: NÃO ATIVAR (WhatsApp)', cycle);
  }
  await sleep(1200);
}

/** [9] Hub — clica em Foto do perfil */
async function stepHubPhotoClick(p: Page, cycle: number): Promise<void> {
  globalState.addLog('info', '🏠 [9] Hub — clicando em Foto do perfil...', cycle);
  await p.waitForSelector('[data-testid="hub"], [data-testid="stepItem profilePhoto"]', { state: 'visible', timeout: 15_000 });
  const photoLink = p.locator('[data-testid="stepItem profilePhoto"]').first();
  await photoLink.waitFor({ state: 'visible', timeout: 10_000 });
  await photoLink.click();
  globalState.addLog('info', '✔️ click: Foto do perfil', cycle);
  await sleep(1500);
}

/** [10] Foto do perfil — clica em Tirar foto */
async function stepProfilePhoto(p: Page, cycle: number): Promise<void> {
  globalState.addLog('info', '📸 [10] Tirar foto do perfil...', cycle);
  await p.waitForSelector('[data-testid="step profilePhoto"], [data-testid="docUploadButton"]', { state: 'visible', timeout: 15_000 });
  const btn = p.locator('[data-testid="docUploadButton"], button:has-text("Tirar foto")').first();
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
    config: { emailProvider: EmailProvider; tempMailApiKey: string; otpTimeout: number; extraDelay: number; inviteCode: string },
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
    config: { emailProvider: EmailProvider; tempMailApiKey: string; otpTimeout: number; extraDelay: number; inviteCode: string },
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

      await stepEmail(p, email, cycle);                                  // 1
      await stepOTP(p, emailClient, email, config.otpTimeout, cycle);    // 2
      await stepPhone(p, cycle);                                         // 3
      await stepPassword(p, cycle);                                      // 4
      await stepPersonalInfo(p, cycle);                                  // 5
      await stepTerms(p, cycle);                                         // 6
      await stepCity(p, config.inviteCode, cycle);                       // 7
      await stepWhatsApp(p, cycle);                                      // 8
      await stepHubPhotoClick(p, cycle);                                 // 9
      await stepProfilePhoto(p, cycle);                                  // 10

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
