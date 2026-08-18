// Stitching and counting, against the fixture journal and against garbage.
// Randomised cases print their seed; TRACE_SEED=<n> replays one.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseLine,
  stitch,
  statsFor,
  splitTurn,
  toolNode,
  cardsInResult,
  dayShift,
  nodesForEvent,
} from "../sh.iva/services/viewer/journal.ts";
import type { TraceEvent, Turn } from "../sh.iva/services/viewer/journal.ts";
import { Store, dayOf } from "../sh.iva/services/viewer/store.ts";
import { fixtureFiles, fixturePlan, writeFixture } from "./fixture.ts";
import type { Plan } from "./fixture.ts";

const SEED = Number(process.env.TRACE_SEED ?? 20260817);
const NOW = Date.parse("2026-08-17T12:00:00Z");
const TODAY = dayOf(NOW);

/** A day file as the fixture holds it: the day name and its lines. */
type DayFile = [string, string[]];

/** A turn as the fixture planned it, chat or night. */
type Planned = Plan["chat"][number] | Plan["night"][number];

/** Tiny deterministic PRNG: a failing case is replayable from the printed seed. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Every line of the fixture, day by day, exactly as the files hold them. */
const fixtureLines = (now = NOW): DayFile[] =>
  [...fixtureFiles(now)].map(([day, lines]) => [day, lines]);

/** Lines to events, the way a reader parses a file: line numbers included. */
function eventsOf(files: readonly DayFile[]): TraceEvent[] {
  const events: TraceEvent[] = [];
  for (const [day, lines] of files)
    lines.forEach((line, i) => {
      const event = parseLine(line, { file: day, line: i + 1 });
      if (event !== null) events.push(event);
    });
  return events;
}

const fixtureEvents = (now = NOW) => eventsOf(fixtureLines(now));

const shape = (turns: readonly Turn[]) =>
  turns.map((turn) => ({
    id: turn.id,
    kind: turn.kind,
    source: turn.source,
    status: turn.status,
    ms: turn.ms,
    events: turn.counts.events,
    counts: turn.counts,
    tokens: turn.tokens,
    nodes: { ...turn.nodes },
    title: turn.title,
    order: turn.events.map((e) => `${e.event}@${e.ts}`),
  }));

test("a line becomes an event only when it carries the seven fields", () => {
  const ok = parseLine(
    '{"ts":"2026-08-17T09:00:00.000Z","turn":"turn_0","session":"s1","source":"telegram","kind":"eve","name":"turn.started","data":{"sequence":1}}',
    { file: "2026-08-17", line: 3 },
  );
  assert.ok(ok !== null);
  assert.equal(ok.event, "eve.turn.started");
  assert.equal(ok.at, Date.parse("2026-08-17T09:00:00.000Z"));
  assert.equal(ok.line, 3);

  const broken = [
    "",
    "   ",
    "not json at all",
    "[1,2,3]",
    "null",
    '"a string"',
    "{",
    '{"ts":"2026-08-17T09:00:00Z","kind":"eve"}', // no name
    '{"ts":"nope","kind":"eve","name":"x"}', // unparsable ts
    '{"kind":"eve","name":"x"}', // no ts
    '{"ts":"2026-08-17T09:00:00Z","kind":"","name":"x"}',
    '{"ts":1755400000000,"kind":"eve","name":"x"}', // ts of the wrong type
  ];
  for (const line of broken) assert.equal(parseLine(line, {}), null, line);

  // data of a wrong type degrades to an empty object, it never throws
  const odd = parseLine('{"ts":"2026-08-17T09:00:00Z","kind":"eve","name":"x","data":7}', {});
  assert.ok(odd !== null);
  assert.deepEqual(odd.data, {});
  assert.equal(odd.source, "unknown");
});

