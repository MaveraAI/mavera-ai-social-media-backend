// Server-only client for the n8n content API (brands, jobs, publishing).
// The shared secret stays on the server; callers must authorize the user first.
const BASE = "https://mavera.app.n8n.cloud/webhook";

export async function smRequest<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const started = performance.now();
  const secret = process.env['SM_API_SECRET'];
  if (!secret) throw new Error("Content API is not configured");
  const res = await fetch(`${BASE}/${path}`, {
    method: init?.method ?? "GET",
    headers: { "x-sm-secret": secret, "Content-Type": "application/json" },
    body: init?.body ? JSON.stringify(init.body) : null,
    signal: AbortSignal.timeout(init?.method === 'POST' ? 90_000 : 25_000),
  }).catch((error: unknown) => {
    if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) throw new Error('The content service took too long to respond. Please retry.');
    throw new Error('Could not reach the content service. Please retry.');
  });
  const text = await res.text();
  const upstreamMs = Math.round(performance.now() - started);
  console.info('Content service timing', { endpoint: path.split('?')[0], method: init?.method ?? 'GET', status: res.status, durationMs: upstreamMs, bytes: new TextEncoder().encode(text).byteLength });
  let data: any = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { errors: [text.slice(0, 300)] }; }
  if (!res.ok || data?.ok === false) {
    console.error(`Content API ${path} [${res.status}]: ${text.slice(0, 500)}`);
    const msg = Array.isArray(data?.errors) ? data.errors.join("; ") : `Content API error ${res.status}`;
    throw new Error(res.status === 403 ? "Content API rejected the connection (403)" : msg);
  }
  return data as T;
}
