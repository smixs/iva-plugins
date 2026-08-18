// Viewer service of the `trace` plugin: one page, four JSON routes, one SSE stream.
// Zero dependencies, loopback only, read-only on the journal.
//
// Env (contract of a plugin service): IVA_SERVICE_PORT, IVA_DATA_DIR, PLUGIN_ROOT, PLUGIN_DATA.
// By hand: IVA_SERVICE_PORT=8726 IVA_DATA_DIR=/path/to/data node server.ts

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { Store, Tail, traceDir, dayOf, currentDay } from "./store.ts";
import { stitch, statsFor, turnSummary, nodesForEvent } from "./journal.ts";
import type { Stats, TraceEvent, Turn } from "./journal.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const HOST = "127.0.0.1"; // never anything else: the journal is personal data behind SSH
const PERIODS = new Set([1, 7, 14]);
const POLL_MS = 700;
const PROBE_TTL_MS = 3000;
const KEEPALIVE_MS = 15000;

/** The environment as a service reads it: names to values, some of them missing. */
export type Env = Record<string, string | undefined>;

/** Whether the agent answers, and with what. */
export interface AgentHealth {
  agent: "alive" | "unreachable" | "unknown";
  status: number;
}

/** What the probe needs of `fetch`: a URL in, a status out. */
export type Fetcher = (url: string, init?: RequestInit) => Promise<{ status: number }>;

/** How the viewer asks about the agent. */
export type Probe = (url: string) => Promise<AgentHealth>;

/** What a failed `fetch` looks like from outside: a name, and a code on it or on its cause. */
interface FetchFault {
  name?: string;
  code?: string;
  cause?: { code?: string };
}

export function agentHealthUrl(env: Env = process.env): string {
  const port = env.IVA_PORT ?? "8723";
  return `http://127.0.0.1:${port}/eve/v1/health`;
}

/**
 * Is the agent alive? Any HTTP answer counts, even 401: the question is whether the process
 * listens, not whether the viewer may talk to it. No listener means "unreachable" (the agent
 * is restarting); anything stranger means "unknown" — the viewer never guesses green.
 */
