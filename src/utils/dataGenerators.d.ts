import { EmailAccount } from '../types/tempMail';
export interface RegistrationPayload {
    email: string;
    telefone: string;
    senha: string;
    nome: string;
    sobrenome: string;
    mes: string;
    dia: string;
    ano: string;
    cidade: string;
    localizacao: string;
    codigoIndicacao: string;
}
export declare function gerarTelefone(): string;
export declare function gerarTelefoneFormatado(): string;
/** @deprecated Use gerarTelefone() */
export declare function gerarTelefoneFixo(): string;
export declare function gerarNome(): string;
export declare function gerarSobrenome(): string;
export declare function gerarPayloadCompleto(emailAccount?: EmailAccount, inviteCode?: string): RegistrationPayload;
export declare function gerarPayloads(qtd?: number): RegistrationPayload[];
//# sourceMappingURL=dataGenerators.d.ts.map