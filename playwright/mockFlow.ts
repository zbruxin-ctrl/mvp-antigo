import { chromium as chromiumExtra } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { Browser, Page, BrowserContext, Frame, devices } from 'playwright';
import { globalState } from '../state/globalState';
import { createEmailClient } from '../tempMail/client';
import { IEmailClient } from '../types/tempMail';
import { EmailProvider } from '../types';
import { gerarPayloadCompleto } from '../utils/dataGenerators';
import { ArtifactsManager } from '../utils/artifacts';
import * as accountStore from '../store/accountStore';

chromiumExtra.use(StealthPlugin());

// ─── Instâncias de browser (uma por configuração de proxy de launch) ───────────
// Mantemos um browser por "assinatura de proxy de launch" para que ciclos com
// proxies diferentes usem browsers separados (e para não ter problema de
// "browser já rodando com proxy X, ciclo Y quer proxy Z").
// Para simplificar: mantemos 1 browser por proxy de launch. Quando não há proxy
// configurado o browser herda a VPN/sistema via --proxy-server="".

let browser: Browser | null = null;
let browserLaunching = false;
let currentLaunchProxy: string | null = null; // proxy usado no último launch

const contextosPorCiclo = new Map<number, BrowserContext>();

/** Timeout máximo de um ciclo completo (10 minutos). */
const CYCLE_TIMEOUT_MS = 10 * 60 * 1_000;

const BRAVE_PATH = 'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe';

const MOBILE_DEVICE = devices['iPhone 14'];

// ─── Speed helpers ────────────────────────────────────────────────────────────

function isSpeedMode(): boolean {
  return !!(globalState.getState().config as any)?.speedMode;
}

function sp(normal: number): number {
  return isSpeedMode() ? Math.max(530, Math.round(normal * 0.4) + 500) : normal;
}

// ─── Helpers humanos ──────────────────────────────────────────────────────────

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function humanPause(baseMs: number): Promise<void> {
  const effective = sp(baseMs);
  const jitter = randInt(-Math.floor(effective * 0.15), Math.floor(effective * 0.2));
  await new Promise<void>((r) => setTimeout(r, Math.max(30, effective + jitter)));
}

async function humanMouseMove(p: Page, x: number, y: number): Promise<void> {
  const steps = isSpeedMode() ? randInt(2, 4) : randInt(5, 10);
  const startX = randInt(50, 300);
  const startY = randInt(100, 400);
  const cpX = startX + (x - startX) * 0.4 + randInt(-20, 20);
  const cpY = startY + (y - startY) * 0.4 + randInt(-15, 15);
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const bx = Math.round((1 - t) * (1 - t) * startX + 2 * (1 - t) * t * cpX + t * t * x);
    const by = Math.round((1 - t) * (1 - t) * startY + 2 * (1 - t) * t * cpY + t * t * y);
    await p.mouse.move(bx, by);
    await humanPause(randInt(3, isSpeedMode() ? 6 : 12));
  }
}

async function humanType(p: Page, selector: string, value: string): Promise<void> {
  await p.waitForSelector(selector, { state: 'visible', timeout: 15000 });
  const box = await p.locator(selector).boundingBox();
  if (box) {
    const tx = Math.round(box.x + box.width * (0.3 + Math.random() * 0.4));
    const ty = Math.round(box.y + box.height * (0.3 + Math.random() * 0.4));
    await humanMouseMove(p, tx, ty);
    await humanPause(randInt(sp(50), sp(100)));
  }
  await p.click(selector);
  await p.fill(selector, '');
  await humanPause(randInt(sp(60), sp(150)));
  const fast = isSpeedMode();
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]!;
    if (!fast && Math.random() < 0.03 && /[a-zA-Z]/.test(ch)) {
      const typo = String.fromCharCode(ch.charCodeAt(0) + (Math.random() > 0.5 ? 1 : -1));
      await p.keyboard.type(typo, { delay: randInt(40, 80) });
      await humanPause(randInt(50, 120));
      await p.keyboard.press('Backspace');
      await humanPause(randInt(40, 90));
    }
    const charDelay = fast ? randInt(15, 40) : randInt(35, 90);
    await p.keyboard.type(ch, { delay: charDelay });
    if (!fast) {
      if (ch === ' ' || ch === '@' || ch === '.') await humanPause(randInt(80, 200));
      else if (Math.random() < 0.05) await humanPause(randInt(100, 300));
    }
  }
}

async function humanTypeForce(p: Page, selector: string, value: string): Promise<void> {
  await p.waitForSelector(selector, { state: 'visible', timeout: 15000 });
  const box = await p.locator(selector).boundingBox();
  if (box) {
    const tx = Math.round(box.x + box.width * (0.3 + Math.random() * 0.4));
    const ty = Math.round(box.y + box.height * (0.3 + Math.random() * 0.4));
    await humanMouseMove(p, tx, ty);
    await humanPause(randInt(sp(50), sp(100)));
  }
  await p.click(selector, { force: true });
  await p.fill(selector, '');
  await humanPause(randInt(sp(60), sp(150)));
  const fast = isSpeedMode();
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]!;
    if (!fast && Math.random() < 0.03 && /[a-zA-Z]/.test(ch)) {
      const typo = String.fromCharCode(ch.charCodeAt(0) + (Math.random() > 0.5 ? 1 : -1));
      await p.keyboard.type(typo, { delay: randInt(40, 80) });
      await humanPause(randInt(50, 120));
      await p.keyboard.press('Backspace');
      await humanPause(randInt(40, 90));
    }
    const charDelay = fast ? randInt(15, 40) : randInt(35, 90);
    await p.keyboard.type(ch, { delay: charDelay });
    if (!fast) {
      if (ch === ' ' || ch === '@' || ch === '.') await humanPause(randInt(80, 200));
      else if (Math.random() < 0.05) await humanPause(randInt(100, 300));
    }
  }
}

async function humanClick(p: Page, selector: string): Promise<void> {
  await p.waitForSelector(selector, { state: 'visible', timeout: 15000 });
  const box = await p.locator(selector).boundingBox();
  if (box) {
    const tx = Math.round(box.x + box.width * (0.25 + Math.random() * 0.5));
    const ty = Math.round(box.y + box.height * (0.25 + Math.random() * 0.5));
    await humanMouseMove(p, tx, ty);
    await humanPause(randInt(sp(40), sp(100)));
    await p.mouse.click(tx, ty);
  } else {
    await p.click(selector);
  }
}