test("garbage never throws and never becomes an event", () => {
  const random = rng(SEED);
  const alphabet = '{}[]",:\\ntsurn0123abcé😀';
  for (let i = 0; i < 400; i += 1) {
    let line = "";
    const length = Math.floor(random() * 40);
    for (let j = 0; j < length; j += 1)
      line += alphabet[Math.floor(random() * alphabet.length)];
    const value = parseLine(line, { file: "x", line: i });
    assert.ok(value === null || typeof value.event === "string", `seed ${SEED}, line ${line}`);
  }
});

test("any order of the lines stitches to the same turns", () => {
  const events = fixtureEvents();
  const base = shape(stitch(events).turns);
  for (let round = 0; round < 12; round += 1) {
    const random = rng(SEED + round);
    const mixed = stitch(shuffled(events, random));
    assert.deepEqual(shape(mixed.turns), base, `seed ${SEED + round} broke the stitching`);
  }
});

test("broken lines written into the middle of the files change nothing", () => {
  const clean = shape(stitch(fixtureEvents()).turns);
  // Real damage, in the file itself: a half-written line, a torn one, a line of NUL bytes,
  // valid JSON that is not an event. Two processes append to one file, so a reader meets all
  // of these in the middle of a day, not at the end of it.
  for (let round = 0; round < 8; round += 1) {
    const random = rng(SEED + 500 + round);
    const files: DayFile[] = fixtureLines().map(([day, lines]) => {
      const copy = [...lines];
      const torn = copy[Math.floor(random() * copy.length)];
      const junk = [
        '{"ts":"2026-08-17T',
        "",
        "}{",
        '{"kind":"eve"}',
        "\u0000\u0000", // a torn write can leave holes, not text
        "  ",
        torn.slice(0, Math.max(1, Math.floor(torn.length * random()))),
        '{"ts":"2026-08-17T09:00:00Z","turn":"turn_0","kind":"eve"}',
      ];
      for (const line of junk) {
        assert.equal(parseLine(line, { file: day, line: 1 }), null, `parsed junk: ${line}`);
        copy.splice(Math.floor(random() * copy.length), 0, line);
      }
      return [day, copy];
    });
    const dirty = eventsOf(files);
    assert.equal(dirty.length, fixtureEvents().length, `seed ${SEED + 500 + round}`);
    assert.deepEqual(shape(stitch(dirty).turns), clean, `seed ${SEED + 500 + round}`);
  }
});

test("every turn the fixture scripted comes back, and nothing else", () => {
  const { turns, unattached } = stitch(fixtureEvents());
  const plan = fixturePlan(NOW);
  const planned = [...plan.chat, ...plan.night];
  assert.equal(turns.length, planned.length);
  assert.equal(unattached.length, 1); // the Bridge callback line, which has no turn

  const byId = new Map(turns.map((turn) => [turn.id, turn]));
  for (const want of planned) {
    const turn = byId.get(want.id);
    assert.ok(turn, `no turn for ${want.id}`);
    assert.equal(turn.status, want.status, want.id);
    assert.equal(turn.counts.steps, want.steps, `steps of ${want.id}`);
    assert.equal(turn.counts.toolCalls, want.tools.length, `tool calls of ${want.id}`);
    assert.equal(turn.counts.toolErrors, want.toolErrors, `tool errors of ${want.id}`);
    assert.equal(turn.counts.subagents, want.subagents, `subagents of ${want.id}`);
    assert.equal(turn.counts.cardsWritten, want.cardsWritten, `cards written by ${want.id}`);
    assert.equal(turn.counts.cardsFound, want.cardsFound, `cards found by ${want.id}`);
    // the number on a tool node is the number of calls of that tool, mapped by toolNode()
    const perNode = new Map<string, number>();
    for (const tool of want.tools) {
      const node = toolNode(tool);
      perNode.set(node, (perNode.get(node) ?? 0) + 1);
    }
    for (const [node, count] of perNode) assert.equal(turn.nodes[node], count, `${want.id} ${node}`);
    // and the seams measure themselves: steps on the Model, calls on Tools, cards in the Vault
    assert.equal(turn.nodes.model ?? 0, want.steps, `Model of ${want.id}`);
    assert.equal(turn.nodes.tools ?? 0, want.tools.length, `Tools of ${want.id}`);
    if (turn.nodes.vault !== undefined)
      assert.equal(turn.nodes.vault, want.cardsFound + want.cardsWritten, `Vault of ${want.id}`);
    if (want.subagents > 0) assert.equal(turn.nodes.planner, want.subagents);
  }
});

