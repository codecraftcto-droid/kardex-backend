import pino from 'pino';
import { env } from '../config/env.js';

export const logger = pino({
  level: env.NODE_ENV === 'test' ? 'silent' : 'info',
  redact: {
    paths: ['req.headers.authorization', 'req.headers.cookie', '*.password', '*.passwordHash', '*.token'],
    censor: '[oculto]',
  },
  transport: env.isProd ? undefined : { target: 'pino-pretty', options: { colorize: true } },
});
