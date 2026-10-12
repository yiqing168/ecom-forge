import { randomUUID } from 'node:crypto';

import type { MailAdapter, MailDispatchResult, VerificationMail } from './mail.types.js';

export class FakeMailAdapter implements MailAdapter {
  readonly provider = 'fake' as const;
  readonly messages: VerificationMail[] = [];

  sendVerificationMail(message: VerificationMail): Promise<MailDispatchResult> {
    this.messages.push({ ...message });
    return Promise.resolve({ state: 'accepted', providerMessageId: `fake-${randomUUID()}` });
  }
}
