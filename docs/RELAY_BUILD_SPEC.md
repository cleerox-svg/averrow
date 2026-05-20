# Relay — Build Specification

> **Project:** Relay — a BBM-inspired secure messenger
> **Owner:** Claude Leroux, LRX Enterprises Inc.
> **Stack:** Cloudflare Workers + D1 + Durable Objects + R2 + React PWA
> **Heritage:** PIN-based identity, D/R receipts, PING!! — the iconic BBM UX, rebuilt for 2026
> **Deployment:**
> &nbsp;&nbsp;&nbsp;&nbsp;UI:  `https://relay.averrow.com` (Cloudflare Pages)
> &nbsp;&nbsp;&nbsp;&nbsp;API: `https://relay-api.averrow.com` (Cloudflare Worker)

---

## 1. BLUF

Relay v0 = email magic link → 8-char PIN → 1:1 chat with D/R receipts + typing + PING. One Cloudflare Worker, one Durable Object class, D1 + R2 + WebSockets. Five Claude Code sessions to ship.

---

## 2. Coding Standard — DIAGNOSE FIRST

Every Claude Code task in this build follows three steps without exception:

1. **DIAGNOSE** — read and print the current state (files, schema, env, route table)
2. **IDENTIFY ROOT CAUSE** — name the exact gap or requirement
3. **FIX** — implement correctly the first time

No blind fixes. No bandaids. No partial implementations that "we'll come back to." Solve correctly the first time.

---

## 3. Brand Identity

**Name:** Relay
**Tagline candidate:** *"Your PIN. Your line. No phone number required."*

### Palette (locked)

| Token | Hex | Usage |
|---|---|---|
| `--bg` | `#0A0A0E` | Page background (near-black) |
| `--surface` | `#15151C` | Incoming chat bubble |
| `--surface-2` | `#1F1F28` | Input fields, cards |
| `--text` | `#F2F2F5` | Primary text |
| `--text-dim` | `#8A8A95` | Secondary text, timestamps |
| `--accent` | `#FF5C2A` | Relay Signal Orange — primary action, outgoing bubble tint |
| `--receipt-d` | `#8A8A95` | Delivered receipt (dim) |
| `--receipt-r` | `#FF5C2A` | Read receipt (signal orange) |
| `--online` | `#00D964` | Presence dot |

### Typography

- **Display / body:** Outfit (variable weight)
- **Monospace:** JetBrains Mono — used for PINs, sequence numbers, technical UI
- **PIN rendering:** Always mono, uppercase, letter-spaced, formatted as `XXXX·XXXX`

### Voice and tone

Minimal. Confident. No emoji bloat. Short labels. "Send" not "Send Message." "PIN" not "User ID."

---

## 4. v0 Scope (Session 1–5 ship target)

1. Email magic-link authentication
2. PIN generation (8-char Crockford base32, excludes I/L/O/U)
3. Add contact by PIN
4. Create 1:1 chat
5. WebSocket send/receive text messages
6. **D** (Delivered) and **R** (Read) receipts
7. Typing indicator
8. **PING!!** nudge
9. Mobile-first React PWA

### Out of v0 scope (saved for v1+)

- libsodium end-to-end encryption
- Multi-device support
- Group chats
- Broadcast lists
- Media (images, voice notes) via R2
- Push notifications (FCM / APNs / Web Push)
- QR code add-contact flow

---

## 5. Information Architecture

```
SignIn
  │
  ▼ (magic link)
Onboarding (PIN reveal, set display name)
  │
  ▼
Chats list ─── ⊕ ──► AddContact
  │                    │
  │                    ▼
  │              (back to Chats list)
  ▼
Chat view
  │
  ├── ⋮ menu → Contact info / Block / Mute
  └── ← back to Chats list

Settings (top-right gear from Chats list)
  ├── My profile (display name, status, avatar)
  ├── My PIN (copy, show QR)
  └── Sign out
```

---

## 6. Wireframes (mobile-first, 390px target)

