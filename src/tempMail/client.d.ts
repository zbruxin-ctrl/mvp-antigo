import { EmailAccount, IEmailClient } from '../types/tempMail';
export declare class TempMailClient implements IEmailClient {
    private config;
    constructor(apiKey: string);
    private request;
    createRandomEmail(): Promise<EmailAccount>;
    private listMessages;
    private getFullMessage;
    waitForOTP(email: string, timeoutMs?: number, cycle?: number): Promise<string>;
}
export declare class MailTmClient implements IEmailClient {
    private baseUrl;
    private authToken;
    private accountEmail;
    private accountPassword;
    private generatePassword;
    private request;
    private relogin;
    createRandomEmail(): Promise<EmailAccount>;
    private listMessages;
    private getFullMessage;
    waitForOTP(email: string, timeoutMs?: number, cycle?: number): Promise<string>;
}
export declare function createEmailClient(provider: 'temp-mail.io' | 'mail.tm', apiKey?: string): IEmailClient;
//# sourceMappingURL=client.d.ts.map