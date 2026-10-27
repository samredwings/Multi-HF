const EXACT = new Set(["huggingface.co", "www.huggingface.co", "hf.co", "router.huggingface.co"]);
export function isAllowedHfUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password) return false;
    const host = url.hostname.toLowerCase();
    return EXACT.has(host) || (host.endsWith(".hf.space") && !host.includes("..") && host.length < 200);
  } catch { return false; }
}
export function parseSpaceInput(raw: string): { id?: string; host?: string } | null {
  const text = raw.trim();
  if (!text) return null;
  if (/^[\w.-]+\/[\w.-]+$/.test(text) && !text.includes("..")) return { id: text };
  try {
    const url = new URL(text);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    if (url.hostname === "huggingface.co" || url.hostname === "www.huggingface.co" || url.hostname === "hf.co") {
      const parts = url.pathname.split("/").filter(Boolean);
      const index = parts[0] === "spaces" ? 1 : 0;
      const owner = parts[index], name = parts[index + 1];
      if (owner && name && !owner.includes("..") && !name.includes("..")) return { id: `${owner}/${name}` };
      return null;
    }
    if (url.hostname.endsWith(".hf.space") && isAllowedHfUrl(url.origin)) return { host: url.origin };
  } catch { return null; }
  return null;
}
export function spaceHubUrl(id: string, suffix = ""): string {
  const [owner, name, ...extra] = id.split("/");
  if (!owner || !name || extra.length || owner.includes("..") || name.includes("..")) throw new Error("Invalid Space ID");
  return `https://huggingface.co/api/spaces/${encodeURIComponent(owner)}/${encodeURIComponent(name)}${suffix}`;
}
export function modelHubUrl(id: string): string {
  const parts = id.split("/");
  if (parts.length < 2 || parts.some(p => !p || p.includes(".."))) throw new Error("Invalid model ID");
  return `https://huggingface.co/api/models/${parts.map(encodeURIComponent).join("/")}`;
}
export function inferenceUrl(id: string): string {
  const parts = id.split("/");
  if (parts.length < 2 || parts.some(p => !p || p.includes(".."))) throw new Error("Invalid model ID");
  return `https://router.huggingface.co/hf-inference/models/${parts.map(encodeURIComponent).join("/")}`;
}
export function normalizeHost(host: string | undefined, subdomain?: string): string {
  if (host?.startsWith("https://")) return host.replace(/\/$/, "");
  if (host?.endsWith(".hf.space")) return `https://${host}`.replace(/\/$/, "");
  if (subdomain && /^[a-z0-9-]+$/i.test(subdomain)) return `https://${subdomain}.hf.space`;
  return "";
}