### 6.1 Onboarding — PIN reveal

```
┌────────────────────────────┐
│                            │
│         RELAY              │
│                            │
│   Your PIN is ready.       │
│                            │
│   ┌──────────────────┐    │
│   │  7K2A · 9XQM     │    │   ← mono, large, letter-spaced
│   └──────────────────┘    │
│                            │
│   Share it. Memorize it.   │
│   This is who you are      │
│   on Relay.                │
│                            │
│   ┌──────────────────┐    │
│   │   Copy PIN       │    │
│   └──────────────────┘    │
│   ┌──────────────────┐    │
│   │   Show QR        │    │
│   └──────────────────┘    │
│                            │
│   [Continue →]             │
└────────────────────────────┘
```

### 6.2 Chats list (home)

```
┌────────────────────────────┐
│ RELAY            ⊕   ⚙     │   ← top bar: add contact, settings
│ ─────────────────────────  │
│ Your PIN: 7K2A·9XQM    📋  │
│                            │
│ ● Banx          2:14 PM    │
│   hey, you up?        D R  │   ← D R receipts inline
│ ─────────────────────────  │
│ ○ Matthew       11:02 AM   │
│   sent a PING!!       D    │   ← only D, not R yet
│ ─────────────────────────  │
│ ○ Daniel        Yesterday  │
│   barn 4 check at 6...  R  │
│                            │
└────────────────────────────┘
```

Filled green dot = online. Hollow dot = offline.

### 6.3 Chat view (the money screen)

```
┌────────────────────────────┐
│ ← Banx                  ⋮  │
│   7K2A·9XQM       ● online │
│ ─────────────────────────  │
│                            │
│  ┌─────────────────────┐   │
│  │ hey, you up?        │   │   ← incoming (left, --surface)
│  │ 2:14 PM             │   │
│  └─────────────────────┘   │
│                            │
│         ┌────────────────┐ │
│         │ yeah just in   │ │   ← outgoing (right, accent tint)
│         │ 2:15 PM    D R │ │   ← D R right-aligned, mono
│         └────────────────┘ │
│                            │
│         ┌────────────────┐ │
│         │ ⚡ PING!!      │ │   ← PING shows as orange chip
│         │ 2:15 PM    D   │ │
│         └────────────────┘ │
│                            │
│  Banx is composing···      │   ← typing indicator, dim text
│                            │
│ ─────────────────────────  │
│ ┌──────────────────┬─┬──┐ │
│ │ Type a message   │⚡│➤│ │   ← PING button + send
│ └──────────────────┴─┴──┘ │
└────────────────────────────┘
```

### 6.4 Add contact by PIN

```
┌────────────────────────────┐
│ ← Add contact              │
│ ─────────────────────────  │
│                            │
│  Enter their PIN           │
│  ┌──────────────────┐     │
│  │ ____ · ____      │     │   ← auto-format on input
│  └──────────────────┘     │
│                            │
│  ──── or ────              │
│                            │
│  ┌──────────────────┐     │
│  │  📷  Scan QR     │     │   ← v1
│  └──────────────────┘     │
│                            │
│  [Find →]                  │
└────────────────────────────┘
```

### 6.5 Sign in

```
┌────────────────────────────┐
│                            │
│         RELAY              │
│                            │
│   Sign in with your email  │
│                            │
│  ┌──────────────────────┐ │
│  │ you@example.com      │ │
│  └──────────────────────┘ │
│                            │
│  [Send magic link →]       │
│                            │
│  ─────────────────         │
│                            │
│  No phone number.          │
│  No tracking.              │
│  Just a PIN.               │
│                            │
└────────────────────────────┘
```

---

## 7. D1 Schema

