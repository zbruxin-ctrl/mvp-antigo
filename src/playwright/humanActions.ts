/**
 * humanActions.ts
 * Helpers de interação humana com o Playwright.
 * Extraído do mockFlow para resolver a dependência circular / módulo ausente.
 */

import { Page } from 'playwright';
import { globalState } from '../state/globalState';

// ─── Constante de delay extra (ms adicionados em cada ação) ───────────────────
const EXTRA_DELAY = 500;

// ─── Speed mode ───────────────────────────────────────────────────────────────

export function isSpeedMode(): boolean {
  const s = globalState.getState();
  return !!(s.config as any)?.speedMode;
}

/** Multiplica ms pelo fator de velocidade (speed=0.3, normal=1.0) e adiciona EXTRA_DELAY */
export function sp(ms: number): number {
  return (isSpeedMode() ? Math.round(ms * 0.3) : ms) + EXTRA_DELAY;
}

export function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export function randFloat(min: number, max: number): number {
  return Math.random() * (max - min) + min;
}

// ─── Pausas ───────────────────────────────────────────────────────────────────

export async function humanPause(ms: number): Promise<void> {
  await new Promise<void>((r) => setTimeout(r, ms + EXTRA_DELAY));
}

export async function cogPause(minMs: number, maxMs: number): Promise<void> {
  await humanPause(randInt(minMs, maxMs));
}

// ─── Mouse humano ─────────────────────────────────────────────────────────────

export async function humanMouseMove(p: Page, x: number, y: number): Promise<void> {
  try {
    const steps = randInt(isSpeedMode() ? 2 : 4, isSpeedMode() ? 5 : 12);
    await p.mouse.move(x, y, { steps });
  } catch { /* ignora */ }
}

export async function hoverElement(p: Page, selector: string): Promise<void> {
  try {
    const el = p.locator(selector).first();
    const box = await el.boundingBox().catch(() => null);
    if (box) {
      await humanMouseMove(
        p,
        box.x + box.width  * randFloat(0.25, 0.75),
        box.y + box.height * randFloat(0.25, 0.75)
      );
    }
  } catch { /* ignora */ }
}

export async function focusField(p: Page, selector: string): Promise<void> {
  try {
    await hoverElement(p, selector);
    await p.locator(selector).first().click({ timeout: 3000 });
    await humanPause(randInt(sp(30), sp(70)));
  } catch { /* ignora */ }
}

// ─── Digitação ────────────────────────────────────────────────────────────────

export async function _typeChar(p: Page, ch: string, fast: boolean): Promise<void> {
  const delay = fast ? randInt(20, 50) : randInt(40, 120);
  // typo simulado muito raro
  if (!fast && Math.random() < 0.015) {
    const typo = String.fromCharCode(ch.charCodeAt(0) + (Math.random() > 0.5 ? 1 : -1));
    await p.keyboard.type(typo, { delay: delay });
    await humanPause(randInt(80, 200));
    await p.keyboard.press('Backspace');
    await humanPause(randInt(50, 120));
  }
  await p.keyboard.type(ch, { delay: delay });
}

export async function humanType(p: Page, selector: string, text: string): Promise<void> {
  await focusField(p, selector);
  await humanPause(randInt(sp(40), sp(80)));
  for (const ch of text) {
    await _typeChar(p, ch, isSpeedMode());
    if (!isSpeedMode() && Math.random() < 0.05) await humanPause(randInt(40, 100));
  }
}

/**
 * humanTypeForce: limpa o campo via React native setter e digita o valor.
 * Garante que o React state seja atualizado mesmo em controlled components.
 */
export async function humanTypeForce(p: Page, selector: string, text: string): Promise<void> {
  try {
    await p.locator(selector).first().click({ timeout: 3000 });
    await humanPause(randInt(sp(30), sp(60)));
    // Ctrl+A para selecionar tudo e deletar
    await p.keyboard.press('Control+a');
    await humanPause(randInt(sp(20), sp(50)));
    await p.keyboard.press('Backspace');
    await humanPause(randInt(sp(20), sp(50)));
  } catch { /* ignora */ }

  for (const ch of text) {
    await _typeChar(p, ch, isSpeedMode());
    if (!isSpeedMode() && Math.random() < 0.04) await humanPause(randInt(30, 80));
  }
}

// ─── Click ────────────────────────────────────────────────────────────────────

export async function humanClick(p: Page, selector: string): Promise<void> {
  try {
    const el = p.locator(selector).first();
    const box = await el.boundingBox().catch(() => null);
    if (box) {
      await humanMouseMove(
        p,
        box.x + box.width  * randFloat(0.3, 0.7),
        box.y + box.height * randFloat(0.3, 0.7)
      );
      await humanPause(randInt(sp(40), sp(90)));
    }
    await el.click({ timeout: 5000 });
  } catch { /* ignora */ }
}

export async function clickForwardButton(p: Page, cycle?: number): Promise<void> {
  const sels = [
    '#forward-button',
    '[data-testid="forward-button"]',
    'button[type="submit"]',
    'button:has-text("Continuar")',
    'button:has-text("Continue")',
    'button:has-text("Avançar")',
    'button:has-text("Next")',
  ];

  for (const sel of sels) {
    try {
      const el = p.locator(sel).first();
      const visible = await el.isVisible({ timeout: 1000 }).catch(() => false);
      if (!visible) continue;
      const enabled = await el.isEnabled({ timeout: 1000 }).catch(() => false);
      if (!enabled) continue;
      const box = await el.boundingBox().catch(() => null);
      if (box) {
        await humanMouseMove(
          p,
          box.x + box.width  * randFloat(0.3, 0.7),
          box.y + box.height * randFloat(0.3, 0.7)
        );
        await humanPause(randInt(sp(40), sp(80)));
      }
      await el.click({ force: true, timeout: 4000 });
      if (cycle !== undefined)
        globalState.addLog('info', `[forward] clicado (${sel})`, cycle);
      return;
    } catch { /* tenta o próximo */ }
  }
}

// ─── Scroll idle ──────────────────────────────────────────────────────────────

export async function scrollIdle(p: Page): Promise<void> {
  if (isSpeedMode()) return;
  const amount = randInt(30, 80);
  try {
    await p.mouse.wheel(0, amount);
    await humanPause(randInt(sp(80), sp(150)));
    await p.mouse.wheel(0, -amount);
    await humanPause(randInt(sp(60), sp(120)));
  } catch { /* ignora */ }
}

// ─── Page warmup ─────────────────────────────────────────────────────────────

export async function pageWarmup(p: Page): Promise<void> {
  if (isSpeedMode()) return;
  try {
    const w = randInt(100, 350);
    const h = randInt(100, 700);
    await p.mouse.move(w, h, { steps: randInt(3, 8) });
    await humanPause(randInt(sp(60), sp(120)));
  } catch { /* ignora */ }
}
