"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const path_1 = __importDefault(require("path"));
const globalState_1 = require("../state/globalState");
const mockFlow_1 = require("../playwright/mockFlow");
const accountStore = require("../store/accountStore");
const app = (0, express_1.default)();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = 'connect@10';
app.use(express_1.default.json());
app.use(express_1.default.static(path_1.default.join(__dirname, '../../src/frontend')));
// ─── SSE ──────────────────────────────────────────────────────────────────────
app.get('/api/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
    const iv = setInterval(() => {
        send({
            state: globalState_1.globalState.getState(),
            logs: globalState_1.globalState.getLogs().slice(0, 50),
            cycleStatus: globalState_1.globalState.getCycleStatusMap(),
        });
    }, 800);
    req.on('close', () => clearInterval(iv));
});
// ─── Executor ─────────────────────────────────────────────────────────────────
globalState_1.globalState.setExecutor(async (config, cycle) => {
    await mockFlow_1.MockPlaywrightFlow.init(config.headless);
    await mockFlow_1.MockPlaywrightFlow.execute(config.cadastroUrl || 'https://bonjour.uber.com/', {
        emailProvider: config.emailProvider ?? 'tempmailc',
        tempMailApiKey: config.tempMailApiKey ?? '',
        otpTimeout: config.otpTimeout,
        extraDelay: config.extraDelay,
        inviteCode: config.inviteCode,
        cityName: config.cityName,
    }, cycle);
});
// ─── Auth ─────────────────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
    const auth = req.headers['x-admin-password'];
    if (!auth || auth !== ADMIN_PASSWORD) {
        res.status(401).json({ ok: false, error: 'N\u00e3o autorizado' });
        return;
    }
    next();
}
// ─── Validação de config ──────────────────────────────────────────────────────
const VALID_EMAIL_PROVIDERS = ['temp-mail.io', 'mail.tm', 'tempmailc'];
function validateConfig(body) {
    const errors = [];
    // FIX: converte proxiesRaw (array de strings) → proxies (array de objetos)
    if (Array.isArray(body.proxiesRaw)) {
        body.proxies = body.proxiesRaw
            .map(l => (0, globalState_1.parseProxyString)(l))
            .filter(Boolean);
        delete body.proxiesRaw;
    }
    // Garante que proxies nunca seja undefined após este ponto
    if (!('proxies' in body)) {
        // campo não enviado — mantém o que já está no state (não sobrescreve)
    } else if (!Array.isArray(body.proxies)) {
        errors.push('proxies deve ser array');
    }
    delete body.cadastroUrl;
    if ('emailProvider' in body) {
        if (!VALID_EMAIL_PROVIDERS.includes(body.emailProvider))
            errors.push(`emailProvider deve ser um de: ${VALID_EMAIL_PROVIDERS.join(', ')}`);
    }
    if ('otpTimeout' in body) {
        const v = Number(body.otpTimeout);
        if (isNaN(v) || v < 5000) errors.push('otpTimeout deve ser n\u00famero >= 5000');
        else body.otpTimeout = v;
    }
    if ('cycleInterval' in body) {
        const v = Number(body.cycleInterval);
        if (isNaN(v) || v < 1000) errors.push('cycleInterval deve ser n\u00famero >= 1000');
        else body.cycleInterval = v;
    }
    if ('extraDelay' in body) {
        const v = Number(body.extraDelay);
        if (isNaN(v) || v < 0) errors.push('extraDelay deve ser n\u00famero >= 0');
        else body.extraDelay = v;
    }
    if ('parallelCycles' in body) {
        const v = Number(body.parallelCycles);
        if (isNaN(v) || v < 1 || v > 20) errors.push('parallelCycles deve ser n\u00famero entre 1 e 20');
        else body.parallelCycles = v;
    }
    if ('headless' in body && typeof body.headless !== 'boolean')
        body.headless = body.headless === 'true' || body.headless === true;
    if ('cityName' in body && body.cityName !== undefined)
        body.cityName = String(body.cityName).trim() || undefined;
    if (errors.length > 0) return { ok: false, error: errors.join('; ') };
    return { ok: true, data: body };
}
// ─── Validação de perfil ──────────────────────────────────────────────────────
function validateProfile(raw) {
    const p = {};
    if (typeof raw.label === 'string') p.label = raw.label.trim() || undefined;
    if (typeof raw.inviteCode === 'string') p.inviteCode = raw.inviteCode.trim() || undefined;
    if (typeof raw.cityName === 'string') p.cityName = raw.cityName.trim() || undefined;
    if (typeof raw.emailProvider === 'string') p.emailProvider = raw.emailProvider;
    if (typeof raw.tempMailApiKey === 'string') p.tempMailApiKey = raw.tempMailApiKey.trim();
    if (typeof raw.tempmailcDomain === 'string') p.tempmailcDomain = raw.tempmailcDomain.trim();
    if (raw.extraDelay !== undefined) { const v = Number(raw.extraDelay); if (!isNaN(v)) p.extraDelay = v; }
    if (Array.isArray(raw.proxiesRaw)) {
        p.proxies = raw.proxiesRaw.map(l => (0, globalState_1.parseProxyString)(l)).filter(Boolean);
    } else if (Array.isArray(raw.proxies)) {
        p.proxies = raw.proxies;
    } else {
        p.proxies = [];
    }
    return p;
}
// ─── Rotas públicas ───────────────────────────────────────────────────────────
app.get('/api/status', (_req, res) => res.json(globalState_1.globalState.getState()));
app.get('/api/logs', (_req, res) => res.json(globalState_1.globalState.getLogs()));
app.get('/api/kyc', (_req, res) => res.json(globalState_1.globalState.getKycState()));
app.get('/api/cycle-status', (_req, res) => res.json(globalState_1.globalState.getCycleStatusMap()));
// ─── Rotas autenticadas ───────────────────────────────────────────────────────
app.get('/api/config', requireAuth, (_req, res) => res.json(globalState_1.globalState.getState().config));
app.get('/api/accounts', requireAuth, (_req, res) => res.json(accountStore.getAll ? accountStore.getAll() : accountStore.list()));
// Perfis
app.get('/api/profiles', requireAuth, (_req, res) =>
    res.json({ ok: true, profiles: globalState_1.globalState.getProfiles() }));