async function dispensarCookies(p: Page): Promise<void> {
  const candidatos = [
    'button:has-text("Aceitar todos")',
    'button:has-text("Accept all")',
    'button:has-text("Aceitar")',
    'button:has-text("Accept")',
    '[id*="cookie"] button:has-text("Concordo")',
    '[class*="cookie"] button',
    '[class*="consent"] button',
    '[data-testid="cookie-banner-accept"]',
    '[data-testid="accept-cookies"]',
    '#onetrust-accept-btn-handler',
    '.onetrust-accept-btn-handler',
    'button#accept-recommended-btn-handler',
  ];
  for (const seletor of candidatos) {
    try {
      const el = p.locator(seletor).first();
      const visivel = await el.isVisible({ timeout: 1500 }).catch(() => false);
      if (visivel) {
        const box = await el.boundingBox().catch(() => null);
        if (box) {
          await humanMouseMove(p, box.x + box.width / 2, box.y + box.height / 2);
          await humanPause(randInt(sp(100), sp(200)));
        }
        await el.click({ timeout: 3000 });
        globalState.addLog('info', `🍪 Banner de cookies dispensado (${seletor})`);
        await humanPause(randInt(sp(300), sp(600)));
        return;
      }
    } catch { /* ignora */ }
  }
}

async function aceitarTermos(p: Page): Promise<void> {
  await humanPause(randInt(sp(500), sp(900)));
  const candidatos = [
    async () => {
      const el = p.locator('input[type="checkbox"]').first();
      await el.waitFor({ state: 'attached', timeout: 8000 });
      const box = await el.boundingBox().catch(() => null);
      if (box) {
        await humanMouseMove(p, box.x + box.width / 2, box.y + box.height / 2);
        await humanPause(randInt(sp(80), sp(160)));
      }
      await el.check({ force: true, timeout: 5000 });
    },
    async () => {
      const el = p.locator('label:has-text("Concordo"), [class*="label"]:has-text("Concordo")').first();
      await el.waitFor({ state: 'attached', timeout: 5000 });
      const box = await el.boundingBox().catch(() => null);
      if (box) await humanMouseMove(p, box.x + box.width / 2, box.y + box.height / 2);
      await humanPause(randInt(sp(60), sp(140)));
      await el.click({ force: true, timeout: 5000 });
    },
    async () => {
      const el = p.locator('[role="checkbox"]').first();
      await el.waitFor({ state: 'attached', timeout: 5000 });
      const box = await el.boundingBox().catch(() => null);
      if (box) await humanMouseMove(p, box.x + box.width / 2, box.y + box.height / 2);
      await humanPause(randInt(sp(60), sp(140)));
      await el.click({ force: true, timeout: 5000 });
    },
    async () => { await p.click('text=Concordo', { force: true, timeout: 5000 }); },
  ];
  let aceitou = false;
  for (const tentativa of candidatos) {
    try { await tentativa(); aceitou = true; break; } catch { /* tenta próximo */ }
  }
  if (!aceitou) throw new Error('Não foi possível aceitar os termos — nenhum seletor funcionou');
  globalState.addLog('info', '☑️ Termos aceitos');
}

// ─── Seleciona cidade ─────────────────────────────────────────────────────────

async function selecionarCidade(p: Page, cidade: string, cycle: number): Promise<void> {
  const INPUT_SEL = '[data-testid="flow-type-city-selector-v2-input"]';
  const DROPDOWN_ITEM_SELS = [
    '[data-testid="flow-type-city-selector-v2-option"]',
    '[role="option"]',
    '[role="listbox"] li',
    '[class*="suggestion"]',
    '[class*="option"]',
    '[class*="item"]',
  ];
  const norm = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
  const nomeBusca = cidade.split(',')[0]!.trim();
  const nomeBuscaNorm = norm(nomeBusca);

  globalState.addLog('info', `📍 Digitando cidade: "${nomeBusca}"`, cycle);
  await p.waitForSelector(INPUT_SEL, { state: 'visible', timeout: 15000 });
  const box = await p.locator(INPUT_SEL).boundingBox().catch(() => null);
  if (box) {
    await humanMouseMove(p, box.x + box.width / 2, box.y + box.height / 2);
    await humanPause(randInt(sp(80), sp(160)));
  }
  await p.click(INPUT_SEL);
  await p.fill(INPUT_SEL, '');
  await humanPause(randInt(sp(100), sp(200)));
  for (const ch of nomeBusca) {
    const charDelay = isSpeedMode() ? randInt(20, 50) : randInt(50, 110);
    await p.keyboard.type(ch, { delay: charDelay });
    if (!isSpeedMode() && Math.random() < 0.08) await humanPause(randInt(80, 200));
  }

  globalState.addLog('info', '⏳ Aguardando dropdown de cidade...', cycle);
  let itemSel: string | null = null;
  const pollMs = isSpeedMode() ? 200 : 500;
  const fimDropdown = Date.now() + 8_000;
  while (Date.now() < fimDropdown) {
    for (const sel of DROPDOWN_ITEM_SELS) {
      try {
        const count = await p.locator(sel).count();
        if (count > 0) {
          const visivel = await p.locator(sel).first().isVisible({ timeout: 800 }).catch(() => false);
          if (visivel) { itemSel = sel; break; }
        }
      } catch { /* tenta próximo */ }
    }
    if (itemSel) break;
    await humanPause(pollMs);
  }

  if (!itemSel) {
    globalState.addLog('warn', '⚠️ Dropdown não detectado, tentando ArrowDown+Enter', cycle);
    await humanPause(randInt(sp(300), sp(600)));
    await p.keyboard.press('ArrowDown');
    await humanPause(randInt(sp(150), sp(300)));
    await p.keyboard.press('Enter');
    return;
  }

  await humanPause(randInt(sp(300), sp(600)));
  const opcoes = p.locator(itemSel);
  const total = await opcoes.count();
  globalState.addLog('info', `📍 Dropdown aberto com ${total} opções`, cycle);

  let clicou = false;
  for (let i = 0; i < total; i++) {
    try {
      const opcao = opcoes.nth(i);
      const texto = await opcao.innerText().catch(() => '');
      if (norm(texto).includes(nomeBuscaNorm)) {
        const opcaoBox = await opcao.boundingBox().catch(() => null);
        if (opcaoBox) {
          await humanMouseMove(p, opcaoBox.x + opcaoBox.width / 2, opcaoBox.y + opcaoBox.height / 2);
          await humanPause(randInt(sp(150), sp(300)));
        }
        await opcao.click({ timeout: 5000 });
        globalState.addLog('info', `✅ Cidade selecionada: "${texto.trim()}"`, cycle);
        clicou = true;
        break;
      }
    } catch { /* tenta próxima */ }
  }

  if (!clicou) {
    globalState.addLog('warn', `⚠️ Nenhuma opção com "${nomeBusca}", clicando na primeira`, cycle);
    try {
      const primeiraBox = await opcoes.first().boundingBox().catch(() => null);
      if (primeiraBox) {
        await humanMouseMove(p, primeiraBox.x + primeiraBox.width / 2, primeiraBox.y + primeiraBox.height / 2);
        await humanPause(randInt(sp(150), sp(300)));
      }
      await opcoes.first().click({ timeout: 5000 });
    } catch {
      await p.keyboard.press('ArrowDown');
      await humanPause(randInt(sp(150), sp(300)));
      await p.keyboard.press('Enter');
    }
  }
  await humanPause(randInt(sp(400), sp(700)));
}

