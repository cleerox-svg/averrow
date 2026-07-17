export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  event: string;
  [key: string]: any;
}

export function log(level: LogLevel, event: string, data?: Record<string, any>): void {
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    event,
    ...data,
  }));
}

// Convenience methods
export const logger = {
  debug: (event: string, data?: Record<string, any>) => log('debug', event, data),
  info: (event: string, data?: Record<string, any>) => log('info', event, data),
  warn: (event: string, data?: Record<string, any>) => log('warn', event, data),
  error: (event: string, data?: Record<string, any>) => log('error', event, data),
};