test("the shapes of a real day read the way the contract describes them", () => {
  const { turns } = stitch(fixtureEvents());
  const byId = new Map(turns.map((turn) => [turn.id, turn]));

  // a chat turn: bound by turn.bound, so Bridge lines and Eve lines land in one turn
  const plain = byId.get("u:tg:88123456:5121")!;
  assert.equal(plain.kind, "chat");
  assert.equal(plain.source, "telegram");
  assert.equal(plain.turnKey, "turn_0");
  assert.equal(plain.updateKey, "tg:88123456:5121");
  assert.ok(plain.title.startsWith("Доброе утро"));
  assert.equal(plain.flags.delivered, true);

  // the blocked turn never became an Eve turn: a verdict plus a service reply, no Outbox
  const blocked = byId.get("u:tg:88123456:5141")!;
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.counts.gateBlocked, 1);
  assert.equal(blocked.counts.steps, 0);
  assert.equal(blocked.flags.delivered, false);

  // the failed turn: a step failed and the Outbox failed too
  const failed = byId.get("u:tg:88123456:5144")!;
  assert.equal(failed.status, "failed");
  assert.equal(failed.flags.trimmed, true); // the trimmed bash result
  assert.equal(byId.get("u:tg:88123456:5163")!.status, "cancelled"); // Stop came in
  assert.equal(byId.get("u:tg:88123456:5164")!.status, "live"); // no terminal event yet

  // the subagent: its lines carry the parent turn key with a suffix and nest under it
  const planner = byId.get("u:tg:88123456:5142")!;
  assert.equal(planner.counts.subagents, 1);
  const nested = planner.events.filter((event) => event.depth === 1);
  assert.equal(nested.length, 5);
  assert.ok(nested.every((event) => event.subagent === "planner"));
  assert.ok(nested.every((event) => splitTurn(event.turn).base === "turn_2"));
  assert.equal(planner.nodes.planner, 1);
});

test("one session can hold several turns, and they stay apart", () => {
  const { turns } = stitch(fixtureEvents());
  const plan = fixturePlan(NOW);

  // The digest sends twice inside one session (contract): two turns, not one, and the keyless
  // seam lines go to the turn that was open when they were written.
  const digest = turns.filter((turn) => turn.session === "sess_night_c");
  assert.equal(digest.length, 2);
  assert.deepEqual(
    digest.map((turn) => turn.id).sort(),
    ["s:sess_night_c|turn_0", "s:sess_night_c|turn_1"],
  );
  for (const turn of digest) {
    assert.equal(turn.kind, "night");
    assert.equal(turn.source, "digest");
    assert.equal(turn.night, "digest");
    assert.equal(turn.updateKey, "");
    assert.equal(turn.flags.delivered, true); // its own outbox.delivered, not the other one's
    assert.equal(turn.counts.gateClean, 1); // one verdict each, not both on one turn
  }
  // and they are separate summaries: the second turn wrote the second card
  const cards = digest.map((turn) => turn.counts.cardsWritten);
  assert.deepEqual(cards, [1, 1]);

  // A Rollup keeps its session alive across midnight: two turns in two day files.
  const span = turns
    .filter((turn) => turn.session === "sess_night_span")
    .sort((a, b) => a.at - b.at);
  assert.equal(span.length, 2);
  assert.notEqual(dayOf(span[0].at), dayOf(span[1].at));
  assert.equal(span[0].counts.cardsWritten, 1);
  assert.equal(span[1].counts.cardsWritten, 2);
  for (const turn of span) {
    assert.equal(turn.kind, "night");
    assert.equal(turn.source, "rollup");
    assert.equal(turn.flags.delivered, true);
  }

  // every scripted night turn is its own turn: the source is not part of the key
  assert.equal(
    turns.filter((turn) => turn.kind === "night").length,
    plan.night.length,
  );
});