// ─── JS helpers ───────────────────────────────────────────────────────────────

const JS_NAO_ATIVAR = `
  (function() {
    var normalize = function(s) {
      return s.normalize('NFD').replace(/[\\u0300-\\u036f]/g, '').toUpperCase().trim();
    };
    var botoes = Array.from(document.querySelectorAll('button'));
    var alvo = botoes.find(function(b) {
      var t = normalize(b.innerText);
      return t.indexOf('NAO ATIVAR') !== -1 || t.indexOf('N AO ATIVAR') !== -1;
    });
    if (alvo) { alvo.click(); return true; }
    return false;
  })()
`;

const JS_FALLBACK_SUBMIT = `
  (function() {
    var normalize = function(s) {
      return s.normalize('NFD').replace(/[\\u0300-\\u036f]/g, '').toUpperCase().trim();
    };
    var botoes = Array.from(document.querySelectorAll('button[type="submit"]'));
    var alvo = botoes.find(function(b) {
      var t = normalize(b.innerText);
      return !t.includes('CONTINUAR') && !t.includes('AJUDA') && b.offsetParent !== null;
    });
    if (alvo) { alvo.click(); return alvo.innerText; }
    return null;
  })()
`;

// ─── KYC init script ──────────────────────────────────────────────────────────

const KYC_INIT_SCRIPT = `
  (function() {
    if (window.__kycInjected) return;
    window.__kycInjected = true;

    var PROVIDERS = {
      'Socure':  ['socure', 'devicer.io', 'sigma.socure', 'verify.socure'],
      'Veriff':  ['veriff', 'magic.veriff', 'api.veriff.me', 'cdn.veriff'],
      'Jumio':   ['jumio', 'lon.jumio', 'netverify'],
      'Onfido':  ['onfido', 'sdk.onfido'],
      'Persona': ['withpersona', 'persona.id'],
      'Stripe':  ['identity.stripe', 'stripe-js'],
      'Au10tix': ['au10tix'],
      'Mitek':   ['miteksystems', 'mitek'],
    };

    function analyze(url, source) {
      if (!url || typeof url !== 'string') return;
      var u = url.toLowerCase();
      for (var provider in PROVIDERS) {
        var patterns = PROVIDERS[provider];
        for (var i = 0; i < patterns.length; i++) {
          if (u.indexOf(patterns[i]) !== -1) {
            try { window.__kycSignal(provider, source, url, 5); } catch(e) {}
            window.dispatchEvent(new CustomEvent('__kyc_hit', { detail: { provider: provider, source: source, url: url } }));
            return;
          }
        }
      }
    }

    var _fetch = window.fetch;
    window.fetch = function() {
      try { analyze(arguments[0] && (arguments[0].url || arguments[0]), 'fetch'); } catch(e) {}
      return _fetch.apply(this, arguments);
    };

    var _open = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url) {
      try { analyze(url, 'xhr'); } catch(e) {}
      return _open.apply(this, arguments);
    };

    var _WS = window.WebSocket;
    if (_WS) {
      window.WebSocket = function(url, proto) {
        try { analyze(url, 'websocket'); } catch(e) {}
        return proto ? new _WS(url, proto) : new _WS(url);
      };
      window.WebSocket.prototype = _WS.prototype;
    }

    var _create = document.createElement.bind(document);
    document.createElement = function(tag) {
      var el = _create(tag);
      var t = tag.toLowerCase();
      if (t === 'script' || t === 'iframe') {
        var proto = t === 'script' ? HTMLScriptElement.prototype : HTMLIFrameElement.prototype;
        var d = Object.getOwnPropertyDescriptor(proto, 'src');
        if (d) {
          Object.defineProperty(el, 'src', {
            set: function(v) { analyze(v, t + '-tag'); return d.set.call(this, v); },
            get: function()  { return d.get.call(this); },
            configurable: true
          });
        }
      }
      return el;
    };

    new MutationObserver(function(ms) {
      ms.forEach(function(m) {
        m.addedNodes.forEach(function(n) {
          if (!n.tagName) return;
          var tag = n.tagName.toUpperCase();
          if (tag === 'SCRIPT' || tag === 'IFRAME') {
            var src = n.src || n.getAttribute('src') || '';
            analyze(src, tag.toLowerCase() + '-dom');
          }
          if (tag === 'LINK') {
            var href = n.href || n.getAttribute('href') || '';
            analyze(href, 'link-dom');
          }
        });
      });
    }).observe(document.documentElement, { childList: true, subtree: true });

    try {
      var po = new PerformanceObserver(function(list) {
        list.getEntries().forEach(function(entry) {
          analyze(entry.name, 'perf-observer');
        });
      });
      po.observe({ type: 'resource', buffered: true });
    } catch(e) {}

  })();
`;

// ─── WhatsApp ─────────────────────────────────────────────────────────────────

