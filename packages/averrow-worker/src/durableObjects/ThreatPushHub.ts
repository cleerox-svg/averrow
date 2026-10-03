/**
 * ThreatPushHub — Cloudflare Durable Object for WebSocket threat push.
 *
 * DORMANT (2026-10): no Worker route upgrades into this DO and nothing
 * calls broadcastThreat() / POSTs /broadcast. The former unauthenticated
 * `GET /ws/threats` route in routes/public.ts was removed (appsec). The
 * class + THREAT_PUSH_HUB binding stay deployed because deleting a DO
 * class requires a `deleted_classes` migration tag in wrangler.toml.
 * If live push is wired, mount the upgrade route behind a staff guard
 * (pinned by test/ws-threats-route.test.ts).
 */

export interface ThreatPushMessage {
  type: "threat_new" | "stats_update" | "ping";
  payload?: unknown;
  ts: number;
}

export class ThreatPushHub {
  private sessions: Set<WebSocket> = new Set();

  constructor(
    private state: DurableObjectState,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    private env: unknown
  ) {}

  // ─── Handle incoming requests ─────────────────────────────────
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // WebSocket upgrade from browser client
    if (request.headers.get("Upgrade") === "websocket") {
      return this.handleWebSocket(request);
    }

    // Internal broadcast (called from feed runner / threat handler)
    if (request.method === "POST" && url.pathname === "/broadcast") {
      return this.handleBroadcast(request);
    }

    // Stats endpoint
    if (request.method === "GET" && url.pathname === "/stats") {
      return Response.json({ connections: this.sessions.size });
    }

    return new Response("Not found", { status: 404 });
  }

  // ─── WebSocket upgrade ────────────────────────────────────────
  private handleWebSocket(request: Request): Response {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];

    this.state.acceptWebSocket(server);
    this.sessions.add(server);

    // Send initial ping to confirm connection
    const initMsg: ThreatPushMessage = { type: "ping", ts: Date.now() };
    server.send(JSON.stringify(initMsg));

    server.addEventListener("close", () => {
      this.sessions.delete(server);
    });

    server.addEventListener("error", () => {
      this.sessions.delete(server);
    });

    server.addEventListener("message", (event) => {
      // Handle ping-pong keepalive from client
      try {
        const msg = JSON.parse(event.data as string) as { type?: string };
        if (msg.type === "ping") {
          server.send(JSON.stringify({ type: "ping", ts: Date.now() }));
        }
      } catch {
        // ignore malformed messages
      }
    });

    return new Response(null, { status: 101, webSocket: client });
  }

  // ─── Internal broadcast endpoint ─────────────────────────────
  private async handleBroadcast(request: Request): Promise<Response> {
    try {
      const body = await request.json() as ThreatPushMessage;
      const msg = JSON.stringify({ ...body, ts: Date.now() });
      let sent = 0;
      const dead: WebSocket[] = [];

      for (const ws of this.sessions) {
        try {
          ws.send(msg);
          sent++;
        } catch {
          dead.push(ws);
        }
      }

      // Prune dead connections
      for (const ws of dead) {
        this.sessions.delete(ws);
      }

      return Response.json({ ok: true, sent, total: this.sessions.size });
    } catch (err) {
      return Response.json({ ok: false, error: "An internal error occurred" }, { status: 400 });
    }
  }

  // ─── Public broadcast helper (called from other code) ─────────
  broadcastThreat(payload: unknown): void {
    const msg: ThreatPushMessage = { type: "threat_new", payload, ts: Date.now() };
    const serialized = JSON.stringify(msg);
    const dead: WebSocket[] = [];

    for (const ws of this.sessions) {
      try {
        ws.send(serialized);
      } catch {
        dead.push(ws);
      }
    }

    for (const ws of dead) {
      this.sessions.delete(ws);
    }
  }
}
