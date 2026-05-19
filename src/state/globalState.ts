import { AppState, AppStatus, Config, LogEntry, ProxyConfig } from '../types';

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

// ─── Cycle Status (painel em tempo real) ─────────────────────────────────────

export interface CycleStatusEntry {
  cycle: number;
  step: string;
  startedAt: string;
  updatedAt: string;
  done: boolean;
  failed: boolean;
}

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

/**
 * Parseia uma string de proxy nos formatos:
 *   http://user:pass@host:port
 *   socks5://user:pass@host:port
 *   host:port
 *   host:port:user:pass
 */
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

/** BUG 4 FIX: limite máximo de entradas de log em memória */
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
    },
    shouldStop: false,
  };

  private logs: LogEntry[] = [];
  private currentCycle = 0;
  private executor: CycleExecutor | null = null;

  private kycByCycle: KycByCycle = {};
  private payloadByCycle: Record<number, CyclePayload> = {};

  // Painel de status por ciclo em tempo real
  private cycleStatusMap: Record<number, CycleStatusEntry> = {};

  // Timer do intervalo entre batches — permite cancelar imediatamente no stop()
  private intervalTimer: ReturnType<typeof setTimeout> | null = null;

  // ─── Callback de broadcast (injetado pelo server) ─────────────────────────
  onStateChange?: (state: AppState) => void;

  // ─── Cycle Status API ─────────────────────────────────────────────────────

  setCycleStatus(cycle: number, step: string, done = false, failed = false): void {
    const now = new Date().toISOString();
    if (!this.cycleStatusMap[cycle]) {
      this.cycleStatusMap[cycle] = { cycle, step, startedAt: now, updatedAt: now, done, failed };
    } else {
      this.cycleStatusMap[cycle]!.step = step;
      this.cycleStatusMap[cycle]!.updatedAt = now;
      this.cycleStatusMap[cycle]!.done = done;
      this.cycleStatusMap[cycle]!.failed = failed;
    }
  }

  getCycleStatuses(): CycleStatusEntry[] {
    return Object.values(this.cycleStatusMap)
      .sort((a, b) => b.cycle - a.cycle)
      .slice(0, 50);
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
    const proxies = this.state.config.proxies;
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
    // retorna sinais ordenados por score descendente (provider mais forte primeiro)
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

  // ─── BUG 1 FIX: incrementSuccess removido — método morto que causaria double-count

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

  // BUG 4 FIX: addLog com cap de MAX_LOG_ENTRIES
  addLog(level: LogEntry['level'], message: string, cycle?: number): void {
    this.logs.unshift({ timestamp: new Date().toISOString(), level, message, cycle });
    if (this.logs.length > MAX_LOG_ENTRIES) {
      this.logs = this.logs.slice(0, MAX_LOG_ENTRIES);
    }
  }

  // ─── STOP FIX ─────────────────────────────────────────────────────────────────
  // Antes: stop() não chamava addLog quando status=RUNNING → nenhum broadcast SSE
  // era emitido → frontend ficava preso mostrando RUNNING para sempre.
  // Agora: addLog é chamado em TODAS as branches → broadcast automático via server patch.
  // Também cancela o intervalTimer para interromper o wait entre batches imediatamente.
  stop(): void {
    if (this.intervalTimer !== null) {
      clearTimeout(this.intervalTimer);
      this.intervalTimer = null;
    }
    if (this.state.status === 'RUNNING' || this.state.status === 'WAITING_OTP' || this.state.status === 'STOPPING') {
      this.state.shouldStop = true;
      this.state.isLoop = false;
      this.state.status = 'STOPPING';
      // FIX: addLog agora chamado aqui → dispara broadcast SSE imediatamente
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
      await this.executeBatch();
      if (loop && !this.state.shouldStop) {
        const intervalSec = Math.round(this.state.config.cycleInterval / 1000);
        this.addLog('info', `⏳ Aguardando ${intervalSec}s para próximo ciclo...`);
        // FIX: usa intervalTimer para permitir cancelamento via stop()
        await new Promise<void>((resolve) => {
          this.intervalTimer = setTimeout(() => {
            this.intervalTimer = null;
            resolve();
          }, this.state.config.cycleInterval);
        });
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

  private async executeBatch(): Promise<void> {
    const n = Math.max(1, this.state.config.parallelCycles || 1);
    this.state.isRunning = true;
    this.state.status = 'RUNNING';
    this.addLog('info', `⚡ Iniciando lote de ${n} ciclo(s) em paralelo...`);

    // COUNTER FIX: incrementa cyclesTotal atomicamente ANTES de criar as promises
    // para garantir que o contador no frontend seja consistente e sem race condition.
    const startCycle = this.currentCycle + 1;
    this.currentCycle += n;
    this.state.cyclesTotal += n;

    const promises = Array.from({ length: n }, (_, i) => {
      const cycle = startCycle + i;
      this.state.activeParallel += 1;
      this.clearKycCycle(cycle);
      this.setCycleStatus(cycle, 'iniciando');
      return this.executeCycleWithRetry(cycle).finally(() => {
        this.state.activeParallel = Math.max(0, this.state.activeParallel - 1);
      });
    });

    await Promise.allSettled(promises);
  }

  private async executeCycleWithRetry(cycle: number): Promise<void> {
    const MAX_RETRIES = 3;
    const BACKOFF = [0, 5000, 15000];
    let lastError = 'Erro desconhecido';

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      if (this.state.shouldStop) {
        this.addLog('info', `🛑 Ciclo #${cycle} interrompido (shouldStop)`, cycle);
        this.setCycleStatus(cycle, 'interrompido', true, false);
        return;
      }

      const backoff = BACKOFF[attempt - 1] ?? 15000;
      if (backoff > 0) {
        this.addLog('warn', `⏳ Retry #${attempt} em ${backoff / 1000}s...`, cycle);
        this.setCycleStatus(cycle, `retry ${attempt}/${MAX_RETRIES}`);
        const end = Date.now() + backoff;
        while (Date.now() < end) {
          if (this.state.shouldStop) {
            this.addLog('info', `🛑 Ciclo #${cycle} interrompido durante backoff`, cycle);
            this.setCycleStatus(cycle, 'interrompido', true, false);
            return;
          }
          await sleep(Math.min(500, end - Date.now()));
        }
      }

      // RETRY FIX: limpa sinais KYC a cada retry para não acumular da tentativa anterior
      if (attempt > 1) {
        this.clearKycCycle(cycle);
      }

      try {
        if (attempt === 1) {
          this.addLog('info', `🚀 Iniciando ciclo #${cycle}`, cycle);
        } else {
          this.addLog('info', `🔁 Ciclo #${cycle} — tentativa ${attempt}/${MAX_RETRIES}`, cycle);
        }
        this.setCycleStatus(cycle, attempt === 1 ? 'rodando' : `tentativa ${attempt}`);

        if (!this.executor) throw new Error('Nenhum executor registrado.');
        await this.executor(this.state.config, cycle);

        this.state.cyclesCompleted += 1;
        this.setCycleStatus(cycle, 'concluído', true, false);
        this.addLog('success', `✅ Ciclo #${cycle} concluído! Total: ${this.state.cyclesCompleted}`, cycle);
        return;
      } catch (error) {
        lastError = error instanceof Error ? error.message : 'Erro desconhecido';
        if (this.state.shouldStop || lastError.includes('Parado pelo usuário')) {
          this.addLog('info', `🛑 Ciclo #${cycle} encerrado pelo usuário`, cycle);
          this.setCycleStatus(cycle, 'interrompido', true, false);
          return;
        }
        this.addLog('error', `❌ Tentativa ${attempt}/${MAX_RETRIES} falhou: ${lastError}`, cycle);
        await sleep(2000);
      }
    }

    this.state.status = 'ERROR';
    this.state.lastError = lastError;
    this.setCycleStatus(cycle, 'falhou', true, true);
    this.addLog('error', `💀 Ciclo #${cycle} falhou após ${MAX_RETRIES} tentativas: ${lastError}`, cycle);

    // AUTO-RESTART FIX: em modo loop, relança um ciclo substituto imediatamente
    // sem esperar o cycleInterval, para manter a capacidade paralela constante.
    if (this.state.isLoop && !this.state.shouldStop) {
      const replaceCycle = ++this.currentCycle;
      this.state.cyclesTotal += 1;
      this.state.activeParallel += 1;
      this.state.status = 'RUNNING';
      this.addLog('info', `♻️ Auto-restart: ciclo #${replaceCycle} substitui ciclo #${cycle} falho`, replaceCycle);
      this.clearKycCycle(replaceCycle);
      this.setCycleStatus(replaceCycle, 'auto-restart');
      this.executeCycleWithRetry(replaceCycle).finally(() => {
        this.state.activeParallel = Math.max(0, this.state.activeParallel - 1);
      });
    }
  }
}

export const globalState = new GlobalState();
