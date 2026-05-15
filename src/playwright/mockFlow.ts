import { chromium as chromiumExtra } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { Browser, Page, BrowserContext, Frame, devices } from 'playwright';
import { globalState } from '../state/globalState';
import { createEmailClient } from '../tempMail/client';
import { IEmailClient } from '../types/tempMail';
import { EmailProvider } from '../types/index';

chromiumExtra.use(StealthPlugin());

// ── Constantes ───────────────────────────────────────────────────────────────
const CYCLE_TIMEOUT_MS = 10 * 60 * 1000; // 10 min por ciclo

// ── Estado global do browser ─────────────────────────────────────────────────
let browser: Browser | null = null;
let currentLaunchProxy: string | null = null;

// ── Helpers de tempo ─────────────────────────────────────────────────────────
const sp  = (ms: number) => ms;
const randInt = (min: number, max: number) => Math.floor(Math.random() * (max - min + 1)) + min;
const humanPause = (ms: number) => new Promise(r => setTimeout(r, ms));

// ── Mapa de contextos ativos: cycle → BrowserContext ─────────────────────────
const activeContexts = new Map&lt;number, BrowserContext&gt;();

async function fecharContextoCiclo(cycle: number, motivo: string): Promise&lt;void&gt; {
  const ctx = activeContexts.get(cycle);
  if (ctx) {
    try { await ctx.close(); } catch {}
    activeContexts.delete(cycle);
    globalState.addLog('warn', `🔒 Contexto do ciclo #${cycle} fechado (${motivo})`, cycle);
  }
}

// ── Cria contexto isolado (sessão mobile iPhone 14) ───────────────────────────
async function criarContextoIsolado(cycle: number): Promise&lt;{ context: BrowserContext; page: Page }&gt; {
  if (!browser) throw new Error('Browser não iniciado');

  const iphone14 = devices['iPhone 14'];
  const context  = await browser.newContext({
    ...iphone14,
    locale:          'pt-BR',
    timezoneId:      'America/Sao_Paulo',
    geolocation:     { latitude: -23.5505, longitude: -46.6333 },
    permissions:     ['geolocation'],
    ignoreHTTPSErrors: true,
  });

  activeContexts.set(cycle, context);
  const page = await context.newPage();
  return { context, page };
}

// ── Digitação humana ──────────────────────────────────────────────────────────
async function typeHuman(page: Page | Frame, selector: string, text: string): Promise&lt;void&gt; {
  await page.click(selector);
  await humanPause(randInt(sp(120), sp(350)));
  for (const char of text) {
    await page.type(selector, char, { delay: randInt(sp(60), sp(180)) });
    if (Math.random() &lt; 0.08) await humanPause(randInt(sp(200), sp(500)));
  }
}

// ── Scroll humano ─────────────────────────────────────────────────────────────
async function humanScroll(page: Page, pixels = 300): Promise&lt;void&gt; {
  await page.evaluate((px) =&gt; window.scrollBy({ top: px, behavior: 'smooth' }), pixels);
  await humanPause(randInt(sp(400), sp(900)));
}

// ── Screenshot ────────────────────────────────────────────────────────────────
async function takeScreenshot(page: Page, cycle: number, label: string): Promise&lt;void&gt; {
  try {
    const fs   = await import('fs/promises');
    const path = await import('path');
    const dir  = path.join(process.cwd(), 'artifacts', 'screenshots');
    await fs.mkdir(dir, { recursive: true });
    const filename = path.join(dir, `cycle-${cycle}-latest.png`);
    await page.screenshot({ path: filename, fullPage: false });
    globalState.addLog('info', `📸 Screenshot salvo: ${label}`, cycle);
  } catch (e) {
    globalState.addLog('warn', `⚠️ Screenshot falhou: ${e}`, cycle);
  }
}

