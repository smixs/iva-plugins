// The file side of the journal: which day files exist, their events (cached), and a tail of
// the current day. Read-only by construction — nothing here opens a file for writing, and the
// data directory of Iva is never created or touched.

import { readdirSync, readFileSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { parseLine, dayShift, type TraceEvent } from "./journal.ts";

const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/u;
const WINDOW_DAYS = 14; // retention of the journal (contract)
const CHUNK = 1 << 20;

const pad = (n: number): string => String(n).padStart(2, "0");

/** Local day name, the same one the writer uses for the file name. */
export function dayOf(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export const traceDir = (dataDir: string): string => join(dataDir, "trace");

/** Day names present in the journal, oldest first. Anything else in the folder is ignored. */
export function listDays(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const days: string[] = [];
  for (const entry of entries) {
    const match = DAY_FILE.exec(entry);
    if (match !== null) days.push(match[1]);
  }
  return days.sort();
}

/**
 * The day being appended to right now. Usually today, but the writer names files after the
 * installation timezone while the service knows only its own: a file dated ahead of the
 * service clock wins, otherwise the viewer would tail a file nobody writes.
 */
export function currentDay(dir: string, now: number): string {
  const today = dayOf(now);
  const days = listDays(dir);
  const last = days.length === 0 ? "" : days[days.length - 1];
  return last > today ? last : today;
}

/** One day file as it was last read: the events, and the stat that produced them. */
interface CachedDay {
  size: number;
  mtimeMs: number;
  events: TraceEvent[];
}

export class Store {
  dir: string;
  now: () => number;
  days: number;
  cache: Map<string, CachedDay>;

  constructor({
    dataDir,
    now = () => Date.now(),
    days = WINDOW_DAYS,
  }: {
    dataDir: string;
    now?: () => number;
    days?: number;
  }) {
    this.dir = traceDir(dataDir);
    this.now = now;
    this.days = days;
    this.cache = new Map(); // day to { size, mtimeMs, events }
  }

  /** Day names inside the retention window, newest last. */
  window(): string[] {
    const today = currentDay(this.dir, this.now());
    const from = dayShift(today, -(this.days - 1));
    return listDays(this.dir).filter((day) => day >= from && day <= today);
  }

  path(day: string): string {
    return join(this.dir, `${day}.jsonl`);
  }

  /** Events of one day file. Re-read only when its size or mtime moved. */
  dayEvents(day: string): TraceEvent[] {
    const path = this.path(day);
    let info;
    try {
      info = statSync(path);
    } catch {
      this.cache.delete(day);
      return [];
    }
    const hit = this.cache.get(day);
    if (hit !== undefined && hit.size === info.size && hit.mtimeMs === info.mtimeMs)
      return hit.events;
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      return [];
    }
    const events: TraceEvent[] = [];
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      const event = parseLine(lines[i], { file: day, line: i + 1 });
      if (event !== null) events.push(event);
    }
    this.cache.set(day, { size: info.size, mtimeMs: info.mtimeMs, events });
    return events;
  }

  /**
   * Fingerprint of the whole window: which day files it holds and the size and mtime of each.
   * A reader that stitched the window can hold on to its work while this string stays equal —
   * an appended line moves size, a rewritten file moves mtime, a pruned day leaves the list.
   * Taken before reading, so a file that grows during the read gets a new fingerprint next time.
   */
  stamp(): string {
    const parts: string[] = [];
    for (const day of this.window()) {
      let info;
      try {
        info = statSync(this.path(day));
      } catch {
        continue;
      }
      parts.push(`${day}:${info.size}:${info.mtimeMs}`);
    }
    return parts.join(",");
  }

  /** Every event of the retention window, unsorted (the stitcher sorts). */
  events(): TraceEvent[] {
    const all: TraceEvent[] = [];
    for (const day of this.window()) all.push(...this.dayEvents(day));
    return all;
  }
}

/** What one poll of the tail brings back. */
export interface Poll {
  rollover: boolean;
  day: string;
  events: TraceEvent[];
}

/**
 * Tail of the current day file by size: open, read the new bytes, keep the half line for the
 * next poll. A day change resets the offset and reports a rollover, so a viewer left open
 * overnight follows the journal into the new file.
 */
export class Tail {
  dir: string;
  now: () => number;
  day: string;
  decoder: StringDecoder;
  pending: string;
  line: number;
  offset: number;

  constructor({
    dataDir,
    now = () => Date.now(),
    fromStart = false,
  }: {
    dataDir: string;
    now?: () => number;
    fromStart?: boolean;
  }) {
    this.dir = traceDir(dataDir);
    this.now = now;
    this.day = currentDay(this.dir, this.now());
    this.decoder = new StringDecoder("utf8");
    this.pending = "";
    this.line = 0;
    this.offset = fromStart ? 0 : this.size();
  }

  size(): number {
    try {
      return statSync(join(this.dir, `${this.day}.jsonl`)).size;
    } catch {
      return 0;
    }
  }

  reset(day: string): void {
    this.day = day;
    this.decoder = new StringDecoder("utf8");
    this.pending = "";
    this.offset = 0;
    this.line = 0;
  }

  /** New events since the last poll, plus whether the day file rolled over. */
  poll(): Poll {
    const day = currentDay(this.dir, this.now());
    let rollover = false;
    if (day !== this.day) {
      this.reset(day);
      rollover = true;
    }
    const size = this.size();
    // A file that shrank was replaced or restored: start over rather than read garbage.
    if (size < this.offset) this.reset(this.day);
    const events: TraceEvent[] = [];
    if (size > this.offset) {
      let fd: number;
      try {
        fd = openSync(join(this.dir, `${this.day}.jsonl`), "r");
      } catch {
        return { rollover, day: this.day, events };
      }
      try {
        const buffer = Buffer.allocUnsafe(CHUNK);
        while (this.offset < size) {
          const want = Math.min(CHUNK, size - this.offset);
          const read = readSync(fd, buffer, 0, want, this.offset);
          if (read <= 0) break;
          this.offset += read;
          this.pending += this.decoder.write(buffer.subarray(0, read));
        }
      } finally {
        closeSync(fd);
      }
      const parts = this.pending.split("\n");
      this.pending = parts.pop() ?? "";
      for (const part of parts) {
        this.line += 1;
        const event = parseLine(part, { file: this.day, line: this.line });
        if (event !== null) events.push(event);
      }
    }
    return { rollover, day: this.day, events };
  }
}
