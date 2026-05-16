import { chromium as chromiumExtra } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { Browser, Page, BrowserContext, devices } from 'playwright';
import type { Cookie } from 'playwright';
import { globalState } from '../state/globalState';
import { createEmailClient } from '../tempMail/client';
import { IEmailClient } from '../types/tempMail';
import { EmailProvider } from '../types';
import { gerarPayloadCompleto } from '../utils/dataGenerators';
import { ArtifactsManager } from '../utils/artifacts';
import * as accountStore from '../store/accountStore';
import {
  isSpeedMode, sp, randInt, randFloat,
  humanPause, cogPause,
  humanMouseMove, hoverElement, focusField, _typeChar,
  humanType, humanTypeForce, humanClick,
  clickForwardButton, scrollIdle, pageWarmup,
} from './humanActions';

let stealthPluginRegistered = false;

let browser: Browser | null = null;
let browserLaunching = false;
let currentLaunchProxy: string | null = null;

const contextosPorCiclo = new Map<number, import('playwright').BrowserContext>();

const STEP_STALL_TIMEOUT_MS = 5 * 60 * 1_000;

const MOBILE_DEVICE = {
  ...devices['iPhone 14'],
  viewport: { width: 390, height: 844 },
  screen:   { width: 390, height: 844 },
};

// ─── Formato Tampermonkey ─────────────────────────────────────────────────────

function cookiesToTampermonkey(cookies: Cookie[]): [string, string, string, number, number, number][] {
  return cookies.map((c) => [
    c.name,
    c.value,
    c.domain,
    c.secure ? 1 : 0,
    c.httpOnly ? 1 : 0,
    c.expires > 0 ? Math.round(c.expires * 1000) : -1,
  ]);
}

function gerarTampermonkeyScript(cookies: Cookie[], email: string): string {
  const cookieArr = cookiesToTampermonkey(cookies);
  const cookieJson = JSON.stringify(cookieArr);
  const header = [
    '// ==UserScript==',
    '// @name         Uber Cookie Injector — ' + email,
    '// @namespace    http://tampermonkey.net/',
    '// @version      1.0',
    '// @description  Injeta cookies de sessão Uber',
    '// @author       MVP',
    '// @match        https://*.uber.com/*',
    '// @grant        GM_cookie',
    '// @run-at       document-start',
    '// ==/UserScript==',
  ].join('\n');
  const body =
    '(function(){' +
    'var H=window.location.hostname,C=' + cookieJson + ';' +
    'var ok=function(d){d=d.replace(/^[.]/,"");return H===d||H.endsWith("."+d)};' +
    'var EX=Date.now()+3154e7;' +
    'C.forEach(function(c){' +
    'var n=c[0],v=c[1],d=c[2],s=c[3],h=c[4],e=c[5]>0?c[5]:EX;' +
    'if(typeof GM_cookie!="undefined")GM_cookie.set({name:n,value:v,domain:d.replace(/^[.]/,""),path:"/",secure:!!s,httpOnly:!!h,expirationDate:Math.floor(e/1000)},function(){});' +
    'if(!h&&ok(d)){var ck=n+"="+v+";path=/;expires="+new Date(e).toUTCString()+(s?";secure":"")+";";' +
    'try{document.cookie=ck;}catch(x){}}' +
    '});' +
    'var RAN="__scr_done";' +
    'if(!sessionStorage.getItem(RAN)){sessionStorage.setItem(RAN,"1");' +
    'setTimeout(function(){location.href="https://account.uber.com/security";},800);}' +
    '})()';
  return header + '\n' + body;
}

// ─── Detecção de URL ──────────────────────────────────────────────────────────

function isSuccessUrl(url: string): boolean {
  return (
    url.includes('rider.uber.com') ||
    (url.includes('m.uber.com') && !url.includes('auth.uber.com')) ||
    url.includes('uber.com/go') ||
    url.includes('uber.com/home') ||
    url.includes('uber.com/feed') ||
    url.includes('/account') ||
    url.includes('/profile') ||
    url.includes('/dashboard') ||
    url.includes('/home')
  );
}

function isOnboardingUrl(url: string): boolean {
  return (
    url.includes('auth.uber.com') ||
    url.includes('bonjour.uber.com') ||
    url.includes('/signup') ||
    url.includes('/register') ||
    url.includes('/onboard') ||
    url.includes('/verify') ||
    url.includes('/confirm')
  );
}

function isVeriffUrl(url: string): boolean {
  return (
    url.includes('veriff.com') ||
    url.includes('veriff.me') ||
    url.includes('veriff.app') ||
    url.includes('kyc.uber') ||
    url.includes('/veriff') ||
    url.includes('identity-verification')
  );
}

async function detectarVeriff(p: Page): Promise<boolean> {
  if (isVeriffUrl(p.url())) return true;
  const seletoresVeriff = [
    '[data-testid="veriff-container"]',
    'iframe[src*="veriff"]',
    '.veriff-container',
    '[class*="veriff"]',
    'img[alt*="Veriff"]',
    'button:has-text("Start verification")',
    'button:has-text("Iniciar verificação")',
  ];
  for (const sel of seletoresVeriff) {
    if (await p.locator(sel).first().isVisible({ timeout: 500 }).catch(() => false)) return true;
  }
  return false;
}

// ─── Logger ───────────────────────────────────────────────────────────────────

function log(level: 'info' | 'warn' | 'success' | 'error', msg: string, cycle?: number): void {
  globalState.addLog(level, msg, cycle);
  const prefix = cycle !== undefined ? `[C#${cycle}]` : '[GLOBAL]';
  console.log(`${new Date().toISOString()} ${prefix} [${level.toUpperCase()}] ${msg}`);
}

// ─── Proxy helper ─────────────────────────────────────────────────────────────

