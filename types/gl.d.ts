/**
 * headless-gl has no types. It is only used by tools/shots.ts, which renders
 * the first-person view to a PNG on a machine with no browser.
 */
declare module 'gl' {
  export default function createGL(
    width: number, height: number, opts?: Record<string, unknown>,
  ): WebGLRenderingContext & { readPixels: WebGLRenderingContext['readPixels'] };
}
