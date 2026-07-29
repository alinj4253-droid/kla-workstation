import pino from 'pino';
import { join } from 'node:path';
import { app } from 'electron';

let _logger: pino.Logger | null = null;

function resolveLogLevel(): string {
  if (process.env.NODE_ENV === 'test') return 'silent';
  return process.env.LOG_LEVEL || 'info';
}

export function getLogger(studioRoot?: string): pino.Logger {
  if (_logger) return _logger;

  const logDir = studioRoot
    ? join(studioRoot, '.kstudio', 'logs')
    : join(app.getPath('userData'), '.kstudio', 'logs');

  _logger = pino({
    level: resolveLogLevel(),
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
      paths: [
        'secret', 'password', 'token', 'key', 'ciphertext', 'authorization',
        '*API_KEY', '*API_TOKEN', '*_TOKEN', '*_SECRET',
        'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'CODEX_API_KEY', 'CLAUDE_API_KEY',
        'GEMINI_API_KEY', 'GITHUB_TOKEN', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY',
      ],
      censor: '[REDACTED]',
    },
  });

  _logger.info({ level: resolveLogLevel(), logDir }, 'Logger initialized');

  return _logger;
}

export function closeLogger(): void {
  if (_logger) {
    _logger.info('Logger closing');
    _logger = null;
  }
}