```sql
-- packages/relay-worker/src/schema.sql

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  pin TEXT UNIQUE NOT NULL,
  display_name TEXT NOT NULL,
  status_message TEXT,
  avatar_r2_key TEXT,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER
);
CREATE INDEX idx_users_pin ON users(pin);

CREATE TABLE auth_emails (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  email TEXT UNIQUE NOT NULL,
  verified INTEGER DEFAULT 0
);
CREATE INDEX idx_auth_email ON auth_emails(email);

CREATE TABLE auth_tokens (
  token TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed INTEGER DEFAULT 0
);

CREATE TABLE sessions (
  jwt_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked INTEGER DEFAULT 0
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

CREATE TABLE contacts (
  owner_id TEXT NOT NULL REFERENCES users(id),
  contact_id TEXT NOT NULL REFERENCES users(id),
  alias TEXT,
  category TEXT,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (owner_id, contact_id)
);
CREATE INDEX idx_contacts_owner ON contacts(owner_id);

CREATE TABLE chats (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK(type IN ('1to1','group')),
  subject TEXT,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL
);

CREATE TABLE chat_participants (
  chat_id TEXT NOT NULL REFERENCES chats(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (chat_id, user_id)
);
CREATE INDEX idx_participants_user ON chat_participants(user_id);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL REFERENCES chats(id),
  sender_id TEXT NOT NULL REFERENCES users(id),
  sequence INTEGER NOT NULL,
  message_type TEXT NOT NULL CHECK(message_type IN ('text','image','voice','ping','system')),
  body TEXT,
  media_r2_key TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_messages_chat ON messages(chat_id, sequence);

CREATE TABLE receipts (
  message_id TEXT NOT NULL REFERENCES messages(id),
  recipient_id TEXT NOT NULL REFERENCES users(id),
  delivered_at INTEGER,
  read_at INTEGER,
  PRIMARY KEY (message_id, recipient_id)
);
CREATE INDEX idx_receipts_recipient ON receipts(recipient_id, read_at);
```

**Schema verification rule:** Before writing any SQL that references columns, always run `PRAGMA table_info(<table>)` first. Never select non-existent columns.

---

## 8. Durable Object — ChatRoom skeleton

