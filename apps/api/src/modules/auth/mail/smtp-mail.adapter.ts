import nodemailer from 'nodemailer';

import type { MailAdapter, MailDispatchResult, VerificationMail } from './mail.types.js';

export interface SmtpMailAdapterOptions {
  host: string;
  port: number;
  from: string;
}

function subject(message: VerificationMail): string {
  return message.purpose === 'email_verification' ? '验证你的邮箱' : '重置你的密码';
}

function isAmbiguousTransportError(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('code' in error)) {
    return true;
  }
  return ['ETIMEDOUT', 'ECONNRESET', 'EPIPE'].includes(String(error.code));
}

function messageId(result: unknown): string | undefined {
  if (!result || typeof result !== 'object' || !('messageId' in result)) return undefined;
  return typeof result.messageId === 'string' ? result.messageId : undefined;
}

export class SmtpMailAdapter implements MailAdapter {
  readonly provider = 'smtp' as const;
  private readonly transport: nodemailer.Transporter;

  constructor(private readonly options: SmtpMailAdapterOptions) {
    this.transport = nodemailer.createTransport({
      host: options.host,
      port: options.port,
      secure: false,
    });
  }

  async sendVerificationMail(message: VerificationMail): Promise<MailDispatchResult> {
    try {
      const result: unknown = await this.transport.sendMail({
        from: this.options.from,
        to: message.recipient,
        subject: subject(message),
        text: `验证码：${message.otp}\n${message.expiresInMinutes} 分钟内有效。`,
      });
      const providerMessageId = messageId(result);
      return {
        state: 'accepted',
        ...(providerMessageId ? { providerMessageId } : {}),
      };
    } catch (error) {
      return isAmbiguousTransportError(error)
        ? { state: 'outcome_unknown', errorCode: 'SMTP_OUTCOME_UNKNOWN' }
        : { state: 'not_dispatched', errorCode: 'SMTP_NOT_DISPATCHED' };
    }
  }
}
