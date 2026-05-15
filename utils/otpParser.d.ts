import { MailMessage } from '../types/tempMail';
export declare class OTPParser {
    static extractOTP(text: string): string | null;
    static extractFromMessageAsync(message: MailMessage): Promise<string | null>;
    /** @deprecated use extractFromMessageAsync */
    static extractFromMessage(message: MailMessage): string | null;
}
//# sourceMappingURL=otpParser.d.ts.map