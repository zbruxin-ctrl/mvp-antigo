/**
 * sessionProxy.ts — Proxy reverso de sessão via Playwright.
 *
 * Fluxo:
 *   1. POST /api/accounts/:id/session  → abre browser com cookies da conta, retorna { sessionId, url }
 *   2. GET  /proxy/:sessionId/*        → faz requisições dentro do browser autenticado e devolve o HTML/JSON
 *   3. Cleanup automático após IDLE_TIMEOUT_MS de inatividade
 */

import { Browser, BrowserContext, chromium } from 'playwright';
import type { Cookie } from 'playwright';
import { randomUUID } from 'crypto';
import type { Request as ExpressRequest, Response as ExpressResponse } from 'express';

const IDLE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutos

interface Session {
  id: string;
  accountId: string;
  browser: Browser;
  context: BrowserContext;
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
 * Retorna o sessionId e a URL inicial para o usuário navegar via proxy.
 */
export async function createSession(
  accountId: string,
  cookies: Cookie[]
): Promise<{ sessionId: string }> {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  });

  // Injeta todos os cookies da conta no contexto
  const validCookies = cookies.filter(
    (c) => c.name && c.value && c.domain
  );
  await context.addCookies(
    validCookies.map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain.startsWith('.') ? c.domain : '.' + c.domain,
      path: c.path ?? '/',
      secure: c.secure ?? true,
      httpOnly: c.httpOnly ?? false,
      sameSite: (c as any).sameSite ?? 'Lax',
      expires: c.expires && c.expires > 0 ? c.expires : undefined,
    }))
  );

  const sessionId = randomUUID();
  const idleTimer = setTimeout(() => closeSession(sessionId), IDLE_TIMEOUT_MS);

  sessions.set(sessionId, {
    id: sessionId,
    accountId,
    browser,
    context,
    lastUsedAt: Date.now(),
    idleTimer,
  });

  console.log(`[SessionProxy] sessão criada: ${sessionId} (conta ${accountId})`);
  return { sessionId };
}

/**
 * Handler Express para GET /proxy/:sessionId/*
 * Navega até a URL destino dentro do browser autenticado e devolve o HTML.
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

  // Monta a URL destino a partir do path após /proxy/:sessionId
  const rawPath = (req.params as any)[0] ?? '';
  const targetUrl = rawPath
    ? (rawPath.startsWith('http') ? rawPath : `https://drivers.uber.com/${rawPath}`)
    : 'https://drivers.uber.com/';

  try {
    const page = await session.context.newPage();

    // Reescreve links absolutos internos para passarem pelo proxy
    await page.route('**/*', (route) => route.continue());

    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });

    // Reescreve hrefs internos da Uber para apontar para o proxy
    const html = await page.evaluate((sid: string) => {
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

    await page.close();

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('X-Session-Id', sessionId);
    res.send(html);
  } catch (err: any) {
    console.error('[SessionProxy] erro ao navegar:', err?.message);
    res.status(500).send(`<h2>Erro ao carregar a página: ${err?.message}</h2>`);
  }
}

/** Retorna lista de sessões ativas (para o painel admin). */
export function listSessions(): { id: string; accountId: string; lastUsedAt: number }[] {
  return Array.from(sessions.values()).map((s) => ({
    id: s.id,
    accountId: s.accountId,
    lastUsedAt: s.lastUsedAt,
  }));
}
