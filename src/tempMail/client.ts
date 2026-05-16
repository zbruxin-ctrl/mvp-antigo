import fetch from 'node-fetch';
import { globalState } from '../state/globalState';
import { EmailProvider } from '../types';

// ────────────────────────────────────────────────────────────────────────────────
// Shared helpers
// ────────────────────────────────────────────────────────────────────────────────

function isStopped(): boolean {
  return !!(globalState.getState() as any).shouldStop;
}

async function sleep(ms: number): Promise<void> {
  const step = 200;
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (isStopped()) throw new Error('Parado pelo usuário');
    await new Promise<void>(r => setTimeout(r, Math.min(step, end - Date.now())));
  }
}

async function withRetry<T>(label: string, fn: () => Promise<T>, tries = 3, delay = 1500): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (e) { last = e; if (i < tries - 1) await sleep(delay); }
  }
  throw last;
}

async function safeFetch(
  url: string,
  opts: { method?: string; body?: string; headers?: Record<string, string>; timeoutMs?: number } = {}
): Promise<Response | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 15000);
  try {
    return await fetch(url, {
      method: opts.method ?? 'GET',
      headers: opts.headers,
      body: opts.body,
      signal: controller.signal,
    }) as unknown as Response;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ────────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────────

export interface EmailAccount {
  email: string;
  token: string;
}

export interface MailMessage {
  id: string;
  from: string;
  subject: string;
  created_at: string;
}

export interface IEmailClient {
  createRandomEmail(): Promise<EmailAccount>;
  waitForOTP(email: string, timeoutMs?: number, cycle?: number): Promise<string>;
}

export interface TempMailConfig {
  apiKey: string;
}

// ────────────────────────────────────────────────────────────────────────────────
// TempMailClient  (temp-mail.io)
// ────────────────────────────────────────────────────────────────────────────────

export class TempMailClient implements IEmailClient {
  private config: TempMailConfig;
  private readonly baseUrl = 'https://api.temp-mail.io';

  constructor(apiKey: string) {
    this.config = { apiKey };
  }

  private async request<T>(path: string, method = 'GET', body?: object): Promise<T> {
    const res = await safeFetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        'X-API-Key': this.config.apiKey,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
      timeoutMs: 15000,
    });
    if (!res) throw new Error('Erro de rede');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json() as Promise<T>;
  }

  async createRandomEmail(): Promise<EmailAccount> {
    const data = await this.request<{ email: string; token: string }>('/v1/email/new', 'POST');
    return { email: data.email, token: data.token };
  }

  private async listMessages(email: string): Promise<MailMessage[]> {
    const data = await this.request<{
      messages: Array<{ id: string; from: string; subject: string; created_at: string }>;
    }>(`/v1/emails/${encodeURIComponent(email)}/messages`);
    return (data.messages ?? []).map(m => ({
      id: m.id,
      from: m.from,
      subject: m.subject,
      created_at: m.created_at,
    }));
  }

  private async getMessage(messageId: string): Promise<{ body_text: string; body_html: string }> {
    return this.request<{ body_text: string; body_html: string }>(`/v1/messages/${messageId}`);
  }

  async waitForOTP(email: string, timeoutMs = 180_000, cycle?: number): Promise<string> {
    const startTime = Date.now();
    const POLL_INTERVAL_MS = 6_000;
    let lastMessageCount = 0;

    while (Date.now() - startTime < timeoutMs) {
      if (isStopped()) throw new Error('Parado pelo usuário');
      try {
        const messages = await withRetry('temp-mail.io listMessages', () => this.listMessages(email), 3, 1500);
        if (messages.length > lastMessageCount) {
          globalState.addLog('info', `📨 [temp-mail.io] ${messages.length} mensagem(s) — verificando OTP...`, cycle);
          for (const message of messages.slice(lastMessageCount).reverse()) {
            try {
              const full = await this.getMessage(message.id);
              const text = full.body_text + ' ' + full.body_html;
              const match = text.match(/\b(\d{4,8})\b/);
              if (match) {
                globalState.addLog('success', `🎉 [temp-mail.io] OTP: ${match[1]}`, cycle);
                return match[1];
              }
            } catch { /* pula mensagem */ }
          }
          lastMessageCount = messages.length;
        } else {
          globalState.addLog('info', `💭 [temp-mail.io] Sem mensagens novas — próximo poll em ${POLL_INTERVAL_MS / 1000}s`, cycle);
        }
      } catch (e) {
        globalState.addLog('warn', `⚠️ [temp-mail.io] Erro no poll: ${e instanceof Error ? e.message : e}`, cycle);
      }
      await sleep(POLL_INTERVAL_MS);
    }
    throw new Error(`⏰ Timeout OTP temp-mail.io (${Math.round(timeoutMs / 1000)}s)`);
  }
}

