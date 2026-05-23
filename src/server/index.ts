import express, { Request, Response, NextFunction } from 'express';
import path from 'path';
import { globalState, parseProxyString } from '../state/globalState';
import { MockPlaywrightFlow } from '../playwright/mockFlow';
import { diagnoseUberForm } from '../playwright/diagnose';
import * as accountStore from '../store/accountStore';
import * as sessionProxy from '../proxy/sessionProxy';
import { Config, CycleProfile } from '../types';
import type { Cookie } from 'playwright';

const app = express();
const PORT = 3000;

const ADMIN_PASSWORD = 'connect@10';
const CADASTRO_URL = 'https://bonjour.uber.com';

app.use(express.json());

// ── CORS ─────────────────────────────────────────────
app.use((req: Request, res: Response, next: NextFunction) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-password');
  if (req.method === 'OPTIONS') { res.sendStatus(204); return; }
  next();
});

const FRONTEND_DIR = path.resolve(__dirname, '../frontend');
app.use(express.static(FRONTEND_DIR));

// ── SSE ─────────────────────────────────────────────
const sseClients = new Set<Response>();

export function broadcastSSE(event: string, data: unknown): void {
  if (sseClients.size === 0) return;
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); } catch { sseClients.delete(res); }
  }
}

app.get('/api/events', (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  sseClients.add(res);

  res.write(`event: state\ndata: ${JSON.stringify(globalState.getState())}\n\n`);
  res.write(`event: kyc\ndata: ${JSON.stringify(globalState.getKycState())}\n\n`);
  res.write(`event: cycleStatus\ndata: ${JSON.stringify(globalState.getCycleStatusMap())}\n\n`);
  res.write(`event: profiles\ndata: ${JSON.stringify(globalState.getProfiles())}\n\n`);

  const keepAlive = setInterval(() => {
    try { res.write(':ping\n\n'); } catch { clearInterval(keepAlive); sseClients.delete(res); }
  }, 25_000);

  req.on('close', () => {
    clearInterval(keepAlive);
    sseClients.delete(res);
  });
});

// ── Patch globalState ─────────────────────────────────────────
const _origAddLog = globalState.addLog.bind(globalState);
globalState.addLog = function(level, message, cycle) {
  _origAddLog(level, message, cycle);
  broadcastSSE('log', { timestamp: new Date().toISOString(), level, message, cycle });
  broadcastSSE('state', globalState.getState());
  broadcastSSE('cycleStatus', globalState.getCycleStatusMap());
};

const _origAddKycSignal = globalState.addKycSignal.bind(globalState);
globalState.addKycSignal = function(provider, source, weight, cycle, url) {
  _origAddKycSignal(provider, source, weight, cycle, url);

  broadcastSSE('kyc', globalState.getKycState());
  broadcastSSE('state', globalState.getState());

  const entry = globalState.getKycByCycleEntry(cycle);
  if (entry && entry[provider]) {
    const provState = entry[provider]!;
    if (provState.level === 'LIKELY' || provState.level === 'CONFIRMED') {
      const lastUrl = provState.signals.find(s => s.url)?.url;
      broadcastSSE('kycAlert', {
        cycle,
        provider,
        level: provState.level,
        url: lastUrl,
      });
    }
  }
};

const _origSetCycleStep = globalState.setCycleStep.bind(globalState);
globalState.setCycleStep = function(cycle, step, stepLabel) {
  _origSetCycleStep(cycle, step, stepLabel);
  broadcastSSE('cycleStatus', globalState.getCycleStatusMap());
};

// ── Executor ────────────────────────────────────────────
globalState.setExecutor(async (config, cycle) => {
  await MockPlaywrightFlow.init(config.headless);
  await MockPlaywrightFlow.execute(
    CADASTRO_URL,
    {
      emailProvider:  config.emailProvider  ?? 'tempmailc',
      tempMailApiKey: config.tempMailApiKey ?? '',
      otpTimeout:     config.otpTimeout,
      extraDelay:     config.extraDelay,
      inviteCode:     config.inviteCode,
      cityName:       config.cityName,
    },
    cycle
  );
});

function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const auth = req.headers['x-admin-password'];
  if (!auth || auth !== ADMIN_PASSWORD) {
    res.status(401).json({ ok: false, error: 'Não autorizado' });
    return;
  }
  next();
}

