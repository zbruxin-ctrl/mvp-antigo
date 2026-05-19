export type AppStatus =
  | 'STOPPED'
  | 'STARTING'
  | 'RUNNING'
  | 'WAITING_OTP'
  | 'STOPPING'
  | 'ERROR';

/**
 * Proxy individual.
 * Formatos aceitos:
 *   - host:porta                          (sem autenticação)
 *   - host:porta:usuario:senha            (com autenticação)
 *   - http://usuario:senha@host:porta     (URL completa)
 */
export interface ProxyConfig {
  server: string;   // ex: "http://1.2.3.4:8080" ou "socks5://1.2.3.4:1080"
  username?: string;
  password?: string;
}

export type EmailProvider = 'temp-mail.io' | 'mail.tm' | 'tempmailc';

export interface Config {
  cadastroUrl: string;
  tempMailApiKey: string;
  emailProvider: EmailProvider;
  /**
   * Domínio a usar com o provider tempmailc.
   * Ex: "kaamoolzy.it.com"
   * Se não informado, o client tenta buscar via /api/v1/domains.
   */
  tempmailcDomain?: string;
  inviteCode: string;
  /** Nome da cidade a digitar no step de seleção de cidade do Uber. */
  cityName?: string;
  otpTimeout: number;
  cycleInterval: number;
  extraDelay: number;
  parallelCycles: number;
  headless: boolean;
  /** Reduz todos os delays humanos para ~40% do valor normal */
  speedMode?: boolean;
  /** Lista de proxies — cada ciclo usa um em rotação round-robin */
  proxies?: ProxyConfig[];
  /**
   * Perfis de ciclo (Opção A — round-robin por índice).
   * Cada perfil sobrescreve parcialmente a config base.
   * Ciclo 1 → perfil[0], ciclo 2 → perfil[1], ..., ciclo N+1 → perfil[0] novamente.
   * Se vazio ou não definido, todos os ciclos usam a config base.
   */
  profiles?: CycleProfile[];
}

/**
 * Subconjunto de Config que pode ser sobrescrito por perfil.
 * Não inclui campos estruturais (cadastroUrl, headless, parallelCycles, etc.).
 */
export interface CycleProfile {
  /** Label para exibição no frontend, ex: 'Itajubá', 'Recife SP' */
  label?: string;
  inviteCode?: string;
  cityName?: string;
  emailProvider?: EmailProvider;
  tempMailApiKey?: string;
  tempmailcDomain?: string;
  extraDelay?: number;
  proxies?: ProxyConfig[];
}

export interface AppState {
  isRunning: boolean;
  isLoop: boolean;
  cyclesCompleted: number;
  cyclesTotal: number;
  activeParallel: number;
  status: AppStatus;
  lastError?: string;
  config: Config;
  shouldStop: boolean;
}

export interface LogEntry {
  timestamp: string;
  level: 'info' | 'warn' | 'error' | 'success' | 'kyc';
  message: string;
  cycle?: number;
}
