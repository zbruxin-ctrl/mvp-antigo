/**
 * sessionProxy.ts — Proxy reverso de sessão via Playwright.
 *
 * Fluxo:
 *   1. POST /api/accounts/:id/session  → abre browser, injeta cookies, navega para drivers.uber.com,
 *                                        aguarda o login ser reconhecido e retorna { sessionId, url }
 *   2. GET  /proxy/:sessionId/*        → serve o snapshot HTML da página atual do browser
 *   3. Cleanup automático após IDLE_TIMEOUT_MS de inatividade
 */

import { Browser, BrowserContext, Page, chromium } from 'playwright';
import type { Cookie } from 'playwright';
import { randomUUID } from 'crypto';
import type { Request as ExpressRequest, Response as ExpressResponse } from 'express';

const IDLE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutos

interface Session {
  id: string;
  accountId: string;
  browser: Browser;
  context: BrowserContext;
  page: Page;
  lastUsedAt: number;
  idleTimer: NodeJS.Timeout;
}

const sessions = new Map<string, Session>();

function resetIdle(session: Session): void {
  clearTimeout(session.idleTimer);
  session.lastUsedAt = Date.now();
  session.idleTimer = setTimeout(() => closeSession(session.id), IDLE_TIMEOUT_MS);
}

export async function closeSession(sessionId: string): Promise<void> {
  const session = sessions.get(sessionId);
  if (!session) return;
  clearTimeout(session.idleTimer);
  try { await session.browser.close(); } catch {}
  sessions.delete(sessionId);
  console.log(`[SessionProxy] sessão ${sessionId} encerrada (idle ou manual)`);
}

export async function closeAllSessions(): Promise<void> {
  for (const id of sessions.keys()) await closeSession(id);
}

/**
 * Cria uma nova sessão Playwright com os cookies da conta.
 * Injeta os cookies ANTES de navegar para drivers.uber.com e aguarda
 * o Uber reconhecer a sessão (URL sai de auth.uber.com).
 */
export async function createSession(
  accountId: string,
  cookies: Cookie[]
): Promise<{ sessionId: string }> {
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
    ],
  });

  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale: 'pt-BR',
    timezoneId: 'America/Sao_Paulo',
    viewport: { width: 1280, height: 800 },
  });

  // Remove o flag webdriver do navigator para evitar detecção anti-bot
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });

  // Injeta todos os cookies da conta no contexto ANTES de qualquer navegação
  const validCookies = cookies.filter((c) => c.name && c.value && c.domain);
  await context.addCookies(
    validCookies.map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain.startsWith('.') ? c.domain : '.' + c.domain,
      path: c.path ?? '/',
      secure: c.secure ?? true,
      httpOnly: c.httpOnly ?? false,
      sameSite: ((c as any).sameSite ?? 'Lax') as 'Strict' | 'Lax' | 'None',
      expires: c.expires && c.expires > 0 ? c.expires : undefined,
    }))
  );

  // Abre UMA página persistente e reutiliza ela em toda a sessão
  const page = await context.newPage();

  // Navega para drivers.uber.com com os cookies já presentes no contexto
  await page.goto('https://drivers.uber.com/', {
    waitUntil: 'domcontentloaded',
    timeout: 30_000,
  });

  // Aguarda até 15s para o Uber reconhecer a sessão e sair de auth.uber.com
  try {
    await page.waitForFunction(
      () => !window.location.hostname.includes('auth.uber.com'),
      { timeout: 15_000 }
    );
  } catch {
    console.warn('[SessionProxy] cookies podem estar expirados — ainda em auth.uber.com');
  }

  const sessionId = randomUUID();
  const idleTimer = setTimeout(() => closeSession(sessionId), IDLE_TIMEOUT_MS);

  sessions.set(sessionId, {
    id: sessionId,
    accountId,
    browser,
    context,
    page,
    lastUsedAt: Date.now(),
    idleTimer,
  });

  console.log(
    `[SessionProxy] sessão criada: ${sessionId} (conta ${accountId}) — url final: ${page.url()}`
  );
  return { sessionId };
}

/**
 * Handler Express para GET /proxy/:sessionId/*
 * Reutiliza a mesma página persistente da sessão (não abre nova),
 * navega se necessário e devolve o HTML com links reescritos.
 */
export async function proxyHandler(
  req: ExpressRequest,
  res: ExpressResponse
): Promise<void> {
  const { sessionId } = req.params;
  const session = sessions.get(sessionId);

  if (!session) {
    res.status(404).send('<h2>Sessão não encontrada ou expirada. Gere uma nova sessão.</h2>');
    return;
  }

  resetIdle(session);

  const rawPath = (req.params as any)[0] ?? '';
  const targetUrl = rawPath && rawPath !== '/'
    ? (rawPath.startsWith('http') ? rawPath : `https://drivers.uber.com/${rawPath.replace(/^\//, '')}`)
    : 'https://drivers.uber.com/';

  try {
    const currentUrl = session.page.url();

    // Só navega se a URL destino for diferente da atual
    if (!currentUrl.includes(targetUrl.replace('https://', '').split('?')[0])) {
      await session.page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    }

    // Reescreve hrefs internos da Uber para apontar para o proxy
    const html = await session.page.evaluate((sid: string) => {
      const base = `/proxy/${sid}/`;
      document.querySelectorAll<HTMLAnchorElement>('a[href]').forEach((a) => {
        try {
          const url = new URL(a.href);
          if (url.hostname.endsWith('uber.com')) {
            a.href = base + url.pathname.replace(/^\//, '') + url.search;
          }
        } catch {}
      });
      return document.documentElement.outerHTML;
    }, sessionId);

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('X-Session-Id', sessionId);
    res.setHeader('X-Current-Url', session.page.url());
    res.send(html);
  } catch (err: any) {
    console.error('[SessionProxy] erro ao navegar:', err?.message);
    res.status(500).send(`<h2>Erro ao carregar a página: ${err?.message}</h2>`);
  }
}

/** Retorna lista de sessões ativas (para o painel admin). */
export function listSessions(): { id: string; accountId: string; lastUsedAt: number; url?: string }[] {
  return Array.from(sessions.values()).map((s) => ({
    id: s.id,
    accountId: s.accountId,
    lastUsedAt: s.lastUsedAt,
    url: s.page?.url(),
  }));
}