async function dispensarWhatsApp(p: Page, cycle: number): Promise<void> {
  try {
    await humanPause(randInt(sp(2000), sp(3500)));
    const SELETORES_WHATSAPP = [
      'button:has-text("ÃO ATIVAR")',
      'button:has-text("Nao ativar")',
      'button:has-text("Not now")',
      'button:has-text("Agora não")',
      '[data-testid*="whatsapp"]',
      'button[type="submit"]',
    ];
    const TIMEOUT_MS = 30_000;
    const POLL_MS = isSpeedMode() ? 1_000 : 3_000;
    const inicio = Date.now();
    let detectado = false;

    globalState.addLog('info', '🔍 Aguardando tela do WhatsApp (até 30s)...', cycle);
    while (Date.now() - inicio < TIMEOUT_MS) {
      for (const sel of SELETORES_WHATSAPP) {
        try {
          const visivel = await p.locator(sel).first().isVisible({ timeout: 1000 }).catch(() => false);
          if (visivel) { detectado = true; break; }
        } catch { /* ignora */ }
      }
      if (detectado) break;
      await humanPause(POLL_MS);
    }

    if (!detectado) {
      globalState.addLog('warn', '⚠️ Tela WhatsApp não detectada após 30s, pulando...', cycle);
      return;
    }

    globalState.addLog('info', '📲 Tela WhatsApp detectada, clicando em NÃO ATIVAR...', cycle);
    await humanPause(randInt(sp(400), sp(800)));

    for (const sel of ['button:has-text("NÃO ATIVAR")', 'button:has-text("Nao ativar")', 'button:has-text("Not now")', 'button:has-text("Agora não")']) {
      try {
        const el = p.locator(sel).first();
        const visivel = await el.isVisible({ timeout: 2000 }).catch(() => false);
        if (visivel) {
          const box = await el.boundingBox().catch(() => null);
          if (box) {
            await humanMouseMove(p, box.x + box.width / 2, box.y + box.height / 2);
            await humanPause(randInt(sp(150), sp(300)));
          }
          await el.click({ timeout: 5000 });
          globalState.addLog('info', `🔕 WhatsApp: NÃO ATIVAR clicado (${sel})`, cycle);
          await humanPause(randInt(sp(400), sp(800)));
          return;
        }
      } catch { /* tenta próxima */ }
    }

    try {
      const clicou = await p.evaluate(JS_NAO_ATIVAR) as boolean;
      if (clicou) { globalState.addLog('info', '🔕 WhatsApp: NÃO ATIVAR clicado (JS normalize)', cycle); return; }
    } catch { /* ignora */ }

    try {
      const clicou = await p.evaluate(JS_FALLBACK_SUBMIT) as string | null;
      if (clicou) { globalState.addLog('info', `🔕 WhatsApp: botão "${clicou}" clicado (fallback)`, cycle); return; }
    } catch { /* ignora */ }

    globalState.addLog('warn', '⚠️ Tela detectada mas não foi possível clicar em NÃO ATIVAR — continuando...', cycle);
  } catch (err) {
    globalState.addLog('warn', `⚠️ dispensarWhatsApp erro inesperado (ignorado): ${err}`, cycle);
  }
}

// ─── KYC: resolve provider dominante ─────────────────────────────────────────

function resolverProviderDominante(
  cycle: number,
  scoreMinimo = 4
): { provider: string; score: number; url: string } | null {
  const { byCycle } = globalState.getKycState();
  const cicloMap = byCycle[cycle];
  if (!cicloMap) return null;
  let melhor: { provider: string; score: number; url: string } | null = null;
  for (const [provider, state] of Object.entries(cicloMap)) {
    if (state.score >= scoreMinimo) {
      if (!melhor || state.score > melhor.score) {
        melhor = { provider, score: state.score, url: state.signals[0]?.url ?? '' };
      }
    }
  }
  return melhor;
}

// ─── Polling do botão "Tirar foto" ────────────────────────────────────────────

async function pollingBotaoTirarFoto(
  p: Page,
  seletoresItem: string[],
  seletoresBotao: string[],
  cycle: number,
  timeoutMs = 60_000
): Promise<boolean> {
  const POLL_INTERVAL_MS = isSpeedMode() ? 1_500 : 3_000;
  const inicio = Date.now();
  let tentativa = 0;

  globalState.addLog('info', `📸 [TirarFoto] Iniciando polling (timeout: ${timeoutMs / 1000}s, intervalo: ${POLL_INTERVAL_MS / 1000}s)`, cycle);

  while (Date.now() - inicio < timeoutMs) {
    tentativa++;
    globalState.addLog('info', `🔄 [TirarFoto] Poll #${tentativa} — buscando botão...`, cycle);

    for (const sel of seletoresBotao) {
      try {
        const el = p.locator(sel).first();
        const visivel = await el.isVisible({ timeout: 1200 }).catch(() => false);
        if (visivel) {
          const box = await el.boundingBox().catch(() => null);
          if (box) {
            await humanMouseMove(p, box.x + box.width / 2, box.y + box.height / 2);
            await humanPause(randInt(sp(200), sp(400)));
          }
          await el.click({ force: true, timeout: 5000 });
          globalState.addLog('info', `✅ [TirarFoto] Poll #${tentativa} — botão clicado! (${sel})`, cycle);
          return true;
        }
      } catch { /* tenta próximo seletor */ }
    }

    globalState.addLog('info', `📌 [TirarFoto] Poll #${tentativa} — botão não encontrado ainda`, cycle);

    if (tentativa % 2 === 0) {
      try {
        const scrollY = tentativa % 4 === 0 ? 0 : 300;
        await p.evaluate(`window.scrollBy(0, ${scrollY})`);
        globalState.addLog('info', `📌 [TirarFoto] Poll #${tentativa} — scroll aplicado (${scrollY > 0 ? '+' + scrollY : 'topo'})`, cycle);
        await humanPause(randInt(sp(300), sp(600)));
        for (const sel of seletoresBotao) {
          try {
            const el = p.locator(sel).first();
            const visivel = await el.isVisible({ timeout: 1200 }).catch(() => false);
            if (visivel) {
              const box = await el.boundingBox().catch(() => null);
              if (box) {
                await humanMouseMove(p, box.x + box.width / 2, box.y + box.height / 2);
                await humanPause(randInt(sp(200), sp(400)));
              }
              await el.click({ force: true, timeout: 5000 });
              globalState.addLog('info', `✅ [TirarFoto] Poll #${tentativa} (pós-scroll) — botão clicado! (${sel})`, cycle);
              return true;
            }
          } catch { /* ignora */ }
        }
      } catch (e) {
        globalState.addLog('warn', `⚠️ [TirarFoto] Poll #${tentativa} — erro no scroll: ${e}`, cycle);
      }
    }

    if (tentativa % 3 === 0) {
      globalState.addLog('info', `🔁 [TirarFoto] Poll #${tentativa} — re-clicando em "Foto do perfil"...`, cycle);
      try {
        await p.evaluate('window.scrollTo(0, 0)');
        await humanPause(randInt(sp(400), sp(700)));
        for (const sel of seletoresItem) {
          try {
            const el = p.locator(sel).first();
            const visivel = await el.isVisible({ timeout: 1500 }).catch(() => false);
            if (visivel) {
              const box = await el.boundingBox().catch(() => null);
              if (box) {
                await humanMouseMove(p, box.x + box.width / 2, box.y + box.height / 2);
                await humanPause(randInt(sp(200), sp(400)));
              }
              await el.click({ force: true, timeout: 5000 });
              globalState.addLog('info', `📸 [TirarFoto] Poll #${tentativa} — "Foto do perfil" re-clicado (${sel})`, cycle);
              await humanPause(randInt(sp(1000), sp(2000)));
              break;
            }
          } catch { /* ignora */ }
        }
      } catch (e) {
        globalState.addLog('warn', `⚠️ [TirarFoto] Poll #${tentativa} — erro no re-clique: ${e}`, cycle);
      }
    }

    const restante = timeoutMs - (Date.now() - inicio);
    if (restante > 0) {
      globalState.addLog('info', `⏳ [TirarFoto] Poll #${tentativa} — aguardando ${POLL_INTERVAL_MS / 1000}s (restam ${Math.round(restante / 1000)}s)...`, cycle);
      await humanPause(POLL_INTERVAL_MS);
    }
  }

  globalState.addLog('warn', `❌ [TirarFoto] Timeout após ${tentativa} polls (${timeoutMs / 1000}s) — botão não encontrado`, cycle);
  return false;
}

