export type EmailProvider = 'temp-mail.io' | 'mail.tm';

export interface TempMailConfig {
  apiKey: string;
  baseUrl: string;
}

export interface MailTmConfig {
  baseUrl: string;
}

export interface EmailAccount {
  email: string;
  token: string;
}

export interface MailMessage {
  mail_id: string;
  mail_from: string;
  mail_to: string;
  mail_subject: string;
  mail_preview: string;
  mail_html: string;
  mail_text: string;
  created_at: string;
  attachments?: unknown[];
}

export interface TempMailError {
  code: number;
  message: string;
}

/** Interface comum para qualquer provider de email temporário */
export interface IEmailClient {
  createRandomEmail(): Promise<EmailAccount>;
  waitForOTP(email: string, timeoutMs?: number, cycle?: number): Promise<string>;
}
