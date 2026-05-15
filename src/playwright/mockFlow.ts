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
let browser: Browser | null = null;
let browserLaunching = false;
let currentLaunchProxy: string | null = null;

const contextosPorCiclo = new Map<number, BrowserContext>();

/** Timeout máximo de um ciclo completo (~1min35s no alvo de speed run). */
const CYCLE_TIMEOUT_MS = 95 * 1_000;

const BRAVE_PATH = 'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe';

const MOBILE_DEVICE = devices['iPhone 14'];

// ─── Speed helpers ────────────────────────────────────────────────────────────

function isSpeedMode(): boolean {
  return !!(globalState.getState().config as any)?.speedMode;
}

function sp(normal: number): number {
  if (!isSpeedMode()) return normal;
  return Math.max(120, Math.round(normal * 0.28));
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
      const typo = String.fromCharCode(ch.charCodeAt(0) + (Math.random() > 0.5 ?