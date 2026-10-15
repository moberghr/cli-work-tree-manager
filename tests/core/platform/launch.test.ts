import { describe, expect, it } from 'vitest';
import { editorArgs } from '../../../src/core/platform/launch.js';

describe('editorArgs', () => {
  const folder = '/wt/api';
  const file = { path: '/wt/api/src/cart.ts', line: 42 };

  it('no file: the folder, as the session menu always did', () => {
    expect(editorArgs('code', folder)).toEqual([folder]);
    expect(editorArgs('notepad', folder)).toEqual([folder]);
  });

  it("VS Code and its kin: the folder's window, the file at its line", () => {
    expect(editorArgs('code', folder, file)).toEqual([folder, '--goto', '/wt/api/src/cart.ts:42']);
    expect(editorArgs('C:\\Program Files\\Microsoft VS Code\\bin\\code.cmd', folder, file)).toEqual([
      folder,
      '--goto',
      '/wt/api/src/cart.ts:42',
    ]);
    expect(editorArgs('cursor', folder, file)[1]).toBe('--goto');
    expect(editorArgs('code-insiders', folder, { path: file.path })).toEqual([folder, '--goto', file.path]); // no line
  });

  it('JetBrains and Sublime take a line their own way', () => {
    expect(editorArgs('rider64.exe', folder, file)).toEqual([folder, '--line', '42', file.path]);
    expect(editorArgs('idea', folder, { path: file.path })).toEqual([folder, file.path]);
    expect(editorArgs('subl', folder, file)).toEqual([folder, '/wt/api/src/cart.ts:42']);
  });

  it('an editor it does not know gets the file alone, never a made-up line flag', () => {
    expect(editorArgs('notepad', folder, file)).toEqual([file.path]);
    expect(editorArgs('vim', folder, file)).toEqual([file.path]);
  });
});