const VALID_EMAIL_PROVIDERS = ['tempmailc', 'temp-mail.io', 'mail.tm'];

function validateConfig(body: Partial<Config> & { proxyServer?: string; proxyUser?: string; proxyPass?: string; proxiesRaw?: string[] }): { ok: true; data: Partial<Config> } | { ok: false; error: string } {
  const errors: string[] = [];

  if (Array.isArray((body as any).proxiesRaw)) {
    const lines: string[] = (body as any).proxiesRaw;
    body.proxies = lines
      .map(l => parseProxyString(l))
      .filter((p): p is NonNullable<typeof p> => p !== null);
    delete (body as any).proxiesRaw;
  }

  if (body.proxyServer !== undefined || body.proxyUser !== undefined || body.proxyPass !== undefined) {
    const server   = (body.proxyServer ?? '').trim();
    const username = (body.proxyUser   ?? '').trim() || undefined;
    const password = (body.proxyPass   ?? '').trim() || undefined;

    if (server) {
      const parsed = parseProxyString(server);
      if (parsed) {
        body.proxies = [{
          server:   parsed.server,
          username: username ?? parsed.username,
          password: password ?? parsed.password,
        }];
      } else {
        body.proxies = [{ server, username, password }];
      }
    } else {
      body.proxies = [];
    }

    delete (body as any).proxyServer;
    delete (body as any).proxyUser;
    delete (body as any).proxyPass;
  }

  delete (body as any).cadastroUrl;

  if ('emailProvider' in body) {
    if (!VALID_EMAIL_PROVIDERS.includes(body.emailProvider as string)) {
      errors.push(`emailProvider deve ser um de: ${VALID_EMAIL_PROVIDERS.join(', ')}`);
    }
  }
  if ('otpTimeout' in body) {
    const v = Number(body.otpTimeout);
    if (isNaN(v) || v < 5000) errors.push('otpTimeout deve ser número >= 5000');
    else body.otpTimeout = v;
  }
  if ('cycleInterval' in body) {
    const v = Number(body.cycleInterval);
    if (isNaN(v) || v < 1000) errors.push('cycleInterval deve ser número >= 1000');
    else body.cycleInterval = v;
  }
  if ('extraDelay' in body) {
    const v = Number(body.extraDelay);
    if (isNaN(v) || v < 0) errors.push('extraDelay deve ser número >= 0');
    else body.extraDelay = v;
  }
  if ('parallelCycles' in body) {
    const v = Number(body.parallelCycles);
    if (isNaN(v) || v < 1 || v > 20) errors.push('parallelCycles deve ser número entre 1 e 20');
    else body.parallelCycles = v;
  }
  if ('headless' in body && typeof body.headless !== 'boolean') {
    body.headless = body.headless === 'true' || (body.headless as unknown) === true;
  }
  if ('proxies' in body && body.proxies !== undefined && !Array.isArray(body.proxies)) {
    errors.push('proxies deve ser array');
  }
  if ('cityName' in body && body.cityName !== undefined) {
    body.cityName = String(body.cityName).trim() || undefined;
  }

  if (errors.length > 0) return { ok: false, error: errors.join('; ') };
  return { ok: true, data: body };
}

function validateProfile(raw: Record<string, unknown>): { ok: true; data: CycleProfile } | { ok: false; error: string } {
  const errors: string[] = [];
  const profile: CycleProfile = {};

  if ('label' in raw && raw.label !== undefined) {
    profile.label = String(raw.label).trim() || undefined;
  }
  if ('inviteCode' in raw && raw.inviteCode !== undefined) {
    profile.inviteCode = String(raw.inviteCode).trim() || undefined;
  }
  if ('cityName' in raw && raw.cityName !== undefined) {
    profile.cityName = String(raw.cityName).trim() || undefined;
  }
  if ('emailProvider' in raw && raw.emailProvider !== undefined) {
    const ep = String(raw.emailProvider).trim();
    if (!VALID_EMAIL_PROVIDERS.includes(ep)) {
      errors.push(`emailProvider deve ser: ${VALID_EMAIL_PROVIDERS.join(', ')}`);
    } else {
      profile.emailProvider = ep as CycleProfile['emailProvider'];
    }
  }
  if ('tempMailApiKey' in raw && raw.tempMailApiKey !== undefined) {
    profile.tempMailApiKey = String(raw.tempMailApiKey).trim() || undefined;
  }
  if ('tempmailcDomain' in raw && raw.tempmailcDomain !== undefined) {
    profile.tempmailcDomain = String(raw.tempmailcDomain).trim() || undefined;
  }
  if ('extraDelay' in raw && raw.extraDelay !== undefined) {
    const v = Number(raw.extraDelay);
    if (isNaN(v) || v < 0) errors.push('extraDelay deve ser >= 0');
    else profile.extraDelay = v;
  }
  if ('proxiesRaw' in raw && Array.isArray(raw.proxiesRaw)) {
    profile.proxies = (raw.proxiesRaw as string[])
      .map(l => parseProxyString(l))
      .filter((p): p is NonNullable<typeof p> => p !== null);
  } else if ('proxies' in raw && Array.isArray(raw.proxies)) {
    profile.proxies = raw.proxies as CycleProfile['proxies'];
  }

  if (errors.length > 0) return { ok: false, error: errors.join('; ') };
  return { ok: true, data: profile };
}

