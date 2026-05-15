"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.globalState = void 0;
exports.parseProxyString = parseProxyString;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function kycLevel(score) {
    if (score >= 8)
        return 'CONFIRMED';
    if (score >= 4)
        return 'LIKELY';
    return 'WEAK';
}
// ─── Helpers de proxy ─────────────────────────────────────────────────────────
/**
 * Parseia uma string de proxy nos formatos:
 *   http://user:pass@host:port          ← formato principal (DataImpulse etc.)
 *   socks5://user:pass@host:port
 *   host:port
 *   host:port:user:pass
 *
 * Usa regex própria para extrair user/pass — evita bugs do new URL() com
 * usernames que contêm '__', '.' ou outros caracteres especiais.
 */
function parseProxyString(raw) {
    raw = raw.trim();
    if (!raw)
        return null;
    // Formato: scheme://user:pass@host:port  ou  scheme://host:port
    const schemeMatch = raw.match(/^(https?|socks[45]):\/\/(?:([^:@]+):([^@]*)@)?([^:/]+):(\d+)\s*$/i);
    if (schemeMatch) {
        const [, scheme, user, pass, host, port] = schemeMatch;
        return {
            server: `${scheme}://${host}:${port}`,
            username: user || undefined,
            password: pass || undefined,
        };
    }
    // Formato legado: host:port  ou  host:port:user:pass
    const parts = raw.split(':');
    if (parts.length === 2) {
        return { server: `http://${parts[0]}:${parts[1]}` };
    }
    if (parts.length === 4) {
        return {
            server: `http://${parts[0]}:${parts[1]}`,
            username: parts[2],
            password: parts[3],
        };
    }
    return null;
}
// ─── GlobalState ──────────────────────────────────────────────────────────────
class GlobalState {
    constructor() {
        this.state = {
            isRunning: false,
            isLoop: false,
            cyclesCompleted: 0,
            cyclesTotal: 0,
            activeParallel: 0,
            status: 'STOPPED',
            config: {
                cadastroUrl: '',
                tempMailApiKey: '',
                emailProvider: 'mail.tm',
                inviteCode: '',
                otpTimeout: 90000,
                cycleInterval: 60000,
                extraDelay: 2000,
                parallelCycles: 1,
                headless: true,
                proxies: [],
            },
            shouldStop: false,
        };
        this.logs = [];
        this.currentCycle = 0;
        this.executor = null;
        // KYC isolado por ciclo
        this.kycByCycle = {};
        // Payload de cadastro por ciclo
        this.payloadByCycle = {};
    }
    // ─── Payload API ─────────────────────────────────────────────────────────────
    setPayload(cycle, payload) {
        this.payloadByCycle[cycle] = payload;
    }
    getPayload(cycle) {
        return this.payloadByCycle[cycle];
    }
    clearPayload(cycle) {
        delete this.payloadByCycle[cycle];
    }
    // ─── Proxy API ───────────────────────────────────────────────────────────────
    getProxyForCycle(cycle) {
        const proxies = this.state.config.proxies;
        if (!proxies || proxies.length === 0)
            return undefined;
        const idx = (cycle - 1) % proxies.length;
        const proxy = proxies[idx];
        this.addLog('info', `🌐 Proxy #${idx + 1}/${proxies.length}: ${proxy.server}${proxy.username ? ` (auth: ${proxy.username})` : ''}`, cycle);
        return proxy;
    }
    // ─── KYC API ─────────────────────────────────────────────────────────────────
    addKycSignal(provider, source, weight, cycle, url) {
        if (!this.kycByCycle[cycle])
            this.kycByCycle[cycle] = {};
        const cycleMap = this.kycByCycle[cycle];
        if (!cycleMap[provider])
            cycleMap[provider] = { score: 0, level: 'WEAK', signals: [] };
        const p = cycleMap[provider];
        p.score += weight;
        p.level = kycLevel(p.score);
        const signal = {
            provider,
            source,
            weight,
            cycle,
            url: url?.substring(0, 120),
            time: new Date().toLocaleTimeString('pt-BR'),
        };
        p.signals.unshift(signal);
        if (p.signals.length > 20)
            p.signals = p.signals.slice(0, 20);
        const urlShort = url ? ` | ${url.substring(0, 60)}` : '';
        this.addLog('kyc', `[${provider}] ${p.level} — score=${p.score} via ${source} (+${weight})${urlShort}`, cycle);
    }
    getKycSignals(cycle) {
        const cycleMap = this.kycByCycle[cycle];
        if (!cycleMap)
            return [];
        const result = [];
        for (const state of Object.values(cycleMap))
            result.push(...state.signals);
        return result;
    }
    getKycState() {
        return { byCycle: this.kycByCycle };
    }
    clearKycState() {
        this.kycByCycle = {};
    }
    // ─── Core API ────────────────────────────────────────────────────────────────
    setExecutor(fn) {
        this.executor = fn;
    }
    getState() {
        return { ...this.state };
    }
    getLogs() {
        return [...this.logs];
    }
    clearLogs() {
        this.logs = [];
    }
    updateConfig(config) {
        this.state.config = { ...this.state.config, ...config };
        this.addLog('info', 'Configuração atualizada');
    }
    addLog(level, message, cycle) {
        this.logs.unshift({ timestamp: new Date().toISOString(), level, message, cycle });
    }
    stop() {
        if (this.state.status === 'RUNNING' || this.state.status === 'WAITING_OTP') {
            this.state.shouldStop = true;
            this.state.isLoop = false;
            this.state.status = 'STOPPING';
            this.addLog('warn', '🛑 Parando após ciclo atual...', this.currentCycle);
        }
        else {
            this.state.isRunning = false;
            this.state.isLoop = false;
            this.state.shouldStop = true;
            this.state.status = 'STOPPED';
            this.addLog('info', '⏹️ Processo parado', this.currentCycle);
        }
    }
    async startLoop() {
        if (this.state.isRunning) {
            this.addLog('warn', '⚠️ Já está rodando');
            return;
        }
        this.state.isLoop = true;
        this.state.shouldStop = false;
        this.state.status = 'STARTING';
        this.addLog('info', '🔄 Loop iniciado', 0);
        void this.runLoop(true);
    }
    async startOnce() {
        if (this.state.isRunning) {
            this.addLog('warn', '⚠️ Já está rodando');
            return;
        }
        this.state.isLoop = false;
        this.state.shouldStop = false;
        this.state.status = 'STARTING';
        this.addLog('info', '▶️ Ciclo único iniciado', 0);
        void this.runLoop(false);
    }
    async runLoop(loop) {
        do {
            await this.executeBatch();
            if (loop && !this.state.shouldStop) {
                this.addLog('info', `⏳ Aguardando ${Math.round(this.state.config.cycleInterval / 1000)}s para próximo ciclo...`);
                await sleep(this.state.config.cycleInterval);
            }
        } while (loop && !this.state.shouldStop);
        if (!this.state.isLoop || this.state.shouldStop) {
            this.state.status = 'STOPPED';
            this.state.isRunning = false;
            this.state.shouldStop = false;
            this.state.activeParallel = 0;
            this.addLog('info', '⏹️ Processo finalizado');
        }
    }
    async executeBatch() {
        const n = Math.max(1, this.state.config.parallelCycles || 1);
        this.state.isRunning = true;
        this.state.status = 'RUNNING';
        this.addLog('info', `⚡ Iniciando lote de ${n} ciclo(s) em paralelo...`);
        const promises = Array.from({ length: n }, () => {
            this.currentCycle += 1;
            this.state.cyclesTotal += 1;
            this.state.activeParallel += 1;
            const cycle = this.currentCycle;
            return this.executeCycleWithRetry(cycle).finally(() => {
                this.state.activeParallel = Math.max(0, this.state.activeParallel - 1);
            });
        });
        await Promise.allSettled(promises);
    }
    async executeCycleWithRetry(cycle) {
        const MAX_RETRIES = 3;
        const BACKOFF = [0, 5000, 15000];
        let lastError = 'Erro desconhecido';
        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            if (this.state.shouldStop) {
                this.addLog('info', `🛑 Ciclo #${cycle} interrompido (shouldStop)`, cycle);
                return;
            }
            const backoff = BACKOFF[attempt - 1] ?? 15000;
            if (backoff > 0) {
                this.addLog('warn', `⏳ Retry #${attempt} em ${backoff / 1000}s...`, cycle);
                const end = Date.now() + backoff;
                while (Date.now() < end) {
                    if (this.state.shouldStop) {
                        this.addLog('info', `🛑 Ciclo #${cycle} interrompido durante backoff`, cycle);
                        return;
                    }
                    await sleep(Math.min(500, end - Date.now()));
                }
            }
            try {
                this.addLog('info', attempt === 1
                    ? `🚀 Iniciando ciclo #${cycle}`
                    : `🔁 Ciclo #${cycle} — tentativa ${attempt}/${MAX_RETRIES}`, cycle);
                if (!this.executor)
                    throw new Error('Nenhum executor registrado.');
                await this.executor(this.state.config, cycle);
                this.state.cyclesCompleted += 1;
                this.addLog('success', `✅ Ciclo #${cycle} concluído!`, cycle);
                return;
            }
            catch (error) {
                lastError = error instanceof Error ? error.message : 'Erro desconhecido';
                if (this.state.shouldStop || lastError.includes('Parado pelo usuário')) {
                    this.addLog('info', `🛑 Ciclo #${cycle} encerrado pelo usuário`, cycle);
                    return;
                }
                this.addLog('error', `❌ Tentativa ${attempt}/${MAX_RETRIES} falhou: ${lastError}`, cycle);
                await sleep(2000);
            }
        }
        this.state.status = 'ERROR';
        this.state.lastError = lastError;
        this.addLog('error', `💀 Ciclo #${cycle} falhou após ${MAX_RETRIES} tentativas: ${lastError}`, cycle);
    }
}
exports.globalState = new GlobalState();
//# sourceMappingURL=globalState.js.map