```typescript
// packages/relay-worker/src/do/chat-room.ts

interface Env {
  DB: D1Database;
  CHAT_ROOM: DurableObjectNamespace;
  JWT_SECRET: string;
}

interface Session {
  userId: string;
}

export class ChatRoom implements DurableObject {
  private sessions = new Map<WebSocket, Session>();
  private typing = new Set<string>();

  constructor(private state: DurableObjectState, private env: Env) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/ws') {
      const pair = new WebSocketPair();
      await this.handleSession(pair[1], request);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    return new Response('Not found', { status: 404 });
  }

  private async handleSession(ws: WebSocket, request: Request) {
    ws.accept();

    const userId = await this.authenticate(request);
    if (!userId) {
      ws.close(1008, 'unauthorized');
      return;
    }

    this.sessions.set(ws, { userId });
    this.broadcastPresence(userId, true);

    ws.addEventListener('message', async (evt) => {
      let msg: any;
      try {
        msg = JSON.parse(evt.data as string);
      } catch {
        this.sendTo(userId, { t: 'error', code: 'bad_json', message: 'invalid JSON' });
        return;
      }

      switch (msg.t) {
        case 'send':    await this.handleSend(userId, msg); break;
        case 'typing':  this.handleTyping(userId, msg.on); break;
        case 'read':    await this.handleRead(userId, msg.messageIds); break;
        case 'PING':    this.broadcast({ t: 'PING', from: userId }); break;
        default:
          this.sendTo(userId, { t: 'error', code: 'unknown_type', message: msg.t });
      }
    });

    ws.addEventListener('close', () => {
      this.sessions.delete(ws);
      this.typing.delete(userId);
      this.broadcastPresence(userId, false);
    });
  }

  private async handleSend(userId: string, msg: any) {
    const sequence = ((await this.state.storage.get<number>('seq')) ?? 0) + 1;
    await this.state.storage.put('seq', sequence);

    const messageId = crypto.randomUUID();
    const now = Date.now();
    const chatId = this.state.id.toString();

    await this.env.DB.prepare(
      `INSERT INTO messages (id, chat_id, sender_id, sequence, message_type, body, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(messageId, chatId, userId, sequence, msg.type ?? 'text', msg.body, now).run();

    // ack to sender
    this.sendTo(userId, { t: 'ack', tempId: msg.tempId, messageId, sequence });

    // fan-out to connected recipients
    const payload = {
      t: 'message',
      id: messageId,
      from: userId,
      sequence,
      type: msg.type ?? 'text',
      body: msg.body,
      ts: now,
    };

    for (const [ws, sess] of this.sessions) {
      if (sess.userId === userId) continue;
      ws.send(JSON.stringify(payload));
      await this.markDelivered(messageId, sess.userId, now);
      this.sendTo(userId, { t: 'delivered', messageId, userId: sess.userId });
    }

    // TODO v1: queue push notification for offline participants
  }

  private async handleRead(userId: string, messageIds: string[]) {
    const now = Date.now();
    const stmt = this.env.DB.prepare(
      `UPDATE receipts SET read_at = ?
       WHERE message_id = ? AND recipient_id = ? AND read_at IS NULL`
    );
    await this.env.DB.batch(messageIds.map(id => stmt.bind(now, id, userId)));

    for (const id of messageIds) {
      this.broadcast({ t: 'read', messageId: id, userId });
    }
  }

  private handleTyping(userId: string, on: boolean) {
    if (on) this.typing.add(userId);
    else this.typing.delete(userId);
    this.broadcast({ t: 'typing', userId, on }, userId);
  }

  private async markDelivered(messageId: string, recipientId: string, ts: number) {
    await this.env.DB.prepare(
      `INSERT INTO receipts (message_id, recipient_id, delivered_at)
       VALUES (?, ?, ?)
       ON CONFLICT(message_id, recipient_id) DO UPDATE SET delivered_at = excluded.delivered_at
       WHERE receipts.delivered_at IS NULL`
    ).bind(messageId, recipientId, ts).run();
  }

  private broadcast(payload: any, exceptUserId?: string) {
    const json = JSON.stringify(payload);
    for (const [ws, sess] of this.sessions) {
      if (exceptUserId && sess.userId === exceptUserId) continue;
      ws.send(json);
    }
  }

  private sendTo(userId: string, payload: any) {
    const json = JSON.stringify(payload);
    for (const [ws, sess] of this.sessions) {
      if (sess.userId === userId) ws.send(json);
    }
  }

  private broadcastPresence(userId: string, online: boolean) {
    this.broadcast({ t: 'presence', userId, online });
  }

  private async authenticate(request: Request): Promise<string | null> {
    // verify JWT from subprotocol header or ?token=... query param
    // validate against sessions table; return user_id or null
    // (full implementation in auth.ts)
    return null;
  }
}
```

---

## 9. WebSocket Protocol

### Client → Server

| Type | Payload | Purpose |
|---|---|---|
| `send` | `{ tempId, type, body }` | Send a message (type: `text` or `ping`) |
| `typing` | `{ on: true \| false }` | Start/stop typing indicator |
| `read` | `{ messageIds: [...] }` | Mark messages as read |
| `PING` | `{}` | BBM-style nudge |

### Server → Client

| Type | Payload | Purpose |
|---|---|---|
| `ack` | `{ tempId, messageId, sequence }` | Confirm send, return server-assigned ID |
| `message` | `{ id, from, sequence, type, body, ts }` | Incoming message |
| `delivered` | `{ messageId, userId }` | A recipient received it |
| `read` | `{ messageId, userId }` | A recipient read it |
| `typing` | `{ userId, on }` | Someone started/stopped typing |
| `presence` | `{ userId, online }` | Someone connected/disconnected |
| `PING` | `{ from }` | Incoming nudge |
| `error` | `{ code, message }` | Protocol or auth error |

---

## 10. Repo Layout

```
relay/
├── packages/
│   ├── relay-worker/
│   │   ├── src/
│   │   │   ├── index.ts           # router + WS upgrade
│   │   │   ├── auth.ts            # magic link, JWT issue/verify
│   │   │   ├── pin.ts             # Crockford base32 generator
│   │   │   ├── contacts.ts        # add by PIN, list
│   │   │   ├── chats.ts           # create 1:1, list
│   │   │   ├── do/
│   │   │   │   └── chat-room.ts   # ChatRoom Durable Object
│   │   │   ├── lib/
│   │   │   │   ├── jwt.ts
│   │   │   │   └── email.ts       # Resend wrapper
│   │   │   └── schema.sql
│   │   ├── wrangler.toml
│   │   └── package.json
│   └── relay-ui/
│       ├── src/
│       │   ├── App.tsx
│       │   ├── routes/
│       │   │   ├── SignIn.tsx
│       │   │   ├── Onboarding.tsx
│       │   │   ├── Chats.tsx
│       │   │   ├── Chat.tsx
│       │   │   ├── AddContact.tsx
│       │   │   └── Profile.tsx
│       │   ├── components/
│       │   │   ├── MessageBubble.tsx
│       │   │   ├── Receipt.tsx
│       │   │   ├── PinDisplay.tsx
│       │   │   ├── TypingDots.tsx
│       │   │   └── PingChip.tsx
│       │   ├── lib/
│       │   │   ├── ws.ts          # WebSocket client + reconnect
│       │   │   ├── api.ts         # fetch wrapper, auth header
│       │   │   └── format.ts      # PIN formatting, timestamps
│       │   └── styles/
│       │       └── tokens.css     # design tokens (palette)
│       ├── vite.config.ts
│       └── package.json
├── turbo.json
└── package.json
```

---

## 11. Five-Session Build Plan

| # | Session | Output |
|---|---|---|
| 1 | **Foundation** | Turborepo scaffold, Worker, D1 init, schema applied, magic-link auth, PIN generation, `GET /me` working |
| 2 | **Contacts + Chats** | Add by PIN, create 1:1 chat, list chats endpoint, contact-invite model |
| 3 | **Chat DO + WebSockets** | ChatRoom DO, send/receive, sequence numbers, D/R receipts, typing, PING |
| 4 | **React UI** | Sign in → Onboarding → Chats list → Chat view, mobile-first, design tokens locked |
| 5 | **Polish + deploy** | Animations (PING shake, typing dots), PWA manifest, deploy to a Relay subdomain |

**Critical rule:** start a fresh Claude Code session for each phase. Long sessions cause context drift and stale instructions.

---

## 12. Session 1 — Claude Code Prompt (paste-ready)

```
# RELAY — SESSION 1: FOUNDATION

