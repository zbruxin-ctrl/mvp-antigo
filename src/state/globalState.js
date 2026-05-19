"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.globalState = void 0;
exports.parseProxyString = parseProxyString;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function kycLevel(score) {
    if (score >= 8) return 'CONFIRMED';
    if (score >= 4) return 'LIKELY';
    return 'WEAK';
}

function parseProxyString(raw) {
    raw = raw.trim();
    if (!raw) return null;
    const schemeMatch = raw.match(/^(https?|socks[45]):\/\/(?:([^:@]+):([^@]*)@)?([^:/]+):(\d+)\s*$/i);
    if (schemeMatch) {
        const [, scheme, user, pass, host, port] = schemeMatch;
        return {
            server: `${scheme}://${host}:${port}`,
            username: user || undefined,
            password: pass || undefined,
        };
    }
    const parts = raw.split(':');
    if (parts.length === 2) return { server: `http://${parts[0]}:${parts[1]}` };
    if (parts.length === 4) {
        return {
            server: `http://${parts[0]}:${parts[1]}`,
            username: parts[2],
            password: parts[3],
        };
    }
    return null;
}

const MAX_LOG_ENTRIES = 2000;

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
                cadastroUrl: 'https://bonjour.uber.com/',
                tempMailApiKey: 'Z4OHhdpnvUA',
                emailProvider: 'tempmailc',
                inviteCode: '',
                otpTimeout: 90000,
                cycleInterval: 60000,
                extraDelay: 2000,
                parallelCycles: 1,
                headless: true,
                proxies: [],
                profiles: [],
            },
            shouldStop: false,
        };
        this.logs = [];
        this.currentCycle = 0;
        this.executor = null;
        this.kycByCycle = {};
        this.payloadByCycle = {};
        this.cycleStatusMap = {};
    }

    // Profile API
    getProfiles() {
        return this.state.config.profiles ?? [];
    }
    setProfiles(profiles) {
        this.state.config.profiles = profiles;
        this.addLog('info', `\uD83D\uDDC2\uFE0F Perfis atualizados: ${profiles.length} perfil(is)`);
    }

    // FIX ponto 2: proxies do perfil t\u00eam prioridade; ?? [] garante nunca undefined
    getConfigForCycle(cycle) {
        const profiles = this.state.config.profiles;
        if (!profiles || profiles.length === 0) return this.state.config;
        const idx = (cycle - 1) % profiles.length;
        const profile = profiles[idx];
        const merged = { ...this.state.config, ...profile };
        merged.proxies = profile.proxies ?? this.state.config.proxies ?? [];
        return merged;
    }
    getProfileIndexForCycle(cycle) {
        const profiles = this.state.config.profiles;
        if (!profiles || profiles.length === 0) return -1;
        return (cycle - 1) % profiles.length;
    }

    // Cycle Status API
    setCycleStep(cycle, step, stepLabel) {
        const existing = this.cycleStatusMap[cycle];
        if (existing) {
            existing.step = step;
            existing.stepLabel = stepLabel;
            existing.updatedAt = Date.now();
        }
    }
    initCycleStatus(cycle, attempt) {
        const existing = this.cycleStatusMap[cycle];
        const profileIndex = this.getProfileIndexForCycle(cycle);
        const profiles = this.state.config.profiles ?? [];
        const profileLabel = profileIndex >= 0 ? (profiles[profileIndex]?.label ?? `P${profileIndex + 1}`) : undefined;
        this.cycleStatusMap[cycle] = {
            cycle,
            status: attempt === 1 ? 'running' : 'retrying',
            step: 'init',
            stepLabel: attempt === 1 ? 'Iniciando...' : `Retry #${attempt}`,
            startedAt: existing?.startedAt ?? Date.now(),
            updatedAt: Date.now(),
            attempt,
            profileIndex,
            profileLabel,
        };
    }
    finishCycleStatus(cycle, success) {
        const existing = this.cycleStatusMap[cycle];
        if (existing) {
            existing.status = success ? 'done' : 'failed';
            existing.stepLabel = success ? '\u2705 Conclu\u00EDdo' : '\u274C Falhou';
            existing.updatedAt = Date.now();
        }
        setTimeout(() => { delete this.cycleStatusMap[cycle]; }, 10000);
    }
    getCycleStatusMap() {
        return { ...this.cycleStatusMap };
    }
    clearCycleStatus(cycle) {
        delete this.cycleStatusMap[cycle];
    }

    // Payload API
    setPayload(cycle, payload) { this.payloadByCycle[cycle] = payload; }
    getPayload(cycle) { return this.payloadByCycle[cycle]; }
    clearPayload(cycle) { delete this.payloadByCycle[cycle]; }

    // FIX ponto 3: ?? [] garante que proxies nunca cause crash ao acessar .length
    getProxyForCycle(cycle) {
        const effectiveConfig = this.getConfigForCycle(cycle);
        const proxies = effectiveConfig.proxies ?? [];
        if (proxies.length === 0) return undefined;
        const idx = (cycle - 1) % proxies.length;
        return proxies[idx];
    }

    // KYC API
    clearKycCycle(cycle) {
        if (this.kycByCycle[cycle]) delete this.kycByCycle[cycle];
    }
    addKycSignal(provider, source, weight, cycle, url) {
        if (!this.kycByCycle[cycle]) this.kycByCycle[cycle] = {};
        const cycleMap = this.kycByCycle[cycle];
        if (!cycleMap[provider]) cycleMap[provider] = { score: 0, level: 'WEAK', signals: [] };
        const p = cycleMap[provider];
        p.score += weight;
        p.level = kycLevel(p.score);
        const signal = {
            provider, source, weight, cycle,
            url: url?.substring(0, 120),
            time: new Date().toLocaleTimeString('pt-BR'),
        };
        p.signals.unshift(signal);
        if (p.signals.length > 20) p.signals = p.signals.slice(0, 20);
        const urlShort = url ? ` | ${url.substring(0, 60)}` : '';
        this.addLog('kyc', `[${provider}] ${p.level} \u2014 score=${p.score} via ${source} (+${weight})${urlShort}`, cycle);
    }
    getKycSignals(cycle) {
        const cycleMap = this.kycByCycle[cycle];
        if (!cycleMap) return [];
        const sorted = Object.values(cycleMap).sort((a, b) => b.score - a.score);
        const result = [];
        for (const state of sorted) result.push(...state.signals);
        return result;
    }
    getTopKycProvider(cycle) {
        const cycleMap = this.kycByCycle[cycle];
        if (!cycleMap) return null;
        let top = null;
        for (const [provider, state] of Object.entries(cycleMap)) {
            if (!top || state.score > top.score) {
                const lastUrl = state.signals.find(s => s.url)?.url;
                top = { provider, level: state.level, score: state.score, url: lastUrl };
            }
        }
        if (!top) return null;
        return { provider: top.provider, level: top.level, url: top.url };
    }
    getKycByCycleEntry(cycle) { return this.kycByCycle[cycle] ?? null; }
    getKycState() { return { byCycle: this.kycByCycle }; }
    clearKycState() { this.kycByCycle = {}; }
    incrementFailure(reason, cycle) {
        const msg = reason ? `\u274C Falha no ciclo: ${reason}` : '\u274C Falha no ciclo';
        this.addLog('error', msg, cycle);
    }

    // Core API
    setExecutor(fn) { this.executor = fn; }
    getState() { return { ...this.state }; }
    getLogs() { return [...this.logs]; }
    clearLogs() { this.logs = []; }

    // FIX ponto 1: proxies e profiles nunca ficam undefined ap\u00f3s um patch parcial
    updateConfig(config) {
        this.state.config = {
            ...this.state.config,
            ...config,
            proxies:  config.proxies  ?? this.state.config.proxies  ?? [],
            profiles: config.profiles ?? this.state.config.profiles ?? [],
        };
        this.addLog('info', 'Configura\u00E7\u00E3o atualizada');
    }

    addLog(level, message, cycle) {
        this.logs.unshift({ timestamp: new Date().toISOString(), level, message, cycle });
        if (this.logs.length > MAX_LOG_ENTRIES) this.logs = this.logs.slice(0, MAX_LOG_ENTRIES);
    }

    stop() {
        if (this.state.status === 'RUNNING' || this.state.status === 'WAITING_OTP' || this.state.status === 'STOPPING') {
            this.state.shouldStop = true;
            this.state.isLoop = false;
            this.state.status = 'STOPPING';
            this.addLog('warn', '\uD83D\uDED1 Parando ap\u00F3s ciclo atual...', this.currentCycle);
        } else {
            this.state.isRunning = false;
            this.state.isLoop = false;
            this.state.shouldStop = true;
            this.state.status = 'STOPPED';
            this.addLog('info', '\u23F9\uFE0F Processo parado', this.currentCycle);
        }
    }

    async startLoop() {
        if (this.state.isRunning) { this.addLog('warn', '\u26A0\uFE0F J\u00E1 est\u00E1 rodando'); return; }
        this.state.isLoop = true;
        this.state.shouldStop = false;
        this.state.status = 'STARTING';
        this.addLog('info', '\uD83D\uDD04 Loop iniciado', 0);
        void this.runLoop(true);
    }

    async startOnce() {
        if (this.state.isRunning) { this.addLog('warn', '\u26A0\uFE0F J\u00E1 est\u00E1 rodando'); return; }
        this.state.isLoop = false;
        this.state.shouldStop = false;
        this.state.status = 'STARTING';
        this.addLog('info', '\u25B6\uFE0F Ciclo \u00FAnico iniciado', 0);
        void this.runLoop(false);
    }

    async runLoop(loop) {
        do {
            const failures = await this.executeBatch();
            if (loop && !this.state.shouldStop) {
                if (failures > 0) {
                    this.addLog('info', `\uD83D\uDD01 Auto-restart: ${failures} ciclo(s) falharam \u2014 relan\u00E7ando imediatamente...`);
                    await this.executeBatch(failures);
                }
                if (!this.state.shouldStop) {
                    const intervalSec = Math.round(this.state.config.cycleInterval / 1000);
                    this.addLog('info', `\u23F3 Aguardando ${intervalSec}s para pr\u00F3ximo ciclo...`);
                    const end = Date.now() + this.state.config.cycleInterval;
                    while (Date.now() < end && !this.state.shouldStop) {
                        await sleep(Math.min(500, end - Date.now()));
                    }
                }
            }
        } while (loop && !this.state.shouldStop);
        this.state.status = 'STOPPED';
        this.state.isRunning = false;
        this.state.shouldStop = false;
        this.state.activeParallel = 0;
        this.addLog('info', '\u23F9\uFE0F Processo finalizado');
    }

    async executeBatch(count) {
        const n = count ?? Math.max(1, this.state.config.parallelCycles || 1);
        this.state.isRunning = true;
        this.state.status = 'RUNNING';
        const profiles = this.state.config.profiles ?? [];
        const profilesSummary = profiles.length > 0 ? ` (${profiles.length} perfil(is) em rota\u00E7\u00E3o)` : '';
        this.addLog('info', `\u26A1 Iniciando lote de ${n} ciclo(s) em paralelo...${profilesSummary}`);
        this.state.cyclesTotal += n;
        const promises = Array.from({ length: n }, () => {
            this.currentCycle += 1;
            this.state.activeParallel += 1;
            const cycle = this.currentCycle;
            this.clearKycCycle(cycle);
            return this.executeCycleWithRetry(cycle).then(
                () => false,
                () => true
            ).finally(() => {
                this.state.activeParallel = Math.max(0, this.state.activeParallel - 1);
            });
        });
        const results = await Promise.allSettled(promises);
        const failures = results.filter(r =>
            r.status === 'rejected' || (r.status === 'fulfilled' && r.value === true)
        ).length;
        return failures;
    }

    async executeCycleWithRetry(cycle) {
        const MAX_RETRIES = 3;
        const BACKOFF = [0, 5000, 15000];
        let lastError = 'Erro desconhecido';
        const profileIndex = this.getProfileIndexForCycle(cycle);
        const profiles = this.state.config.profiles ?? [];
        if (profileIndex >= 0) {
            const p = profiles[profileIndex];
            const label = p.label ?? `P${profileIndex + 1}`;
            const city  = p.cityName ? ` | cidade: ${p.cityName}` : '';
            const code  = p.inviteCode ? ` | c\u00F3digo: ${p.inviteCode}` : '';
            this.addLog('info', `\uD83D\uDDC2\uFE0F Ciclo #${cycle} \u2192 Perfil "${label}"${city}${code}`, cycle);
        }
        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            if (this.state.shouldStop) {
                this.addLog('info', `\uD83D\uDED1 Ciclo #${cycle} interrompido (shouldStop)`, cycle);
                this.finishCycleStatus(cycle, false);
                return;
            }
            if (attempt > 1) this.clearKycCycle(cycle);
            this.initCycleStatus(cycle, attempt);
            const backoff = BACKOFF[attempt - 1] ?? 15000;
            if (backoff > 0) {
                this.addLog('warn', `\u23F3 Retry #${attempt} em ${backoff / 1000}s...`, cycle);
                const end = Date.now() + backoff;
                while (Date.now() < end) {
                    if (this.state.shouldStop) {
                        this.addLog('info', `\uD83D\uDED1 Ciclo #${cycle} interrompido durante backoff`, cycle);
                        this.finishCycleStatus(cycle, false);
                        return;
                    }
                    await sleep(Math.min(500, end - Date.now()));
                }
            }
            try {
                if (attempt === 1) {
                    this.addLog('info', `\uD83D\uDE80 Iniciando ciclo #${cycle}`, cycle);
                } else {
                    this.addLog('info', `\uD83D\uDD01 Ciclo #${cycle} \u2014 tentativa ${attempt}/${MAX_RETRIES}`, cycle);
                }
                if (!this.executor) throw new Error('Nenhum executor registrado.');
                const effectiveConfig = this.getConfigForCycle(cycle);
                await this.executor(effectiveConfig, cycle);
                this.state.cyclesCompleted += 1;
                this.finishCycleStatus(cycle, true);
                this.addLog('success', `\u2705 Ciclo #${cycle} conclu\u00EDdo! Total: ${this.state.cyclesCompleted}`, cycle);
                return;
            } catch (error) {
                lastError = error instanceof Error ? error.message : 'Erro desconhecido';
                if (this.state.shouldStop || lastError.includes('Parado pelo usu\u00E1rio')) {
                    this.addLog('info', `\uD83D\uDED1 Ciclo #${cycle} encerrado pelo usu\u00E1rio`, cycle);
                    this.finishCycleStatus(cycle, false);
                    return;
                }
                this.addLog('error', `\u274C Tentativa ${attempt}/${MAX_RETRIES} falhou: ${lastError}`, cycle);
                await sleep(2000);
            }
        }
        this.state.status = 'ERROR';
        this.state.lastError = lastError;
        this.finishCycleStatus(cycle, false);
        this.addLog('error', `\uD83D\uDC80 Ciclo #${cycle} falhou ap\u00F3s ${MAX_RETRIES} tentativas: ${lastError}`, cycle);
        throw new Error(lastError);
    }
}

exports.globalState = new GlobalState();
