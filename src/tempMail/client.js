"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.MailTmClient = exports.TempMailClient = void 0;
exports.createEmailClient = createEmailClient;
const node_fetch_1 = __importDefault(require("node-fetch"));
const globalState_1 = require("../state/globalState");
const otpParser_1 = require("../utils/otpParser");
// ────────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────────
function isStopped() {
    return !!globalState_1.globalState.getState().shouldStop;
}
async function sleep(ms) {
    const step = 300;
    const end = Date.now() + ms;
    while (Date.now() < end) {
        if (isStopped())
            throw new Error('Parado pelo usu\u00e1rio');
        await new Promise(r => setTimeout(r, Math.min(step, end - Date.now())));
    }
}
async function safeFetch(url, options) {
    const { timeoutMs = 15000, ...fetchOpts } = options;
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await (0, node_fetch_1.default)(url, { ...fetchOpts, signal: controller.signal });
        clearTimeout(tid);
        return res;
    }
    catch {
        clearTimeout(tid);
        return null;
    }
}
async function withRetry(label, fn, maxAttempts = 3, baseDelayMs = 2000) {
    let lastErr;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        if (isStopped())
            throw new Error('Parado pelo usu\u00e1rio');
        try {
            return await fn();
        }
        catch (e) {
            if (e instanceof Error && e.message.includes('Parado'))
                throw e;
            lastErr = e;
            const delay = baseDelayMs * attempt;
            globalState_1.globalState.addLog('warn', `\u26a0\ufe0f ${label} \u2014 tentativa ${attempt}/${maxAttempts} falhou, aguardando ${delay / 1000}s...`);
            if (attempt < maxAttempts)
                await sleep(delay);
        }
    }
    throw lastErr;
}
// ────────────────────────────────────────────────────────────────────────────────
// Dom\u00ednios do plano Starter (tempmailc.com)
// ────────────────────────────────────────────────────────────────────────────────
const TEMPMAILC_DOMAINS = ['nuivo.org', 'rumsee.com'];
// ────────────────────────────────────────────────────────────────────────────────
// TempMailClient  (temp-mail.io)
// ────────────────────────────────────────────────────────────────────────────────
class TempMailClient {
    constructor(apiKey) {
        this.config = { apiKey, baseUrl: 'https://api.temp-mail.io' };
    }
    async request(endpoint, method = 'GET') {
        const url = `${this.config.baseUrl}${endpoint}`;
        const headers = {
            'Content-Type': 'application/json',
            'X-API-Key': this.config.apiKey,
        };
        const res = await safeFetch(url, { method, headers });
        if (!res)
            throw new Error(`Temp-Mail ${endpoint}: erro de rede/timeout`);
        if (!res.ok) {
            const text = await res.text().catch(() => String(res.status));
            throw new Error(`Temp-Mail ${res.status}: ${text}`);
        }
        const text = await res.text();
        return text ? JSON.parse(text) : {};
    }
    async createRandomEmail() {
        globalState_1.globalState.addLog('info', '\ud83d\udce7 [temp-mail.io] Criando email tempor\u00e1rio...');
        const data = await withRetry('temp-mail.io createEmail', () => this.request('/v1/emails', 'POST'));
        globalState_1.globalState.addLog('info', `\u2705 [temp-mail.io] Email criado: ${data.email}`);
        return { email: data.email, token: data.email };
    }
    async listMessages(email) {
        const data = await this.request(`/v1/emails/${encodeURIComponent(email)}/messages`);
        return (data.messages ?? []).map(m => ({
            mail_id: m.id,
            mail_from: m.from,
            mail_to: email,
            mail_subject: m.subject,
            mail_preview: '',
            mail_html: '',
            mail_text: '',
            created_at: m.created_at,
        }));
    }
    async getFullMessage(messageId) {
        return this.request(`/v1/messages/${messageId}`);
    }
    async waitForOTP(email, timeoutMs = 90000, cycle) {
        const startTime = Date.now();
        let lastMessageCount = 0;
        const POLL_INTERVAL_MS = 6000;
        const INITIAL_WAIT_MS = 8000;
        globalState_1.globalState.addLog('info', `\u23f3 [temp-mail.io] Aguardando OTP (${Math.round(timeoutMs / 1000)}s)...`, cycle);
        await sleep(INITIAL_WAIT_MS);
        while (Date.now() - startTime < timeoutMs) {
            if (isStopped())
                throw new Error('Parado pelo usu\u00e1rio');
            try {
                const messages = await withRetry('temp-mail.io listMessages', () => this.listMessages(email), 3, 1500);
                if (messages.length > lastMessageCount) {
                    globalState_1.globalState.addLog('info', `\ud83d\udce8 [temp-mail.io] ${messages.length} mensagem(s) \u2014 verificando OTP...`, cycle);
                    for (const message of messages.slice(lastMessageCount).reverse()) {
                        try {
                            const full = await withRetry('temp-mail.io getFullMessage', () => this.getFullMessage(message.mail_id), 3, 1500);
                            const mailMsg = { ...message, mail_text: full.body_text ?? '', mail_html: full.body_html ?? '' };
                            const otp = await otpParser_1.OTPParser.extractFromMessageAsync(mailMsg);
                            if (otp) {
                                globalState_1.globalState.addLog('success', `\ud83c\udf89 [temp-mail.io] OTP encontrado: ${otp}`, cycle);
                                return otp;
                            }
                        }
                        catch { /* mensagem individual falhou \u2014 continua */ }
                    }
                    lastMessageCount = messages.length;
                }
                else {
                    globalState_1.globalState.addLog('info', `\ud83d\udcad [temp-mail.io] Sem mensagens novas \u2014 pr\u00f3ximo poll em ${POLL_INTERVAL_MS / 1000}s`, cycle);
                }
            }
            catch (e) {
                if (e instanceof Error && e.message.includes('Parado'))
                    throw e;
                globalState_1.globalState.addLog('warn', `\u26a0\ufe0f [temp-mail.io] Erro no poll: ${e instanceof Error ? e.message : e}`, cycle);
            }
            await sleep(POLL_INTERVAL_MS);
        }
        throw new Error(`\u23f0 Timeout aguardando OTP temp-mail.io (${Math.round(timeoutMs / 1000)}s)`);
    }
}
exports.TempMailClient = TempMailClient;
// ────────────────────────────────────────────────────────────────────────────────
// MailTmClient  (mail.tm)
// ────────────────────────────────────────────────────────────────────────────────
class MailTmClient {
    constructor() {
        this.baseUrl = 'https://api.mail.tm';
        this.authToken = null;
        this.accountEmail = null;
        this.accountPassword = null;
    }
    generatePassword() {
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$';
        let pwd = '';
        for (let i = 0; i < 16; i++)
            pwd += chars[Math.floor(Math.random() * chars.length)];
        return pwd;
    }
    async request(endpoint, method = 'GET', body, auth = false) {
        const url = `${this.baseUrl}${endpoint}`;
        const headers = { 'Content-Type': 'application/json' };
        if (auth && this.authToken)
            headers['Authorization'] = `Bearer ${this.authToken}`;
        const res = await safeFetch(url, {
            method,
            headers,
            body: body ? JSON.stringify(body) : undefined,
        });
        if (!res)
            throw new Error(`Mail.tm ${endpoint}: erro de rede/timeout`);
        if (res.status === 401 && auth) {
            globalState_1.globalState.addLog('warn', '\ud83d\udd11 [mail.tm] Token expirado \u2014 reautenticando...');
            await this.relogin();
            const headers2 = { 'Content-Type': 'application/json' };
            if (this.authToken)
                headers2['Authorization'] = `Bearer ${this.authToken}`;
            const res2 = await safeFetch(url, {
                method,
                headers: headers2,
                body: body ? JSON.stringify(body) : undefined,
            });
            if (!res2 || !res2.ok) {
                const errText = res2 ? await res2.text().catch(() => '') : 'null';
                throw new Error(`Mail.tm ${res2?.status ?? 'null'}: ${errText}`);
            }
            const t2 = await res2.text();
            return t2 ? JSON.parse(t2) : {};
        }
        if (!res.ok) {
            const text = await res.text().catch(() => String(res.status));
            throw new Error(`Mail.tm ${res.status}: ${text}`);
        }
        const text = await res.text();
        return text ? JSON.parse(text) : {};
    }
    async relogin() {
        if (!this.accountEmail || !this.accountPassword) {
            throw new Error('Mail.tm: credenciais n\u00e3o dispon\u00edveis para relogin');
        }
        const tokenResp = await withRetry('mail.tm relogin', () => this.request('/token', 'POST', {
            address: this.accountEmail,
            password: this.accountPassword,
        }));
        this.authToken = tokenResp.token;
        globalState_1.globalState.addLog('info', '\u2705 [mail.tm] Reautenticado com sucesso');
    }
    async createRandomEmail() {
        globalState_1.globalState.addLog('info', '\ud83d\udce7 [mail.tm] Buscando dom\u00ednios dispon\u00edveis...');
        const domainsResp = await withRetry('mail.tm getDomains', () => this.request('/domains?page=1'));
        const domains = domainsResp['hydra:member']?.filter(d => d.isActive);
        if (!domains || domains.length === 0)
            throw new Error('Mail.tm: nenhum dom\u00ednio dispon\u00edvel');
        const domain = domains[Math.floor(Math.random() * domains.length)].domain;
        const localPart = 'user' + Math.random().toString(36).slice(2, 10);
        const address = `${localPart}@${domain}`;
        const password = this.generatePassword();
        globalState_1.globalState.addLog('info', `\ud83d\udce7 [mail.tm] Criando conta: ${address}`);
        await withRetry('mail.tm createAccount', () => this.request('/accounts', 'POST', { address, password }));
        const tokenResp = await withRetry('mail.tm getToken', () => this.request('/token', 'POST', { address, password }));
        this.authToken = tokenResp.token;
        this.accountEmail = address;
        this.accountPassword = password;
        globalState_1.globalState.addLog('info', `\u2705 [mail.tm] Conta criada e autenticada: ${address}`);
        return { email: address, token: tokenResp.token };
    }
    async listMessages() {
        const resp = await this.request('/messages?page=1', 'GET', undefined, true);
        return resp['hydra:member'] ?? [];
    }
    async getFullMessage(id) {
        const resp = await this.request(`/messages/${id}`, 'GET', undefined, true);
        const html = Array.isArray(resp.html) ? resp.html.join('\n') : (resp.html ?? '');
        const text = (typeof resp.text === 'string' && resp.text.trim().length > 0)
            ? resp.text
            : (resp.intro ?? '');
        return { html, text };
    }
    async waitForOTP(email, timeoutMs = 90000, cycle) {
        const startTime = Date.now();
        let lastMessageCount = 0;
        const POLL_INTERVAL_MS = 5000;
        const INITIAL_WAIT_MS = 6000;
        globalState_1.globalState.addLog('info', `\u23f3 [mail.tm] Aguardando OTP para ${email} (${Math.round(timeoutMs / 1000)}s)...`, cycle);
        if (!this.authToken)
            throw new Error('Mail.tm: n\u00e3o autenticado \u2014 chame createRandomEmail() primeiro');
        globalState_1.globalState.addLog('info', `\u23f3 [mail.tm] Espera inicial de ${INITIAL_WAIT_MS / 1000}s...`, cycle);
        await sleep(INITIAL_WAIT_MS);
        let tentativaPoll = 0;
        while (Date.now() - startTime < timeoutMs) {
            if (isStopped())
                throw new Error('Parado pelo usu\u00e1rio');
            tentativaPoll++;
            globalState_1.globalState.addLog('info', `\ud83d\udd04 [mail.tm] Poll #${tentativaPoll} \u2014 buscando mensagens...`, cycle);
            try {
                const messages = await withRetry('mail.tm listMessages', () => this.listMessages(), 3, 1500);
                globalState_1.globalState.addLog('info', `\ud83d\udcec [mail.tm] ${messages.length} mensagem(s) (anterior: ${lastMessageCount})`, cycle);
                if (messages.length > lastMessageCount) {
                    const novas = messages.slice(lastMessageCount);
                    globalState_1.globalState.addLog('info', `\ud83d\udce8 [mail.tm] ${novas.length} mensagem(s) nova(s) \u2014 verificando OTP...`, cycle);
                    for (const msg of novas.reverse()) {
                        globalState_1.globalState.addLog('info', `\ud83d\udce7 [mail.tm] Lendo: "${msg.subject}" de ${msg.from.address}`, cycle);
                        try {
                            const full = await withRetry('mail.tm getFullMessage', () => this.getFullMessage(msg.id), 3, 1500);
                            const mailMsg = {
                                mail_id: msg.id,
                                mail_from: msg.from.address,
                                mail_to: email,
                                mail_subject: msg.subject,
                                mail_preview: '',
                                mail_html: full.html,
                                mail_text: full.text,
                                created_at: msg.createdAt,
                            };
                            const otp = await otpParser_1.OTPParser.extractFromMessageAsync(mailMsg);
                            if (otp) {
                                globalState_1.globalState.addLog('success', `\ud83c\udf89 [mail.tm] OTP encontrado: ${otp}`, cycle);
                                return otp;
                            }
                            globalState_1.globalState.addLog('warn', `\u26a0\ufe0f [mail.tm] Nenhum OTP extra\u00eddo de "${msg.subject}"`, cycle);
                        }
                        catch (e) {
                            globalState_1.globalState.addLog('warn', `\u26a0\ufe0f [mail.tm] Erro ao ler mensagem ${msg.id}: ${e instanceof Error ? e.message : e}`, cycle);
                        }
                    }
                    lastMessageCount = messages.length;
                }
                else {
                    globalState_1.globalState.addLog('info', `\ud83d\udcad [mail.tm] Sem mensagens novas \u2014 pr\u00f3ximo poll em ${POLL_INTERVAL_MS / 1000}s`, cycle);
                }
            }
            catch (e) {
                if (e instanceof Error && e.message.includes('Parado'))
                    throw e;
                globalState_1.globalState.addLog('warn', `\u26a0\ufe0f [mail.tm] Erro no poll #${tentativaPoll}: ${e instanceof Error ? e.message : e}`, cycle);
            }
            await sleep(POLL_INTERVAL_MS);
        }
        throw new Error(`\u23f0 Timeout aguardando OTP mail.tm (${Math.round(timeoutMs / 1000)}s)`);
    }
}
exports.MailTmClient = MailTmClient;
// ────────────────────────────────────────────────────────────────────────────────
// TempMailCClient  (tempmailc.com \u2014 plano Starter)
// Dom\u00ednios: nuivo.org e rumsee.com (rota\u00e7\u00e3o aleat\u00f3ria)
// ────────────────────────────────────────────────────────────────────────────────
class TempMailCClient {
    constructor(apiCode) {
        this.baseUrl = 'https://private.tempmailc.com';
        this.apiCode = apiCode;
    }
    pickDomain() {
        return TEMPMAILC_DOMAINS[Math.floor(Math.random() * TEMPMAILC_DOMAINS.length)];
    }
    async createRandomEmail() {
        const domain = this.pickDomain();
        const localPart = 'user' + Math.random().toString(36).slice(2, 10);
        const email = `${localPart}@${domain}`;
        globalState_1.globalState.addLog('info', `\u2705 [tempmailc] Email gerado: ${email}`);
        return { email, token: email };
    }
    async waitForOTP(email, timeoutMs = 180000, cycle) {
        const startTime = Date.now();
        const POLL_INTERVAL_MS = 4000;
        const INITIAL_WAIT_MS = 6000;
        globalState_1.globalState.addLog('info', `\u23f3 [tempmailc] Aguardando OTP para ${email} (${Math.round(timeoutMs / 1000)}s)...`, cycle);
        await sleep(INITIAL_WAIT_MS);
        let tentativaPoll = 0;
        let lastCode = '';
        while (Date.now() - startTime < timeoutMs) {
            if (isStopped())
                throw new Error('Parado pelo usu\u00e1rio');
            tentativaPoll++;
            globalState_1.globalState.addLog('info', `\ud83d\udd04 [tempmailc] Poll #${tentativaPoll} \u2014 verificando OTP...`, cycle);
            try {
                const reqUrl = `${this.baseUrl}/api/v1/code?email=${encodeURIComponent(email)}&code=${encodeURIComponent(this.apiCode)}`;
                const res = await safeFetch(reqUrl, { method: 'GET', timeoutMs: 10000 });
                if (!res) {
                    globalState_1.globalState.addLog('warn', `\u26a0\ufe0f [tempmailc] Poll #${tentativaPoll}: erro de rede`, cycle);
                } else if (!res.ok) {
                    const errText = await res.text().catch(() => String(res.status));
                    globalState_1.globalState.addLog('warn', `\u26a0\ufe0f [tempmailc] Poll #${tentativaPoll}: HTTP ${res.status} \u2014 ${errText}`, cycle);
                } else {
                    const body = JSON.parse(await res.text());
                    if (body.status === 'ok' && body.code && body.code !== lastCode) {
                        globalState_1.globalState.addLog('success', `\ud83c\udf89 [tempmailc] OTP encontrado: ${body.code}`, cycle);
                        return body.code;
                    }
                    if (body.status === 'empty' || !body.code) {
                        globalState_1.globalState.addLog('info', `\ud83d\udcad [tempmailc] Sem c\u00f3digo ainda \u2014 pr\u00f3ximo poll em ${POLL_INTERVAL_MS / 1000}s`, cycle);
                    }
                    lastCode = body.code ?? lastCode;
                }
            } catch (e) {
                if (e instanceof Error && e.message.includes('Parado'))
                    throw e;
                globalState_1.globalState.addLog('warn', `\u26a0\ufe0f [tempmailc] Erro no poll #${tentativaPoll}: ${e instanceof Error ? e.message : e}`, cycle);
            }
            await sleep(POLL_INTERVAL_MS);
        }
        throw new Error(`\u23f0 Timeout aguardando OTP tempmailc (${Math.round(timeoutMs / 1000)}s)`);
    }
}
function createEmailClient(provider, apiKey) {
    if (provider === 'tempmailc') {
        if (!apiKey)
            throw new Error('tempmailc requer um API code (apiKey)');
        return new TempMailCClient(apiKey);
    }
    if (provider === 'mail.tm')
        return new MailTmClient();
    return new TempMailClient(apiKey);
}
//# sourceMappingURL=client.js.map
