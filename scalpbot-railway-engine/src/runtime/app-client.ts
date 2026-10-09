/** Thin client for the dashboard's /api/public/worker/* endpoints. Authenticates with WORKER_SECRET. */
export type AppResponse<T = unknown> = { status: number; body: T | null; error?: string };

export class AppClient {
  constructor(
    private readonly baseUrl: string,
    private readonly secret: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 15_000,
  ) {}

  async call<T = unknown>(method: "GET" | "POST", path: string, body?: unknown): Promise<AppResponse<T>> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.baseUrl.replace(/\/$/, "")}/api/public/worker/${path}`, {
        method,
        headers: { Authorization: `Bearer ${this.secret}`, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctrl.signal,
      });
      const text = await res.text();
      let parsed: T | null = null;
      try {
        parsed = text ? (JSON.parse(text) as T) : null;
      } catch {
        return { status: res.status, body: null, error: `non-JSON response: ${text.slice(0, 200)}` };
      }
      return { status: res.status, body: parsed };
    } catch (e) {
      return { status: 0, body: null, error: e instanceof Error ? e.message : "request failed" };
    } finally {
      clearTimeout(timer);
    }
  }
}