test("the tiles count the fixture the way the journal reads", () => {
  const { turns } = stitch(fixtureEvents());
  const plan = fixturePlan(NOW);
  const planned = [...plan.chat, ...plan.night];
  const all = statsFor(turns, { today: TODAY, days: 14, dayOf });

  const sum = (pick: (item: Planned) => number): number =>
    planned.reduce((total, item) => total + pick(item), 0);
  assert.equal(all.turns, planned.length);
  assert.equal(all.chat, plan.chat.length);
  assert.equal(all.night, plan.night.length);
  assert.equal(all.steps, sum((item) => item.steps));
  assert.equal(all.toolCalls, sum((item) => item.tools.length));
  assert.equal(all.toolErrors, sum((item) => item.toolErrors));
  assert.equal(all.cardsWritten, sum((item) => item.cardsWritten));
  assert.equal(all.cardsFound, sum((item) => item.cardsFound));
  assert.equal(
    all.memorySearch,
    sum((item) => item.tools.filter((tool) => tool === "memory_search").length),
  );
  assert.equal(all.failed, planned.filter((item) => item.status === "failed").length);
  assert.equal(all.gateBlocked, 1);
  assert.equal(all.gateFlagged, 1);
  assert.equal(all.timedTurns, planned.length - 1); // the live turn has no duration yet
  assert.ok(all.avgMs > 0);
  assert.ok(all.tokens.costUsd > 1);
  assert.equal(all.nodes.model, all.steps); // the Model node counts steps, per turn and per period

  // the period is a window on the same turns: shorter can only be smaller, and the three
  // periods of the page really differ on this journal
  const today = statsFor(turns, { today: TODAY, days: 1, dayOf });
  const week = statsFor(turns, { today: TODAY, days: 7, dayOf });
  assert.equal(today.from, TODAY);
  assert.equal(week.from, dayShift(TODAY, -6));
  assert.equal(all.from, dayShift(TODAY, -13));
  assert.ok(today.turns > 0);
  assert.ok(today.turns < week.turns, `${today.turns} vs ${week.turns}`);
  assert.ok(week.turns < all.turns, `${week.turns} vs ${all.turns}`);
  assert.ok(today.toolCalls < week.toolCalls && week.toolCalls < all.toolCalls);

  // sums are additive: every turn of the window is counted once
  const byHand = turns.reduce((total, turn) => total + turn.counts.toolCalls, 0);
  assert.equal(all.toolCalls, byHand);
});

test("an empty journal gives empty tiles, not a crash", () => {
  const { turns, unattached } = stitch([]);
  assert.deepEqual(turns, []);
  assert.deepEqual(unattached, []);
  const stats = statsFor(turns, { today: TODAY, days: 7, dayOf });
  assert.equal(stats.turns, 0);
  assert.equal(stats.avgMs, 0);
  assert.deepEqual(Object.keys(stats.nodes), []);
});

