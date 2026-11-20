import { Injectable, Logger } from '@nestjs/common';
import {
  createTestAccount,
  createTransport,
  getTestMessageUrl,
  SendMailOptions,
  Transporter,
} from 'nodemailer';
import SMTPTransport from 'nodemailer/lib/smtp-transport';

import { Config, metrics, OnEvent } from '../../base';

export type SendOptions = Omit<SendMailOptions, 'to' | 'subject' | 'html'> & {
  to: string;
  subject: string;
  html: string;
};

function configToSMTPOptions(
  config: AppConfig['mailer']['SMTP']
): SMTPTransport.Options {
  return {
    host: config.host,
    port: config.port,
    tls: {
      rejectUnauthorized: !config.ignoreTLS,
    },
    auth: {
      user: config.username,
      pass: config.password,
    },
  };
}

@Injectable()
export class MailSender {
  private readonly logger = new Logger(MailSender.name);
  private smtp: Transporter<SMTPTransport.SentMessageInfo> | null = null;
  private usingTestAccount = false;
  constructor(private readonly config: Config) {}

  static create(config: Config['mailer']['SMTP']) {
    return createTransport(configToSMTPOptions(config));
  }

  get configured() {
    // NOTE: testing environment will use mock queue, so we need to return true
    return this.smtp !== null || env.testing;
  }

  @OnEvent('config.init')
  onConfigInit() {
    this.setup();
  }

  @OnEvent('config.changed')
  onConfigChanged(event: Events['config.changed']) {
    if ('mailer' in event.updates) {
      this.setup();
    }
  }

  private setup() {
    const { SMTP } = this.config.mailer;
    const opts = configToSMTPOptions(SMTP);

    if (SMTP.host) {
      this.smtp = createTransport(opts);
    } else if (env.dev) {
      createTestAccount((err, account) => {
        if (!err) {
          this.smtp = createTransport({
            ...opts,
            ...account.smtp,
            auth: {
              user: account.user,
              pass: account.pass,
            },
          });
          this.usingTestAccount = true;
        }
      });
    } else {
      this.logger.warn('Mailer SMTP transport is not configured.');
      this.smtp = null;
    }
  }

  private async sendViaResend(name: string, options: SendOptions) {
    metrics.mail.counter('send_total').add(1, { name });
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: this.config.mailer.SMTP.sender,
          to: [options.to],
          subject: options.subject,
          html: options.html,
        }),
      });

      if (!res.ok) {
        metrics.mail.counter('rejected_total').add(1, { name });
        this.logger.error(
          `Mail [${name}] rejected by Resend: ${res.status} ${await res.text()}`
        );
        return false;
      }

      metrics.mail.counter('accepted_total').add(1, { name });
      this.logger.debug(`Mail [${name}] sent successfully via Resend.`);
      return true;
    } catch (e) {
      metrics.mail.counter('failed_total').add(1, { name });
      this.logger.error(`Failed to send mail [${name}] via Resend.`, e);
      return false;
    }
  }

  async send(name: string, options: SendOptions) {
    // Railway blocks outbound SMTP on lower-tier plans; use Resend's HTTPS API when a key is set.
    if (process.env.RESEND_API_KEY) {
      return this.sendViaResend(name, options);
    }

    if (!this.smtp) {
      this.logger.warn(`Mailer SMTP transport is not configured to send mail.`);
      return null;
    }

    metrics.mail.counter('send_total').add(1, { name });
    try {
      const result = await this.smtp.sendMail({
        from: this.config.mailer.SMTP.sender,
        ...options,
      });

      if (result.rejected.length > 0) {
        metrics.mail.counter('rejected_total').add(1, { name });
        this.logger.error(
          `Mail [${name}] rejected with response: ${result.response}`
        );
        return false;
      }

      metrics.mail.counter('accepted_total').add(1, { name });
      this.logger.debug(`Mail [${name}] sent successfully.`);
      if (this.usingTestAccount) {
        this.logger.debug(
          `  ⚙️ Mail preview url: ${getTestMessageUrl(result)}`
        );
      }

      return true;
    } catch (e) {
      metrics.mail.counter('failed_total').add(1, { name });
      this.logger.error(`Failed to send mail [${name}].`, e);
      return false;
    }
  }
}