function buildProxyServerArg(server: string): string {
  let normalized = server.trim();
  try {
    const parsed = new URL(
      normalized.startsWith('http://') || normalized.startsWith('https://')
        ? normalized : 'http://' + normalized
    );
    return `http://${parsed.host}`;
  } catch {
    normalized = normalized.replace(/^https:\/\//, 'http://');
    normalized = normalized.replace(/^http:\/\/[^@]+@/, 'http://');
    if (!normalized.startsWith('http://')) normalized = 'http://' + normalized;
    return normalized;
  }
}

// ─── Dispensar cookies ────────────────────────────────────────────────────────

async function dispensarCookies(p: Page): Promise<void> {
  const candidatos = [
    'button:has-text("Aceitar todos")', 'button:has-text("Accept all")',
    'button:has-text("Aceitar")', 'button:has-text("Accept")',
    '[id*="cookie"] button:has-text("Concordo")',
    '[class*="cookie"] button', '[class*="consent"] button',
    '[data-testid="cookie-banner-accept"]', '[data-testid="accept-cookies"]',
    '#onetrust-accept-btn-handler', '.onetrust-accept-btn-handler',
    'button#accept-recommended-btn-handler',
  ];
  for (const seletor of candidatos) {
    try {
      const el = p.locator(seletor).first();
      if (await el.isVisible({ timeout: 500 }).catch(() => false)) {
        await hoverElement(p, seletor);
        await el.click({ timeout: 2000 });
        globalState.addLog('info', `Banner de cookies dispensado (${seletor})`);
        await humanPause(randInt(sp(80), sp(160)));
        return;
      }
    } catch { /* ignora */ }
  }
}

// ─── Aceitar termos ───────────────────────────────────────────────────────────
async function tentarAceitarTermos(p: Page, cycle?: number): Promise<boolean> {
  let marcouAlgum = false;

  async function estaChecked(cb: import('playwright').Locator): Promise<boolean> {
    return cb.evaluate((el: HTMLInputElement) =>
      el.type === 'checkbox'
        ? el.checked
        : el.getAttribute('aria-checked') === 'true'
    ).catch(() => false);
  }

  async function forcarCheckViaLabel(
    cb: import('playwright').Locator,
    idx: number
  ): Promise<void> {
    const labelPai = cb.locator('xpath=ancestor::label[1]');
    const lpCount = await labelPai.count().catch(() => 0);

    if (lpCount > 0) {
      await labelPai.first().evaluate((el: HTMLElement) => { el.click(); }).catch(() => {});
      await humanPause(randInt(sp(40), sp(80)));
      if (cycle !== undefined) log('info', `[termos] Checkbox #${idx} — click nativo no label pai`, cycle);
    } else {
      await cb.evaluate((el: HTMLInputElement) => {
        if (el.type === 'checkbox') {
          const nativeSet = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'checked')?.set;
          if (nativeSet) nativeSet.call(el, true);
          else el.checked = true;
        } else {
          el.setAttribute('aria-checked', 'true');
        }
        el.dispatchEvent(new MouseEvent('click',  { bubbles: true, cancelable: true, composed: true }));
        el.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
        el.dispatchEvent(new Event('input',  { bubbles: true, cancelable: true }));
      }).catch(() => {});
      await humanPause(randInt(sp(40), sp(80)));
      if (cycle !== undefined) log('info', `[termos] Checkbox #${idx} — fallback nativeSet+events`, cycle);
    }
  }

  const containerTermos = p.locator('[data-testid="accept-terms"]');
  const containerCount = await containerTermos.count().catch(() => 0);

  if (containerCount > 0) {
    if (cycle !== undefined) log('info', `[termos] Encontrados ${containerCount} container(s) accept-terms`, cycle);

    for (let i = 0; i < containerCount; i++) {
      const container = containerTermos.nth(i);
      const visible = await container.isVisible({ timeout: 800 }).catch(() => false);
      if (!visible) continue;

      const cbInterno = container.locator('input[type="checkbox"]').first();
      const cbCount = await cbInterno.count().catch(() => 0);
      if (cbCount > 0 && await estaChecked(cbInterno)) {
        if (cycle !== undefined) log('info', `[termos] Container #${i} já marcado — pulando`, cycle);
        marcouAlgum = true;
        continue;
      }

      const labelFilho = container.locator('label').first();
      const labelCount = await labelFilho.count().catch(() => 0);

      if (labelCount > 0) {
        const lbox = await labelFilho.boundingBox().catch(() => null);
        if (lbox && lbox.width > 0 && lbox.height > 0) {
          await humanMouseMove(p, lbox.x + lbox.width * randFloat(0.3, 0.7), lbox.y + lbox.height * randFloat(0.3, 0.7));
          await humanPause(randInt(sp(40), sp(80)));
          await labelFilho.evaluate((el: HTMLElement) => { el.click(); }).catch(() => {});
          await humanPause(randInt(sp(80), sp(150)));
          if (cycle !== undefined) log('info', `[termos] Container #${i} — click no label filho`, cycle);
        }
      } else {
        const cbox = await container.boundingBox().catch(() => null);
        if (cbox && cbox.width > 0) {
          await humanMouseMove(p, cbox.x + cbox.width * randFloat(0.2, 0.5), cbox.y + cbox.height * randFloat(0.3, 0.7));
          await humanPause(randInt(sp(40), sp(80)));
          await container.evaluate((el: HTMLElement) => { el.click(); }).catch(() => {});
          await humanPause(randInt(sp(80), sp(150)));
          if (cycle !== undefined) log('info', `[termos] Container #${i} — click direto no container`, cycle);
        }
      }

      if (cbCount > 0 && !(await estaChecked(cbInterno))) {
        if (cycle !== undefined) log('warn', `[termos] Container #${i} não marcou — forçando via nativeSet`, cycle);
        await forcarCheckViaLabel(cbInterno, i);
      }

      marcouAlgum = true;
      await humanPause(randInt(sp(60), sp(120)));
    }

    if (marcouAlgum) {
      if (cycle !== undefined) log('info', '[termos] Todos os accept-terms marcados', cycle);
      await _aguardarForwardHabilitar(p);
      return true;
    }
  }

  const labelTextoSels = [
    'label:has-text("Concordo")', 'label:has-text("Agree")',
    'label:has-text("aceito")', 'label:has-text("accept")',
    'label:has-text("termos")', 'label:has-text("terms")',
    'label:has-text("Li e aceito")', 'label:has-text("I agree")',
  ];

  for (const sel of labelTextoSels) {
    try {
      const lbl = p.locator(sel).first();
      const lbox = await lbl.boundingBox().catch(() => null);
      if (!lbox || lbox.width === 0 || lbox.height === 0) continue;

      await humanMouseMove(p, lbox.x + lbox.width * randFloat(0.3, 0.7), lbox.y + lbox.height * randFloat(0.3, 0.7));
      await humanPause(randInt(sp(40), sp(80)));
      await lbl.evaluate((el: HTMLElement) => { el.click(); }).catch(() => {});
      await humanPause(randInt(sp(80), sp(150)));
      if (cycle !== undefined) log('info', `[termos] Label texto — element.click(): "${sel}"`, cycle);

      const cbInterno = lbl.locator('input[type="checkbox"]').first();
      const cbCount = await cbInterno.count().catch(() => 0);
      if (cbCount > 0 && !(await estaChecked(cbInterno))) {
        await forcarCheckViaLabel(cbInterno, 100);
      }

      marcouAlgum = true;
      break;
    } catch { /* continua */ }
  }

  if (marcouAlgum) {
    if (cycle !== undefined) log('info', '[termos] Termos marcados via label visível', cycle);
    await _aguardarForwardHabilitar(p);
    return true;
  }

  const nativos = p.locator('input[type="checkbox"]');
  const nCount = await nativos.count().catch(() => 0);

  for (let i = 0; i < nCount; i++) {
    try {
      const cb = nativos.nth(i);
      if (!(await cb.count().then((n) => n > 0).catch(() => false))) continue;

      if (await estaChecked(cb)) {
        if (cycle !== undefined) log('info', `[termos] Checkbox #${i} já marcado`, cycle);
        marcouAlgum = true;
        continue;
      }

      let clicked = false;
      try {
        const labelPai = cb.locator('xpath=ancestor::label[1]');
        const lpCount = await labelPai.count().catch(() => 0);
        if (lpCount > 0) {
          const lbox = await labelPai.first().boundingBox().catch(() => null);
          if (lbox && lbox.width > 0 && lbox.height > 0) {
            await humanMouseMove(p, lbox.x + lbox.width * randFloat(0.3, 0.7), lbox.y + lbox.height * randFloat(0.3, 0.7));
            await humanPause(randInt(sp(40), sp(80)));
            await labelPai.first().evaluate((el: HTMLElement) => { el.click(); }).catch(() => {});
            await humanPause(randInt(sp(80), sp(150)));
            clicked = true;
          }
        }
      } catch { /* fallback */ }

      if (!clicked) {
        try {
          await cb.click({ force: true, timeout: 3000 });
          await humanPause(randInt(sp(60), sp(120)));
          clicked = true;
        } catch { /* fallback */ }
      }

      if (!(await estaChecked(cb))) {
        await forcarCheckViaLabel(cb, i);
      }

      marcouAlgum = true;
    } catch { /* continua */ }
  }

  const roles = p.locator('[role="checkbox"]');
  const rCount = await roles.count().catch(() => 0);
  for (let i = 0; i < rCount; i++) {
    try {
      const cb = roles.nth(i);
      if (!(await cb.isVisible({ timeout: 800 }).catch(() => false))) continue;
      if (await estaChecked(cb)) { marcouAlgum = true; continue; }

      const box = await cb.boundingBox().catch(() => null);
      if (box) await humanMouseMove(p, box.x + box.width * randFloat(0.3, 0.7), box.y + box.height * randFloat(0.3, 0.7));
      await humanPause(randInt(sp(40), sp(80)));
      await cb.evaluate((el: HTMLElement) => { el.click(); }).catch(() => {});
      await humanPause(randInt(sp(80), sp(150)));

      if (!(await estaChecked(cb))) {
        await forcarCheckViaLabel(cb, i + 1000);
      }
      marcouAlgum = true;
      if (cycle !== undefined) log('info', `[termos] [role=checkbox] #${i} marcado`, cycle);
    } catch { /* continua */ }
  }

  if (marcouAlgum) {
    if (cycle !== undefined) log('info', '[termos] Termos aceitos (fallback)', cycle);
    await _aguardarForwardHabilitar(p);
  }

  return marcouAlgum;
}

