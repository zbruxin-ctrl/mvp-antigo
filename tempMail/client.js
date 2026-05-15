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
            throw new Error('Parado pelo usuário');
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
            throw new Error('Parado pelo usuário');
        try {
            return await fn();
        }
        catch (e) {
            if (e instanceof Error && e.message.includes('Parado'))
                throw e;
            lastErr = e;
            const delay = baseDelayMs * attempt;
            globalState_1.globalState.addLog('warn', `⚠️ ${label} — tentativa ${attempt}/${maxAttempts} falhou, aguardando ${delay / 1000}s...`);
            if (attempt < maxAttempts)
                await sleep(delay);
        }
    }
    throw lastErr;
}
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
        globalState_1.globalState.addLog('info', '📧 [temp-mail.io] Criando email temporário...');
        const data = await withRetry('temp-mail.io createEmail', () => this.request('/v1/emails', 'POST'));
        globalState_1.globalState.addLog('info', `✅ [temp-mail.io] Email criado: ${data.email}`);
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
        globalState_1.globalState.addLog('info', `⏳ [temp-mail.io] Aguardando OTP (${Math.round(timeoutMs / 1000)}s)...`, cycle);
        await sleep(INITIAL_WAIT_MS);
        while (Date.now() - startTime < timeoutMs) {
            if (isStopped())
                throw new Error('Parado pelo usuário');
            try {
                const messages = await withRetry('temp-mail.io listMessages', () => this.listMessages(email), 3, 1500);
                if (messages.length > lastMessageCount) {
                    globalState_1.globalState.addLog('info', `📨 [temp-mail.io] ${messages.length} mensagem(s) — verificando OTP...`, cycle);
                    for (const message of messages.slice(lastMessageCount).reverse()) {
                        try {
                            const full = await withRetry('temp-mail.io getFullMessage', () => this.getFullMessage(message.mail_id), 3, 1500);
                            const mailMsg = { ...message, mail_text: full.body_text ?? '', mail_html: full.body_html ?? '' };
                            const otp = await otpParser_1.OTPParser.extractFromMessageAsync(mailMsg);
                            if (otp) {
                                globalState_1.globalState.addLog('success', `🎉 [temp-mail.io] OTP encontrado: ${otp}`, cycle);
                                return otp;
                            }
                        }
                        catch { /* mensagem individual falhou — continua */ }
                    }
                    lastMessageCount = messages.length;
                }
                else {
                    globalState_1.globalState.addLog('info', `📭 [temp-mail.io] Sem mensagens novas — próximo poll em ${POLL_INTERVAL_MS / 1000}s`, cycle);
                }
            }
            catch (e) {
                if (e instanceof Error && e.message.includes('Parado'))
                    throw e;
                globalState_1.globalState.addLog('warn', `⚠️ [temp-mail.io] Erro no poll: ${e instanceof Error ? e.message : e}`, cycle);
            }
            await sleep(POLL_INTERVAL_MS);
        }
        throw new Error(`⏰ Timeout aguardando OTP temp-mail.io (${Math.round(timeoutMs / 1000)}s)`);
    }
}
exports.TempMailClient = TempMailClient;
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
            globalState_1.globalState.addLog('warn', '🔑 [mail.tm] Token expirado — reautenticando...');
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
            throw new Error('Mail.tm: credenciais não disponíveis para relogin');
        }
        const tokenResp = await withRetry('mail.tm relogin', () => this.request('/token', 'POST', {
            address: this.accountEmail,
            password: this.accountPassword,
        }));
        this.authToken = tokenResp.token;
        globalState_1.globalState.addLog('info', '✅ [mail.tm] Reautenticado com sucesso');
    }
    async createRandomEmail() {
        globalState_1.globalState.addLog('info', '📧 [mail.tm] Buscando domínios disponíveis...');
        const domainsResp = await withRetry('mail.tm getDomains', () => this.request('/domains?page=1'));
        const domains = domainsResp['hydra:member']?.filter(d => d.isActive);
        if (!domains || domains.length === 0)
            throw new Error('Mail.tm: nenhum domínio disponível');
        const domain = domains[Math.floor(Math.random() * domains.length)].domain;
        const localPart = 'user' + Math.random().toString(36).slice(2, 10);
        const address = `${localPart}@${domain}`;
        const password = this.generatePassword();
        globalState_1.globalState.addLog('info', `📧 [mail.tm] Criando conta: ${address}`);
        await withRetry('mail.tm createAccount', () => this.request('/accounts', 'POST', { address, password }));
        const tokenResp = await withRetry('mail.tm getToken', () => this.request('/token', 'POST', { address, password }));
        this.authToken = tokenResp.token;
        this.accountEmail = address;
        this.accountPassword = password;
        globalState_1.globalState.addLog('info', `✅ [mail.tm] Conta criada e autenticada: ${address}`);
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
        globalState_1.globalState.addLog('info', `⏳ [mail.tm] Aguardando OTP para ${email} (${Math.round(timeoutMs / 1000)}s)...`, cycle);
        if (!this.authToken)
            throw new Error('Mail.tm: não autenticado — chame createRandomEmail() primeiro');
        globalState_1.globalState.addLog('info', `⏳ [mail.tm] Espera inicial de ${INITIAL_WAIT_MS / 1000}s...`, cycle);
        await sleep(INITIAL_WAIT_MS);
        let tentativaPoll = 0;
        while (Date.now() - startTime < timeoutMs) {
            if (isStopped())
                throw new Error('Parado pelo usuário');
            tentativaPoll++;
            globalState_1.globalState.addLog('info', `🔄 [mail.tm] Poll #${tentativaPoll} — buscando mensagens...`, cycle);
            try {
                const messages = await withRetry('mail.tm listMessages', () => this.listMessages(), 3, 1500);
                globalState_1.globalState.addLog('info', `📬 [mail.tm] ${messages.length} mensagem(s) (anterior: ${lastMessageCount})`, cycle);
                if (messages.length > lastMessageCount) {
                    const novas = messages.slice(lastMessageCount);
                    globalState_1.globalState.addLog('info', `📨 [mail.tm] ${novas.length} mensagem(s) nova(s) — verificando OTP...`, cycle);
                    for (const msg of novas.reverse()) {
                        globalState_1.globalState.addLog('info', `📧 [mail.tm] Lendo: "${msg.subject}" de ${msg.from.address}`, cycle);
                        try {
                            const full = await withRetry('mail.tm getFullMessage', () => this.getFullMessage(msg.id), 3, 1500);
                            globalState_1.globalState.addLog('info', `📄 [mail.tm] html(300): ${full.html.slice(0, 300)}`, cycle);
                            globalState_1.globalState.addLog('info', `📄 [mail.tm] text(300): ${full.text.slice(0, 300)}`, cycle);
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
                            // extractFromMessageAsync resolve iframes antes de extrair
                            const otp = await otpParser_1.OTPParser.extractFromMessageAsync(mailMsg);
                            if (otp) {
                                globalState_1.globalState.addLog('success', `🎉 [mail.tm] OTP encontrado: ${otp}`, cycle);
                                return otp;
                            }
                            globalState_1.globalState.addLog('warn', `⚠️ [mail.tm] Nenhum OTP extraído de "${msg.subject}"`, cycle);
                        }
                        catch (e) {
                            globalState_1.globalState.addLog('warn', `⚠️ [mail.tm] Erro ao ler mensagem ${msg.id}: ${e instanceof Error ? e.message : e}`, cycle);
                        }
                    }
                    lastMessageCount = messages.length;
                }
                else {
                    globalState_1.globalState.addLog('info', `📭 [mail.tm] Sem mensagens novas — próximo poll em ${POLL_INTERVAL_MS / 1000}s`, cycle);
                }
            }
            catch (e) {
                if (e instanceof Error && e.message.includes('Parado'))
                    throw e;
                globalState_1.globalState.addLog('warn', `⚠️ [mail.tm] Erro no poll #${tentativaPoll}: ${e instanceof Error ? e.message : e}`, cycle);
            }
            await sleep(POLL_INTERVAL_MS);
        }
        throw new Error(`⏰ Timeout aguardando OTP mail.tm (${Math.round(timeoutMs / 1000)}s)`);
    }
}
exports.MailTmClient = MailTmClient;
function createEmailClient(provider, apiKey) {
    if (provider === 'mail.tm')
        return new MailTmClient();
    if (!apiKey)
        throw new Error('temp-mail.io requer uma API key');
    return new TempMailClient(apiKey);
}
//# sourceMappingURL=client.js.map