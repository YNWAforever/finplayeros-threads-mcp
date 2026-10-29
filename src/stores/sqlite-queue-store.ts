import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { queuePostSchema, type QueuePost } from '../core/model.js';
import type { QueueStore } from './queue-store.js';

/** Node 24 built-in SQLite; each UPSERT commits atomically, including state and history. */
export class SqliteQueueStore implements QueueStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (path.length === 0) throw new Error('SQLite database path must not be empty.');
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    try {
      if (path !== ':memory:') chmodSync(path, 0o600);
      const version = this.db.prepare('PRAGMA user_version').get()?.user_version;
      if (version !== 0 && version !== 1) throw new Error('Unsupported FinPlayer SQLite schema version.');
      this.db.exec(`
        PRAGMA busy_timeout = 5000;
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = FULL;
        CREATE TABLE IF NOT EXISTS posts (
          id TEXT PRIMARY KEY,
          data TEXT NOT NULL CHECK (json_valid(data))
        ) STRICT;
        PRAGMA user_version = 1;
      `);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  async list(): Promise<QueuePost[]> {
    return this.db.prepare('SELECT data FROM posts ORDER BY rowid').all().map((row) => this.parseRow(row.data));
  }

  async get(id: string): Promise<QueuePost | undefined> {
    const row = this.db.prepare('SELECT data FROM posts WHERE id = ?').get(id);
    return row ? this.parseRow(row.data) : undefined;
  }

  async save(post: QueuePost): Promise<void> {
    const validated = queuePostSchema.parse(post);
    this.db.prepare(`
      INSERT INTO posts (id, data) VALUES (?, ?)
      ON CONFLICT(id) DO UPDATE SET data = excluded.data
    `).run(validated.id, JSON.stringify(validated));
  }

  close(): void {
    if (this.db.isOpen) this.db.close();
  }

  private parseRow(data: unknown): QueuePost {
    if (typeof data !== 'string') throw new Error('Invalid FinPlayer SQLite record.');
    return queuePostSchema.parse(JSON.parse(data));
  }
}