// ────────────────────────────────────────────────────────────────────────────────
// MailTmClient  (mail.tm)
// ────────────────────────────────────────────────────────────────────────────────

interface MailTmMessageSummary {
  '@id': string;
  id: string;
  from: { address: string; name: string };
  to: Array<{ address: string; name: string }>;
  subject: string;
  intro: string;
  seen: boolean;
  createdAt: string;
}

interface MailTmMessageFull extends MailTmMessageSummary {
  text: string;
  html: string[];
}

export class MailTmClient implements IEmailClient {
  private readonly baseUrl = 'https://api.mail.tm';
  private token: string | null = null;

  private async request<T>(
    path: string,
    method = 'GET',
    body?: object,
    authenticated = false
  ): Promise<T> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (authenticated && this.token) headers['Authorization'] = `Bearer ${this.token}`;
    const res = await safeFetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      timeoutMs: 15000,
    });
    if (!res) throw new Error('Erro de rede');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json() as Promise<T>;
  }

  async createRandomEmail(): Promise<EmailAccount> {
    const domains = await this.request<{ 'hydra:member': Array<{ domain: string }> }>('/domains?page=1');
    const domain = domains['hydra:member'][0]?.domain ?? 'mail.tm';
    const localPart = 'user' + Math.random().toString(36).slice(2, 10);
    const email = `${localPart}@${domain}`;
    const password = 'Pass' + Math.random().toString(36).slice(2, 10) + '!';
    await this.request('/accounts', 'POST', { address: email, password });
    const auth = await this.request<{ token: string }>('/token', 'POST', { address: email, password });
    this.token = auth.token;
    globalState.addLog('info', `✅ [mail.tm] Email gerado: ${email}`);
    return { email, token: auth.token };
  }

  private async listMessages(): Promise<MailTmMessageSummary[]> {
    const resp = await this.request<{ 'hydra:member': MailTmMessageSummary[] }>(
      '/messages?page=1', 'GET', undefined, true
    );
    return resp['hydra:member'] ?? [];
  }

  private async getFullMessage(id: string): Promise<MailTmMessageFull> {
    return this.request<MailTmMessageFull>(`/messages/${id}`, 'GET', undefined, true);
  }

  async waitForOTP(email: string, timeoutMs = 180_000, cycle?: number): Promise<string> {
    const startTime = Date.now();
    const POLL_INTERVAL_MS = 5_000;
    let lastMessageCount = 0;
    let tentativaPoll = 0;

    while (Date.now() - startTime < timeoutMs) {
      if (isStopped()) throw new Error('Parado pelo usuário');
      tentativaPoll++;
      globalState.addLog('info', `🔄 [mail.tm] Poll #${tentativaPoll} — buscando mensagens...`, cycle);
      try {
        const messages = await withRetry('mail.tm listMessages', () => this.listMessages(), 3, 1500);
        if (messages.length > lastMessageCount) {
          const novas = messages.slice(lastMessageCount);
          for (const msg of novas) {
            try {
              const full = await this.getFullMessage(msg.id);
              const text = [full.subject, full.text, ...(full.html ?? [])].join(' ');
              const match = text.match(/\b(\d{4,8})\b/);
              if (match) {
                globalState.addLog('success', `🎉 [mail.tm] OTP: ${match[1]}`, cycle);
                return match[1];
              }
            } catch { /* pula */ }
          }
          lastMessageCount = messages.length;
        } else {
          globalState.addLog('info', `💭 [mail.tm] Sem mensagens novas — próximo poll em ${POLL_INTERVAL_MS / 1000}s`, cycle);
        }
      } catch (e) {
        globalState.addLog('warn', `⚠️ [mail.tm] Erro no poll #${tentativaPoll}: ${e instanceof Error ? e.message : e}`, cycle);
      }
      await sleep(POLL_INTERVAL_MS);
    }
    throw new Error(`⏰ Timeout OTP mail.tm (${Math.round(timeoutMs / 1000)}s)`);
  }
}