// ── Aguarda elemento com retry ────────────────────────────────────────────────
async function waitForSelectorRetry(
  page: Page,
  selector: string,
  options: { timeout?: number; retries?: number } = {}
): Promise&lt;void&gt; {
  const { timeout = 15000, retries = 3 } = options;
  for (let i = 0; i &lt; retries; i++) {
    try {
      await page.waitForSelector(selector, { timeout });
      return;
    } catch {
      if (i === retries - 1) throw new Error(`Seletor não encontrado após ${retries} tentativas: ${selector}`);
      await humanPause(randInt(sp(1000), sp(2000)));
    }
  }
}

// ── Resolve CAPTCHA via CapSolver ─────────────────────────────────────────────
async function resolveCaptcha(page: Page, cycle: number): Promise&lt;boolean&gt; {
  try {
    const capsolverId = process.env.CAPSOLVER_API_KEY;
    if (!capsolverId) {
      globalState.addLog('warn', '⚠️ CAPSOLVER_API_KEY não configurado', cycle);
      return false;
    }

    globalState.addLog('info', '🤖 Detectando CAPTCHA...', cycle);

    // Verifica se há hCaptcha ou reCaptcha na página
    const hasCaptcha = await page.evaluate(() =&gt; {
      return !!(
        document.querySelector('.h-captcha') ||
        document.querySelector('.g-recaptcha') ||
        document.querySelector('[data-hcaptcha-widget-id]') ||
        document.querySelector('[data-sitekey]')
      );
    });

    if (!hasCaptcha) {
      globalState.addLog('info', '✅ Nenhum CAPTCHA detectado', cycle);
      return true;
    }

    globalState.addLog('info', '🔍 CAPTCHA encontrado, resolvendo...', cycle);

    const siteKey = await page.evaluate(() =&gt; {
      const el = document.querySelector('[data-sitekey]') as HTMLElement | null;
      return el?.dataset?.sitekey || null;
    });

    if (!siteKey) {
      globalState.addLog('warn', '⚠️ Site key não encontrada', cycle);
      return false;
    }

    const pageUrl = page.url();

    // Tenta resolver via CapSolver
    const createTaskRes = await fetch('https://api.capsolver.com/createTask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientKey: capsolverId,
        task: {
          type: 'HCaptchaTaskProxyLess',
          websiteURL: pageUrl,
          websiteKey: siteKey,
        }
      })
    });

    const createData = await createTaskRes.json() as { taskId?: string; errorCode?: string };
    if (!createData.taskId) {
      globalState.addLog('warn', `⚠️ CapSolver erro: ${createData.errorCode}`, cycle);
      return false;
    }

    const taskId = createData.taskId;
    globalState.addLog('info', `⏳ Task criada: ${taskId}`, cycle);

    // Poll pelo resultado
    for (let attempt = 0; attempt &lt; 30; attempt++) {
      await humanPause(3000);

      const resultRes = await fetch('https://api.capsolver.com/getTaskResult', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientKey: capsolverId, taskId })
      });

      const resultData = await resultRes.json() as {
        status: string;
        solution?: { gRecaptchaResponse?: string };
        errorCode?: string;
      };

      if (resultData.status === 'ready' && resultData.solution?.gRecaptchaResponse) {
        const token = resultData.solution.gRecaptchaResponse;
        globalState.addLog('info', '✅ CAPTCHA resolvido!', cycle);

        // Injeta o token na página
        await page.evaluate((t) =&gt; {
          const textarea = document.querySelector('[name="h-captcha-response"]') as HTMLTextAreaElement | null;
          if (textarea) textarea.value = t;
          // Dispara evento de callback se existir
          const iframe = document.querySelector('.h-captcha iframe') as HTMLIFrameElement | null;
          if (iframe) {
            const callbackName = iframe.closest('[data-callback]')?.getAttribute('data-callback');
            if (callbackName && typeof (window as any)[callbackName] === 'function') {
              (window as any)[callbackName](t);
            }
          }
        }, token);

        return true;
      }

      if (resultData.status === 'failed') {
        globalState.addLog('warn', `⚠️ CAPTCHA falhou: ${resultData.errorCode}`, cycle);
        return false;
      }
    }

    globalState.addLog('warn', '⚠️ CAPTCHA timeout', cycle);
    return false;
  } catch (e) {
    globalState.addLog('warn', `⚠️ Erro ao resolver CAPTCHA: ${e}`, cycle);
    return false;
  }
}

