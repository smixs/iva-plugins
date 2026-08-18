// Reading the Trace journal: parse a line, stitch turns, count a period, map an event to a
// schema node. Pure functions only — no fs, no http, no clock of its own. The contract is
// `docs/trace.md` in the Iva repo; this file follows it and nothing else.

/** The payload of a line, seen the only way a reader can see it: keys to unknown values. */
export type Data = Record<string, unknown>;

/** Where a line came from, as the reader of the file knows it. */
export interface LineMeta {
  readonly file?: string;
  readonly line?: number;
}

/** One journal line, parsed. `event` is `kind.name`, the name the whole viewer speaks in. */
export interface TraceEvent {
  readonly ts: string;
  readonly at: number;
  readonly turn: string;
  readonly session: string;
  readonly source: string;
  readonly kind: string;
  readonly name: string;
  readonly event: string;
  readonly data: Data;
  readonly file: string;
  readonly line: number;
}

/** An event inside a stitched turn: the subagent it belongs to, and how deep it sits. */
export interface TurnEvent extends TraceEvent {
  readonly depth: number;
  readonly subagent: string;
}

export type TurnKind = "chat" | "night";
export type TurnStatus = "live" | "ok" | "failed" | "cancelled" | "blocked" | "dropped";

/** What a turn did, in the units each seam measures itself in. */
export interface Counts {
  events: number;
  steps: number;
  toolCalls: number;
  toolErrors: number;
  memorySearch: number;
  cardsFound: number;
  cardsFoundKnown: boolean;
  cardsWritten: number;
  gateBlocked: number;
  gateFlagged: number;
  gateClean: number;
  subagents: number;
}

export interface Tokens {
  in: number;
  out: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number;
}

export interface Flags {
  blocked: boolean;
  flagged: boolean;
  failed: boolean;
  cancelled: boolean;
  stopped: boolean;
  dropped: boolean;
  delivered: boolean;
  trimmed: boolean;
}

/** One stitched turn: its keys, its outcome, its numbers and every event that made it. */
export interface Turn {
  id: string;
  kind: TurnKind;
  source: string;
  session: string;
  turnKey: string;
  updateKey: string;
  chatKey: string;
  startedAt: string;
  endedAt: string;
  at: number;
  ms: number;
  night: string;
  status: TurnStatus;
  title: string;
  reply: string;
  counts: Counts;
  tokens: Tokens;
  nodes: Record<string, number>;
  flags: Flags;
  events: TurnEvent[];
}

/** A turn without its events: what the list and the tiles carry. */
export type TurnSummary = Omit<Turn, "events">;

/** The tiles of a period. */
export interface Stats {
  period: number;
  from: string;
  to: string;
  turns: number;
  chat: number;
  night: number;
  events: number;
  steps: number;
  avgMs: number;
  timedTurns: number;
  toolCalls: number;
  toolErrors: number;
  memorySearch: number;
  cardsFound: number;
  cardsFoundKnown: boolean;
  cardsWritten: number;
  gateBlocked: number;
  gateFlagged: number;
  gateClean: number;
  failed: number;
  tokens: Tokens;
  nodes: Record<string, number>;
}

/** How many cards a result carried, and whether that could be known at all. */
export interface CardCount {
  known: boolean;
  count: number;
}

/** Sources that mark a night turn: it has no turn key, only a session. */
export const NIGHT_SOURCES = new Set(["rollup", "digest", "cron"]);

/** Update key space: everything before the turn exists. */
const UPDATE_PREFIX = "tg:";

/**
 * A callback update (Stop, /menu) is seen by the Bridge alone: it never reaches the Inbound
 * pipeline, so its line has no turn to belong to (contract). It stays unattached instead of
 * appearing as a one-line turn in the list.
 */
const CALLBACK_KEY = /^tg:[^:]*:cb:/u;

/** Two turn.bound lines claiming one turn key — refuse to guess. */
const CONFLICT = Symbol("conflict");

/** A bound key, or the mark that two lines claimed it. */
type Bound = string | typeof CONFLICT;

