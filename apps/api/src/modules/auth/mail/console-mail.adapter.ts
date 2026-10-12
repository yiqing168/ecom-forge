import type { MailAdapter, MailDispatchResult, VerificationMail } from './mail.types.js';

function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!local || !domain) {
    return '[invalid-recipient]';
  }
  return `${local.slice(0, 1)}***@${domain}`;
}

export class ConsoleMailAdapter implements MailAdapter {
  readonly provider = 'console' as const;

  sendVerificationMail(message: VerificationMail): Promise<MailDispatchResult> {
    console.info(
      `[DEV MAIL] ${message.purpose}:${maskEmail(message.recipient)} -> ${message.otp} (${message.expiresInMinutes}m)`,
    );
    return Promise.resolve({ state: 'accepted', providerMessageId: `console-${Date.now()}` });
  }
}