// ── Rotas de leitura ─────────────────────────────────────
app.get('/api/status',       (_req, res) => { res.json(globalState.getState()); });
app.get('/api/logs',         (_req, res) => { res.json(globalState.getLogs()); });
app.get('/api/kyc',          (_req, res) => { res.json(globalState.getKycState()); });
app.get('/api/cycle-status', (_req, res) => { res.json(globalState.getCycleStatusMap()); });
app.get('/api/config',       requireAuth, (_req, res) => { res.json(globalState.getState().config); });
app.get('/api/accounts',     requireAuth, (_req, res) => {
  res.json({ accounts: accountStore.list() });
});

// ── GET /api/accounts/:id/script ─────────────────────────────
// Retorna o userscript Tampermonkey como texto puro para o frontend
// copiar direto para o clipboard (sem Content-Disposition attachment
// que causaria diálogo de download em vez de permitir o fetch/clipboard).
app.get('/api/accounts/:id/script', requireAuth, (req: Request, res: Response) => {
  const account = accountStore.regenScript(req.params.id);
  if (!account) {
    res.status(404).json({ ok: false, error: 'Conta não encontrada' });
    return;
  }

  const script = account.tampermonkeyScript ?? '';

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.send(script);
});

// ── Session Proxy routes ─────────────────────────────────

/**
 * POST /api/accounts/:id/session
 * Abre um browser Playwright com os cookies da conta e retorna o sessionId.
 * O usuário deve navegar para GET /proxy/:sessionId/ para acessar o Uber logado.
 */
app.post('/api/accounts/:id/session', requireAuth, async (req: Request, res: Response) => {
  const account = accountStore.list().find((a) => a.id === req.params.id);
  if (!account) {
    res.status(404).json({ ok: false, error: 'Conta não encontrada' });
    return;
  }
  try {
    const { sessionId } = await sessionProxy.createSession(
      account.id,
      (account.cookies ?? []) as Cookie[]
    );
    res.json({
      ok: true,
      sessionId,
      url: `/proxy/${sessionId}/`,
    });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err?.message ?? String(err) });
  }
});

/**
 * DELETE /api/sessions/:sessionId
 * Encerra uma sessão proxy manualmente.
 */
app.delete('/api/sessions/:sessionId', requireAuth, async (req: Request, res: Response) => {
  await sessionProxy.closeSession(req.params.sessionId);
  res.json({ ok: true });
});

/**
 * GET /api/sessions
 * Lista sessões ativas.
 */
app.get('/api/sessions', requireAuth, (_req: Request, res: Response) => {
  res.json({ sessions: sessionProxy.listSessions() });
});

/**
 * GET /proxy/:sessionId/*
 * Proxy reverso: navega dentro do browser autenticado e devolve o HTML.
 */
app.get('/proxy/:sessionId/*', (req: Request, res: Response) => {
  sessionProxy.proxyHandler(req, res);
});

// ── Profile endpoints ─────────────────────────────────
app.get('/api/profiles', requireAuth, (_req, res) => {
  res.json({ profiles: globalState.getProfiles() });
});