You are building Relay, a BBM-inspired messenger.
Stack: Cloudflare Workers + D1 + Durable Objects + R2,
React PWA frontend, Turborepo monorepo.

## CODING STANDARD: DIAGNOSE FIRST
For every step:
  1. DIAGNOSE — read current state, print what exists
  2. IDENTIFY ROOT CAUSE / requirement
  3. FIX — implement correctly the first time
No blind fixes. No bandaids. Solve correctly.

## SESSION 1 GOALS (do not exceed scope)

1. Initialize Turborepo with two packages: relay-worker, relay-ui
   (relay-ui may be a stub package.json + empty src this session;
    full UI is Session 4)

2. relay-worker: Hono router, wrangler.toml configured for D1 +
   DO binding (ChatRoom class stubbed only — fetch returns 501)

3. Apply D1 schema (see SCHEMA section below) via
   `wrangler d1 execute relay-db --local --file=src/schema.sql`
   and document the remote-apply command in README.

4. Implement endpoints:
     POST /auth/request   { email }            → sends magic link
     GET  /auth/verify    ?token=...           → returns JWT,
                                                 creates user if new
     GET  /me                                  → returns
                                                 { id, pin, displayName,
                                                   statusMessage }
     PATCH /me            { displayName?, statusMessage? }
                                               → update profile