app.post('/api/profiles', requireAuth, (req, res) => {
    const raw = req.body;
    const arr = Array.isArray(raw) ? raw : (Array.isArray(raw === null || raw === void 0 ? void 0 : raw.profiles) ? raw.profiles : null);
    if (!arr) { res.status(400).json({ ok: false, error: 'Body deve ser array ou {profiles:[]}' }); return; }
    const profiles = arr.map(validateProfile);
    globalState_1.globalState.setProfiles(profiles);
    res.json({ ok: true, profiles });
});
app.put('/api/profiles/:index', requireAuth, (req, res) => {
    const idx = parseInt(req.params.index, 10);
    const profiles = [...globalState_1.globalState.getProfiles()];
    if (isNaN(idx) || idx < 0 || idx >= profiles.length) {
        res.status(404).json({ ok: false, error: 'Perfil n\u00e3o encontrado' }); return;
    }
    profiles[idx] = Object.assign(Object.assign({}, profiles[idx]), validateProfile(req.body));
    globalState_1.globalState.setProfiles(profiles);
    res.json({ ok: true, profile: profiles[idx] });
});
app.delete('/api/profiles/:index', requireAuth, (req, res) => {
    const idx = parseInt(req.params.index, 10);
    const profiles = [...globalState_1.globalState.getProfiles()];
    if (isNaN(idx) || idx < 0 || idx >= profiles.length) {
        res.status(404).json({ ok: false, error: 'Perfil n\u00e3o encontrado' }); return;
    }
    profiles.splice(idx, 1);
    globalState_1.globalState.setProfiles(profiles);
    res.json({ ok: true });
});
// Logs / KYC
app.post('/api/logs/clear', requireAuth, (_req, res) => { globalState_1.globalState.clearLogs(); res.json({ ok: true }); });
app.delete('/api/logs', requireAuth, (_req, res) => { globalState_1.globalState.clearLogs(); res.json({ ok: true }); });
app.post('/api/kyc/clear', requireAuth, (_req, res) => { globalState_1.globalState.clearKycState(); res.json({ ok: true }); });
app.delete('/api/kyc', requireAuth, (_req, res) => { globalState_1.globalState.clearKycState(); res.json({ ok: true }); });
// Config
app.post('/api/config', requireAuth, (req, res) => {
    const result = validateConfig(Object.assign({}, req.body));
    if (!result.ok) { res.status(400).json({ ok: false, error: result.error }); return; }
    globalState_1.globalState.updateConfig(result.data);
    res.json({ ok: true });
});
// Contas
app.delete('/api/accounts/:id', requireAuth, (req, res) => {
    const removed = accountStore.remove(req.params.id);
    res.json({ ok: removed });
});
// Controle
app.post('/api/start', requireAuth, (req, res) => {
    if (req.body && req.body.config) {
        const result = validateConfig(Object.assign({}, req.body.config));
        if (!result.ok) { res.status(400).json({ ok: false, error: result.error }); return; }
        globalState_1.globalState.updateConfig(result.data);
    }
    globalState_1.globalState.startLoop();
    res.json({ ok: true });
});
app.post('/api/start-once', requireAuth, (req, res) => {
    if (req.body && req.body.config) {
        const result = validateConfig(Object.assign({}, req.body.config));
        if (!result.ok) { res.status(400).json({ ok: false, error: result.error }); return; }
        globalState_1.globalState.updateConfig(result.data);
    }
    globalState_1.globalState.startOnce();
    res.json({ ok: true });
});
app.post('/api/run-once', requireAuth, (req, res) => {
    if (req.body && req.body.config) {
        const result = validateConfig(Object.assign({}, req.body.config));
        if (!result.ok) { res.status(400).json({ ok: false, error: result.error }); return; }
        globalState_1.globalState.updateConfig(result.data);
    }
    globalState_1.globalState.startOnce();
    res.json({ ok: true });
});
app.post('/api/stop', requireAuth, (_req, res) => { globalState_1.globalState.stop(); res.json({ ok: true }); });
// Cleanup
async function gracefulShutdown(signal) {
    console.log(`\n\uD83D\uDED1 Recebido ${signal} \u2014 encerrando graciosamente...`);
    await mockFlow_1.MockPlaywrightFlow.cleanup();
    process.exit(0);
}
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
app.listen(PORT, () => console.log(`\uD83D\uDE80 Server rodando em http://localhost:${PORT}`));