async function _aguardarForwardHabilitar(p: Page): Promise<void> {
  try {
    await p.locator('#forward-button, [data-testid="forward-button"]')
      .first()
      .waitFor({ state: 'visible', timeout: 3000 });
    const fwd = p.locator('#forward-button, [data-testid="forward-button"]').first();
    for (let t = 0; t < 10; t++) {
      const enabled = await fwd.isEnabled({ timeout: 300 }).catch(() => false);
      if (enabled) break;
      await humanPause(200);
    }
  } catch { /* ignora */ }
}

// ─── Seleciona cidade ─────────────────────────────────────────────────────────

async function selecionarCidade(p: Page, cidade: string, cycle: number): Promise<void> {
  const INPUT_SEL = '[data-testid="flow-type-city-selector-v2-input"]';
  const DROPDOWN_ITEM_SELS = [
    '[data-testid="flow-type-city-selector-v2-option"]',
    '[role="option"]', '[role="listbox"] li',
    '[class*="suggestion"]', '[class*="option"]', '[class*="item"]',
  ];
  const norm = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
  const nomeBusca = cidade.split(',')[0]!.trim();
  const nomeBuscaNorm = norm(nomeBusca);

  log('info', `Digitando cidade: "${nomeBusca}"`, cycle);
  await p.waitForSelector(INPUT_SEL, { state: 'visible', timeout: 10000 });
  await focusField(p, INPUT_SEL);
  await p.fill(INPUT_SEL, '');
  await humanPause(randInt(sp(50), sp(100)));
  for (const ch of nomeBusca) {
    await _typeChar(p, ch, isSpeedMode());
    if (!isSpeedMode() && Math.random() < 0.06) await humanPause(randInt(40, 100));
  }

  let itemSel: string | null = null;
  const pollMs = isSpeedMode() ? 80 : 150;
  const fimDropdown = Date.now() + 5_000;
  while (Date.now() < fimDropdown) {
    for (const sel of DROPDOWN_ITEM_SELS) {
      try {
        if (await p.locator(sel).count() > 0 &&
            await p.locator(sel).first().isVisible({ timeout: 300 }).catch(() => false)) {
          itemSel = sel; break;
        }
      } catch { /* continua */ }
    }
    if (itemSel) break;
    await humanPause(pollMs);
  }

  if (!itemSel) {
    log('warn', 'Dropdown nao detectado, tentando ArrowDown+Enter', cycle);
    await p.keyboard.press('ArrowDown');
    await humanPause(randInt(sp(80), sp(150)));
    await p.keyboard.press('Enter');
    return;
  }

  await humanPause(randInt(sp(80), sp(180)));
  const opcoes = p.locator(itemSel);
  const total = await opcoes.count();
  let clicou = false;
  for (let i = 0; i < total; i++) {
    try {
      const opcao = opcoes.nth(i);
      const texto = await opcao.innerText().catch(() => '');
      if (norm(texto).includes(nomeBuscaNorm)) {
        const box = await opcao.boundingBox().catch(() => null);
        if (box) await humanMouseMove(p, box.x + box.width * randFloat(0.25, 0.75), box.y + box.height * randFloat(0.25, 0.75));
        await humanPause(randInt(sp(50), sp(110)));
        await opcao.click({ timeout: 4000 });
        clicou = true;
        log('info', `Cidade selecionada: "${texto.trim()}"`, cycle);
        break;
      }
    } catch { /* continua */ }
  }
  if (!clicou) {
    await p.keyboard.press('ArrowDown');
    await humanPause(randInt(sp(80), sp(150)));
    await p.keyboard.press('Enter');
  }
}

async function preencherInviteCode(p: Page, inviteCode: string, cycle: number): Promise<void> {
  if (!inviteCode) return;
  const SEL = '[data-testid="signup-step::invite-code-input"]';
  const visible = await p.locator(SEL).first().isVisible({ timeout: 1500 }).catch(() => false);
  if (!visible) return;
  const val = await p.locator(SEL).first().inputValue().catch(() => '');
  if (val) { log('info', `Invite code ja preenchido: "${val}"`, cycle); return; }
  log('info', `Preenchendo invite code: "${inviteCode}"`, cycle);
  await humanTypeForce(p, SEL, inviteCode);
  log('info', 'Invite code preenchido', cycle);
}

// ─── Tela WhatsApp opt-in ─────────────────────────────────────────────────────