5. PIN generation:
   - 8-char Crockford base32
   - Alphabet: 0123456789ABCDEFGHJKMNPQRSTVWXYZ (excludes I, L, O, U)
   - Generated via crypto.getRandomValues, NOT Math.random
   - Stored unformatted in DB (e.g., "7K2A9XQM")
   - Returned to client unformatted; client formats as XXXX·XXXX
   - Collision-retry on insert (max 5 attempts, then 500)

6. Magic-link email via Resend:
   - env: RESEND_API_KEY, FROM_EMAIL, APP_URL
   - APP_URL for local dev: http://localhost:5173
   - APP_URL for production: https://relay.averrow.com
   - FROM_EMAIL: noreply@averrow.com (or a relay-specific sender once
     domain auth is added in Resend)
   - For local dev (wrangler dev), if RESEND_API_KEY is unset,
     console.log the magic link instead of sending
   - Link format: ${APP_URL}/auth/verify?token=...
   - Token: 32-byte random, base64url-encoded
   - Expiry: 15 minutes
   - Single-use (mark consumed=1 on verify)

7. JWT:
   - HS256 signed, secret in env (JWT_SECRET)
   - 24-hour expiry
   - Includes jti (random UUID) stored in sessions table
   - Verify path: check signature, check jti exists in sessions,
     check not revoked, check not expired

## D1 SCHEMA

[Paste the schema block from section 7 of this spec]

## ACCEPTANCE CRITERIA

- `wrangler dev` runs cleanly with zero TypeScript errors
- `curl -X POST localhost:8787/auth/request -d '{"email":"test@example.com"}' -H 'Content-Type: application/json'`
  returns 200, console logs a magic link
- Following the magic link returns a JWT in the response body
- `curl localhost:8787/me -H "Authorization: Bearer <jwt>"`
  returns the user object with an 8-char PIN
- `wrangler d1 execute relay-db --local --command "SELECT pin FROM users"`
  shows generated PINs
- All TypeScript strict, no `any` without inline justification comment
- README.md documents setup steps and the four endpoints

## OUT OF SCOPE FOR THIS SESSION

- WebSockets / ChatRoom DO implementation (Session 3)
- Contacts / chats endpoints (Session 2)
- React UI (Session 4)
- Encryption (v1)
- Push notifications (v1)

## BEGIN

Step 1: DIAGNOSE — view the current state of the working
directory. Print what exists. Then propose the file structure
you will create.
```

---

## 13. Session 2–5 — Goal Sketches

Use these only as the *next* session begins. Write the full prompt fresh each time, in the same DIAGNOSE → IDENTIFY → FIX style as Session 1.

### Session 2 — Contacts + Chats

- `POST /contacts/add` `{ pin }` — look up user by PIN, create mutual contact entry
- `GET /contacts` — list with online/offline state (uses `last_seen_at`)
- `POST /chats/1to1` `{ contactId }` — find-or-create deterministic 1:1 chat (sorted-pair ID)
- `GET /chats` — list user's chats with last message preview, unread count, last activity
- Contact invite model if you want explicit accept/decline (optional for v0)

### Session 3 — ChatRoom DO + WebSockets

- Full ChatRoom DO implementation (use the skeleton in section 8)
- Endpoint: `GET /chats/:id/ws` → upgrades to WS, routes to DO
- JWT auth on WS handshake via `Sec-WebSocket-Protocol: bearer.<jwt>` or `?token=` query
- Sequence numbers persisted in DO storage
- D/R receipts wired to receipts table
- Typing in-memory only (no persistence)
- PING broadcast to all participants
- Heartbeat / idle timeout: kick after 60s no activity

### Session 4 — React UI

- Vite + React + TypeScript
- Routes (React Router): /signin, /onboarding, /chats, /chats/:id, /add-contact, /profile
- Design tokens in `styles/tokens.css` per palette in section 3
- Components: MessageBubble, Receipt, PinDisplay, TypingDots, PingChip
- WebSocket client in `lib/ws.ts` with exponential-backoff reconnect
- Mobile-first; fluid widths; minimum 44px touch targets
- Test on Pixel 9 Pro XL viewport (412 × 915 CSS px)

### Session 5 — Polish + Deploy

- PING shake animation (CSS keyframes on incoming PING)
- Typing dots animation
- PWA manifest + service worker for installability
- Favicon, splash, og:image
- Deploy Worker to `relay-api.averrow.com`
- Deploy UI to `relay.averrow.com` (Cloudflare Pages)
- Smoke test: two devices, one PIN exchange, full conversation including PING

---

## 14. Deployment & DNS

### Domains

| Surface | URL | Cloudflare resource |
|---|---|---|
| Web UI (PWA) | `https://relay.averrow.com` | Cloudflare Pages project `relay-ui` |
| API + WS | `https://relay-api.averrow.com` | Cloudflare Worker `relay-worker` |