// ─── Foto do perfil + KYC ─────────────────────────────────────────────────────

async function clicarFotoPerfil(p: Page, cycle: number, context: BrowserContext): Promise<void> {
  globalState.addLog('info', '📸 Aguardando tela de lista de requisitos (Foto do perfil)...', cycle);

  const SELETORES_ITEM = [
    '[data-testid="stepItem profilePhoto"]',
    '[data-dgui="requirement-list-item"]:has-text("Foto do perfil")',
    '[data-dgui="requirement-list-item"]:has-text("Foto")',
    'a:has-text("Foto do perfil")',
    'a:has-text("Foto")',
    '[data-tracking-name="requirement-list-item"]:has-text("Foto")',
    '[role="listitem"]:has-text("Foto do perfil")',
    '[role="listitem"]:has-text("Foto")',
    'li:has-text("Foto do perfil")',
    'li:has-text("Foto")',
  ];

  const SELETORES_BOTAO_FOTO = [
    '[data-dgui="button"]:has-text("Tirar foto")',
    'button:has-text("Tirar foto")',
    'button:has-text("Usar meu telefone")',
    'button:has-text("Enviar foto")',
    'button:has-text("Escolher foto")',
    'button:has-text("Take photo")',
    'button:has-text("Upload photo")',
    '[data-testid="step-bottom-navigation"] button',
    '[data-testid="step-bottom-navigation"] [data-dgui="button"]',
    '[data-dgui="button"]',
  ];

  const TIMEOUT_ITEM = 20_000;
  const inicioItem = Date.now();
  let clicouItem = false;

  while (Date.now() - inicioItem < TIMEOUT_ITEM) {
    for (const sel of SELETORES_ITEM) {
      try {
        const el = p.locator(sel).first();
        const visivel = await el.isVisible({ timeout: 1500 }).catch(() => false);
        if (visivel) {
          const box = await el.boundingBox().catch(() => null);
          if (box) {
            await humanMouseMove(p, box.x + box.width / 2, box.y + box.height / 2);
            await humanPause(randInt(sp(200), sp(400)));
          }
          await el.click({ force: true, timeout: 5000 });
          globalState.addLog('info', `📸 "Foto do perfil" clicado (${sel})`, cycle);
          clicouItem = true;
          break;
        }
      } catch { /* tenta próximo seletor */ }
    }
    if (clicouItem) break;
    await humanPause(isSpeedMode() ? 600 : 1500);
  }

  if (!clicouItem) {
    globalState.addLog('warn', '⚠️ "Foto do perfil" não encontrado após 20s, pulando...', cycle);
    return;
  }

  await humanPause(randInt(sp(1200), sp(2000)));

  const botaoClicado = await pollingBotaoTirarFoto(p, SELETORES_ITEM, SELETORES_BOTAO_FOTO, cycle, 60_000);

  if (!botaoClicado) {
    globalState.addLog('warn', '⚠️ Botão de foto não encontrado após polling completo', cycle);
  }

  const salvarContaSocure = async (): Promise<void> => {
    const payload = globalState.getPayload(cycle);
    if (!payload) { globalState.addLog('warn', '⚠️ Payload não encontrado — conta não salva', cycle); return; }
    try {
      const cookies = await context.cookies();
      const saved = accountStore.save({
        cycle,
        provider: 'Socure',
        nome: payload.nome,
        sobrenome: payload.sobrenome,
        email: payload.email,
        telefone: payload.telefone,
        senha: payload.senha,
        localizacao: payload.localizacao,
        codigoIndicacao: payload.codigoIndicacao,
        cookies,
      });
      globalState.addLog('success', `💾 Conta salva! id=${saved.id} | ${payload.email}`, cycle);
    } catch (e) {
      globalState.addLog('warn', `⚠️ Erro ao salvar conta: ${e}`, cycle);
    } finally {
      globalState.clearPayload(cycle);
    }
  };

  const detectarEFechar = async (provider: string, score: number, url: string): Promise<void> => {
    if (provider === 'Veriff') {
      globalState.addLog('info', `🗑️ Veriff detectado (score=${score}) → fechando aba para liberar RAM`, cycle);
      await humanPause(randInt(sp(500), sp(1000)));
      await context.close().catch(() => {});
      contextosPorCiclo.delete(cycle);
      globalState.clearPayload(cycle);
    } else {
      globalState.addLog('success', `🟢 ${provider} detectado (score=${score}, url=${url}) → aba mantida aberta`, cycle);
      if (provider === 'Socure') await salvarContaSocure();
    }
  };

  globalState.addLog('info', '⏳ Aguardando KYC inicializar (até 30s)...', cycle);
  const fimKyc1 = Date.now() + 30_000;
  while (Date.now() < fimKyc1) {
    const dominante = resolverProviderDominante(cycle, 4);
    if (dominante) {
      globalState.addLog('info', `✅ KYC detectado: ${dominante.provider} (score=${dominante.score})`, cycle);
      await detectarEFechar(dominante.provider, dominante.score, dominante.url);
      return;
    }
    await humanPause(isSpeedMode() ? 500 : 1000);
  }

  globalState.addLog('warn', '⚠️ KYC não detectado após 30s — aguardando mais 20s (re-poll)...', cycle);
  const fimKyc2 = Date.now() + 20_000;
  while (Date.now() < fimKyc2) {
    const dominante = resolverProviderDominante(cycle, 4);
    if (dominante) {
      globalState.addLog('info', `✅ KYC detectado (re-poll): ${dominante.provider} (score=${dominante.score})`, cycle);
      await detectarEFechar(dominante.provider, dominante.score, dominante.url);
      return;
    }
    await humanPause(isSpeedMode() ? 500 : 1000);
  }

  globalState.addLog('warn', '⚠️ KYC não detectado após 50s total. Aba mantida aberta para inspeção.', cycle);
}

