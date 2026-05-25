type LogLevel = 'debug' | 'info' | 'warn' | 'error';

type LogMeta = Record<string, unknown> | undefined;

const isDev = import.meta.env.DEV;

function emit(level: LogLevel, event: string, meta?: LogMeta) {
  if (!isDev && level === 'debug') return;
  const payload = {
    ts: new Date().toISOString(),
    level,
    event,
    ...meta,
  };
  const line = JSON.stringify(payload);
  if (level === 'error') {
    console.error(line);
    return;
  }
  if (level === 'warn') {
    console.warn(line);
    return;
  }
  if (level === 'info') {
    console.info(line);
    return;
  }
  console.debug(line);
}

export const logger = {
  debug(event: string, meta?: LogMeta) {
    emit('debug', event, meta);
  },
  info(event: string, meta?: LogMeta) {
    emit('info', event, meta);
  },
  warn(event: string, meta?: LogMeta) {
    emit('warn', event, meta);
  },
  error(event: string, meta?: LogMeta) {
    emit('error', event, meta);
  },
};
