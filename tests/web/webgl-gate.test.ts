import { describe, expect, it, vi } from 'vitest';
import { gpuName, webglRefusal } from '../../src/web/src/state/webgl-gate.js';

describe('webglRefusal', () => {
  it.each([
    'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)',
    'Google SwiftShader',
    'llvmpipe (LLVM 15.0.7, 256 bits)',
    'softpipe',
    'ANGLE (Microsoft, Microsoft Basic Render Driver Direct3D11 vs_5_0 ps_5_0, D3D11)',
    'Apple Software Renderer',
  ])('refuses a software rasterizer: %s', (name) => {
    expect(webglRefusal(name)).toBe('software');
  });

  it.each([
    'ANGLE (Apple, ANGLE Metal Renderer: Apple M3 Pro, Unspecified Version)',
    'ANGLE (NVIDIA, NVIDIA GeForce RTX 3080 Direct3D11 vs_5_0 ps_5_0, D3D11)',
    'ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)',
    'Mesa Intel(R) UHD Graphics 620 (KBL GT2)',
    'Apple GPU',
  ])('takes a GPU: %s', (name) => {
    expect(webglRefusal(name)).toBeNull();
  });

  it('a name it could not read is no reason to refuse: the addon tries, and falls back itself', () => {
    expect(webglRefusal(null)).toBeNull();
  });
});

const UNMASKED = 0x9246;
const RENDERER = 0x1f01;

function fakeDoc(gl: object | null | 'throws') {
  const canvas = {
    getContext: vi.fn(() => {
      if (gl === 'throws') throw new Error('blocked');
      return gl;
    }),
  };
  return { createElement: () => canvas as unknown as HTMLCanvasElement };
}

function fakeGl(opts: { debugInfo: boolean; names: Record<number, unknown> }) {
  const loseContext = vi.fn();
  const gl = {
    RENDERER,
    getExtension: (name: string) =>
      name === 'WEBGL_debug_renderer_info' ? (opts.debugInfo ? { UNMASKED_RENDERER_WEBGL: UNMASKED } : null) : { loseContext },
    getParameter: (p: number) => opts.names[p],
  };
  return { gl, loseContext };
}

describe('gpuName', () => {
  it('reads the unmasked name where the browser gives it, and lets the probe context go', () => {
    const { gl, loseContext } = fakeGl({ debugInfo: true, names: { [UNMASKED]: 'llvmpipe', [RENDERER]: 'WebKit WebGL' } });
    expect(gpuName(fakeDoc(gl))).toBe('llvmpipe');
    expect(loseContext).toHaveBeenCalledOnce();
  });

  it('reads RENDERER where the unmasked one is not offered (Firefox, Safari)', () => {
    const { gl, loseContext } = fakeGl({ debugInfo: false, names: { [RENDERER]: 'Apple GPU' } });
    expect(gpuName(fakeDoc(gl))).toBe('Apple GPU');
    expect(loseContext).toHaveBeenCalledOnce();
  });

  it('is null with no WebGL2 context, or with WebGL blocked', () => {
    expect(gpuName(fakeDoc(null))).toBeNull();
    expect(gpuName(fakeDoc('throws'))).toBeNull();
  });

  it('is null for an empty or non-string name', () => {
    expect(gpuName(fakeDoc(fakeGl({ debugInfo: true, names: { [UNMASKED]: '' } }).gl))).toBeNull();
    expect(gpuName(fakeDoc(fakeGl({ debugInfo: true, names: { [UNMASKED]: 7 } }).gl))).toBeNull();
  });
});