// ─── Stealth script ───────────────────────────────────────────────────────────

const stealthScript = `
  (function() {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'platform',          { get: () => 'iPhone' });
    Object.defineProperty(navigator, 'maxTouchPoints',    { get: () => 5 });
    Object.defineProperty(navigator, 'languages',         { get: () => ['pt-BR', 'pt', 'en-US', 'en'] });
    Object.defineProperty(navigator, 'hardwareConcurrency',{ get: () => 6 });
    Object.defineProperty(navigator, 'plugins', {
      get: () => {
        const arr = Object.create(PluginArray.prototype);
        Object.defineProperty(arr, 'length', { value: 0 });
        arr.item = () => null;
        arr.namedItem = () => null;
        arr.refresh = () => {};
        return arr;
      }
    });
    if (navigator.connection) {
      Object.defineProperty(navigator.connection, 'effectiveType', { get: () => '4g' });
      Object.defineProperty(navigator.connection, 'rtt',           { get: () => 80 });
      Object.defineProperty(navigator.connection, 'downlink',      { get: () => 8 });
      Object.defineProperty(navigator.connection, 'saveData',      { get: () => false });
    }
    Object.defineProperty(screen, 'colorDepth', { get: () => 24 });
    Object.defineProperty(screen, 'pixelDepth', { get: () => 24 });
    const _origQuery = window.navigator.permissions.query.bind(navigator.permissions);
    window.navigator.permissions.query = (p) =>
      p.name === 'notifications'
        ? Promise.resolve({ state: Notification.permission, onchange: null })
        : _origQuery(p);
    const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = function(type) {
      const ctx = this.getContext('2d');
      if (ctx) {
        const noise = ctx.createImageData(1, 1);
        noise.data[0] = Math.floor(Math.random() * 3);
        ctx.putImageData(noise, Math.random() * this.width | 0, Math.random() * this.height | 0);
      }
      return origToDataURL.apply(this, arguments);
    };
    const getParameter = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function(param) {
      if (param === 37445) return 'Apple Inc.';
      if (param === 37446) return 'Apple GPU';
      return getParameter.call(this, param);
    };
  })();
`;

// ─── KYC patterns ─────────────────────────────────────────────────────────────

const KYC_PATTERNS: Array<{ pattern: RegExp; provider: string }> = [
  { pattern: /socure/i,              provider: 'Socure'  },
  { pattern: /devicer\.io/i,         provider: 'Socure'  },
  { pattern: /sigma\.socure/i,       provider: 'Socure'  },
  { pattern: /verify\.socure/i,      provider: 'Socure'  },
  { pattern: /veriff/i,              provider: 'Veriff'  },
  { pattern: /magic\.veriff/i,       provider: 'Veriff'  },
  { pattern: /api\.veriff\.me/i,     provider: 'Veriff'  },
  { pattern: /cdn\.veriff/i,         provider: 'Veriff'  },
  { pattern: /jumio/i,               provider: 'Jumio'   },
  { pattern: /lon\.jumio/i,          provider: 'Jumio'   },
  { pattern: /netverify/i,           provider: 'Jumio'   },
  { pattern: /onfido/i,              provider: 'Onfido'  },
  { pattern: /sdk\.onfido/i,         provider: 'Onfido'  },
  { pattern: /withpersona/i,         provider: 'Persona' },
  { pattern: /persona\.id/i,         provider: 'Persona' },
  { pattern: /identity\.stripe/i,    provider: 'Stripe'  },
  { pattern: /au10tix/i,             provider: 'Au10tix' },
  { pattern: /miteksystems/i,        provider: 'Mitek'   },
];

function detectKycProvider(url: string): string | null {
  for (const { pattern, provider } of KYC_PATTERNS) {
    if (pattern.test(url)) return provider;
  }
  return null;
}

// ─── Listeners ────────────────────────────────────────────────────────────────

function registrarListenersFrame(frame: Frame, cycle: number): void {
  try {
    const url = frame.url();
    const provider = detectKycProvider(url);
    if (provider) globalState.addKycSignal(provider, 'frame-url', 5, cycle, url);
  } catch { /* ignora */ }
}

function registrarListenersPage(page: Page, cycle: number): void {
  try {
    for (const frame of page.frames()) registrarListenersFrame(frame, cycle);
  } catch { /* ignora */ }

  page.on('frameattached',  (frame) => registrarListenersFrame(frame, cycle));
  page.on('framenavigated', (frame) => {
    const url = frame.url();
    const provider = detectKycProvider(url);
    if (provider) globalState.addKycSignal(provider, 'frame-navigated', 5, cycle, url);
  });
  page.on('websocket', (ws) => {
    const url = ws.url();
    const provider = detectKycProvider(url);
    if (provider) globalState.addKycSignal(provider, 'websocket-native', 5, cycle, url);
  });
  page.on('request', (req) => {
    const url = req.url();
    const provider = detectKycProvider(url);
    if (provider) globalState.addKycSignal(provider, 'page-request', 4, cycle, url);
  });
  page.exposeFunction('__kycSignal', (provider: string, source: string, url: string, weight: number) => {
    globalState.addKycSignal(provider, source, weight, cycle, url);
  }).catch(() => {});
}

// ─── Determina proxy para o launch do browser ─────────────────────────────────
// Usamos o proxy do PRIMEIRO ciclo disponível como proxy de launch.
// Isso garante que todo o tráfego do browser (incluindo DNS) passe pelo proxy.
// Cada contexto pode sobrescrever com seu próprio proxy.

function getFirstAvailableProxy(): { server: string; username?: string; password?: string } | null {
  const proxies = (globalState.getState().config as any).proxies as Array<{server:string;username?:string;password?:string}> | undefined;
  if (!proxies || proxies.length === 0) return null;
  return proxies[0] ?? null;
}

// ─── Cria contexto isolado ─────────────────────────────────────────────────────

