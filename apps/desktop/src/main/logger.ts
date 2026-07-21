import pino from 'pino';
import { join } from 'node:path';

let _logger: pino.Logger | null = null;

export function getLogger(studioRoot?: string): pino.Logger {
  if (_logger) return _logger;

  const logDir = studioRoot
    ? join(studioRoot, '.kstudio', 'logs')
    : join('K_Studio', '.kstudio', 'logs');

  _logger = pino({
    level: process.env.NODE_ENV === 'test' ? 'silent' : 'info',
    transport: {
      target: 'pino/file',
      options: {
        destination: join(logDir, 'app.log'),
        mkdir: true,
      },
    },
    serializers: {
      err: pino.stdSerializers.err,
    },
    redact: {
      paths: ['secret', 'password', 'token', 'key', 'ciphertext', 'authorization'],
      censor: '[REDACTED]',
    },
  });

  return _logger;
}

export function closeLogger(): void {
  _logger = null;
}