const str = (value: unknown): string => (typeof value === "string" ? value : "");
const num = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

/** A JSON object and nothing else: an array is not a payload, and neither is null. */
const isRecord = (value: unknown): value is Data =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * One journal line to one event, or null. A broken line is skipped, never thrown: two
 * processes append to the file and a reader meets a half-written line at any moment.
 */
export function parseLine(raw: unknown, meta?: LineMeta): TraceEvent | null {
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  if (text.length === 0 || text[0] !== "{") return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  const kind = str(value.kind);
  const name = str(value.name);
  const ts = str(value.ts);
  if (kind === "" || name === "" || ts === "") return null;
  const at = Date.parse(ts);
  if (!Number.isFinite(at)) return null;
  const data = isRecord(value.data) ? value.data : {};
  return {
    ts,
    at,
    turn: str(value.turn),
    session: str(value.session),
    source: str(value.source) || "unknown",
    kind,
    name,
    event: `${kind}.${name}`,
    data,
    file: str(meta?.file),
    line: num(meta?.line),
  };
}

/** `turn_3#planner` gives base `turn_3` and subagent `planner`. */
export function splitTurn(turn: string): { base: string; subagent: string } {
  const hash = turn.indexOf("#");
  if (hash < 0) return { base: turn, subagent: "" };
  return { base: turn.slice(0, hash), subagent: turn.slice(hash + 1) };
}

/**
 * Order in the file is write order, not turn order (contract, "Guarantees for a reader"), so
 * sort by `ts`. Ties break on file and line: a reader must land on the same order whatever
 * order it read the lines in.
 */
export function compareEvents(a: TraceEvent, b: TraceEvent): number {
  if (a.at !== b.at) return a.at - b.at;
  if (a.file !== b.file) return a.file < b.file ? -1 : 1;
  if (a.line !== b.line) return a.line - b.line;
  if (a.event !== b.event) return a.event < b.event ? -1 : 1;
  if (a.turn !== b.turn) return a.turn < b.turn ? -1 : 1;
  return a.session < b.session ? -1 : a.session > b.session ? 1 : 0;
}

function keepFirst(map: Map<string, Bound>, key: string, value: string): void {
  if (!map.has(key)) map.set(key, value);
  else if (map.get(key) !== value) map.set(key, CONFLICT);
}

/** Tool call to the schema node it belongs to. An unknown tool lands on the Tools group. */
export function toolNode(toolName: string): string {
  switch (toolName) {
    case "memory_search":
      return "memory_search";
    case "write_card":
      return "write_card";
    case "bash":
      return "bash";
    case "web_fetch":
      return "web_fetch";
    case "web_search":
      return "web_search";
    case "read_file":
    case "write_file":
    case "glob":
    case "grep":
      return "files";
    case "tasks":
      return "tasks";
    default:
      return "other";
  }
}

const actionTool = (action: unknown): string =>
  isRecord(action) ? str(action.toolName) || str(action.name) : "";

/**
 * Schema nodes an event lights up. The first one is the primary: the feed and the replay
 * follow it, the rest only glow along (Vault behind memory_search, Telegram behind Bridge).
 */
