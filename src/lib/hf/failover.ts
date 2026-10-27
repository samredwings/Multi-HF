export type FailureKind = "quota" | "auth" | "waking" | "switch" | "fatal" | "policy";
const POLICY = /content policy|safety filter|moderation|nsfw filter|flagged as/i;
const AUTH = /invalid username or password|invalid token|token is invalid|unauthorized|\b401\b|expired token|not authenticated/i;
const QUOTA = /zero\s*gpu|gpu quota|quota exceeded|out of credits|insufficient credit|payment required|monthly (included )?credit|depleted|spend limit|exceeded your (free|gpu|quota)/i;
const WAKING = /asleep|waking|is starting|space is (sleep|start|build|paused)|currently loading|loading (the )?model|model is loading|building replica/i;
const TRANSIENT = /timeout|timed out|econnreset|socket hang up|network|fetch failed|bad gateway|gateway timeout|connection (closed|reset|dropped|aborted)|runtime (has )?(ended|expired)|upstream|overloaded|rate limit|too many requests|\b429\b|\b502\b|\b503\b|\b504\b|\b524\b|no gpu|disconnected/i;
export function classifyFailure(status: number | undefined, message: string): FailureKind {
  const text = `${status ?? ""} ${message}`;
  if (POLICY.test(text)) return "policy";
  if (status === 401 || AUTH.test(message)) return "auth";
  if (status === 402 || QUOTA.test(text)) return "quota";
  if (WAKING.test(text)) return "waking";
  if (status === 429 || status === 502 || status === 503 || status === 504 || TRANSIENT.test(text) || (status != null && status >= 500)) return "switch";
  if (status === 400 || status === 404 || status === 422) return "fatal";
  return message ? "fatal" : "switch";
}
/** Only use a server-reported reset time. Never fabricate a quota reset timestamp. */
export function holdFor(kind: FailureKind, message: string, resetsAt: string | null): number | null {
  if (kind === "quota" && resetsAt) {
    const t = Date.parse(resetsAt);
    if (Number.isFinite(t) && t > Date.now()) return t;
  }
  if (kind === "switch" && /rate limit|too many requests|\b429\b/i.test(message)) return Date.now() + 2 * 60 * 1000;
  return null;
}
