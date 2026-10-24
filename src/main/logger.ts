import { existsSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import log from 'electron-log/main';
import { redactLogValue } from './log-redaction';

const MAX_LOG_BYTES = 2 * 1024 * 1024;
const LOG_GENERATIONS = 4;

log.transports.file.level = 'info';
log.transports.file.maxSize = MAX_LOG_BYTES;
log.transports.file.resolvePathFn = () => {
  const localAppData = process.env['LOCALAPPDATA'];
  if (localAppData !== undefined && localAppData.length > 0) {
    return join(localAppData, 'WindhawkProfileManager', 'logs', 'main.log');
  }
  return join(process.cwd(), 'logs', 'main.log');
};
log.transports.console.level = process.env['NODE_ENV'] === 'development' ? 'debug' : 'info';

// electron-log only keeps one archive by default. Keep current + four archives
// (five files total), all capped at 2 MiB.
log.transports.file.archiveLogFn = (oldLogFile) => {
  const path = oldLogFile.path;
  if (existsSync(`${path}.${LOG_GENERATIONS}`)) unlinkSync(`${path}.${LOG_GENERATIONS}`);
  for (let index = LOG_GENERATIONS - 1; index >= 1; index -= 1) {
    const source = `${path}.${index}`;
    if (existsSync(source)) renameSync(source, `${path}.${index + 1}`);
  }
  renameSync(path, `${path}.1`);
};

log.hooks.push((message) => {
  message.data = message.data.map((value) => redactLogValue(value));
  return message;
});

export const logger = log;
