import { AppState, Config, LogEntry, ProxyConfig } from '../types';
export type CycleExecutor = (config: Config, cycle: number) => Promise<void>;
export interface KycSignal {
    provider: 'Socure' | 'Veriff' | string;
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
export interface CyclePayload {
    nome: string;
    sobrenome: string;
    email: string;
    telefone: string;
    senha: string;
    localizacao: string;
    codigoIndicacao: string;
}
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
export declare function parseProxyString(raw: string): ProxyConfig | null;
declare class GlobalState {
    private state;
    private logs;
    private currentCycle;
    private executor;
    private kycByCycle;
    private payloadByCycle;
    setPayload(cycle: number, payload: CyclePayload): void;
    getPayload(cycle: number): CyclePayload | undefined;
    clearPayload(cycle: number): void;
    getProxyForCycle(cycle: number): ProxyConfig | undefined;
    addKycSignal(provider: string, source: string, weight: number, cycle: number, url?: string): void;
    getKycSignals(cycle: number): KycSignal[];
    getKycState(): {
        byCycle: KycByCycle;
    };
    clearKycState(): void;
    setExecutor(fn: CycleExecutor): void;
    getState(): AppState;
    getLogs(): LogEntry[];
    clearLogs(): void;
    updateConfig(config: Partial<Config>): void;
    addLog(level: LogEntry['level'], message: string, cycle?: number): void;
    stop(): void;
    startLoop(): Promise<void>;
    startOnce(): Promise<void>;
    private runLoop;
    private executeBatch;
    private executeCycleWithRetry;
}
export declare const globalState: GlobalState;
export {};
//# sourceMappingURL=globalState.d.ts.map