test("turn keys, tools and card counts map by their own rules", () => {
  assert.deepEqual(splitTurn("turn_3#planner"), { base: "turn_3", subagent: "planner" });
  assert.deepEqual(splitTurn("turn_3"), { base: "turn_3", subagent: "" });
  assert.deepEqual(splitTurn(""), { base: "", subagent: "" });

  assert.equal(toolNode("memory_search"), "memory_search");
  assert.equal(toolNode("write_card"), "write_card");
  assert.equal(toolNode("grep"), "files");
  assert.equal(toolNode("read_file"), "files");
  assert.equal(toolNode("something_new"), "other");
  assert.equal(toolNode(""), "other");

  assert.deepEqual(cardsInResult({ count: 5, hits: [] }), { known: true, count: 5 });
  assert.deepEqual(cardsInResult({ hits: [1, 2] }), { known: true, count: 2 });
  assert.deepEqual(cardsInResult('{"count":3}'), { known: true, count: 3 });
  assert.deepEqual(cardsInResult('… "count": 7 …'), { known: true, count: 7 });
  assert.deepEqual(cardsInResult("no numbers here"), { known: false, count: 0 });
  assert.deepEqual(cardsInResult(undefined), { known: false, count: 0 });

  assert.equal(dayShift("2026-08-17", -1), "2026-08-16");
  assert.equal(dayShift("2026-03-01", -1), "2026-02-28");
  assert.equal(dayShift("2026-01-01", -1), "2025-12-31");
});

test("an event knows which nodes of the schema it lights", () => {
  const at = "2026-08-17T09:00:00.000Z";
  const make = (
    kind: string,
    name: string,
    data: Record<string, unknown> = {},
    source = "telegram",
    turn = "turn_0",
  ): TraceEvent =>
    parseLine(JSON.stringify({ ts: at, turn, session: "s", source, kind, name, data }), {})!;

  assert.deepEqual(nodesForEvent(make("bridge", "admitted")), ["bridge", "telegram_in"]);
  assert.deepEqual(nodesForEvent(make("gate", "inbound")), ["gate_in", "inbound"]);
  assert.deepEqual(nodesForEvent(make("gate", "web")), ["web_fetch"]);
  assert.deepEqual(nodesForEvent(make("context", "parts")), ["context"]);
  assert.deepEqual(nodesForEvent(make("outbox", "delivered")), ["outbox", "telegram_out"]);
  assert.deepEqual(
    nodesForEvent(
      make("eve", "actions.requested", {
        actions: [{ toolName: "memory_search" }, { toolName: "bash" }],
      }),
    ),
    ["tools", "memory_search", "vault", "bash"],
  );
  assert.deepEqual(nodesForEvent(make("eve", "action.result", { toolName: "write_card" })), [
    "write_card",
    "tools",
    "vault",
  ]);
  assert.deepEqual(
    nodesForEvent(make("eve", "step.completed", { subagent: "planner" }, "telegram", "turn_0#planner")),
    ["planner"],
  );
  // a night turn names itself: Rollup or Report, next to the model
  assert.deepEqual(nodesForEvent(make("eve", "turn.started", {}, "http"), "rollup"), [
    "model",
    "rollup",
  ]);
  assert.deepEqual(nodesForEvent(make("eve", "turn.started", {}, "http"), "digest"), [
    "model",
    "report",
  ]);
  assert.deepEqual(nodesForEvent(make("nonsense", "whatever")), []);
  // Brain is not in the journal: no event lights it, so the page must not print a number on it
  const lit = new Set<string>();
  for (const event of fixtureEvents()) for (const node of nodesForEvent(event)) lit.add(node);
  assert.ok(!lit.has("brain"));
});

test("the Store reads the fixture from disk and follows a new line", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-journal-"));
  try {
    writeFixture(dir, NOW);
    const store = new Store({ dataDir: dir, now: () => NOW });
    const first = store.events();
    assert.ok(first.length > 500);
    assert.equal(stitch(first).turns.length, fixturePlan(NOW).chat.length + fixturePlan(NOW).night.length);
    // the cache must not hide a fresh line
    appendFileSync(
      join(dir, "trace", `${TODAY}.jsonl`),
      `${JSON.stringify({
        ts: new Date(NOW).toISOString(),
        turn: "tg:88123456:5999",
        session: "",
        source: "bridge",
        kind: "bridge",
        name: "admitted",
        data: { chatId: 88123456, messageId: 5999, kind: "message", decision: "owned" },
      })}\n`,
    );
    assert.equal(store.events().length, first.length + 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