async function criarContextoIsolado(
  cycle: number
): Promise<{ context: BrowserContext; page: Page }> {
  const proxy = globalState.getProxyForCycle(cycle);

  if (proxy) {
    globalState.addLog(
      'info',
      `🌐 [Proxy] Ciclo #${cycle} → usando proxy: ${proxy.server}` +
      (proxy.username ? ` | usuário: ${proxy.username}` : ''),
      cycle
    );
  } else {
    globalState.addLog(
      'warn',
      `⚠️ [Proxy] Ciclo #${cycle} → SEM proxy configurado (usando conexão do sistema / VPN)`,
      cycle
    );
  }

  const context = await browser!.newContext({
    ...MOBILE_DEVICE,
    locale: 'pt-BR',
    timezoneId: 'America/Sao_Paulo',
    geolocation: { latitude: -23.5505, longitude: -46.6333 },
    permissions: ['geolocation'],
    extraHTTPHeaders: {
      'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
    },
    // Proxy por contexto: sobrescreve o proxy de launch para este ciclo específico
    ...(proxy ? { proxy: { server: proxy.server, username: proxy.username, password: proxy.password } } : {}),
  });

  await context.addInitScript({ content: stealthScript });
  await context.addInitScript({ content: KYC_INIT_SCRIPT });

  await context.route('**/*', (route) => {
    const url = route.request().url();
    const provider = detectKycProvider(url);
    if (provider) globalState.addKycSignal(provider, 'network-route', 3, cycle, url);
    route.continue();
  });

  const page = await context.newPage();

  // ── FIX: Interceptar novas abas abertas PELO SITE (popup com window.open) ───
  // ATENÇÃO: só fechamos a aba se ela tiver um "opener" (ou seja, foi aberta
  // via window.open / target="_blank" pelo próprio site controlado).
  // Abas abertas manualmente pelo usuário (nova guia, menu do browser) NÃO
  // possuem opener e NÃO devem ser fechadas — são abas independentes do usuário.
  context.on('page', async (novaPage) => {
    try {
      // Verifica se a nova página tem opener (foi aberta pelo site via JS)
      const temOpener = await novaPage.evaluate(() => window.opener !== null).catch(() => false);

      if (!temOpener) {
        // Aba aberta pelo usuário manualmente — não interferir
        globalState.addLog(
          'info',
          `🪟 Nova aba detectada sem opener (aberta pelo usuário) — ignorando`,
          cycle
        );
        return;
      }

      // É um popup do site (window.open) — interceptar e fechar
      const url = novaPage.url();
      globalState.addLog(
        'info',
        `📌 Popup do site interceptado (url: ${url || 'about:blank'}) — fechando automaticamente`,
        cycle
      );
      // Registra listeners KYC antes de fechar (pode ter KYC signal)
      registrarListenersPage(novaPage, cycle);
      // Aguarda um instante para capturar qualquer signal de rede antes de fechar
      await new Promise<void>((r) => setTimeout(r, 800));
      await novaPage.close().catch(() => {});
    } catch {
      // Se não conseguir verificar o opener, não fecha a aba (mais seguro)
    }
  });

  try {
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      mobile: true,
      width: MOBILE_DEVICE.viewport?.width ?? 390,
      height: MOBILE_DEVICE.viewport?.height ?? 844,
      deviceScaleFactor: MOBILE_DEVICE.deviceScaleFactor ?? 3,
      screenOrientation: { angle: 0, type: 'portraitPrimary' },
    });
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await cdp.send('Emulation.setUserAgentOverride', {
      userAgent: MOBILE_DEVICE.userAgent ?? '',
      acceptLanguage: 'pt-BR,pt;q=0.9',
      platform: 'iPhone',
    });
    globalState.addLog('info', `📱 CDP mobile ativado (${MOBILE_DEVICE.viewport?.width}x${MOBILE_DEVICE.viewport?.height})`, cycle);
  } catch (e) {
    globalState.addLog('warn', `⚠️ CDP mobile falhou, usando contexto padrão: ${e}`, cycle);
  }

  registrarListenersPage(page, cycle);
  contextosPorCiclo.set(cycle, context);
  return { context, page };
}

// ─── Fecha contexto de um ciclo (sem afetar outros) ───────────────────────────

async function fecharContextoCiclo(cycle: number, motivo: string): Promise<void> {
  const ctx = contextosPorCiclo.get(cycle);
  if (ctx) {
    globalState.addLog('warn', `🧹 Fechando aba do ciclo #${cycle} — motivo: ${motivo}`, cycle);
    await ctx.close().catch(() => {});
    contextosPorCiclo.delete(cycle);
  }
  globalState.clearPayload(cycle);
}