### DNS records to add (averrow.com zone)

- `relay` — CNAME → Pages project hostname (set automatically by Pages on custom-domain bind)
- `relay-api` — proxied to the Worker (via Worker route binding, no DNS record needed beyond enabling the route)

### Worker route binding (`wrangler.toml`)

```toml
[[routes]]
pattern = "relay-api.averrow.com/*"
zone_name = "averrow.com"
```

### CORS

`relay-api.averrow.com` allows origin `https://relay.averrow.com` only in production. Local dev allows `http://localhost:5173`. No wildcard.

### Brand isolation from Averrow proper

- Relay shares the averrow.com **zone** for DNS convenience and Cloudflare account simplicity, but is a **separate product surface**
- No shared D1 database. Relay gets its own D1 (`relay-db`).
- No shared user table. Averrow auth ≠ Relay auth.
- No shared design system. Averrow uses Afterburner Amber (#E5A832); Relay uses Signal Orange (#FF5C2A). Distinct on purpose.
- Footer on `relay.averrow.com` says "from LRX Enterprises" — not "from Averrow." Keeps the option open to split it out to a standalone domain later (e.g., `getrelay.app`) without rebranding.

### Resend setup

- Add `averrow.com` as a verified sending domain in Resend (if not already)
- DKIM/SPF records published in the averrow.com zone
- Use `noreply@averrow.com` as `FROM_EMAIL` for Relay magic links initially
- Once Relay has traction, optionally migrate to a Relay-branded sender like `hello@relay.averrow.com` (requires Resend domain re-verification on the subdomain)

---

## 15. Trademark / IP Safety Notes

- Do **not** use "BBM", "BlackBerry Messenger", or BlackBerry's logos anywhere
- "PIN" as a term is generic — safe to use
- "Relay" as a brand — clear of major messenger trademarks; verify with a Canadian trademark search before serious investment
- Pre-2010 delivery-receipt patents have largely expired; modern variants are held by Malikie Innovations (former BlackBerry portfolio)
- Functional UX patterns (D/R receipts, typing indicators, group chat, broadcast) are not protectable; specific visual treatments may be — design fresh

---

## 16. Future Considerations (v1+)

- **E2E encryption layer:** libsodium-wrappers (X25519 ECDH + XSalsa20-Poly1305), per-chat symmetric key, per-message nonce. Server stores ciphertext only.
- **Multi-device:** per-device keypair; sender-side fan-out encryption to each recipient device
- **Groups:** reuse the `chats` table with `type='group'`; new participant flow; group key rotation on member change
- **Media:** R2 storage; client-side encrypts payload with random key; key sent in chat message
- **Push notifications:** Cloudflare Queue → FCM/APNs/Web Push fan-out worker
- **QR code add-contact:** library candidate is `qrcode` for generation, `@zxing/library` for scan
- **Federation / open protocol:** consider Matrix-style federation as a moonshot; would let Relay interop with other servers

---

*End of spec. Print this. Tape it to your monitor. Ship Session 1 this weekend.*
