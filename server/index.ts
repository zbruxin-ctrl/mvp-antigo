import express, { Request, Response, NextFunction } from 'express';
import path from 'path';
import { globalState } from '../state/globalState';
import { MockPlaywrightFlow } from '../playwright/mockFlow';
import * as accountStore from '../store/accountStore';
import { Config } from '../types';

const app = express();
const PORT = process.env.PORT || 3000;

const ADMIN_PASSWORD = 'connect@10';

app.use(express.json());
app.use(express.static(path.join(__dirname, '../../src/frontend')));

globalState.setExecutor(async (config, cycle) => {
  await MockPlaywrightFlow.init(config.headless);
  await MockPlaywrightFlow.execute(
    config.cadastroUrl,
    {
      emailProvider:  config.emailProvider  ?? 'temp-mail.io',
      tempMailApiKey: config.tempMailApiKey ?? '',
      otpTimeout:     config.otpTimeout,
      extraDelay:     config.extraDelay,
      inviteCode:     config.inviteCode,
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

function validateConfig(body: Partial<Config>): { ok: true; data: Partial<Config> } | { ok: false; error: string } {
  const errors: string[] = [];

  if ('emailProvider' in body) {
    if (body.emailProvider !== 'temp-mail.io' && body.emailProvider !== 'mail.tm') {
      errors.push('emailProvider deve ser "temp-mail.io" ou "mail.tm"');
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
  if ('cadastroUrl' in body && body.cadastroUrl && typeof body.cadastroUrl !== 'string') {
    errors.push('cadastroUrl deve ser string');
  }
  if ('proxies' in body && body.proxies !== undefined && !Array.isArray(body.proxies)) {
    errors.push('proxies deve ser array');
  }

  if (errors.length > 0) return { ok: false, error: errors.join('; ') };
  return { ok: true, data: body };
}

app.get('/api/status',   (_req, res) => { res.json(globalState.getState()); });
app.get('/api/logs',     (_req, res) => { res.json(globalState.getLogs()); });
app.get('/api/kyc',      (_req, res) => { res.json(globalState.getKycState()); });
app.get('/api/accounts', requireAuth, (_req, res) => {
  res.json({ accounts: accountStore.list() });
});

app.post('/api/logs/clear', requireAuth, (_req, res) => {
  globalState.clearLogs();
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

app.post('/api/stop', requireAuth, (_req, res) => {
  globalState.stop();
  res.json({ ok: true });
});

app.post('/api/kyc/clear', requireAuth, (_req, res) => {
  globalState.clearKycState();
  res.json({ ok: true });
});

app.delete('/api/accounts/:id', requireAuth, (req, res) => {
  const removed = accountStore.remove(req.params.id);
  res.json({ ok: removed });
});

app.listen(PORT, () => {
  console.log(`🚀 Server rodando em http://localhost:${PORT}`);
});

async function gracefulShutdown(signal: string) {
  console.log(`\n🛑 Recebido ${signal} — encerrando graciosamente...`);
  await MockPlaywrightFlow.cleanup();
  process.exit(0);
}

process.on('SIGINT',  () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