async function tratarTelaWhatsApp(p: Page, cycle: number): Promise<boolean> {
  const isWhatsApp =
    await p.locator('[data-testid="step whatsAppOptIn"]').isVisible({ timeout: 1500 }).catch(() => false);
  if (!isWhatsApp) return false;

  log('info', 'Tela WhatsApp opt-in detectada — clicando NAO ATIVAR', cycle);
  await cogPause(150, 300);

  const btn = p.locator('button', { hasText: /NÃO ATIVAR/i }).first();
  if (await btn.isVisible({ timeout: 1500 }).catch(() => false)) {
    const box = await btn.boundingBox().catch(() => null);
    if (box) await humanMouseMove(p, box.x + box.width * randFloat(0.3, 0.7), box.y + box.height * randFloat(0.3, 0.7));
    await humanPause(randInt(sp(60), sp(130)));
    await btn.click({ timeout: 4000 });
    log('info', 'WhatsApp opt-in recusado', cycle);
    await humanPause(randInt(sp(200), sp(400)));
    return true;
  }

  const nav = p.locator('[data-testid="step-bottom-navigation"] button').first();
  if (await nav.isVisible({ timeout: 1000 }).catch(() => false)) {
    await nav.click({ timeout: 4000 });
    log('info', 'WhatsApp opt-in recusado (fallback nav)', cycle);
    await humanPause(randInt(sp(200), sp(400)));
    return true;
  }

  return false;
}

// ─── Hub de KYC ──────────────────────────────────────────────────────────────

async function tratarHubKYC(p: Page, cycle: number): Promise<boolean> {
  const isHub =
    await p.locator('[data-testid="hub"]').isVisible({ timeout: 1500 }).catch(() => false);
  if (!isHub) return false;

  log('info', 'Hub KYC detectado — clicando em Foto do perfil', cycle);
  await cogPause(150, 300);

  const fotoItem = p.locator('[data-testid="stepItem profilePhoto"]').first();
  if (await fotoItem.isVisible({ timeout: 3000 }).catch(() => false)) {
    const box = await fotoItem.boundingBox().catch(() => null);
    if (box) await humanMouseMove(p, box.x + box.width * randFloat(0.2, 0.8), box.y + box.height * randFloat(0.2, 0.8));
    await humanPause(randInt(sp(80), sp(160)));
    await fotoItem.click({ force: true, timeout: 4000 });
    log('info', 'Navegando para etapa de foto do perfil', cycle);
    await humanPause(randInt(sp(200), sp(500)));
    return true;
  }

  log('warn', 'Item "Foto do perfil" nao encontrado no hub', cycle);
  return false;
}

// ─── Tela de foto do perfil ───────────────────────────────────────────────────

async function tratarTelaFotoPerfil(p: Page, cycle: number): Promise<boolean> {
  const isFotoStep =
    await p.locator('[data-testid="step profilePhoto"]').isVisible({ timeout: 1500 }).catch(() => false);
  if (!isFotoStep) return false;

  log('info', 'Tela de foto do perfil detectada — clicando Tirar foto', cycle);
  await cogPause(150, 400);

  const btnFoto = p.locator('[data-testid="docUploadButton"]').first();
  if (await btnFoto.isVisible({ timeout: 3000 }).catch(() => false)) {
    const box = await btnFoto.boundingBox().catch(() => null);
    if (box) await humanMouseMove(p, box.x + box.width * randFloat(0.3, 0.7), box.y + box.height * randFloat(0.3, 0.7));
    await humanPause(randInt(sp(80), sp(180)));
    await btnFoto.click({ force: true, timeout: 4000 });
    log('info', 'Botao "Tirar foto" clicado', cycle);
    await humanPause(randInt(sp(200), sp(500)));
    return true;
  }

  const btnTexto = p.locator('button', { hasText: /Tirar foto/i }).first();
  if (await btnTexto.isVisible({ timeout: 1000 }).catch(() => false)) {
    await btnTexto.click({ force: true, timeout: 4000 });
    log('info', 'Botao "Tirar foto" clicado (fallback texto)', cycle);
    await humanPause(randInt(sp(200), sp(500)));
    return true;
  }

  log('warn', 'Botao "Tirar foto" nao encontrado', cycle);
  return false;
}

// ─── Tela de senha isolada pós-email ─────────────────────────────────────────

async function tratarTelaSenhaFluxo(
  p: Page,
  email: string,
  senha: string,
  cycle: number
): Promise<boolean> {
  const temSenha = await p.locator('#PASSWORD, input[autocomplete="new-password"], input[type="password"]')
    .first().isVisible({ timeout: 1000 }).catch(() => false);
  if (!temSenha) return false;

  const cidadeAindaVisivel = await p.locator(
    '[data-testid="flow-type-city-selector-v2-input"]'
  ).first().isVisible({ timeout: 300 }).catch(() => false);
  if (cidadeAindaVisivel) {
    log('info', '[tratarTelaSenhaFluxo] Input de cidade visivel — ignorando campo password (autofill)', cycle);
    return false;
  }

  const usernameVisivel = await p.locator('#username, input[id="username"]')
    .first().isVisible({ timeout: 400 }).catch(() => false);

  if (usernameVisivel) return false;

  const temUsernameAttached = await p.locator('#username, input[id="username"]')
    .count().then((n) => n > 0).catch(() => false);

  log('info', 'Tela de senha do fluxo detectada (pos-email)', cycle);
  await cogPause(150, 300);

  if (temUsernameAttached) {
    await forcarValorReact(p, '#username', email);
    log('info', '[senha-fluxo] Username hidden preenchido via React setter', cycle);
    await humanPause(randInt(sp(50), sp(90)));
  }

  const senhaSels = [
    '#PASSWORD',
    'input[autocomplete="new-password"]',
    'input[autocomplete="current-password"]',
    'input[name="password"]',
    'input[type="password"]',
  ];

  for (const sel of senhaSels) {
    if (await p.locator(sel).first().isVisible({ timeout: 1000 }).catch(() => false)) {
      await p.locator(sel).evaluate((el: HTMLInputElement) => {
        const nativeSet = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
        if (nativeSet) nativeSet.call(el, '');
        else el.value = '';
        el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: false, composed: true, data: '', inputType: 'deleteContentBackward' }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }).catch(() => {});
      await humanPause(randInt(sp(40), sp(80)));

      await forcarValorReact(p, sel, senha);
      await humanPause(randInt(sp(50), sp(90)));
      await humanTypeForce(p, sel, senha);

      const val = await p.locator(sel).inputValue().catch(() => '');
      if (val !== senha) {
        log('warn', '[senha-fluxo] Valor incorreto apos digitacao — re-forcando', cycle);
        await forcarValorReact(p, sel, senha);
        await humanPause(randInt(sp(80), sp(160)));
      }

      const fwdBtn = p.locator('#forward-button, [data-testid="forward-button"]').first();
      const habilitado = await fwdBtn.waitFor({ state: 'visible', timeout: 1500 })
        .then(() => fwdBtn.isEnabled({ timeout: 1500 }))
        .catch(() => false);
      if (!habilitado) {
        log('warn', '[senha-fluxo] forward-button ainda disabled — disparando blur', cycle);
        await p.locator(sel).evaluate((el) => {
          el.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
        }).catch(() => {});
        await humanPause(randInt(sp(120), sp(240)));
      }

      log('info', `[senha-fluxo] Senha digitada (${sel})`, cycle);
      break;
    }
  }

  await cogPause(150, 300);
  await clickForwardButton(p, cycle);
  log('info', '[senha-fluxo] Avancado apos senha', cycle);
  await humanPause(randInt(sp(200), sp(500)));
  return true;
}