app.post('/api/profiles', requireAuth, (req, res) => {
  const raw = req.body;
  if (!Array.isArray(raw?.profiles)) {
    res.status(400).json({ ok: false, error: 'Body deve ser { profiles: CycleProfile[] }' });
    return;
  }

  const validated: CycleProfile[] = [];
  for (let i = 0; i < raw.profiles.length; i++) {
    const result = validateProfile(raw.profiles[i] as Record<string, unknown>);
    if (!result.ok) {
      res.status(400).json({ ok: false, error: `Perfil #${i + 1}: ${result.error}` });
      return;
    }
    validated.push(result.data);
  }

  globalState.setProfiles(validated);
  broadcastSSE('profiles', globalState.getProfiles());
  res.json({ ok: true, count: validated.length });
});

app.put('/api/profiles/:index', requireAuth, (req, res) => {
  const idx = parseInt(req.params.index, 10);
  const profiles = [...globalState.getProfiles()];

  if (isNaN(idx) || idx < 0 || idx >= profiles.length) {
    res.status(404).json({ ok: false, error: 'Índice de perfil inválido' });
    return;
  }

  const result = validateProfile(req.body as Record<string, unknown>);
  if (!result.ok) {
    res.status(400).json({ ok: false, error: result.error });
    return;
  }

  profiles[idx] = { ...profiles[idx], ...result.data };
  globalState.setProfiles(profiles);
  broadcastSSE('profiles', globalState.getProfiles());
  res.json({ ok: true });
});

app.delete('/api/profiles/:index', requireAuth, (req, res) => {
  const idx = parseInt(req.params.index, 10);
  const profiles = [...globalState.getProfiles()];

  if (isNaN(idx) || idx < 0 || idx >= profiles.length) {
    res.status(404).json({ ok: false, error: 'Índice de perfil inválido' });
    return;
  }

  profiles.splice(idx, 1);
  globalState.setProfiles(profiles);
  broadcastSSE('profiles', globalState.getProfiles());
  res.json({ ok: true });
});

// ─────────────────────────────────────────────────────────────
app.post('/api/diagnose', requireAuth, async (req: Request, res: Response) => {
  const url: string = req.body?.url ?? CADASTRO_URL;
  try {
    const result = await diagnoseUberForm(url);
    res.json({ ok: true, ...result });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err?.message ?? String(err) });
  }
});

app.delete('/api/logs', requireAuth, (_req, res) => {
  globalState.clearLogs();
  res.json({ ok: true });
});

app.delete('/api/kyc', requireAuth, (_req, res) => {
  globalState.clearKycState();
  res.json({ ok: true });
});

app.post('/api/config', requireAuth, (req, res) => {
  const result = validateConfig(req.body);
  if (!result.ok) { res.status(400).json({ ok: false, error: result.error }); return; }
  globalState.updateConfig(result.data);
  res.json({ ok: true });
});

app.post('/api/start', requireAuth, (req, res) => {
  if (req.body?.config) {
    const result = validateConfig(req.body.config);
    if (!result.ok) { res.status(400).json({ ok: false, error: result.error }); return; }
    globalState.updateConfig(result.data);
  }
  globalState.startLoop();
  res.json({ ok: true });
});

app.post('/api/start-once', requireAuth, (req, res) => {
  if (req.body?.config) {
    const result = validateConfig(req.body.config);
    if (!result.ok) { res.status(400).json({ ok: false, error: result.error }); return; }
    globalState.updateConfig(result.data);
  }
  globalState.startOnce();
  res.json({ ok: true });
});

app.post('/api/run-once', requireAuth, (req, res) => {
  if (req.body?.config) {
    const result = validateConfig(req.body.config);
    if (!result.ok) { res.status(400).json({ ok: false, error: result.error }); return; }
    globalState.updateConfig(result.data);
  }
  globalState.startOnce();
  res.json({ ok: true });
});

app.post('/api/stop', requireAuth, (_req, res) => {
  globalState.stop();
  res.json({ ok: true });
});

app.delete('/api/accounts/:id', requireAuth, (req, res) => {
  const removed = accountStore.remove(req.params.id);
  res.json({ ok: removed });
});

app.get('*', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.sendFile(path.join(FRONTEND_DIR, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`\n🚀 Servidor rodando em http://localhost:${PORT}`);
  console.log(`🔑 Senha do painel: connect@10\n`);
  console.log(`📁 Frontend dir: ${FRONTEND_DIR}`);
});

async function gracefulShutdown(signal: string) {
  console.log(`\n🛑 Recebido ${signal} — encerrando graciosamente...`);
  await sessionProxy.closeAllSessions();
  await MockPlaywrightFlow.cleanup();
  process.exit(0);
}

process.on('SIGINT',  () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
