import type { FileStatus } from '../api/client.js';

export const STATUS_LETTER: Record<FileStatus, string> = {
  added: 'A',
  deleted: 'D',
  modified: 'M',
  renamed: 'R',
  binary: 'B',
};