// ── Tipos internos ────────────────────────────────────────────────────────────
interface CadastroPayload {
  email: string;
  username: string;
  password: string;
  inviteCode: string;
}

// ── Gerador de dados falsos ───────────────────────────────────────────────────
function gerarDadosFalsos(email: string, inviteCode: string): CadastroPayload {
  const adj   = ['cool', 'fast', 'dark', 'blue', 'fire', 'sky', 'neo', 'zen', 'rad', 'mad'];
  const noun  = ['wolf', 'hawk', 'bear', 'lion', 'fox', 'owl', 'cat', 'bat', 'ray', 'ace'];
  const num   = () =&gt; Math.floor(Math.random() * 9000 + 1000);
  const pick  = (arr: string[]) =&gt; arr[Math.floor(Math.random() * arr.length)];

  const username = `${pick(adj)}${pick(noun)}${num()}`;
  const password = `Pass${num()}!${pick(noun)}`;

  return { email, username, password, inviteCode };
}

// ── Fluxo principal de cadastro ───────────────────────────────────────────────
async function executarFluxoCadastro(
  page: Page,
  payload: CadastroPayload,
  client: IEmailClient,
  otpTimeout: number,
  cycle: number
): Promise&lt;void&gt; {

  // ── Etapa 1: Preenche formulário inicial ──────────────────────────────────
  globalState.addLog('info', `📝 Preenchendo email: ${payload.email}`, cycle);

  // Tenta encontrar campo de email com múltiplos seletores
  const emailSelectors = [
    'input[type="email"]',
    'input[name="email"]',
    'input[placeholder*="email" i]',
    'input[placeholder*="e-mail" i]',
    '#email',
  ];

  let emailField: string | null = null;
  for (const sel of emailSelectors) {
    try {
      await page.waitForSelector(sel, { timeout: 5000 });
      emailField = sel;
      break;
    } catch {}
  }

  if (!emailField) {
    await takeScreenshot(page, cycle, 'sem-campo-email');
    throw new Error('Campo de email não encontrado');
  }

  await typeHuman(page, emailField, payload.email);
  await humanPause(randInt(sp(500), sp(1000)));

  // Botão continuar / próximo
  const continueSelectors = [
    'button[type="submit"]',
    'button:has-text("Continuar")',
    'button:has-text("Continue")',
    'button:has-text("Next")',
    'button:has-text("Próximo")',
    'button:has-text("Avançar")',
    '[data-testid="continue-button"]',
    '[data-testid="submit-button"]',
  ];

  let clicked = false;
  for (const sel of continueSelectors) {
    try {
      await page.click(sel, { timeout: 3000 });
      clicked = true;
      break;
    } catch {}
  }

  if (!clicked) {
    await page.keyboard.press('Enter');
  }

  await humanPause(randInt(sp(1500), sp(3000)));
  await takeScreenshot(page, cycle, 'apos-email');

  // ── Etapa 2: Verifica se chegou na tela de OTP ────────────────────────────
  globalState.addLog('info', `🔑 Aguardando OTP (timeout: ${otpTimeout / 1000}s)...`, cycle);
  const otp = await client.waitForOTP(payload.email, otpTimeout, cycle);

  if (!otp) throw new Error('OTP não recebido dentro do timeout');
  globalState.addLog('info', `✅ OTP recebido: ${otp}`, cycle);

  // Preenche OTP
  const otpSelectors = [
    'input[type="text"][maxlength="6"]',
    'input[type="number"]',
    'input[name*="otp" i]',
    'input[name*="code" i]',
    'input[placeholder*="code" i]',
    'input[placeholder*="código" i]',
    '[data-testid="otp-input"]',
  ];

  let otpField: string | null = null;
  for (const sel of otpSelectors) {
    try {
      await page.waitForSelector(sel, { timeout: 5000 });
      otpField = sel;
      break;
    } catch {}
  }

  if (!otpField) {
    // Tenta inputs individuais de OTP (um por dígito)
    const singleDigitInputs = await page.$$('input[maxlength="1"]');
    if (singleDigitInputs.length >= 4) {
      globalState.addLog('info', '🔢 Preenchendo OTP dígito a dígito', cycle);
      for (let i = 0; i &lt; Math.min(singleDigitInputs.length, otp.length); i++) {
        await singleDigitInputs[i].click();
        await humanPause(randInt(sp(100), sp(250)));
        await singleDigitInputs[i].type(otp[i], { delay: randInt(sp(80), sp(150)) });
      }
    } else {
      await takeScreenshot(page, cycle, 'sem-campo-otp');
      throw new Error('Campo OTP não encontrado');
    }
  } else {
    await typeHuman(page, otpField, otp);
  }

  await humanPause(randInt(sp(500), sp(1200)));

  // Submete OTP
  const submitSelectors = [
    'button[type="submit"]',
    'button:has-text("Verificar")',
    'button:has-text("Verify")',
    'button:has-text("Confirmar")',
    'button:has-text("Confirm")',
  ];

  for (const sel of submitSelectors) {
    try {
      await page.click(sel, { timeout: 3000 });
      break;
    } catch {}
  }

  await humanPause(randInt(sp(2000), sp(4000)));
  await takeScreenshot(page, cycle, 'apos-otp');

  // ── Etapa 3: Preenche dados do perfil (se necessário) ─────────────────────
  try {
    const usernameSelectors = [
      'input[name="username"]',
      'input[name="user"]',
      'input[placeholder*="username" i]',
      'input[placeholder*="usuário" i]',
      '#username',
    ];

    for (const sel of usernameSelectors) {
      try {
        await page.waitForSelector(sel, { timeout: 5000 });
        await typeHuman(page, sel, payload.username);
        globalState.addLog('info', `👤 Username preenchido: ${payload.username}`, cycle);
        await humanPause(randInt(sp(400), sp(900)));
        break;
      } catch {}
    }
  } catch {}

  try {
    const passwordSelectors = [
      'input[type="password"]',
      'input[name="password"]',
      '#password',
    ];

    for (const sel of passwordSelectors) {
      try {
        await page.waitForSelector(sel, { timeout: 5000 });
        await typeHuman(page, sel, payload.password);
        globalState.addLog('info', `🔐 Senha preenchida`, cycle);
        await humanPause(randInt(sp(400), sp(900)));
        break;
      } catch {}
    }
  } catch {}

  // Invite code
  if (payload.inviteCode) {
    const inviteSelectors = [
      'input[name*="invite" i]',
      'input[name*="referral" i]',
      'input[placeholder*="invite" i]',
      'input[placeholder*="referral" i]',
      'input[placeholder*="código" i]',
    ];

    for (const sel of inviteSelectors) {
      try {
        await page.waitForSelector(sel, { timeout: 3000 });
        await typeHuman(page, sel, payload.inviteCode);
        globalState.addLog('info', `🎟️ Invite code preenchido`, cycle);
        await humanPause(randInt(sp(300), sp(700)));
        break;
      } catch {}
    }
  }

  // Resolve CAPTCHA se houver
  await resolveCaptcha(page, cycle);

  // Submit final
  await humanScroll(page, 200);
  await humanPause(randInt(sp(500), sp(1000)));

  const finalSubmitSelectors = [
    'button[type="submit"]',
    'button:has-text("Criar conta")',
    'button:has-text("Create account")',
    'button:has-text("Cadastrar")',
    'button:has-text("Register")',
    'button:has-text("Sign up")',
  ];

  for (const sel of finalSubmitSelectors) {
    try {
      await page.click(sel, { timeout: 3000 });
      break;
    } catch {}
  }

  await humanPause(randInt(sp(3000), sp(5000)));
  await takeScreenshot(page, cycle, 'final');

  globalState.addLog('info', `🎉 Ciclo #${cycle} concluído com sucesso!`, cycle);
}