// ─── Tela de re-autenticação ──────────────────────────────────────────────────

async function tratarTelaReAuth(
  p: Page,
  email: string,
  senha: string,
  cycle: number
): Promise<boolean> {
  const temEmail = await p.locator('#username, input[id="username"]')
    .first().isVisible({ timeout: 1000 }).catch(() => false);
  const temSenha = await p.locator('#PASSWORD, input[autocomplete="new-password"], input[type="password"]')
    .first().isVisible({ timeout: 1000 }).catch(() => false);

  if (!temEmail || !temSenha) return false;

  const cidadeAindaVisivelReAuth = await p.locator(
    '[data-testid="flow-type-city-selector-v2-input"]'
  ).first().isVisible({ timeout: 300 }).catch(() => false);
  if (cidadeAindaVisivelReAuth) {
    log('info', '[tratarTelaReAuth] Input de cidade visivel — ignorando re-auth (autofill)', cycle);
    return false;
  }

  log('info', 'Tela re-auth detectada (username + password visiveis)', cycle);
  await cogPause(150, 300);

  const emailSel = '#username';

  await p.locator(emailSel).evaluate((el: HTMLInputElement) => {
    const nativeSet = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    if (nativeSet) nativeSet.call(el, '');
    else el.value = '';
    el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: false, composed: true, data: '', inputType: 'deleteContentBackward' }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }).catch(() => {});
  await humanPause(randInt(sp(40), sp(80)));

  await forcarValorReact(p, emailSel, email);
  await humanPause(randInt(sp(50), sp(90)));
  await humanTypeForce(p, emailSel, email);

  const emailVal = await p.locator(emailSel).inputValue().catch(() => '');
  if (emailVal !== email) {
    log('warn', '[re-auth] Email incorreto apos digitacao — re-forcando', cycle);
    await forcarValorReact(p, emailSel, email);
    await humanPause(randInt(sp(80), sp(160)));
  }

  await p.locator(emailSel).evaluate((el) => {
    el.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
  }).catch(() => {});
  await humanPause(randInt(sp(80), sp(160)));

  const senhaSels = ['#PASSWORD', 'input[autocomplete="new-password"]', 'input[autocomplete="current-password"]', 'input[type="password"]'];
  let senhaSel = '';

  for (const sel of senhaSels) {
    if (await p.locator(sel).first().isVisible({ timeout: 1000 }).catch(() => false)) {
      senhaSel = sel;
      await p.locator(sel).evaluate((el: HTMLInputElement) => {
        const nativeSet = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
        if (nativeSet) nativeSet.call(el, '');
        else el.value = '';
        el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: false, composed: true, data: '', inputType: 'deleteContentBackward' }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }).catch(() => {});
      await humanPause(randInt(sp(40), sp(80)));
      await forcarValorReact(p, sel, senha);
      await humanPause(randInt(sp(50), sp(90)));
      await humanTypeForce(p, sel, senha);
      const senhaVal = await p.locator(sel).inputValue().catch(() => '');
      if (senhaVal !== senha) {
        log('warn', '[re-auth] Senha incorreta — re-forcando', cycle);
        await forcarValorReact(p, sel, senha);
        await humanPause(randInt(sp(80), sp(160)));
      }
      await p.locator(sel).evaluate((el) => {
        el.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
      }).catch(() => {});
      await humanPause(randInt(sp(80), sp(160)));
      log('info', `[re-auth] Senha digitada (${sel})`, cycle);
      break;
    }
  }

  const fwdBtn = p.locator('#forward-button, [data-testid="forward-button"]').first();
  let habilitado = false;
  for (let tentativa = 1; tentativa <= 3; tentativa++) {
    habilitado = await fwdBtn.waitFor({ state: 'visible', timeout: 3000 })
      .then(() => fwdBtn.isEnabled({ timeout: 3000 }))
      .catch(() => false);
    if (habilitado) break;
    log('warn', `[re-auth] forward-button disabled (tentativa ${tentativa}/3) — re-forcando`, cycle);
    await forcarValorReact(p, emailSel, email);
    if (senhaSel) {
      await forcarValorReact(p, senhaSel, senha);
      await p.locator(senhaSel).evaluate((el) => {
        el.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
      }).catch(() => {});
    }
    await humanPause(randInt(sp(150), sp(300)));
  }

  if (!habilitado) log('warn', '[re-auth] forward-button nunca habilitou — tentando clicar mesmo assim', cycle);

  await cogPause(120, 250);

  const submitSels = [
    '#forward-button', '[data-testid="forward-button"]',
    'button[type="submit"]', 'button:has-text("Continuar")', 'button:has-text("Continue")',
    'button:has-text("Entrar")', 'button:has-text("Sign in")',
  ];

  for (const sel of submitSels) {
    const el = p.locator(sel).first();
    if (await el.isVisible({ timeout: 1000 }).catch(() => false)) {
      const box = await el.boundingBox().catch(() => null);
      if (box) await humanMouseMove(p, box.x + box.width * randFloat(0.3, 0.7), box.y + box.height * randFloat(0.3, 0.7));
      await humanPause(randInt(sp(60), sp(140)));
      await el.click({ force: true, timeout: 4000 });
      log('info', `[re-auth] Botao submit clicado (${sel})`, cycle);
      await humanPause(randInt(sp(400), sp(700)));
      return true;
    }
  }

  log('warn', '[re-auth] Nenhum botao de submit encontrado', cycle);
  return false;
}

// ─── Browser management ───────────────────────────────────────────────────────

async function ensureBrowser(headless = false, proxyConfig?: string): Promise<void> {
  if (browser && browser.isConnected() && currentLaunchProxy === (proxyConfig ?? null)) return;
  if (browserLaunching) {
    while (browserLaunching) await new Promise<void>((r) => setTimeout(r, 100));
    if (browser && browser.isConnected() && currentLaunchProxy === (proxyConfig ?? null)) return;
  }
  browserLaunching = true;
  try {
    if (browser) { await browser.close().catch(() => {}); browser = null; }
    if (!stealthPluginRegistered) {
      chromiumExtra.use(StealthPlugin());
      stealthPluginRegistered = true;
    }
    const launchOpts: any = {
      headless,
      args: [
        '--no-sandbox', '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-features=IsolateOrigins,site-per-process',
        '--window-size=390,844',
      ],
    };
    if (proxyConfig) {
      const proxyServer = buildProxyServerArg(proxyConfig);
      launchOpts.proxy = { server: proxyServer };
      const url = new URL(proxyConfig.startsWith('http') ? proxyConfig : 'http://' + proxyConfig);
      if (url.username) {
        launchOpts.proxy.username = decodeURIComponent(url.username);
        launchOpts.proxy.password = decodeURIComponent(url.password);
      }
    }
    browser = await (chromiumExtra as any).launch(launchOpts);
    currentLaunchProxy = proxyConfig ?? null;
    log('info', 'Browser iniciado');
  } finally {
    browserLaunching = false;
  }
}

