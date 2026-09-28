import { describe, it, expect } from 'vitest';
import { buildStartupScript } from '../../src/core/autostart.js';

describe('buildStartupScript', () => {
  it('runs work web hidden with both paths quoted for spaces', () => {
    const vbs = buildStartupScript('C:\Program Files\nodejs\node.exe', 'C:\a b\dist\bin.js');
    expect(vbs).toContain(
      'CreateObject("WScript.Shell").Run """C:\Program Files\nodejs\node.exe"" ""C:\a b\dist\bin.js"" web --no-open", 0, False',
    );
  });
});
