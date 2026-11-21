/** Terminal progress primitives shared by the CLI and the release scripts. */
export const PROGRESS_FRAMES = ['|', '/', '-', '\\'] as const;

export function progressFrame(index: number): string {
  return PROGRESS_FRAMES[Math.abs(index) % PROGRESS_FRAMES.length];
}

export function clearProgressLine(color: boolean): string {
  return color ? '\r\x1b[2K' : '\r';
}

export function formatElapsed(elapsedMs: number): string {
  return (elapsedMs / 1000).toFixed(1) + 's';
}
