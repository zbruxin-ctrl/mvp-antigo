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

// ─── CycleStep — etapa atual de cada ciclo ───────────────────────────────────

export interface CycleStep {
  cycle: number;
  step: string;
  startedAt: number;  // Date.now() — ms para calcular elapsed no frontend
  stepStatus: 'running' | 'done' | 'error';
  error?: string;
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
    },
    shouldStop: false,
  };

  private logs: LogEntry[] = [];
  private currentCycle = 0;
  private executor: CycleExecutor | null = null;

  private kycByCycle: KycByCycle = {};
  private payloadByCycle: Record<number, CyclePayload> = {};

  // Etapa atual de cada ciclo: cycle → CycleStep
  private cycleSteps: Record<number, CycleStep> = {};

  // Callback de broadcast injetado pelo server
  onStateChange?: (state: AppState) => void;

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
    return proxies[idx]!;
  }

  // ─── CycleStep API ───────────────────────────────────────────────────────────

  /**
   * Registra a etapa atual de um ciclo.
   * Chame com um label legível em cada etapa do mockFlow:
   *   globalState.setCycleStep(cycle, '[1] Gerando email');
   *   globalState.setCycleStep(cycle, '[2] Aguardando OTP');
   * O server emite SSE 'cycleStatus' com todos os ciclos ativos.
   */
  setCycleStep(cycle: number, step: string, status: CycleStep['stepStatus'] = 'running', error?: string): void {
    this.cycleSteps[cycle] = {
      cycle,
      step,
      startedAt: this.cycleSteps[cycle]?.startedAt ?? Date.now(),
      stepStatus: status,
      error,
    };
    this.addLog('step' as LogEntry['level'], `[STEP] ${step}`, cycle);
  }

  getCycleSteps(): CycleStep[] {
    return Object.values(this.cycleSteps);
  }

  getCycleStepsMap(): Record<number, CycleStep> {
    return { ...this.cycleSteps };
  }

  clearCycleStep(cycle: number): void {
    delete this.cycleSteps[cycle];
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

  // ─── FIX: stop() ─────────────────────────────────────────────────────────────
  //
  // ANTES:
  //   - addLog só era chamado no else (processo já parado) → sem broadcast SSE
  //     quando status era RUNNING/WAITING_OTP
  //   - isStopped() só checa a cada 200ms no sleep() → se ciclo estava preso
  //     esperando OTP (90s sem sleep), o stop não interrompia
  //
  // AGORA:
  //   1. shouldStop = true é a PRIMEIRA coisa — sleep() para em ≤200ms imediatamente
  //   2. addLog chamado em TODAS as branches → broadcast SSE do status STOPPING
  //      chega ao frontend antes mesmo do ciclo atual terminar
  //   3. STOPPING exibido no badge do topbar instantaneamente
  //
  stop(): void {
    // Seta primeiro — sleep() e isStopped() reagem em até 200ms
    this.state.shouldStop = true;

    if (
      this.state.status === 'RUNNING' ||
      this.state.status === 'WAITING_OTP' ||
      this.state.status === 'STARTING'
    ) {
      this.state.isLoop = false;
      this.state.status = 'STOPPING';
      // addLog dispara o onStateChange/broadcast no server → SSE imediato
      this.addLog('warn', '🛑 Parando — aguardando ciclo(s) atual(is) terminar(em)...', this.currentCycle || undefined);
    } else {
      // Já está STOPPED, STOPPING ou ERROR — força reset imediato
      this.state.isRunning = false;
      this.state.isLoop = false;
      this.state.status = 'STOPPED';
      this.state.activeParallel = 0;
      this.state.shouldStop = false;
      this.addLog('info', '⏹️ Processo parado', undefined);
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
        this.addLog('info', `⏳ Aguardando ${Math.round(this.state.config.cycleInterval / 1000)}s para próximo lote...`);
        const end = Date.now() + this.state.config.cycleInterval;
        while (Date.now() < end) {
          if (this.state.shouldStop) break;
          await sleep(200);
        }
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

  // ─── FIX: executeBatch() ─────────────────────────────────────────────────────
  //
  // ANTES:
  //   - Array.from() incrementava currentCycle 3x de forma síncrona E
  //     cyclesTotal só incrementava dentro de executeCycleWithRetry
  //     → com parallelCycles=3, SSE podia emitir cyclesTotal 1, 2, 3 fora de ordem
  //     causando saltos visuais no contador
  //
  // AGORA:
  //   - currentCycle e cyclesTotal incrementados atomicamente ANTES das promises
  //   - cycles numerados como firstCycle + i (determinístico)
  //   - clearCycleStep e decremento de activeParallel no finally de cada promise
  //
  private async executeBatch(): Promise<void> {
    const n = Math.max(1, this.state.config.parallelCycles || 1);
    this.state.isRunning = true;
    this.state.status = 'RUNNING';
    this.addLog('info', `⚡ Iniciando lote de ${n} ciclo(s) em paralelo...`);

    // Incremento atômico: todos os números de ciclo definidos antes de qualquer promise
    const firstCycle = this.currentCycle + 1;
    this.currentCycle += n;
    this.state.cyclesTotal += n;
    this.state.activeParallel += n;

    const promises = Array.from({ length: n }, (_, i) => {
      const cycle = firstCycle + i;
      this.clearKycCycle(cycle);
      return this.executeCycleWithRetry(cycle).finally(() => {
        this.state.activeParallel = Math.max(0, this.state.activeParallel - 1);
        this.clearCycleStep(cycle);
      });
    });

    await Promise.allSettled(promises);
  }

  // ─── FIX: executeCycleWithRetry() ────────────────────────────────────────────
  //
  // ANTES:
  //   - clearKycCycle(cycle) era chamado APENAS na primeira vez (no Array.from)
  //     → em retries, sinais KYC da tentativa anterior acumulavam incorretamente
  //
  // AGORA:
  //   - clearKycCycle(cycle) chamado no início de CADA tentativa > 1
  //
  // NOVA FUNÇÃO: auto-restart imediato de ciclo falho
  //   - Se em modo Loop e shouldStop=false, ao esgotar retries lança um ciclo
  //     substituto imediatamente (sem esperar cycleInterval)
  //   - Ciclo substituto roda em background via void para não bloquear allSettled
  //
  private async executeCycleWithRetry(cycle: number): Promise<void> {
    const MAX_RETRIES = 3;
    const BACKOFF_MS = [0, 5000, 15000];
    let lastError = 'Erro desconhecido';

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      if (this.state.shouldStop) {
        this.addLog('info', `🛑 Ciclo #${cycle} interrompido (shouldStop)`, cycle);
        return;
      }

      // Backoff com resposta imediata ao shouldStop
      const backoff = BACKOFF_MS[attempt - 1] ?? 15000;
      if (backoff > 0) {
        this.addLog('warn', `⏳ Retry #${attempt} em ${backoff / 1000}s...`, cycle);
        const end = Date.now() + backoff;
        while (Date.now() < end) {
          if (this.state.shouldStop) {
            this.addLog('info', `🛑 Ciclo #${cycle} interrompido durante backoff`, cycle);
            return;
          }
          await sleep(Math.min(200, end - Date.now()));
        }
      }

      try {
        if (attempt === 1) {
          this.addLog('info', `🚀 Iniciando ciclo #${cycle}`, cycle);
        } else {
          // FIX: limpa sinais KYC da tentativa anterior
          this.clearKycCycle(cycle);
          this.addLog('info', `🔁 Ciclo #${cycle} — tentativa ${attempt}/${MAX_RETRIES}`, cycle);
        }

        if (!this.executor) throw new Error('Nenhum executor registrado.');
        await this.executor(this.state.config, cycle);

        this.state.cyclesCompleted += 1;
        this.addLog('success', `✅ Ciclo #${cycle} concluído! Total: ${this.state.cyclesCompleted}`, cycle);
        return;
      } catch (error) {
        lastError = error instanceof Error ? error.message : 'Erro desconhecido';
        if (this.state.shouldStop || lastError.includes('Parado pelo usuário')) {
          this.addLog('info', `🛑 Ciclo #${cycle} encerrado pelo usuário`, cycle);
          return;
        }
        this.addLog('error', `❌ Tentativa ${attempt}/${MAX_RETRIES} falhou: ${lastError}`, cycle);
      }
    }

    this.addLog('error', `💀 Ciclo #${cycle} falhou após ${MAX_RETRIES} tentativas: ${lastError}`, cycle);

    // NOVA FUNÇÃO: auto-restart — relança ciclo substituto imediatamente em modo Loop
    if (this.state.isLoop && !this.state.shouldStop) {
      this.currentCycle += 1;
      this.state.cyclesTotal += 1;
      this.state.activeParallel += 1;
      const newCycle = this.currentCycle;
      this.clearKycCycle(newCycle);
      this.addLog('warn', `♻️ Auto-restart: relançando ciclo #${newCycle} (substituto do #${cycle})`, newCycle);
      void this.executeCycleWithRetry(newCycle).finally(() => {
        this.state.activeParallel = Math.max(0, this.state.activeParallel - 1);
        this.clearCycleStep(newCycle);
      });
    } else {
      this.state.status = 'ERROR';
      this.state.lastError = lastError;
    }
  }
}

export const globalState = new GlobalState();