// ── Classe principal ──────────────────────────────────────────────────────────
export class MockPlaywrightFlow {

  static async init(headless = true): Promise&lt;void&gt; {
    if (browser) return;

    browser = await chromiumExtra.launch({
      headless,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu',
        '--disable-web-security',
        '--disable-features=IsolateOrigins,site-per-process',
      ],
    });

    globalState.addLog('info', '🚀 Browser iniciado');
  }

  static async execute(
    cadastroUrl: string,
    config: {
      emailProvider: EmailProvider;
      tempMailApiKey: string;
      tempmailcDomain?: string;
      otpTimeout: number;
      extraDelay: number;
      inviteCode: string;
    },
    cycle: number
  ): Promise&lt;void&gt; {
    if (!browser) throw new Error('Browser não inicializado — chame init() primeiro');

    const timeoutPromise = new Promise&lt;never&gt;((_, reject) =&gt;
      setTimeout(
        () =&gt; reject(new Error(`⏱️ Ciclo #${cycle} excedeu o timeout de ${CYCLE_TIMEOUT_MS / 60_000} min`)),
        CYCLE_TIMEOUT_MS
      )
    );

    try {
      await Promise.race([timeoutPromise, MockPlaywrightFlow._executarCiclo(cadastroUrl, config, cycle)]);
    } catch (error) {
      // FIX: fecha APENAS o contexto deste ciclo — não afeta outros ciclos/abas
      await fecharContextoCiclo(cycle, String(error));
      throw error;
    }
  }

  private static async _executarCiclo(
    cadastroUrl: string,
    config: {
      emailProvider: EmailProvider;
      tempMailApiKey: string;
      tempmailcDomain?: string;
      otpTimeout: number;
      extraDelay: number;
      inviteCode: string;
    },
    cycle: number
  ): Promise&lt;void&gt; {
    globalState.addLog('info', `🆕 Ciclo #${cycle}: abrindo nova aba (sessão isolada, mobile iPhone 14)`, cycle);
    const { context, page: p } = await criarContextoIsolado(cycle);

    const client = createEmailClient(config.emailProvider, config.tempMailApiKey, config.tempmailcDomain);

    try {
      await p.goto(cadastroUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await p.waitForLoadState('networkidle', { timeout: 10000 }).catch(() =&gt; {});
      await humanPause(randInt(sp(800), sp(1600)));
      globalState.addLog('info', '🌐 Página de cadastro aberta', cycle);

      // Gera email temporário
      const email = await client.createRandomEmail();
      globalState.addLog('info', `📧 Email gerado: ${email}`, cycle);

      // Gera dados do formulário
      const payload = gerarDadosFalsos(email, config.inviteCode);
      globalState.addLog('info', `👤 Username: ${payload.username}`, cycle);

      // Extra delay antes de começar
      if (config.extraDelay &gt; 0) {
        await humanPause(config.extraDelay);
      }

      // Executa fluxo principal
      await executarFluxoCadastro(p, payload, client, config.otpTimeout, cycle);

      await fecharContextoCiclo(cycle, 'sucesso');
    } catch (error) {
      await takeScreenshot(p, cycle, 'erro');
      await fecharContextoCiclo(cycle, String(error));
      throw error;
    }
  }

  static async cleanup(): Promise&lt;void&gt; {
    // Fecha todos os contextos ativos
    for (const [cycle, ctx] of activeContexts.entries()) {
      try { await ctx.close(); } catch {}
      activeContexts.delete(cycle);
    }

    if (browser) {
      try { await browser.close(); } catch {}
      browser = null;
      currentLaunchProxy = null;
      globalState.addLog('info', '🧹 Browser fechado');
    }
  }
}
