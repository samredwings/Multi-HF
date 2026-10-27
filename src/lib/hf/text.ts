/** Small shared helpers; these functions do not perform I/O. */
export function stripEmoji(input: string): string {
  return input.replace(/\p{Extended_Pictographic}/gu, "").replace(/[\u200d\ufe0f]/g, "").replace(/\s+/g, " ").trim();
}
export function redact(input: string): string {
  return input.replace(/hf_[A-Za-z0-9_-]{6,}/g, "hf_…").replace(/\beyJ[A-Za-z0-9_-]{20,}/g, "jwt…");
}
export function clampText(input: string, max = 500): string {
  const clean = redact(input).replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}
export function formatGpu(seconds: number | null): string {
  if (seconds == null || !Number.isFinite(seconds)) return "Unknown";
  const s = Math.max(0, Math.round(seconds));
  const m = Math.floor(s / 60);
  return m <= 0 ? `${s}s` : `${m}m ${String(s % 60).padStart(2, "0")}s`;
}
export function uid(): string { return crypto.randomUUID(); }
export function isAbort(err: unknown): boolean {
  return (err instanceof DOMException && err.name === "AbortError") || (err instanceof Error && err.name === "AbortError");
}
