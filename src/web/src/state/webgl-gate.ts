/**
 * Whether the Terminal tab may use the WebGL renderer here at all (terminal-rendering.md, "Fonts and the renderer").
 *
 * A software rasterizer — SwiftShader (Chromium with no usable GPU: a VM, a remote desktop, a blocklisted driver),
 * llvmpipe / softpipe (Mesa with no GPU driver), Microsoft Basic Render Driver (WARP), Apple Software Renderer — gives
 * a WebGL context that works, but draws it on the CPU: the "GPU" renderer is then a slower CPU renderer than the DOM
 * one, and holds a context for nothing. On one, the tab draws with the DOM renderer. Hermes gates the same names
 * (web/src/lib/xterm-webgl-gating.ts).
 *
 * Safari is not refused: the addon itself refuses Safari below 16 (it throws, and the tab falls back), and the one
 * report against later versions (Hermes #18773) names no cause; VS Code, which runs in Safari as vscode.dev, gates none.
 *
 * Import-free: the probe takes the document it creates its canvas in.
 */

/** A renderer name that is a software rasterizer's. */
export const SOFTWARE_RENDERER = /swiftshader|llvmpipe|softpipe|software|basic render driver/i;

/** Why WebGL is not used here, or null when it may be (a name that couldn't be read is not a reason: the addon tries). */
export function webglRefusal(rendererName: string | null): 'software' | null {
  return rendererName !== null && SOFTWARE_RENDERER.test(rendererName) ? 'software' : null;
}

interface ProbeGl {
  getExtension(name: string): unknown;
  getParameter(p: number): unknown;
  readonly RENDERER: number;
}

/**
 * The GPU's name as WebGL reports it, or null when it can't be told (no WebGL2, or the name withheld). The probe's
 * context is let go at once: browsers cap live contexts, and this one would count until the canvas is collected.
 */
export function gpuName(doc: { createElement(tag: 'canvas'): HTMLCanvasElement }): string | null {
  let gl: ProbeGl | null = null;
  try {
    gl = doc.createElement('canvas').getContext('webgl2') as ProbeGl | null;
  } catch {
    /* WebGL blocked: unknown, the addon finds out */
  }
  if (!gl) return null;
  try {
    // Chromium answers the unmasked name; Firefox and Safari a sanitised one through either. Both name a rasterizer.
    const info = gl.getExtension('WEBGL_debug_renderer_info') as { UNMASKED_RENDERER_WEBGL: number } | null;
    const name = gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER);
    return typeof name === 'string' && name ? name : null;
  } catch {
    return null;
  } finally {
    try {
      (gl.getExtension('WEBGL_lose_context') as { loseContext(): void } | null)?.loseContext();
    } catch {
      /* already lost */
    }
  }
}

let refusal: 'software' | null | undefined;

/** Why WebGL is not used in this page, probed once (the GPU doesn't change under a page; a lost context is recovery's). */
export function pageWebglRefusal(doc: { createElement(tag: 'canvas'): HTMLCanvasElement } = document): 'software' | null {
  if (refusal === undefined) refusal = webglRefusal(gpuName(doc));
  return refusal;
}