// ─── Flow principal ───────────────────────────────────────────────────────────

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
  static async init(headless = false): Promise<void> {
    const firstProxy = getFirstAvailableProxy();
    const launchProxyKey = firstProxy ? firstProxy.server : '__system__';

    // Se o browser já existe com o mesmo proxy de launch, reutiliza
    if (browser && currentLaunchProxy === launchProxyKey) {
      globalState.addLog('info', '🦁 Browser já está rodando — próximo ciclo abrirá nova aba');
      return;
    }

    // Se o browser existe mas com proxy diferente, destrói e recria
    if (browser && currentLaunchProxy !== launchProxyKey) {
      globalState.addLog('warn', '🔄 Proxy de launch mudou — reiniciando browser...');
      await browser.close().catch(() => {});
      browser = null;
      currentLaunchProxy = null;
      contextosPorCiclo.clear();
    }

    if (browserLaunching) {
      globalState.addLog('info', '⏳ Aguardando browser iniciar (outro ciclo já está subindo)...');
      const deadline = Date.now() + 30_000;
      while (!browser && Date.now() < deadline) {
        await new Promise<void>((r) => setTimeout(r, 200));
      }
      if (!browser) throw new Error('Timeout aguardando browser iniciar');
      return;
    }

    browserLaunching = true;
    try {
      // Determina o argumento de proxy para o launch
      let proxyArg: string;
      if (firstProxy) {
        proxyArg = firstProxy.server;
        globalState.addLog('info', `🌐 [Browser Launch] Proxy de launch: ${proxyArg}`);
      } else {
        // Sem proxy configurado → herda VPN/sistema.
        // String vazia faz o Chromium usar as configurações de proxy do SO.
        proxyArg = '';
        globalState.addLog('info', '🌐 [Browser Launch] Sem proxy — usando conexão do sistema (VPN se ativa)');
      }

      globalState.addLog('info', '🦁 Iniciando Brave...');
      browser = await chromiumExtra.launch({
        headless,
        executablePath: BRAVE_PATH,
        slowMo: 0,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-blink-features=AutomationControlled',
          '--disable-infobars',
          '--disable-dev-shm-usage',
          '--no-first-run',
          '--no-default-browser-check',
          // ── PROXY DE LAUNCH ──────────────────────────────────────────────────
          // Força TODO tráfego pelo proxy (inclui DNS-over-HTTPS, WebSockets etc.)
          // Quando proxyArg === '' o Chromium lê as configurações do SO (VPN).
          ...(proxyArg ? [`--proxy-server=${proxyArg}`, '--proxy-bypass-list=<-loopback>'] : []),
          // ── SEM PROXY: deixa o SO controlar (VPN funciona) ───────────────────
          // Sem --proxy-server o Brave usa wpad/sistema → VPN é respeitada.
        ],
      }) as unknown as Browser;

      currentLaunchProxy = launchProxyKey;
      globalState.addLog('info', '✅ Browser pronto — cada ciclo abrirá uma aba com emulação iPhone 14 via CDP');
    } finally {
      browserLaunching = false;
    }
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
    if (!browser) throw new Error('Browser não inicializado — chame init() primeiro');

    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`⏱️ Ciclo #${cycle} excedeu o timeout de ${CYCLE_TIMEOUT_MS / 60_000} min`)),
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
      otpTimeout: number;
      extraDelay: number;
      inviteCode: string;
    },
    cycle: number
  ): Promise<void> {
    globalState.addLog('info', `🆕 Ciclo #${cycle}: abrindo nova aba (sessão isolada, mobile iPhone 14)`, cycle);
    const { context, page: p } = await criarContextoIsolado(cycle);

    const client = createEmailClient(config.emailProvider, config.tempMailApiKey);

    try {
      await p.goto(cadastroUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await p.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
      await humanPause(randInt(sp(800), sp(1600)));
      globalState.addLog('info', '🌐 Página de cadastro aberta', cycle);

      const emailAccount = await client.createRandomEmail();
      const payload = gerarPayloadCompleto(emailAccount, config.inviteCode);
      globalState.addLog('info', `👤 ${payload.nome} ${payload.sobrenome} | ${payload.email}`, cycle);

      globalState.setPayload(cycle, {
        nome: payload.nome,
        sobrenome: payload.sobrenome,
        email: payload.email,
        telefone: payload.telefone,
        senha: payload.senha,
        localizacao: payload.localizacao,
        codigoIndicacao: payload.codigoIndicacao,
      });

      // 1. EMAIL
      globalState.addLog('info', '📧 Preenchendo email (force mode)...', cycle);
      await humanTypeForce(p, '#PHONE_NUMBER_or_EMAIL_ADDRESS', payload.email);
      await humanPause(randInt(config.extraDelay, config.extraDelay + 400));
      await humanClick(p, '#forward-button');
      globalState.addLog('info', '📧 Email preenchido → Continuar', cycle);

      // 2. OTP
      globalState.addLog('info', `🔑 Aguardando OTP (timeout: ${config.otpTimeout / 1000}s)...`, cycle);
      const otp = await client.waitForOTP(payload.email, config.otpTimeout, cycle);
      globalState.addLog('info', `🔑 OTP recebido: ${otp}`, cycle);

      await humanPause(randInt(sp(800), sp(1400)));
      const digits = otp.replace(/\D/g, '').split('');
      for (let i = 0; i < digits.length; i++) {
        await humanType(p, `#EMAIL_OTP_CODE-${i}`, digits[i]!);
        await humanPause(randInt(sp(50), sp(120)));
      }
      await humanPause(randInt(config.extraDelay, config.extraDelay + 300));
      await humanClick(p, '#forward-button');
      globalState.addLog('info', '✅ OTP preenchido → Avançar', cycle);

      // 3. TELEFONE
      await humanPause(randInt(sp(400), sp(900)));
      await humanType(p, '#PHONE_NUMBER', payload.telefone);
      await humanPause(randInt(config.extraDelay, config.extraDelay + 300));
      await humanClick(p, '#forward-button');
      globalState.addLog('info', `📱 Telefone: ${payload.telefone}`, cycle);

      // 4. SENHA
      await humanPause(randInt(sp(400), sp(900)));
      await humanType(p, '#PASSWORD', payload.senha);
      await humanPause(randInt(config.extraDelay, config.extraDelay + 300));
      await humanClick(p, '#forward-button');
      globalState.addLog('info', '🔒 Senha preenchida', cycle);

      // 5. NOME
      await humanPause(randInt(sp(400), sp(900)));
      await humanType(p, '#FIRST_NAME', payload.nome);
      await humanPause(randInt(sp(200), sp(400)));
      await humanType(p, '#LAST_NAME', payload.sobrenome);
      await humanPause(randInt(config.extraDelay, config.extraDelay + 300));
      await humanClick(p, '#forward-button');
      globalState.addLog('info', `👤 Nome: ${payload.nome} ${payload.sobrenome}`, cycle);

      // 6. TERMOS
      await aceitarTermos(p);
      await humanPause(randInt(config.extraDelay, config.extraDelay + 400));
      await humanClick(p, '#forward-button');

      // Pós-cadastro
      await p.waitForURL('**/bonjour.uber.com/**', { timeout: 40000 });
      await humanPause(randInt(sp(700), sp(1400)));
      globalState.addLog('info', '🔄 Redirecionado para bonjour', cycle);

      await dispensarCookies(p);
      await selecionarCidade(p, payload.localizacao, cycle);
      await dispensarCookies(p);

      await humanTypeForce(p, '[data-testid="signup-step::invite-code-input"]', payload.codigoIndicacao);
      await humanPause(randInt(config.extraDelay, config.extraDelay + 400));
      await dispensarCookies(p);
      await humanClick(p, '[data-testid="submit-button"]');
      globalState.addLog('info', `📍 Cidade: ${payload.localizacao} | Convite: ${payload.codigoIndicacao}`, cycle);

      await dispensarWhatsApp(p, cycle);
      await clicarFotoPerfil(p, cycle, context);

      const aindaAberta = contextosPorCiclo.has(cycle);
      if (aindaAberta) {
        globalState.addLog('success', `🎉 Ciclo #${cycle} COMPLETO! Aba mantida aberta.`, cycle);
      } else {
        globalState.addLog('info', `✅ Ciclo #${cycle} concluído!`, cycle);
      }

    } catch (error) {
      globalState.clearPayload(cycle);
      await ArtifactsManager.saveScreenshot(p, cycle, 'error').catch(() => {});
      await ArtifactsManager.saveHTML(p, cycle, 'error').catch(() => {});
      throw error;
    }
  }

  static async cleanup(): Promise<void> {
    for (const [cycle, ctx] of contextosPorCiclo.entries()) {
      await ctx.close().catch(() => {});
      globalState.addLog('info', `🗑️ Aba do ciclo #${cycle} fechada`);
    }
    contextosPorCiclo.clear();
    await browser?.close().catch(() => {});
    browser = null;
    currentLaunchProxy = null;
    globalState.addLog('info', '🧹 Browser fechado');
  }
}
