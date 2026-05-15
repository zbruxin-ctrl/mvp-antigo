"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const path_1 = __importDefault(require("path"));
const globalState_1 = require("../state/globalState");
const mockFlow_1 = require("../playwright/mockFlow");
const accountStore = __importStar(require("../store/accountStore"));
const app = (0, express_1.default)();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = 'connect@10';
app.use(express_1.default.json());
app.use(express_1.default.static(path_1.default.join(__dirname, '../../src/frontend')));
globalState_1.globalState.setExecutor(async (config, cycle) => {
    await mockFlow_1.MockPlaywrightFlow.init(config.headless);
    await mockFlow_1.MockPlaywrightFlow.execute(config.cadastroUrl, {
        emailProvider: config.emailProvider ?? 'temp-mail.io',
        tempMailApiKey: config.tempMailApiKey ?? '',
        otpTimeout: config.otpTimeout,
        extraDelay: config.extraDelay,
        inviteCode: config.inviteCode,
    }, cycle);
});
function requireAuth(req, res, next) {
    const auth = req.headers['x-admin-password'];
    if (!auth || auth !== ADMIN_PASSWORD) {
        res.status(401).json({ ok: false, error: 'Não autorizado' });
        return;
    }
    next();
}
function validateConfig(body) {
    const errors = [];
    if ('emailProvider' in body) {
        if (body.emailProvider !== 'temp-mail.io' && body.emailProvider !== 'mail.tm') {
            errors.push('emailProvider deve ser "temp-mail.io" ou "mail.tm"');
        }
    }
    if ('otpTimeout' in body) {
        const v = Number(body.otpTimeout);
        if (isNaN(v) || v < 5000)
            errors.push('otpTimeout deve ser número >= 5000');
        else
            body.otpTimeout = v;
    }
    if ('cycleInterval' in body) {
        const v = Number(body.cycleInterval);
        if (isNaN(v) || v < 1000)
            errors.push('cycleInterval deve ser número >= 1000');
        else
            body.cycleInterval = v;
    }
    if ('extraDelay' in body) {
        const v = Number(body.extraDelay);
        if (isNaN(v) || v < 0)
            errors.push('extraDelay deve ser número >= 0');
        else
            body.extraDelay = v;
    }
    if ('parallelCycles' in body) {
        const v = Number(body.parallelCycles);
        if (isNaN(v) || v < 1 || v > 20)
            errors.push('parallelCycles deve ser número entre 1 e 20');
        else
            body.parallelCycles = v;
    }
    if ('headless' in body && typeof body.headless !== 'boolean') {
        body.headless = body.headless === 'true' || body.headless === true;
    }
    if ('cadastroUrl' in body && body.cadastroUrl && typeof body.cadastroUrl !== 'string') {
        errors.push('cadastroUrl deve ser string');
    }
    if ('proxies' in body && body.proxies !== undefined && !Array.isArray(body.proxies)) {
        errors.push('proxies deve ser array');
    }
    if (errors.length > 0)
        return { ok: false, error: errors.join('; ') };
    return { ok: true, data: body };
}
app.get('/api/status', (_req, res) => { res.json(globalState_1.globalState.getState()); });
app.get('/api/logs', (_req, res) => { res.json(globalState_1.globalState.getLogs()); });
app.get('/api/kyc', (_req, res) => { res.json(globalState_1.globalState.getKycState()); });
app.get('/api/accounts', requireAuth, (_req, res) => {
    res.json({ accounts: accountStore.list() });
});
app.post('/api/logs/clear', requireAuth, (_req, res) => {
    globalState_1.globalState.clearLogs();
    res.json({ ok: true });
});
app.post('/api/config', requireAuth, (req, res) => {
    const result = validateConfig(req.body);
    if (!result.ok) {
        res.status(400).json({ ok: false, error: result.error });
        return;
    }
    globalState_1.globalState.updateConfig(result.data);
    res.json({ ok: true });
});
app.post('/api/start', requireAuth, (req, res) => {
    if (req.body?.config) {
        const result = validateConfig(req.body.config);
        if (!result.ok) {
            res.status(400).json({ ok: false, error: result.error });
            return;
        }
        globalState_1.globalState.updateConfig(result.data);
    }
    globalState_1.globalState.startLoop();
    res.json({ ok: true });
});
app.post('/api/start-once', requireAuth, (req, res) => {
    if (req.body?.config) {
        const result = validateConfig(req.body.config);
        if (!result.ok) {
            res.status(400).json({ ok: false, error: result.error });
            return;
        }
        globalState_1.globalState.updateConfig(result.data);
    }
    globalState_1.globalState.startOnce();
    res.json({ ok: true });
});
app.post('/api/stop', requireAuth, (_req, res) => {
    globalState_1.globalState.stop();
    res.json({ ok: true });
});
app.post('/api/kyc/clear', requireAuth, (_req, res) => {
    globalState_1.globalState.clearKycState();
    res.json({ ok: true });
});
app.delete('/api/accounts/:id', requireAuth, (req, res) => {
    const removed = accountStore.remove(req.params.id);
    res.json({ ok: removed });
});
app.listen(PORT, () => {
    console.log(`🚀 Server rodando em http://localhost:${PORT}`);
});
async function gracefulShutdown(signal) {
    console.log(`\n🛑 Recebido ${signal} — encerrando graciosamente...`);
    await mockFlow_1.MockPlaywrightFlow.cleanup();
    process.exit(0);
}
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
//# sourceMappingURL=index.js.map