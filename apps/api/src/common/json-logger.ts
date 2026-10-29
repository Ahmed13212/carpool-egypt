import { LoggerService } from '@nestjs/common';

/** Structured JSON logger. Callers must never pass secrets, tokens or passwords. */
export class JsonLogger implements LoggerService {
  private write(level: string, message: unknown, context?: string) {
    const line = JSON.stringify({ ts: new Date().toISOString(), level, context, message });
    (level === 'error' ? process.stderr : process.stdout).write(line + '\n');
  }
  log(message: unknown, context?: string) {
    this.write('info', message, context);
  }
  error(message: unknown, ...rest: unknown[]) {
    this.write(
      'error',
      message,
      typeof rest[rest.length - 1] === 'string' ? (rest[rest.length - 1] as string) : undefined,
    );
  }
  warn(message: unknown, context?: string) {
    this.write('warn', message, context);
  }
  debug(message: unknown, context?: string) {
    this.write('debug', message, context);
  }
}
