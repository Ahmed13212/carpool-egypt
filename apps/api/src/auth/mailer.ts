import { Inject, Injectable, Logger } from '@nestjs/common';
import { ENV, Env } from '../config/env';

export interface MailMessage {
  to: string;
  kind: 'email_verification' | 'password_reset';
  token: string;
}

/**
 * DEVELOPMENT mail adapter. It does NOT deliver email. Outside production it keeps messages in memory
 * (tests read tokens from here). In production it only logs recipient+kind, never the token.
 * A real provider (SES/SendGrid/...) must replace this before launch - see docs/known-limitations.
 */
@Injectable()
export class DevMailer {
  private readonly logger = new Logger('DevMailer');
  readonly outbox: MailMessage[] = [];
  constructor(@Inject(ENV) private readonly env: Env) {}

  async send(msg: MailMessage): Promise<void> {
    if (this.env.NODE_ENV !== 'production') {
      this.outbox.push(msg);
      if (this.outbox.length > 200) this.outbox.shift();
    }
    this.logger.log(JSON.stringify({ msg: 'mail_not_delivered_dev_adapter', to: msg.to, kind: msg.kind }));
  }

  lastTokenFor(email: string, kind: MailMessage['kind']): string | undefined {
    return [...this.outbox]
      .reverse()
      .find((m) => m.to.toLowerCase() === email.toLowerCase() && m.kind === kind)?.token;
  }
}