export async function closeBrowser(): Promise<void> {
  if (browser) { await browser.close().catch(() => {}); browser = null; }
}

// ─── Context por ciclo ────────────────────────────────────────────────────────

async function criarContextoCiclo(cycle: number): Promise<import('playwright').BrowserContext> {
  const ctx = await browser!.newContext({
    ...MOBILE_DEVICE,
    viewport: { width: 390, height: 844 },
    screen:   { width: 390, height: 844 },
    locale: 'pt-BR',
    timezoneId: 'America/Sao_Paulo',
    colorScheme: 'light',
    permissions: ['geolocation'],
    geolocation: { latitude: -23.55 + randFloat(-0.5, 0.5), longitude: -46.63 + randFloat(-0.5, 0.5) },
    userAgent: MOBILE_DEVICE.userAgent,
  });
  await ctx.route('**/*.{png,jpg,jpeg,gif,webp,svg,ico,woff,woff2,ttf,otf,eot}', (r) => r.abort()).catch(() => {});
  contextosPorCiclo.set(cycle, ctx);
  return ctx;
}

async function fecharContextoCiclo(cycle: number): Promise<void> {
  const ctx = contextosPorCiclo.get(cycle);
  if (ctx) { await ctx.close().catch(() => {}); contextosPorCiclo.delete(cycle); }
}

// ─── Etapas do flow ───────────────────────────────────────────────────────────

async function forcarValorReact(p: Page, selector: string, value: string): Promise<void> {
  await p.locator(selector).evaluate((el: HTMLInputElement, val: string) => {
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype, 'value'
    )?.set;
    if (nativeInputValueSetter) {
      nativeInputValueSetter.call(el, val);
    } else {
      el.value = val;
    }
    el.dispatchEvent(new InputEvent('input',  { bubbles: true, cancelable: false, composed: true, data: val, inputType: 'insertText' }));
    el.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
  }, value).catch(() => {});
}

async function etapa_digitarEmailOuTelefone(p: Page, email: string, cycle: number): Promise<void> {
  log('info', `Digitando email: ${email}`, cycle);

  const SELS = [
    '#PHONE_NUMBER_or_EMAIL_ADDRESS', '#EMAIL_ADDRESS',
    'input[autocomplete="email"]', 'input[type="email"]',
    '#PHONE_NUMBER', 'input[autocomplete="tel-national"]',
    'input[type="tel"]', 'input[inputmode="tel"]',
  ];

  for (const SEL of SELS) {
    const visible = await p.locator(SEL).first().isVisible({ timeout: 3000 }).catch(() => false);
    if (visible) {
      log('info', `[DEBUG] Campo "${SEL}" -> "${email}"`, cycle);
      await p.locator(SEL).evaluate((el: HTMLInputElement) => {
        const nativeSet = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
        if (nativeSet) nativeSet.call(el, '');
        else el.value = '';
        el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: false, composed: true, data: '', inputType: 'deleteContentBackward' }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }).catch(() => {});
      await humanPause(randInt(sp(40), sp(80)));
      await humanTypeForce(p, SEL, email);
      const val = await p.locator(SEL).inputValue().catch(() => '');
      if (val !== email) {
        log('warn', `Valor pos-digitacao "${val}" != email esperado — forcando via React setter`, cycle);
        await forcarValorReact(p, SEL, email);
        await humanPause(randInt(sp(80), sp(160)));
      }
      const finalVal = await p.locator(SEL).inputValue().catch(() => '');
      log('info', `Email digitado — valor final: "${finalVal}"`, cycle);
      return;
    }
  }

  throw new Error('Campo de email/telefone nao encontrado em nenhum seletor conhecido');
}

async function etapa_digitarSenha(p: Page, senha: string, cycle: number): Promise<void> {
  log('info', 'Digitando senha...', cycle);

  const SELS = [
    '#PASSWORD', 'input[autocomplete="new-password"]',
    'input[autocomplete="current-password"]',
    'input[name="password"]', 'input[type="password"]',
  ];

  for (const SEL of SELS) {
    const visible = await p.locator(SEL).first().isVisible({ timeout: 3000 }).catch(() => false);
    if (visible) {
      log('info', `Campo senha encontrado: "${SEL}"`, cycle);
      await p.locator(SEL).evaluate((el: HTMLInputElement) => {
        const nativeSet = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
        if (nativeSet) nativeSet.call(el, '');
        else el.value = '';
        el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: false, composed: true, data: '', inputType: 'deleteContentBackward' }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }).catch(() => {});
      await humanPause(randInt(sp(40), sp(80)));
      await forcarValorReact(p, SEL, senha);
      await humanPause(randInt(sp(50), sp(90)));
      await humanTypeForce(p, SEL, senha);
      const val = await p.locator(SEL).inputValue().catch(() => '');
      if (val !== senha) {
        log('warn', 'Valor pos-digitacao da senha incorreto — forcando', cycle);
        await forcarValorReact(p, SEL, senha);
        await humanPause(randInt(sp(80), sp(160)));
      }
      const fwdBtn = p.locator('#forward-button, [data-testid="forward-button"]').first();
      const habilitado = await fwdBtn.waitFor({ state: 'visible', timeout: 1500 })
        .then(() => fwdBtn.isEnabled({ timeout: 1500 })).catch(() => false);
      if (!habilitado) {
        log('warn', '#forward-button ainda disabled apos senha — disparando blur', cycle);
        await p.locator(SEL).evaluate((el) => {
          el.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
        }).catch(() => {});
        await humanPause(randInt(sp(120), sp(200)));
      }
      log('info', 'Senha digitada', cycle);
      return;
    }
  }

  throw new Error('Campo de senha nao encontrado');
}

async function etapa_aguardarOTP(
  p: Page, emailClient: IEmailClient, email: string,
  cycle: number, otpTimeoutMs = 180_000
): Promise<string> {
  log('info', 'Aguardando OTP no email...', cycle);
  const otp = await emailClient.waitForOTP(email, otpTimeoutMs, cycle);
  log('success', `OTP recebido: ${otp}`, cycle);
  return otp;
}