// ────────────────────────────────────────────────────────────────────────────────
// TempMailCClient  (tempmailc.com)
// Base URL correto: https://private.tempmailc.com  (conforme documentação)
// Endpoint OTP: GET /api/v1/code?email=X&code=APIKEY
// Domínio fixo: kaamoolzy.it.com (licença trial)
// ────────────────────────────────────────────────────────────────────────────────

export class TempMailCClient implements IEmailClient {
  private readonly baseUrl = 'https://private.tempmailc.com';  // ← corrigido
  private readonly apiCode: string;
  private readonly domain = 'kaamoolzy.it.com';

  constructor(apiCode: string, _fixedDomain?: string) {
    this.apiCode = apiCode;
  }

  async createRandomEmail(): Promise<EmailAccount> {
    const localPart = 'user' + Math.random().toString(36).slice(2, 10);
    const email = `${localPart}@${this.domain}`;
    globalState.addLog('info', `✅ [tempmailc] Email gerado: ${email}`);
    return { email, token: email };
  }

  async waitForOTP(email: string, timeoutMs = 180_000, cycle?: number): Promise<string> {
    const startTime = Date.now();
    const POLL_INTERVAL_MS = 4_000;
    const INITIAL_WAIT_MS  = 6_000;

    globalState.addLog('info', `⏳ [tempmailc] Aguardando OTP para ${email} (${Math.round(timeoutMs / 1000)}s)...`, cycle);
    await sleep(INITIAL_WAIT_MS);

    let tentativaPoll = 0;
    let lastCode = '';

    while (Date.now() - startTime < timeoutMs) {
      if (isStopped()) throw new Error('Parado pelo usuário');

      tentativaPoll++;
      globalState.addLog('info', `🔄 [tempmailc] Poll #${tentativaPoll} — verificando OTP...`, cycle);

      try {
        const reqUrl = `${this.baseUrl}/api/v1/code?email=${encodeURIComponent(email)}&code=${encodeURIComponent(this.apiCode)}`;
        const res = await safeFetch(reqUrl, { method: 'GET', timeoutMs: 10000 });

        if (!res) {
          globalState.addLog('warn', `⚠️ [tempmailc] Poll #${tentativaPoll}: erro de rede`, cycle);
        } else if (!res.ok) {
          const errText = await res.text().catch(() => String(res.status));
          globalState.addLog('warn', `⚠️ [tempmailc] Poll #${tentativaPoll}: HTTP ${res.status} — ${errText}`, cycle);
        } else {
          const body = JSON.parse(await res.text()) as { status: string; code: string };

          if (body.status === 'ok' && body.code && body.code !== lastCode) {
            globalState.addLog('success', `🎉 [tempmailc] OTP encontrado: ${body.code}`, cycle);
            return body.code;
          }

          if (body.status === 'empty' || !body.code) {
            globalState.addLog('info', `💭 [tempmailc] Sem código ainda — próximo poll em ${POLL_INTERVAL_MS / 1000}s`, cycle);
          }

          lastCode = body.code ?? lastCode;
        }
      } catch (e) {
        if (e instanceof Error && e.message.includes('Parado')) throw e;
        globalState.addLog('warn', `⚠️ [tempmailc] Erro no poll #${tentativaPoll}: ${e instanceof Error ? e.message : e}`, cycle);
      }

      await sleep(POLL_INTERVAL_MS);
    }

    throw new Error(`⏰ Timeout aguardando OTP tempmailc (${Math.round(timeoutMs / 1000)}s)`);
  }
}

// ────────────────────────────────────────────────────────────────────────────────
// Factory
// ────────────────────────────────────────────────────────────────────────────────

export function createEmailClient(
  provider: 'temp-mail.io' | 'mail.tm' | 'tempmailc',
  apiKey: string,
  tempmailcDomain?: string
): IEmailClient {
  if (provider === 'tempmailc') {
    if (!apiKey) throw new Error('tempmailc requer um API code (apiKey)');
    return new TempMailCClient(apiKey, tempmailcDomain);
  }
  if (provider === 'mail.tm') return new MailTmClient();
  return new TempMailClient(apiKey);
}