export function nodesForEvent(event: TraceEvent, nightSource = ""): string[] {
  const { kind, name, data } = event;
  const night = NIGHT_SOURCES.has(event.source) || nightSource !== "";
  // A night turn has a name of its own: Rollup assembles memory, a Report is the summary
  // that leaves through the Outbox. Both light up next to the seams they actually use.
  const nightNode = (NIGHT_SOURCES.has(event.source) ? event.source : nightSource) === "rollup"
    ? "rollup"
    : "report";
  const inSubagent = str(data.subagent) !== "" || splitTurn(event.turn).subagent !== "";
  switch (kind) {
    case "bridge":
      return name === "admitted" || name === "delivered"
        ? ["bridge", "telegram_in"]
        : ["bridge"];
    case "inbound":
      return name === "received" ? ["inbound", "allowlist"] : ["inbound"];
    case "gate":
      if (name === "web") return ["web_fetch"];
      if (name === "outbound")
        return night ? ["gate_out", "outbox", "report"] : ["gate_out", "outbox"];
      return ["gate_in", "inbound"];
    case "turn":
      return ["inbound"];
    case "context":
      return ["context"];
    case "stop":
      return ["stop", "model"];
    case "outbox": {
      const out = name === "delivered" ? ["outbox", "telegram_out"] : ["outbox"];
      return night ? [...out, "report"] : out;
    }
    case "eve": {
      if (name.startsWith("subagent.")) return ["planner", "tools"];
      if (name === "actions.requested") {
        const actions = Array.isArray(data.actions) ? data.actions : [];
        const nodes = ["tools"];
        for (const action of actions) {
          const node = toolNode(actionTool(action));
          if (!nodes.includes(node)) nodes.push(node);
          if (node === "memory_search" || node === "write_card") nodes.push("vault");
        }
        return inSubagent ? [...nodes, "planner"] : nodes;
      }
      if (name === "action.result") {
        const node = toolNode(str(data.toolName));
        const nodes = [node, "tools"];
        if (node === "memory_search" || node === "write_card") nodes.push("vault");
        return inSubagent ? [...nodes, "planner"] : nodes;
      }
      if (inSubagent) return ["planner"];
      return night ? ["model", nightNode] : ["model"];
    }
    default:
      return [];
  }
}

/** A memory_search result to how many cards came back. Content may be off; then it is unknown. */
export function cardsInResult(result: unknown): CardCount {
  let value = result;
  if (typeof value === "string") {
    const text = value;
    try {
      value = JSON.parse(text);
    } catch {
      const match = /"count"\s*:\s*(\d+)/u.exec(text);
      return match ? { known: true, count: Number(match[1]) } : { known: false, count: 0 };
    }
  }
  if (value === null || typeof value !== "object") return { known: false, count: 0 };
  const box = value as Data;
  if (typeof box.count === "number" && Number.isFinite(box.count))
    return { known: true, count: box.count };
  if (Array.isArray(box.hits)) return { known: true, count: box.hits.length };
  return { known: false, count: 0 };
}

function emptyCounts(): Counts {
  return {
    events: 0,
    steps: 0,
    toolCalls: 0,
    toolErrors: 0,
    memorySearch: 0,
    cardsFound: 0,
    cardsFoundKnown: false,
    cardsWritten: 0,
    gateBlocked: 0,
    gateFlagged: 0,
    gateClean: 0,
    subagents: 0,
  };
}

function emptyTokens(): Tokens {
  return { in: 0, out: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 };
}

function newTurn(id: string, kind: TurnKind): Turn {
  return {
    id,
    kind,
    source: "",
    session: "",
    turnKey: "",
    updateKey: "",
    chatKey: "",
    startedAt: "",
    endedAt: "",
    at: 0,
    ms: 0,
    night: "",
    status: "live",
    title: "",
    reply: "",
    counts: emptyCounts(),
    tokens: emptyTokens(),
    nodes: Object.create(null),
    flags: {
      blocked: false,
      flagged: false,
      failed: false,
      cancelled: false,
      stopped: false,
      dropped: false,
      delivered: false,
      trimmed: false,
    },
    events: [],
  };
}

