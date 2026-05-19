import { AppState, AppStatus, Config, CycleProfile, LogEntry, ProxyConfig } from '../types';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export type CycleExecutor = (config: Config, cycle: number) => Promise<void>;

// ─── KYC State ────────────────────────────────────────────────────────────────

export interface KycSignal {
  provider: 'Socure' | 'Veriff' | 'Onfido' | 'Jumio' | string;
  source: string;
  url?: string;
  weight: number;
  time: string;
  cycle: number;
}

export interface KycProviderState {
  score: number;
  level: 'WEAK' | 'LIKELY' | 'CONFIRMED';
  signals: KycSignal[];
}

/** Mapa por ciclo: cycle → provider → KycProviderState */
export type KycByCycle = Record<number, Record<string, KycProviderState>>;

function kycLevel(score: number): KycProviderState['level'] {
  if (score >= 8) return 'CONFIRMED';
  if (score >= 4) return 'LIKELY';
  return 'WEAK';
}

// ─── Cycle Status ─────────────────────────────────────────────────────────────

export interface CycleStatus {
  cycle: number;
  status: 'running' | 'retrying' | 'done' | 'failed';
  step: string;
  stepLabel: string;
  startedAt: number;
  updatedAt: number;
  attempt: number;
  /** Índice do perfil usado (0-based), -1 se sem perfil */
  profileIndex: number;
  /** Label do perfil para exibição */
  profileLabel?: string;
}

export type CycleStatusMap = Record<number, CycleStatus>;

// ─── Payload por ciclo ────────────────────────────────────────────────────────

export interface CyclePayload {
  nome: string;
  sobrenome: string;
  email: string;
  telefone: string;
  senha: string;
  localizacao: string;
  codigoIndicacao: string;
}

// ─── Helpers de proxy ─────────────────────────────────────────────────────────

export function parseProxyString(raw: string): ProxyConfig | null {
  raw = raw.trim();
  if (!raw) return null;

  const schemeMatch = raw.match(
    /^(https?|socks[45]):\/\/(?:([^:@]+):([^@]*)@)?([^:/]+):(\d+)\s*$/i
  );
  if (schemeMatch) {
    const [, scheme, user, pass, host, port] = schemeMatch;
    return {
      server:   `${scheme}://${host}:${port}`,
      username: user  || undefined,
      password: pass  || undefined,
    };
  }

  const parts = raw.split(':');
  if (parts.length === 2) {
    return { server: `http://${parts[0]}:${parts[1]}` };
  }
  if (parts.length === 4) {
    return {
      server:   `http://${parts[0]}:${parts[1]}`,
      username: parts[2],
      password: parts[3],
    };
  }

  return null;
}

// ─── Constantes ───────────────────────────────────────────────────────────────

const MAX_LOG_ENTRIES = 2000;

// ─── GlobalState ──────────────────────────────────────────────────────────────

