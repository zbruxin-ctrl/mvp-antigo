import express, { Request, Response, NextFunction } from 'express';
import path from 'path';
import { globalState, parseProxyString } from '../state/globalState';
import { MockPlaywrightFlow } from '../playwright/mockFlow';
import { diagnoseUberForm } from '../playwright/diagnose';
import * as accountStore from '../store/accountStore';
import { Config } from '../types';

const app = express();
const PORT = 3000;

const ADMIN_PASSWORD = 'connect@10';
const CADASTRO_URL = 'https://bonjour.uber.com';

app.use(express.json());

// ── CORS ──────────────────────────────────────────────────────
app.use((req: Request, res: Response, next: NextFunction) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-password');
  if (req.method === 'OPTIONS') { res.sendStatus(204); return; }
  next();
});

const FRONTEND_DIR = path.resolve(__dirname, '../frontend');
app.use(express.static(FRONTEND_DIR));

// ── SSE ───────────────────────────────────────────────────────
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
  res.write(`event: cycles\ndata: ${JSON.stringify(globalState.getCycleStatuses())}\n\n`);

  const keepAlive = setInterval(() => {
    try { res.write(':ping\n\n'); } catch { clearInterval(keepAlive); sseClients.delete(res); }
  }, 25_000);

  req.on('close', () => {
    clearInterval(keepAlive);
    sseClients.delete(res);
  });
});

// ── Patch globalState para broadcast automático ───────────────
const _origAddLog = globalState.addLog.bind(globalState);
globalState.addLog = function(level, message, cycle) {
  _origAddLog(level, message, cycle);
  broadcastSSE('log', { timestamp: new Date().toISOString(), level, message, cycle });
  broadcastSSE('state', globalState.getState());
};

const _origAddKycSignal = globalState.addKycSignal.bind(globalState);
globalState.addKycSignal = function(provider, source, weight, cycle, url) {
  _origAddKycSignal(provider, source, weight, cycle, url);
  broadcastSSE('kyc', globalState.getKycState());
  broadcastSSE('state', globalState.getState());
};

// Patch setCycleStatus para broadcast automático do painel de ciclos
const _origSetCycleStatus = globalState.setCycleStatus.bind(globalState);
globalState.setCycleStatus = function(cycle, step, done, failed) {
  _origSetCycleStatus(cycle, step, done, failed);
  broadcastSSE('cycles', globalState.getCycleStatuses());
};

// ── Executor ─────────────────────────────────────────────────
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

app.get('/api/status',   (_req, res) => { res.json(globalState.getState()); });
app.get('/api/logs',     (_req, res) => { res.json(globalState.getLogs()); });
app.get('/api/kyc',      (_req, res) => { res.json(globalState.getKycState()); });
app.get('/api/cycles',   (_req, res) => { res.json(globalState.getCycleStatuses()); });
app.get('/api/config',   requireAuth, (_req, res) => { res.json(globalState.getState().config); });
app.get('/api/accounts', requireAuth, (_req, res) => {
  res.json({ accounts: accountStore.list() });
});

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
  await MockPlaywrightFlow.cleanup();
  process.exit(0);
}

process.on('SIGINT',  () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