function cap(text: string, limit: number): string {
  const flat = String(text).replace(/\s+/gu, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

/** Which turn a keyed line belongs to, and whether it came from a subagent. */
interface Group {
  id: string;
  kind: TurnKind;
  subagent: string;
}

/** The turns of one session in start order, as a keyless line looks them up. */
interface SessionTurn {
  at: number;
  id: string;
  kind: TurnKind;
}

interface Maps {
  bind: Map<string, Bound>;
  nightSource: Map<string, Bound>;
  sessionTurns: Map<string, SessionTurn[]>;
}

/**
 * The three key spaces of `turn` (contract): the update key before the turn, the Eve turnId
 * after it, nothing at all on the night seams. `turn.bound` welds the first two.
 *
 * One session can hold several turns — the digest sends twice inside one session, a Rollup
 * keeps its session alive across two nights — so the session alone is never a turn key, and
 * neither is the pair (session, source). A keyless seam line joins the latest turn of its
 * session that had already started by `ts`.
 */
function index(sorted: readonly TraceEvent[]): Maps {
  const bind = new Map<string, Bound>(); // session + turnId (and turnId alone) to update key
  const nightSource = new Map<string, Bound>(); // session to rollup | digest | cron
  for (const event of sorted) {
    if (event.kind === "turn" && event.name === "bound") {
      const updateKey = str(event.data.updateKey);
      if (updateKey !== "" && event.turn !== "") {
        keepFirst(bind, `${event.session} ${event.turn}`, updateKey);
        keepFirst(bind, ` ${event.turn}`, updateKey);
      }
    }
    if (NIGHT_SOURCES.has(event.source) && event.session !== "")
      keepFirst(nightSource, event.session, event.source);
  }
  // Turns of each session in start order: this is what a keyless line looks its turn up in.
  const sessionTurns = new Map<string, SessionTurn[]>();
  for (const event of sorted) {
    if (event.session === "") continue;
    const keyed = keyedGroup(event, bind, nightSource);
    if (keyed === null) continue;
    const list = sessionTurns.get(event.session) ?? [];
    if (!list.some((item) => item.id === keyed.id))
      list.push({ at: event.at, id: keyed.id, kind: keyed.kind });
    sessionTurns.set(event.session, list);
  }
  return { bind, nightSource, sessionTurns };
}

/** The group of a line that carries a turn key, or null when it carries none. */
function keyedGroup(
  event: TraceEvent,
  bind: Map<string, Bound>,
  nightSource: Map<string, Bound>,
): Group | null {
  const { base, subagent } = splitTurn(event.turn);
  if (base === "" || CALLBACK_KEY.test(base)) return null;
  if (base.startsWith(UPDATE_PREFIX)) return { id: `u:${base}`, kind: "chat", subagent };
  const scoped = bind.get(`${event.session} ${base}`);
  const loose = bind.get(` ${base}`);
  const updateKey =
    scoped !== undefined && scoped !== CONFLICT
      ? scoped
      : loose !== undefined && loose !== CONFLICT
        ? loose
        : "";
  if (updateKey !== "") return { id: `u:${updateKey}`, kind: "chat", subagent };
  const night = event.session !== "" && nightSource.has(event.session);
  if (event.session !== "")
    return { id: `s:${event.session}|${base}`, kind: night ? "night" : "chat", subagent };
  return { id: `t:${base}`, kind: "chat", subagent };
}

function groupOf(event: TraceEvent, { bind, nightSource, sessionTurns }: Maps): Group | null {
  const keyed = keyedGroup(event, bind, nightSource);
  if (keyed !== null) return keyed;
  const { base } = splitTurn(event.turn);
  if (CALLBACK_KEY.test(base)) return null; // the Bridge alone sees a callback: it has no turn
  if (event.session === "") return null; // a verdict outside a turn: nothing to attach it to
  let landed: SessionTurn | null = null;
  for (const item of sessionTurns.get(event.session) ?? [])
    if (item.at <= event.at) landed = item;
  if (landed !== null) return { id: landed.id, kind: landed.kind, subagent: "" };
  const night = nightSource.has(event.session);
  return { id: `s:${event.session}`, kind: night ? "night" : "chat", subagent: "" };
}

function absorb(turn: Turn, event: TraceEvent, subagent: string, night: string): void {
  const counts = turn.counts;
  counts.events += 1;
  const { base } = splitTurn(event.turn);
  if (turn.session === "" && event.session !== "") turn.session = event.session;
  if (base.startsWith(UPDATE_PREFIX)) {
    if (turn.updateKey === "") turn.updateKey = base;
  } else if (base !== "" && subagent === "" && turn.turnKey === "") turn.turnKey = base;
  if (event.kind === "turn" && event.name === "bound") {
    turn.updateKey = str(event.data.updateKey) || turn.updateKey;
    turn.chatKey = str(event.data.chatKey) || turn.chatKey;
  }
  if (turn.chatKey === "" && typeof event.data.chatKey === "string")
    turn.chatKey = event.data.chatKey;
  if (event.source !== "unknown" && event.source !== "" && event.source !== "bridge") {
    if (turn.source === "" || turn.source === "unknown") turn.source = event.source;
    else if (NIGHT_SOURCES.has(event.source)) turn.source = event.source;
  }
  if (event.data.traceTrimmed === true) turn.flags.trimmed = true;

  for (const node of nodesForEvent(event, night))
    turn.nodes[node] = (turn.nodes[node] ?? 0) + 1;

  switch (event.event) {
    case "inbound.received":
      if (turn.title === "" && typeof event.data.text === "string")
        turn.title = cap(event.data.text, 160);
      break;
    case "inbound.dropped":
      turn.flags.dropped = true;
      break;
    case "inbound.accepted":
      if (turn.title === "" && Array.isArray(event.data.context) && event.data.context[0])
        turn.title = cap(String(event.data.context[0]), 160);
      break;
    case "gate.inbound":
    case "gate.web":
      if (event.data.blocked === true) {
        counts.gateBlocked += 1;
        turn.flags.blocked = true;
      } else if (Array.isArray(event.data.flags) && event.data.flags.length > 0) {
        counts.gateFlagged += 1;
        turn.flags.flagged = true;
      } else counts.gateClean += 1;
      break;
    case "gate.outbound":
      if (event.data.clean === false) {
        counts.gateFlagged += 1;
        turn.flags.flagged = true;
      } else counts.gateClean += 1;
      if (typeof event.data.text === "string") turn.reply = cap(event.data.text, 200);
      break;
    case "eve.step.completed": {
      counts.steps += 1;
      const usage = event.data.usage;
      if (isRecord(usage)) {
        turn.tokens.in += num(usage.in);
        turn.tokens.out += num(usage.out);
        turn.tokens.cacheRead += num(usage.cacheRead);
        turn.tokens.cacheWrite += num(usage.cacheWrite);
        turn.tokens.costUsd += num(usage.costUsd);
      }
      break;
    }
    case "eve.turn.failed":
    case "eve.step.failed":
      turn.flags.failed = true;
      break;
    case "eve.turn.cancelled":
      turn.flags.cancelled = true;
      break;
    case "eve.message.completed":
      if (turn.reply === "" && typeof event.data.message === "string")
        turn.reply = cap(event.data.message, 200);
      break;
    case "eve.subagent.started":
      counts.subagents += 1;
      break;
    case "outbox.delivered":
      turn.flags.delivered = true;
      break;
    case "outbox.failed":
      turn.flags.failed = true;
      break;
    default:
      break;
  }
  if (event.kind === "stop" && event.name !== "idle") turn.flags.stopped = true;
}

/** One tool call, as the two lines that describe it leave it. */
interface Call {
  tool: string;
  cards: CardCount;
  error: boolean;
}

/**
 * Tool calls are counted by callId, not by line: one call shows up twice (requested, result)
 * and a permutation of the lines must not change the number.
 */
function collectCalls(turn: Turn): Map<string, Call> {
  const calls = new Map<string, Call>();
  const take = (id: string): Call =>
    calls.get(id) ?? { tool: "", cards: { known: false, count: 0 }, error: false };
  for (const event of turn.events) {
    if (event.event === "eve.actions.requested") {
      const actions = Array.isArray(event.data.actions) ? event.data.actions : [];
      actions.forEach((action: unknown, i: number) => {
        const tool = actionTool(action);
        const callId =
          (isRecord(action) && str(action.callId)) ||
          `${event.turn}:${num(event.data.stepIndex)}:${i}:${tool}`;
        const call = take(callId);
        if (call.tool === "") call.tool = tool;
        calls.set(callId, call);
      });
    }
    if (event.event === "eve.action.result") {
      const tool = str(event.data.toolName);
      const callId =
        str(event.data.callId) || `${event.turn}:${num(event.data.stepIndex)}:${tool}`;
      const call = take(callId);
      if (call.tool === "") call.tool = tool;
      if (event.data.isError === true || str(event.data.status) === "error") call.error = true;
      if (toolNode(call.tool) === "memory_search" && "result" in event.data)
        call.cards = cardsInResult(event.data.result);
      calls.set(callId, call);
    }
  }
  return calls;
}

/** Every node that measures itself in tool calls. */
const TOOL_NODES = [
  "memory_search",
  "write_card",
  "bash",
  "files",
  "web_fetch",
  "web_search",
  "tasks",
  "other",
];

/**
 * What the number on a schema node means. Events touched a node while the turn ran, but an
 * event count is not what the seam does: the Model counts steps, a tool counts calls, the
 * Vault counts cards, a Gate counts verdicts (one line is one verdict), and the seams that
 * pass a turn through — Bridge, Inbound pipeline, Outbox — count the events they wrote.
 */
function measure(turn: Turn, calls: Map<string, Call>): void {
  const nodes = turn.nodes;
  const counts = turn.counts;
  const perTool = new Map<string, number>();
  for (const call of calls.values()) {
    const node = toolNode(call.tool);
    perTool.set(node, (perTool.get(node) ?? 0) + 1);
  }
  for (const node of TOOL_NODES)
    if (perTool.has(node) || node in nodes) nodes[node] = perTool.get(node) ?? 0;
  if ("model" in nodes || counts.steps > 0) nodes.model = counts.steps;
  if ("tools" in nodes || counts.toolCalls > 0) nodes.tools = counts.toolCalls;
  if ("planner" in nodes || counts.subagents > 0) nodes.planner = counts.subagents;
  if ("vault" in nodes) nodes.vault = counts.cardsFound + counts.cardsWritten;
}

function countTools(turn: Turn, calls: Map<string, Call>): void {
  const counts = turn.counts;
  counts.toolCalls = calls.size;
  for (const call of calls.values()) {
    const node = toolNode(call.tool);
    if (node === "memory_search") {
      counts.memorySearch += 1;
      if (call.cards.known) {
        counts.cardsFound += call.cards.count;
        counts.cardsFoundKnown = true;
      }
    }
    if (node === "write_card") counts.cardsWritten += 1;
    if (call.error) counts.toolErrors += 1;
  }
}

const TERMINAL = new Set([
  "eve.turn.completed",
  "eve.turn.failed",
  "eve.turn.cancelled",
  "outbox.delivered",
  "outbox.failed",
  "inbound.dropped",
  "bridge.dropped",
  "bridge.rejected",
]);

function finish(turn: Turn): Turn {
  const first = turn.events[0];
  const last = turn.events[turn.events.length - 1];
  turn.startedAt = first.ts;
  turn.at = first.at;
  turn.endedAt = last.ts;
  turn.ms = last.at - first.at;
  if (turn.source === "") turn.source = first.source;
  const closed = turn.events.some((event) => TERMINAL.has(event.event));
  const calls = collectCalls(turn);
  countTools(turn, calls);
  measure(turn, calls);
  if (turn.flags.failed) turn.status = "failed";
  else if (turn.flags.cancelled || turn.flags.stopped) turn.status = "cancelled";
  else if (turn.flags.blocked) turn.status = "blocked";
  else if (turn.flags.dropped) turn.status = "dropped";
  else if (!closed) turn.status = "live";
  else turn.status = "ok";
  if (turn.title === "")
    turn.title =
      turn.kind === "night"
        ? `${turn.source || "night"} turn`
        : turn.reply !== ""
          ? turn.reply
          : turn.chatKey || turn.updateKey || turn.turnKey || turn.session;
  return turn;
}

/**
 * Every event of the window to turns. The same input in any order gives the same turns; a
 * line with nothing to attach it to (a Bridge callback, a verdict outside a turn) goes to
 * `unattached` instead of getting a turn invented for it.
 */
export function stitch(events: readonly TraceEvent[]): {
  turns: Turn[];
  unattached: TraceEvent[];
} {
  const sorted = [...events].sort(compareEvents);
  const maps = index(sorted);
  const turns = new Map<string, Turn>();
  const unattached: TraceEvent[] = [];
  for (const event of sorted) {
    const group = groupOf(event, maps);
    if (group === null) {
      unattached.push(event);
      continue;
    }
    let turn = turns.get(group.id);
    if (turn === undefined) {
      turn = newTurn(group.id, group.kind);
      turns.set(group.id, turn);
    }
    const night = maps.nightSource.get(event.session);
    if (group.kind === "night") {
      turn.kind = "night";
      turn.night = night === undefined || night === CONFLICT ? "rollup" : night;
    }
    const subagent = group.subagent || str(event.data.subagent);
    turn.events.push({ ...event, depth: subagent === "" ? 0 : 1, subagent });
    absorb(turn, event, group.subagent, turn.night);
  }
  const list = [...turns.values()].map(finish);
  list.sort((a, b) => b.at - a.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { turns: list, unattached };
}

/** A turn without its events: the list and the tiles never need the payload. */
export function turnSummary(turn: Turn): TurnSummary {
  const { events, ...rest } = turn;
  return rest;
}

/**
 * Tiles for a period. `days` counts back from `today` inclusive: 1 is today, 7 a week.
 * Turns are placed by the day they started, in the same local day the file names use.
 */
export function statsFor(
  turns: readonly Turn[],
  { today, days, dayOf }: { today: string; days: number; dayOf: (at: number) => string },
): Stats {
  const from = dayShift(today, -(days - 1));
  const picked = turns.filter((turn) => {
    const day = dayOf(turn.at);
    return day >= from && day <= today;
  });
  const totals: Stats = {
    period: days,
    from,
    to: today,
    turns: picked.length,
    chat: 0,
    night: 0,
    events: 0,
    steps: 0,
    avgMs: 0,
    timedTurns: 0,
    toolCalls: 0,
    toolErrors: 0,
    memorySearch: 0,
    cardsFound: 0,
    cardsFoundKnown: false,
    cardsWritten: 0,
    gateBlocked: 0,
    gateFlagged: 0,
    gateClean: 0,
    failed: 0,
    tokens: emptyTokens(),
    nodes: Object.create(null),
  };
  let msSum = 0;
  for (const turn of picked) {
    if (turn.kind === "night") totals.night += 1;
    else totals.chat += 1;
    if (turn.status !== "live") {
      msSum += turn.ms;
      totals.timedTurns += 1;
    }
    if (turn.status === "failed") totals.failed += 1;
    const c = turn.counts;
    totals.events += c.events;
    totals.steps += c.steps;
    totals.toolCalls += c.toolCalls;
    totals.toolErrors += c.toolErrors;
    totals.memorySearch += c.memorySearch;
    totals.cardsFound += c.cardsFound;
    totals.cardsFoundKnown = totals.cardsFoundKnown || c.cardsFoundKnown;
    totals.cardsWritten += c.cardsWritten;
    totals.gateBlocked += c.gateBlocked;
    totals.gateFlagged += c.gateFlagged;
    totals.gateClean += c.gateClean;
    totals.tokens.in += turn.tokens.in;
    totals.tokens.out += turn.tokens.out;
    totals.tokens.cacheRead += turn.tokens.cacheRead;
    totals.tokens.cacheWrite += turn.tokens.cacheWrite;
    totals.tokens.costUsd += turn.tokens.costUsd;
    for (const [node, count] of Object.entries(turn.nodes))
      totals.nodes[node] = (totals.nodes[node] ?? 0) + count;
  }
  totals.avgMs = totals.timedTurns === 0 ? 0 : Math.round(msSum / totals.timedTurns);
  return totals;
}

/** `2026-08-17` shifted by whole days, without leaving the day-name space. */
export function dayShift(day: string, delta: number): string {
  const [y, m, d] = day.split("-").map(Number);
  const moved = new Date(Date.UTC(y, m - 1, d) + delta * 86400000);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${moved.getUTCFullYear()}-${pad(moved.getUTCMonth() + 1)}-${pad(moved.getUTCDate())}`;
}