class GlobalState {
  private state: AppState = {
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

  private logs: LogEntry[] = [];
  private currentCycle = 0;
  private executor: CycleExecutor | null = null;

  private kycByCycle: KycByCycle = {};
  private payloadByCycle: Record<number, CyclePayload> = {};
  private cycleStatusMap: CycleStatusMap = {};

  onStateChange?: (state: AppState) => void;

  // ─── Profile API ─────────────────────────────────────────────────────────────

  getProfiles(): CycleProfile[] {
    return this.state.config.profiles ?? [];
  }

  setProfiles(profiles: CycleProfile[]): void {
    this.state.config.profiles = profiles;
    this.addLog('info', `🗂️ Perfis atualizados: ${profiles.length} perfil(is)`);
  }

  /**
   * Retorna a config efetiva para um ciclo específico.
   * Aplica round-robin: ciclo N usa perfil[(N-1) % profiles.length].
   * Se não houver perfis, retorna a config base.
   */
  getConfigForCycle(cycle: number): Config {
    const profiles = this.state.config.profiles;
    if (!profiles || profiles.length === 0) return this.state.config;

    const idx = (cycle - 1) % profiles.length;
    const profile = profiles[idx]!;
    const merged: Config = { ...this.state.config, ...profile };
    // proxies do perfil têm prioridade; se perfil não definir proxies, usa da config base
    merged.proxies = profile.proxies ?? this.state.config.proxies;
    return merged;
  }

  getProfileIndexForCycle(cycle: number): number {
    const profiles = this.state.config.profiles;
    if (!profiles || profiles.length === 0) return -1;
    return (cycle - 1) % profiles.length;
  }

  // ─── Cycle Status API ────────────────────────────────────────────────────────

  setCycleStep(cycle: number, step: string, stepLabel: string): void {
    const existing = this.cycleStatusMap[cycle];
    if (existing) {
      existing.step = step;
      existing.stepLabel = stepLabel;
      existing.updatedAt = Date.now();
    }
  }

  initCycleStatus(cycle: number, attempt: number): void {
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

  finishCycleStatus(cycle: number, success: boolean): void {
    const existing = this.cycleStatusMap[cycle];
    if (existing) {
      existing.status = success ? 'done' : 'failed';
      existing.stepLabel = success ? '✅ Concluído' : '❌ Falhou';
      existing.updatedAt = Date.now();
    }
    setTimeout(() => { delete this.cycleStatusMap[cycle]; }, 10_000);
  }

  getCycleStatusMap(): CycleStatusMap {
    return { ...this.cycleStatusMap };
  }

  clearCycleStatus(cycle: number): void {
    delete this.cycleStatusMap[cycle];
  }

  // ─── Payload API ─────────────────────────────────────────────────────────────

  setPayload(cycle: number, payload: CyclePayload): void {
    this.payloadByCycle[cycle] = payload;
  }

  getPayload(cycle: number): CyclePayload | undefined {
    return this.payloadByCycle[cycle];
  }

  clearPayload(cycle: number): void {
    delete this.payloadByCycle[cycle];
  }

  // ─── Proxy API ───────────────────────────────────────────────────────────────

  getProxyForCycle(cycle: number): ProxyConfig | undefined {
    // Usa proxies do perfil efetivo do ciclo (pode ser do perfil ou da config base)
    const effectiveConfig = this.getConfigForCycle(cycle);
    const proxies = effectiveConfig.proxies;
    if (!proxies || proxies.length === 0) return undefined;
    const idx = (cycle - 1) % proxies.length;
    const proxy = proxies[idx]!;
    this.addLog(
      'info',
      `🌐 Proxy #${idx + 1}/${proxies.length}: ${proxy.server}${proxy.username ? ` (auth: ${proxy.username})` : ''}`,
      cycle
    );
    return proxy;
  }

  // ─── KYC API ─────────────────────────────────────────────────────────────────

  clearKycCycle(cycle: number): void {
    if (this.kycByCycle[cycle]) {
      delete this.kycByCycle[cycle];
    }
  }

  addKycSignal(provider: string, source: string, weight: number, cycle: number, url?: string): void {
    if (!this.kycByCycle[cycle]) this.kycByCycle[cycle] = {};
    const cycleMap = this.kycByCycle[cycle]!;

    if (!cycleMap[provider]) cycleMap[provider] = { score: 0, level: 'WEAK', signals: [] };
    const p = cycleMap[provider]!;
    p.score += weight;
    p.level = kycLevel(p.score);

    const signal: KycSignal = {
      provider,
      source,
      weight,
      cycle,
      url: url?.substring(0, 120),
      time: new Date().toLocaleTimeString('pt-BR'),
    };
    p.signals.unshift(signal);
    if (p.signals.length > 20) p.signals = p.signals.slice(0, 20);

    const urlShort = url ? ` | ${url.substring(0, 60)}` : '';
    this.addLog(
      'kyc',
      `[${provider}] ${p.level} — score=${p.score} via ${source} (+${weight})${urlShort}`,
      cycle
    );
  }

  getKycSignals(cycle: number): KycSignal[] {
    const cycleMap = this.kycByCycle[cycle];
    if (!cycleMap) return [];
    const sorted = Object.values(cycleMap).sort((a, b) => b.score - a.score);
    const result: KycSignal[] = [];
    for (const state of sorted) result.push(...state.signals);
    return result;
  }

  getTopKycProvider(cycle: number): { provider: string; level: KycProviderState['level']; url?: string } | null {
    const cycleMap = this.kycByCycle[cycle];
    if (!cycleMap) return null;

    let top: { provider: string; level: KycProviderState['level']; score: number; url?: string } | null = null;

    for (const [provider, state] of Object.entries(cycleMap)) {
      if (!top || state.score > top.score) {
        const lastUrl = state.signals.find(s => s.url)?.url;
        top = { provider, level: state.level, score: state.score, url: lastUrl };
      }
    }

    if (!top) return null;
    return { provider: top.provider, level: top.level, url: top.url };
  }

  getKycByCycleEntry(cycle: number): Record<string, KycProviderState> | null {
    return this.kycByCycle[cycle] ?? null;
  }

  getKycState(): { byCycle: KycByCycle } {
    return { byCycle: this.kycByCycle };
  }

  clearKycState(): void {
    this.kycByCycle = {};
  }

  incrementFailure(reason?: string, cycle?: number): void {
    const msg = reason ? `❌ Falha no ciclo: ${reason}` : '❌ Falha no ciclo';
    this.addLog('error', msg, cycle);
  }

  // ─── Core API ────────────────────────────────────────────────────────────────

  setExecutor(fn: CycleExecutor): void {
    this.executor = fn;
  }

  getState(): AppState {
    return { ...this.state };
  }

  getLogs(): LogEntry[] {
    return [...this.logs];
  }

  clearLogs(): void {
    this.logs = [];
  }

  updateConfig(config: Partial<Config>): void {
    this.state.config = { ...this.state.config, ...config };
    this.addLog('info', 'Configuração atualizada');
  }

  addLog(level: LogEntry['level'], message: string, cycle?: number): void {
    this.logs.unshift({ timestamp: new Date().toISOString(), level, message, cycle });
    if (this.logs.length > MAX_LOG_ENTRIES) {
      this.logs = this.logs.slice(0, MAX_LOG_ENTRIES);
    }
  }

  stop(): void {
    if (this.state.status === 'RUNNING' || this.state.status === 'WAITING_OTP' || this.state.status === 'STOPPING') {
      this.state.shouldStop = true;
      this.state.isLoop = false;
      this.state.status = 'STOPPING';
      this.addLog('warn', '🛑 Parando após ciclo atual...', this.currentCycle);
    } else {
      this.state.isRunning = false;
      this.state.isLoop = false;
      this.state.shouldStop = true;
      this.state.status = 'STOPPED';
      this.addLog('info', '⏹️ Processo parado', this.currentCycle);
    }
  }

  async startLoop(): Promise<void> {
    if (this.state.isRunning) { this.addLog('warn', '⚠️ Já está rodando'); return; }
    this.state.isLoop = true;
    this.state.shouldStop = false;
    this.state.status = 'STARTING';
    this.addLog('info', '🔄 Loop iniciado', 0);
    void this.runLoop(true);
  }

  async startOnce(): Promise<void> {
    if (this.state.isRunning) { this.addLog('warn', '⚠️ Já está rodando'); return; }
    this.state.isLoop = false;
    this.state.shouldStop = false;
    this.state.status = 'STARTING';
    this.addLog('info', '▶️ Ciclo único iniciado', 0);
    void this.runLoop(false);
  }

  private async runLoop(loop: boolean): Promise<void> {
    do {
      const failures = await this.executeBatch();

      if (loop && !this.state.shouldStop) {
        if (failures > 0) {
          this.addLog('info', `🔁 Auto-restart: ${failures} ciclo(s) falharam — relançando imediatamente...`);
          await this.executeBatch(failures);
        }

        if (!this.state.shouldStop) {
          const intervalSec = Math.round(this.state.config.cycleInterval / 1000);
          this.addLog('info', `⏳ Aguardando ${intervalSec}s para próximo ciclo...`);
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
    this.addLog('info', '⏹️ Processo finalizado');
  }

  private async executeBatch(count?: number): Promise<number> {
    const n = count ?? Math.max(1, this.state.config.parallelCycles || 1);
    this.state.isRunning = true;
    this.state.status = 'RUNNING';

    const profiles = this.state.config.profiles ?? [];
    const profilesSummary = profiles.length > 0
      ? ` (${profiles.length} perfil(is) em rotação)`
      : '';
    this.addLog('info', `⚡ Iniciando lote de ${n} ciclo(s) em paralelo...${profilesSummary}`);

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

  private async executeCycleWithRetry(cycle: number): Promise<void> {
    const MAX_RETRIES = 3;
    const BACKOFF = [0, 5000, 15000];
    let lastError = 'Erro desconhecido';

    // Log do perfil usado por este ciclo
    const profileIndex = this.getProfileIndexForCycle(cycle);
    const profiles = this.state.config.profiles ?? [];
    if (profileIndex >= 0) {
      const p = profiles[profileIndex]!;
      const label = p.label ?? `P${profileIndex + 1}`;
      const city  = p.cityName ? ` | cidade: ${p.cityName}` : '';
      const code  = p.inviteCode ? ` | código: ${p.inviteCode}` : '';
      this.addLog('info', `🗂️ Ciclo #${cycle} → Perfil "${label}"${city}${code}`, cycle);
    }

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      if (this.state.shouldStop) {
        this.addLog('info', `🛑 Ciclo #${cycle} interrompido (shouldStop)`, cycle);
        this.finishCycleStatus(cycle, false);
        return;
      }

      if (attempt > 1) this.clearKycCycle(cycle);

      this.initCycleStatus(cycle, attempt);

      const backoff = BACKOFF[attempt - 1] ?? 15000;
      if (backoff > 0) {
        this.addLog('warn', `⏳ Retry #${attempt} em ${backoff / 1000}s...`, cycle);
        const end = Date.now() + backoff;
        while (Date.now() < end) {
          if (this.state.shouldStop) {
            this.addLog('info', `🛑 Ciclo #${cycle} interrompido durante backoff`, cycle);
            this.finishCycleStatus(cycle, false);
            return;
          }
          await sleep(Math.min(500, end - Date.now()));
        }
      }

      try {
        if (attempt === 1) {
          this.addLog('info', `🚀 Iniciando ciclo #${cycle}`, cycle);
        } else {
          this.addLog('info', `🔁 Ciclo #${cycle} — tentativa ${attempt}/${MAX_RETRIES}`, cycle);
        }

        if (!this.executor) throw new Error('Nenhum executor registrado.');

        // Passa a config efetiva do ciclo (base + perfil round-robin)
        const effectiveConfig = this.getConfigForCycle(cycle);
        await this.executor(effectiveConfig, cycle);

        this.state.cyclesCompleted += 1;
        this.finishCycleStatus(cycle, true);
        this.addLog('success', `✅ Ciclo #${cycle} concluído! Total: ${this.state.cyclesCompleted}`, cycle);
        return;
      } catch (error) {
        lastError = error instanceof Error ? error.message : 'Erro desconhecido';
        if (this.state.shouldStop || lastError.includes('Parado pelo usuário')) {
          this.addLog('info', `🛑 Ciclo #${cycle} encerrado pelo usuário`, cycle);
          this.finishCycleStatus(cycle, false);
          return;
        }
        this.addLog('error', `❌ Tentativa ${attempt}/${MAX_RETRIES} falhou: ${lastError}`, cycle);
        await sleep(2000);
      }
    }

    this.state.status = 'ERROR';
    this.state.lastError = lastError;
    this.finishCycleStatus(cycle, false);
    this.addLog('error', `💀 Ciclo #${cycle} falhou após ${MAX_RETRIES} tentativas: ${lastError}`, cycle);
    throw new Error(lastError);
  }
}

export const globalState = new GlobalState();