async function etapa_digitarOTP(p: Page, otp: string, cycle: number): Promise<void> {
  log('info', `Digitando OTP: ${otp}`, cycle);

  const primeroCampoUber = p.locator('#EMAIL_OTP_CODE-0');
  if (await primeroCampoUber.isVisible({ timeout: 3000 }).catch(() => false)) {
    log('info', 'OTP em campos individuais EMAIL_OTP_CODE-N', cycle);
    for (let i = 0; i < otp.length; i++) {
      const campo = p.locator(`#EMAIL_OTP_CODE-${i}`);
      await campo.waitFor({ state: 'visible', timeout: 3000 }).catch(() => {});
      await focusField(p, `#EMAIL_OTP_CODE-${i}`);
      await humanPause(randInt(sp(40), sp(80)));
      await _typeChar(p, otp[i]!, isSpeedMode());
      await humanPause(randInt(sp(40), sp(80)));
    }
    log('info', 'OTP digitado (EMAIL_OTP_CODE-N)', cycle);
    return;
  }

  const camposOtp = p.locator('input[autocomplete="one-time-code"]');
  const totalOtp = await camposOtp.count().catch(() => 0);
  if (totalOtp >= 2) {
    log('info', `OTP em ${totalOtp} campos autocomplete=one-time-code`, cycle);
    for (let i = 0; i < Math.min(totalOtp, otp.length); i++) {
      const campo = camposOtp.nth(i);
      await campo.waitFor({ state: 'visible', timeout: 3000 }).catch(() => {});
      await focusField(p, `input[autocomplete="one-time-code"]:nth-of-type(${i + 1})`);
      await humanPause(randInt(sp(40), sp(80)));
      await _typeChar(p, otp[i]!, isSpeedMode());
      await humanPause(randInt(sp(40), sp(80)));
    }
    log('info', 'OTP digitado (one-time-code multi)', cycle);
    return;
  }

  const campoUnico = p.locator(
    'input[autocomplete="one-time-code"], input[name="otp"], input[name="code"], input[placeholder*="código"], input[placeholder*="code"]'
  ).first();
  if (await campoUnico.isVisible({ timeout: 3000 }).catch(() => false)) {
    log('info', 'OTP em campo unico', cycle);
    await focusField(p, 'input[autocomplete="one-time-code"]');
    await humanPause(randInt(sp(50), sp(100)));
    for (const ch of otp) {
      await _typeChar(p, ch, isSpeedMode());
      await humanPause(randInt(sp(40), sp(80)));
    }
    log('info', 'OTP digitado (campo unico)', cycle);
    return;
  }

  throw new Error('Campo OTP nao encontrado');
}

// ─── Processamento de telas no onboarding ────────────────────────────────────

async function processarTelaOnboarding(
  p: Page,
  payload: ReturnType<typeof gerarPayloadCompleto>,
  emailClient: IEmailClient,
  cycle: number,
  state: { otpDigitado: boolean; senhaDigitada: boolean; cidadePreenchida: boolean }
): Promise<'continua' | 'sucesso' | 'kyc' | 'erro'> {

  const cidadeInputVisivel = await p.locator(
    '[data-testid="flow-type-city-selector-v2-input"]'
  ).first().isVisible({ timeout: 500 }).catch(() => false);

  if (cidadeInputVisivel && !state.cidadePreenchida) {
    log('info', 'Tela de localizacao detectada', cycle);
    await cogPause(150, 300);
    await selecionarCidade(p, payload.cidade, cycle);
    await humanPause(randInt(sp(150), sp(300)));
    await preencherInviteCode(p, (payload as any).inviteCode ?? '', cycle);
    await cogPause(120, 250);
    await clickForwardButton(p, cycle);
    state.cidadePreenchida = true;
    await humanPause(randInt(sp(200), sp(500)));
    return 'continua';
  }

  if (isSuccessUrl(p.url())) return 'sucesso';
  if (await detectarVeriff(p)) { log('warn', 'KYC/Veriff detectado', cycle); return 'kyc'; }
  if (await tratarTelaWhatsApp(p, cycle)) return 'continua';
  if (await tratarHubKYC(p, cycle)) return 'continua';
  if (await tratarTelaFotoPerfil(p, cycle)) return 'continua';

  const aceitou = await tentarAceitarTermos(p, cycle);
  if (aceitou) {
    await cogPause(120, 250);
    await clickForwardButton(p, cycle);
    await humanPause(randInt(sp(200), sp(500)));
    return 'continua';
  }

  const temOtpField = await p.locator(
    '#EMAIL_OTP_CODE-0, input[autocomplete="one-time-code"]'
  ).first().isVisible({ timeout: 1000 }).catch(() => false);

  if (temOtpField && !state.otpDigitado) {
    // OTP timeout: 3 minutos — tempo suficiente para o Uber enviar o email
    const otp = await etapa_aguardarOTP(p, emailClient, payload.email, cycle, 180_000);
    await etapa_digitarOTP(p, otp, cycle);
    state.otpDigitado = true;
    await cogPause(120, 250);
    await clickForwardButton(p, cycle);
    await humanPause(randInt(sp(300), sp(600)));
    return 'continua';
  }

  if (await tratarTelaReAuth(p, payload.email, payload.senha, cycle)) return 'continua';

  if (!state.senhaDigitada) {
    if (await tratarTelaSenhaFluxo(p, payload.email, payload.senha, cycle)) {
      state.senhaDigitada = true;
      return 'continua';
    }
  }

  const temEmailField = await p.locator(
    '#PHONE_NUMBER_or_EMAIL_ADDRESS, #EMAIL_ADDRESS, input[autocomplete="email"], input[type="email"]'
  ).first().isVisible({ timeout: 1000 }).catch(() => false);

  if (temEmailField) {
    await etapa_digitarEmailOuTelefone(p, payload.email, cycle);
    await cogPause(120, 250);
    await clickForwardButton(p, cycle);
    await humanPause(randInt(sp(200), sp(500)));
    return 'continua';
  }

  const temSenhaField = await p.locator(
    '#PASSWORD, input[autocomplete="new-password"], input[type="password"]'
  ).first().isVisible({ timeout: 1000 }).catch(() => false);

  if (temSenhaField && !state.senhaDigitada) {
    await etapa_digitarSenha(p, payload.senha, cycle);
    state.senhaDigitada = true;
    await cogPause(120, 250);
    await clickForwardButton(p, cycle);
    await humanPause(randInt(sp(200), sp(500)));
    return 'continua';
  }

  const fwdVisible = await p.locator('#forward-button, [data-testid="forward-button"]')
    .first().isVisible({ timeout: 800 }).catch(() => false);
  if (fwdVisible) {
    await cogPause(80, 200);
    await clickForwardButton(p, cycle);
    await humanPause(randInt(sp(200), sp(400)));
    return 'continua';
  }

  return 'continua';
}

// ─── Preencher nome ───────────────────────────────────────────────────────────

