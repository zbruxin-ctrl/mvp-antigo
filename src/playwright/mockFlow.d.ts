import { EmailProvider } from '../types';
export declare class MockPlaywrightFlow {
    /**
     * Inicia o browser (Brave).
     *
     * Regras de proxy no launch:
     * - Se há proxies configurados → lança com --proxy-server=<primeiro proxy>
     *   para que TODO o tráfego (incluindo DNS e requests fora dos contextos)
     *   passe pelo proxy. Cada contexto ainda pode sobrescrever com seu próprio.
     * - Se NÃO há proxies → lança com --proxy-server="" para que o Brave herde
     *   a configuração de rede do sistema operacional (inclui VPN ativa).
     *
     * Se a configuração de proxy mudar entre calls, o browser anterior é destruído
     * e um novo é lançado com as novas configurações.
     */
    static init(headless?: boolean): Promise<void>;
    static execute(cadastroUrl: string, config: {
        emailProvider: EmailProvider;
        tempMailApiKey: string;
        otpTimeout: number;
        extraDelay: number;
        inviteCode: string;
    }, cycle: number): Promise<void>;
    private static _executarCiclo;
    static cleanup(): Promise<void>;
}
//# sourceMappingURL=mockFlow.d.ts.map