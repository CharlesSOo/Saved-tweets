// bookmarks.jsonl: the server-side copy of the extension's records, read by the chat agent.
import { mkdir, rename } from "node:fs/promises";
import { join } from "node:path";

export const DATA_DIR = join(import.meta.dir, "..", "data");
const FILE = join(DATA_DIR, "bookmarks.jsonl");

export type StoredRecord = { id: string } & Record<string, unknown>;

// Fields the chat agent needs; everything else (status, flags, media) is dropped.
const KEEP = ["id", "url", "author", "handle", "text", "thread", "quoted", "links", "summary", "createdAt"] as const;
const slim = (r: StoredRecord): StoredRecord =>
  Object.fromEntries(KEEP.filter((k) => r[k] !== undefined && r[k] !== "").map((k) => [k, r[k]])) as StoredRecord;

async function load(): Promise<Map<string, StoredRecord>> {
  const map = new Map<string, StoredRecord>();
  const f = Bun.file(FILE);
  if (!(await f.exists())) return map;
  for (const line of (await f.text()).split("\n")) {
    if (!line.trim()) continue;
    const r = JSON.parse(line) as StoredRecord;
    map.set(r.id, r);
  }
  return map;
}

async function write(map: Map<string, StoredRecord>): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  const tmp = `${FILE}.${process.pid}.tmp`;
  await Bun.write(tmp, [...map.values()].map((r) => JSON.stringify(r)).join("\n") + (map.size ? "\n" : ""));
  await rename(tmp, FILE);
}

// Serialize mutations so concurrent requests can't interleave read-modify-write.
let queue: Promise<unknown> = Promise.resolve();
function locked<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn);
  queue = run.catch(() => {});
  return run;
}

/** Upserts records; with `replace`, the file becomes exactly these records (full push from the extension). */
export function upsert(records: StoredRecord[], replace = false): Promise<number> {
  return locked(async () => {
    const map = replace ? new Map<string, StoredRecord>() : await load();
    for (const r of records) if (r?.id) map.set(String(r.id), slim(r));
    await write(map);
    return map.size;
  });
}

export function remove(id: string): Promise<boolean> {
  return locked(async () => {
    const map = await load();
    const had = map.delete(id);
    if (had) await write(map);
    return had;
  });
}