async function etapa_preencherNome(
  p: Page, firstName: string, lastName: string, cycle: number
): Promise<void> {
  log('info', `Preenchendo nome: ${firstName} ${lastName}`, cycle);

  const firstSels = [
    '#FIRST_NAME', 'input[name="firstName"]',
    'input[placeholder*="ome"]', 'input[autocomplete="given-name"]',
  ];
  const lastSels = [
    '#LAST_NAME', 'input[name="lastName"]',
    'input[placeholder*="obrenome"]', 'input[autocomplete="family-name"]',
  ];

  for (const sel of firstSels) {
    if (await p.locator(sel).first().isVisible({ timeout: 2000 }).catch(() => false)) {
      await humanTypeForce(p, sel, firstName);
      log('info', `Primeiro nome digitado (${sel})`, cycle);
      break;
    }
  }

  await humanPause(randInt(sp(60), sp(120)));

  for (const sel of lastSels) {
    if (await p.locator(sel).first().isVisible({ timeout: 2000 }).catch(() => false)) {
      await humanTypeForce(p, sel, lastName);
      log('info', `Sobrenome digitado (${sel})`, cycle);
      break;
    }
  }
}

// ─── Ciclo principal ──────────────────────────────────────────────────────────

export interface RunCycleConfig {
  urlCadastro: string;
  headless: boolean;
  proxy?: string;
  emailProvider: EmailProvider;
  tempMailApiKey?: string;
  tempmailcDomain?: string;
  inviteCode?: string;
  speedMode?: boolean;
}

export interface ExecuteOptions {
  emailProvider: EmailProvider;
  tempMailApiKey: string;
  otpTimeout?: number;
  extraDelay?: number;
  inviteCode?: string;
}

export class MockPlaywrightFlow {
  static async init(headless: boolean): Promise<void> {
    await ensureBrowser(headless);
  }

  static async execute(
    urlCadastro: string,
    opts: ExecuteOptions,
    cycle: number
  ): Promise<void> {
    await runCycle(
      {
        urlCadastro,
        headless: false,
        emailProvider: opts.emailProvider,
        tempMailApiKey: opts.tempMailApiKey,
        inviteCode: opts.inviteCode,
        speedMode: false,
      },
      cycle
    );
  }

  static async cleanup(): Promise<void> {
    await closeBrowser();
  }
}

export async function runCycle(config: RunCycleConfig, cycle: number): Promise<void> {
  const state = globalState.getState();
  (state.config as any) = { ...state.config, speedMode: config.speedMode ?? false };

  // Timeout total: 8 min (3 min OTP + navegação + margem)
  // Ao estourar, lança erro para encerrar o ciclo de verdade
  const CYCLE_TIMEOUT_MS = 8 * 60_000;

  let cycleTimedOut = false;
  let cycleReject: ((err: Error) => void) | null = null;

  const cycleTimeoutPromise = new Promise<never>((_, reject) => {
    cycleReject = reject;
    setTimeout(() => {
      cycleTimedOut = true;
      reject(new Error(`Ciclo #${cycle} excedeu ${CYCLE_TIMEOUT_MS / 1000}s — abortando`));
    }, CYCLE_TIMEOUT_MS);
  });

  const cycleWork = async (): Promise<void> => {
    await ensureBrowser(config.headless, config.proxy);

    const ctx = await criarContextoCiclo(cycle);
    const p = await ctx.newPage();

    // Timeouts de elemento e navegação: 120s cada
    p.setDefaultTimeout(120_000);
    p.setDefaultNavigationTimeout(120_000);

    const emailClient = createEmailClient(
      config.emailProvider,
      config.tempMailApiKey ?? '',
      config.tempmailcDomain ?? ''
    );

    log('info', 'Criando email no provedor...', cycle);
    const emailAccount = await emailClient.createRandomEmail();
    log('info', `Email criado: ${emailAccount.email}`, cycle);

    const payload = gerarPayloadCompleto(emailAccount);
    if (config.inviteCode) (payload as any).inviteCode = config.inviteCode;

    log('info', `Payload gerado: ${payload.email} / ${payload.nome} ${payload.sobrenome}`, cycle);

    try {
      await pageWarmup(p);
      log('info', `Navegando para: ${config.urlCadastro}`, cycle);
      await p.goto(config.urlCadastro, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await humanPause(randInt(sp(200), sp(400)));

      await dispensarCookies(p);
      await scrollIdle(p);

      const temNomeInicial = await p.locator('#FIRST_NAME, input[name="firstName"]')
        .first().isVisible({ timeout: 2000 }).catch(() => false);
      if (temNomeInicial) {
        await etapa_preencherNome(p, payload.nome, payload.sobrenome, cycle);
        await humanPause(randInt(sp(60), sp(120)));
      }

      const flowState = { otpDigitado: false, senhaDigitada: false, cidadePreenchida: false };
      let iteracoes = 0;
      const MAX_ITER = 60;

      while (iteracoes < MAX_ITER) {
        iteracoes++;
        log('info', `[iter ${iteracoes}] URL: ${p.url()}`, cycle);

        const resultado = await processarTelaOnboarding(p, payload, emailClient, cycle, flowState);

        if (resultado === 'sucesso') {
          log('success', `Conta criada com sucesso: ${payload.email}`, cycle);

          const cookies: Cookie[] = await ctx.cookies();
          const tmScript = gerarTampermonkeyScript(cookies, payload.email);

          ArtifactsManager.init();

          accountStore.save({
            cycle,
            provider: config.emailProvider,
            nome: payload.nome,
            sobrenome: payload.sobrenome,
            email: payload.email,
            telefone: (payload as any).telefone ?? '',
            senha: payload.senha,
            localizacao: payload.cidade,
            codigoIndicacao: (payload as any).inviteCode ?? '',
            cookies,
          });

          globalState.incrementSuccess(cycle);
          break;
        }

        if (resultado === 'kyc') {
          log('warn', `KYC detectado no ciclo #${cycle}`, cycle);
          globalState.incrementFailure('KYC detectado', cycle);
          break;
        }

        if (resultado === 'erro') {
          log('error', `Erro fatal no ciclo #${cycle}`, cycle);
          globalState.incrementFailure('erro fatal', cycle);
          break;
        }

        await humanPause(randInt(sp(120), sp(250)));
      }

      if (iteracoes >= MAX_ITER) {
        log('warn', `Ciclo #${cycle} atingiu limite de ${MAX_ITER} iteracoes`, cycle);
        globalState.incrementFailure('max iteracoes atingido', cycle);
      }

    } finally {
      await fecharContextoCiclo(cycle);
    }
  };

  try {
    await Promise.race([cycleWork(), cycleTimeoutPromise]);
  } catch (err: any) {
    if (cycleTimedOut || err?.message?.includes('excedeu')) {
      log('error', err?.message ?? `Ciclo #${cycle} timeout`, cycle);
    } else {
      log('error', `Ciclo #${cycle} falhou: ${err?.message ?? String(err)}`, cycle);
    }
    globalState.incrementFailure(err?.message ?? 'erro desconhecido', cycle);
  } finally {
    // Garante que o timer seja cancelado mesmo se cycleWork terminar antes
    if (cycleReject) {
      // Não há clearTimeout direto pois usamos Promise.race — o timer vai disparar
      // mas como cycleTimedOut já foi tratado, o reject extra é silencioso
    }
  }
}
