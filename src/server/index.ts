import express, { Request, Response, NextFunction } from 'express';
import path from 'path';
import { globalState } from '../state/globalState';
import { MockPlaywrightFlow } from '../playwright/mockFlow';
import { Config, EmailProvider } from '../types/index';

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

const VALID_EMAIL_PROVIDERS: EmailProvider[] = ['temp-mail.io', 'mail.tm', 'tempmailc'];

app.use(express.json());
app.use(express.static(path.join(__dirname, '../frontend')));

globalState.setExecutor(async (config, cycle) => {
  await MockPlaywrightFlow.init(config.headless);
  await MockPlaywrightFlow.execute(
    config.cadastroUrl,
    {
      emailProvider:   config.emailProvider   ?? 'temp-mail.io',
      tempMailApiKey:  config.tempMailApiKey  ?? '',
      tempmailcDomain: config.tempmailcDomain,
      otpTimeout:      config.otpTimeout,
      extraDelay:      config.extraDelay,
      inviteCode:      config.inviteCode,
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

// ── GET /api/state ──────────────────────────────────────────────────────────
app.get('/api/state', requireAuth, (_req, res) => {
  res.json(globalState.getState());
});

// ── GET /api/logs ───────────────────────────────────────────────────────────
app.get('/api/logs', requireAuth, (_req, res) => {
  res.json(globalState.getLogs());
});

// ── POST /api/config ────────────────────────────────────────────────────────
app.post('/api/config', requireAuth, (req, res) => {
  const body = req.body as Partial<Config>;
  const errors: string[] = [];

  if ('emailProvider' in body) {
    if (!VALID_EMAIL_PROVIDERS.includes(body.emailProvider as any)) {
      errors.push(`emailProvider deve ser um de: ${VALID_EMAIL_PROVIDERS.join(', ')}`);
    }
  }
  if ('parallelCycles' in body) {
    const v = Number(body.parallelCycles);
    if (!Number.isInteger(v) || v < 1 || v > 10) {
      errors.push('parallelCycles deve ser inteiro entre 1 e 10');
    }
  }
  if ('otpTimeout' in body) {
    const v = Number(body.otpTimeout);
    if (!Number.isFinite(v) || v < 10000) {
      errors.push('otpTimeout deve ser >= 10000 ms');
    }
  }

  if (errors.length > 0) {
    res.status(400).json({ ok: false, errors });
    return;
  }

  globalState.updateConfig(body);
  res.json({ ok: true });
});

// ── POST /api/start ─────────────────────────────────────────────────────────
app.post('/api/start', requireAuth, async (req, res) => {
  const state = globalState.getState();
  if (state.isRunning) {
    res.status(409).json({ ok: false, error: 'Já em execução' });
    return;
  }

  const body = req.body as { cycles?: number; loop?: boolean };
  const loop = Boolean(body.loop ?? false);

  if (loop) {
    await globalState.startLoop();
  } else {
    await globalState.startOnce();
  }

  res.json({ ok: true });
});

// ── POST /api/stop ──────────────────────────────────────────────────────────
app.post('/api/stop', requireAuth, (_req, res) => {
  globalState.stop();
  res.json({ ok: true });
});

// ── POST /api/cleanup ───────────────────────────────────────────────────────
app.post('/api/cleanup', requireAuth, async (_req, res) => {
  try {
    await MockPlaywrightFlow.cleanup();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// ── GET /api/screenshot/:cycle ──────────────────────────────────────────────
app.get('/api/screenshot/:cycle', requireAuth, (req, res) => {
  const cycle = Number(req.params.cycle);
  const screenshotPath = path.join(__dirname, '../../artifacts/screenshots', `cycle-${cycle}-latest.png`);
  res.sendFile(screenshotPath, (err) => {
    if (err) res.status(404).json({ ok: false, error: 'Screenshot não encontrado' });
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Server rodando na porta ${PORT}`);
  console.log(`🔑 Admin password: ${ADMIN_PASSWORD}`);
});
