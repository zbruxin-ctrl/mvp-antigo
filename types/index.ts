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

export type EmailProvider = 'temp-mail.io' | 'mail.tm';

export interface Config {
  cadastroUrl: string;
  tempMailApiKey: string;
  emailProvider: EmailProvider;
  inviteCode: string;
  otpTimeout: number;
  cycleInterval: number;
  extraDelay: number;
  parallelCycles: number;
  headless: boolean;
  /** Reduz todos os delays humanos para ~40% do valor normal */
  speedMode?: boolean;
  /** Lista de proxies — cada ciclo usa um em rotação round-robin */
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
