import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync, lstatSync } from "node:fs";
import { dirname } from "node:path";
import type { Identity, StoredBot } from "./types";

export interface Registry {
  all(): StoredBot[];
  get(id: string): StoredBot | undefined;
  put(bot: StoredBot): void | Promise<void>;
  close(): void | Promise<void>;
  refresh?(): Promise<void>;
  write?<T>(work: () => Promise<T>): Promise<T>;
  credentials?(id: string, identity: Identity): { token: string; memoryKey: string };
}

/** Server-only durable registry. Credentials never leave publicBot's projection. */
export class BotRegistry implements Registry {
  private db: DatabaseSync;
  constructor(filename: string) {
    mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
    if (lstatSync(filename, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error("Unsafe registry path");
    this.db = new DatabaseSync(filename);
    chmodSync(filename, 0o600);
    this.db.exec("PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS bots (id TEXT PRIMARY KEY, value TEXT NOT NULL)");
  }
  all(): StoredBot[] {
    return this.db.prepare("SELECT value FROM bots ORDER BY id").all().map(row => JSON.parse(String(row.value)));
  }
  get(id: string): StoredBot | undefined {
    const row = this.db.prepare("SELECT value FROM bots WHERE id=?").get(id);
    return row ? JSON.parse(String(row.value)) : undefined;
  }
  put(bot: StoredBot): void {
    this.db.prepare("INSERT INTO bots VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET value=excluded.value")
      .run(bot.record.id, JSON.stringify(bot));
  }
  close(): void { this.db.close(); }
}
