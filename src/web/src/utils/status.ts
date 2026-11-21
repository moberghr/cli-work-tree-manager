import type { FileStatus } from '../api/client.js';

export const STATUS_LETTER: Record<FileStatus, string> = {
  added: 'A',
  deleted: 'D',
  modified: 'M',
  renamed: 'R',
  binary: 'B',
};

/** A file's change as a badge's colour (`Badge kind="letter"`): green added, red deleted, amber modified, blue renamed, grey binary. */
export const STATUS_TONE: Record<FileStatus, 'ok' | 'danger' | 'warn' | 'accent' | 'neutral'> = {
  added: 'ok',
  deleted: 'danger',
  modified: 'warn',
  renamed: 'accent',
  binary: 'neutral',
};