export async function probeAgent(url: string, fetchImpl: Fetcher = fetch): Promise<AgentHealth> {
  try {
    const response = await fetchImpl(url, {
      signal: AbortSignal.timeout(1200),
      headers: { accept: "application/json" },
    });
    return { agent: "alive", status: response.status };
  } catch (error) {
    const fault = error as FetchFault | null;
    const code = fault?.cause?.code ?? fault?.code ?? "";
    if (code === "ECONNREFUSED" || code === "ECONNRESET" || code === "EHOSTUNREACH")
      return { agent: "unreachable", status: 0 };
    if (fault?.name === "TimeoutError" || code === "ETIMEDOUT")
      return { agent: "unreachable", status: 0 };
    return { agent: "unknown", status: 0 };
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

/**
 * A loopback service still has one remote attack: a page on the internet resolving its own
 * name to 127.0.0.1 and reading the answers. Only loopback names are served.
 */
function localHost(header: string | undefined): boolean {
  if (header === undefined) return true;
  const host = header.replace(/:\d+$/u, "").replace(/^\[|\]$/gu, "").toLowerCase();
  return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "";
}

/** The stitched window, held against the fingerprint it was built from. */
interface Model {
  stamp: string;
  turns: Turn[];
  unattached: TraceEvent[];
  byId: Map<string, Turn>;
  stats: Map<string, Stats>;
}

export function createViewer({
  dataDir,
  now = () => Date.now(),
  probe = probeAgent,
  env = process.env,
}: {
  dataDir: string;
  now?: () => number;
  probe?: Probe;
  env?: Env;
}) {
  const store = new Store({ dataDir, now });
  const clients = new Set<ServerResponse>();
  const page = { text: "", mtimeMs: 0 };
  let cachedProbe: { at: number; value: AgentHealth } = {
    at: 0,
    value: { agent: "unknown", status: 0 },
  };
  let tail: Tail | null = null;
  let timer: NodeJS.Timeout | null = null;

  const indexPath = join(HERE, "index.html");
  const readPage = (): string => {
    const info = statSync(indexPath);
    if (page.mtimeMs !== info.mtimeMs) {
      page.text = readFileSync(indexPath, "utf8");
      page.mtimeMs = info.mtimeMs;
    }
    return page.text;
  };

  /**
   * Stitching the window is the expensive part of every route, and the window barely changes:
   * one appended line at a time, and nothing at all between two clicks. So the model is kept
   * against the fingerprint of the day files and rebuilt only when one of them moved. Purely a
   * memory of what was read — the journal is still never written to.
   */
  let stitched: Model | null = null;
  const model = (): Model => {
    const stamp = store.stamp();
    if (stitched !== null && stitched.stamp === stamp) return stitched;
    const { turns, unattached } = stitch(store.events());
    stitched = {
      stamp,
      turns,
      unattached,
      byId: new Map(turns.map((turn) => [turn.id, turn])),
      stats: new Map(),
    };
    return stitched;
  };

  /** Tiles of one period, held against the same fingerprint as the model. */
  const stats = (days: number, today: string): Stats => {
    const current = model();
    const key = `${today}|${days}`;
    const hit = current.stats.get(key);
    if (hit !== undefined) return hit;
    const value = statsFor(current.turns, { today, days, dayOf });
    current.stats.set(key, value);
    return value;
  };

  const health = async (): Promise<AgentHealth> => {
    const at = now();
    if (at - cachedProbe.at < PROBE_TTL_MS) return cachedProbe.value;
    const value = await probe(agentHealthUrl(env));
    cachedProbe = { at, value };
    return value;
  };

  const journalFile = (): { day: string; path: string; bytes: number } => {
    const day = currentDay(traceDir(dataDir), now());
    const path = join(traceDir(dataDir), `${day}.jsonl`);
    let bytes = -1;
    try {
      bytes = statSync(path).size;
    } catch {
      bytes = -1;
    }
    return { day, path, bytes };
  };

  const broadcast = (name: string, payload: unknown): void => {
    const frame = `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const client of clients) client.write(frame);
  };

  const tick = (): void => {
    if (tail === null) return;
    const { rollover, day, events } = tail.poll();
    if (rollover) broadcast("rollover", { day });
    for (const event of events)
      broadcast("line", { ...event, nodes: nodesForEvent(event) });
  };

  const startPolling = (): void => {
    if (timer !== null) return;
    tail = new Tail({ dataDir, now });
    timer = setInterval(() => {
      try {
        tick();
      } catch {
        // A journal that moved under us is not a reason to lose the stream.
      }
    }, POLL_MS);
    timer.unref?.();
  };

  const stopPolling = (): void => {
    if (timer === null) return;
    clearInterval(timer);
    timer = null;
    tail = null;
  };

  const server = createServer((req, res) => {
    if (!localHost(req.headers.host)) {
      res.writeHead(403, { "content-type": "text/plain" });
      res.end("loopback only\n");
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      sendJson(res, 405, { error: "GET only" });
      return;
    }
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    try {
      route(url, req, res);
    } catch (error) {
      const problem = error as { message?: unknown } | null;
      sendJson(res, 500, { error: String(problem?.message ?? error) });
    }
  });

  function route(url: URL, req: IncomingMessage, res: ServerResponse): void {
    const path = url.pathname;
    if (path === "/" || path === "/index.html") {
      const text = readPage();
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "content-length": Buffer.byteLength(text),
      });
      res.end(req.method === "HEAD" ? undefined : text);
      return;
    }
    if (path === "/api/turns") {
      const { turns, unattached } = model();
      sendJson(res, 200, {
        turns: turns.map(turnSummary),
        unattached: unattached.length,
        days: store.window(),
        today: dayOf(now()),
      });
      return;
    }
    if (path === "/api/turn") {
      const id = url.searchParams.get("id") ?? "";
      const turn = model().byId.get(id);
      if (turn === undefined) {
        sendJson(res, 404, { error: "no such turn" });
        return;
      }
      sendJson(res, 200, {
        turn: turnSummary(turn),
        events: turn.events.map((event) => ({ ...event, nodes: nodesForEvent(event, turn.night) })),
      });
      return;
    }
    if (path === "/api/stats") {
      const asked = Number(url.searchParams.get("days") ?? "1");
      const days = PERIODS.has(asked) ? asked : 1;
      sendJson(res, 200, stats(days, dayOf(now())));
      return;
    }
    if (path === "/api/status") {
      const file = journalFile();
      health().then((agent) => {
        sendJson(res, 200, { ...agent, ...file, at: new Date(now()).toISOString() });
      });
      return;
    }
    if (path === "/api/stream") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      res.write("retry: 2000\n\n");
      res.write(`event: hello\ndata: ${JSON.stringify(journalFile())}\n\n`);
      clients.add(res);
      startPolling();
      const beat = setInterval(() => res.write(": beat\n\n"), KEEPALIVE_MS);
      beat.unref?.();
      const drop = (): void => {
        clearInterval(beat);
        clients.delete(res);
        if (clients.size === 0) stopPolling();
      };
      req.on("close", drop);
      res.on("close", drop);
      return;
    }
    sendJson(res, 404, { error: "no such route" });
  }

  server.on("close", stopPolling);
  return { server, model, stats, health, journalFile, store };
}

export function main(env: Env = process.env) {
  const dataDir = env.IVA_DATA_DIR ?? "";
  if (dataDir === "") {
    process.stderr.write("trace viewer: IVA_DATA_DIR is not set\n");
    process.exit(2);
  }
  const port = Number(env.IVA_SERVICE_PORT ?? "8726");
  const viewer = createViewer({ dataDir, env });
  viewer.server.listen(port, HOST, () => {
    const bound = viewer.server.address() as AddressInfo;
    process.stdout.write(
      `trace viewer on http://${HOST}:${bound.port} — journal ${traceDir(dataDir)}\n`,
    );
  });
  const bye = (): void => {
    viewer.server.close();
    process.exit(0);
  };
  process.on("SIGTERM", bye);
  process.on("SIGINT", bye);
  return viewer;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
