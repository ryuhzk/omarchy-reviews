import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import type { CachedInbox, Review, ReviewResponse } from "./model";

interface ReviewRow {
  id: string;
  app_id: string;
  store: string;
  rating: number;
  title: string;
  body: string;
  nickname: string;
  created_date: string;
  territory: string;
  version: string;
  response_id: string | null;
  response_body: string | null;
  response_last_modified: string | null;
  response_state: string | null;
}

interface MetaRow {
  app_id: string;
  next_url: string;
  fetched_at: string;
}

export function inboxDbPath(cacheDir: string): string {
  return join(cacheDir, "inbox.sqlite");
}

export function openInboxDb(cacheDir: string): Database {
  mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
  const path = inboxDbPath(cacheDir);
  const db = new Database(path, { create: true });
  db.run("PRAGMA journal_mode = WAL;");
  db.run(`
    CREATE TABLE IF NOT EXISTS reviews (
      id TEXT PRIMARY KEY,
      app_id TEXT NOT NULL,
      rating INTEGER NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      nickname TEXT NOT NULL,
      created_date TEXT NOT NULL,
      territory TEXT NOT NULL,
      response_id TEXT,
      response_body TEXT,
      response_last_modified TEXT,
      response_state TEXT,
      updated_at TEXT NOT NULL
    )
  `);
  db.run("CREATE INDEX IF NOT EXISTS reviews_app_created ON reviews(app_id, created_date DESC)");
  ensureColumn(db, "reviews", "store", "TEXT NOT NULL DEFAULT 'apple'");
  ensureColumn(db, "reviews", "version", "TEXT NOT NULL DEFAULT ''");
  db.run(`
    CREATE TABLE IF NOT EXISTS inbox_meta (
      app_id TEXT PRIMARY KEY,
      next_url TEXT NOT NULL DEFAULT '',
      fetched_at TEXT NOT NULL
    )
  `);
  try {
    chmodSync(path, 0o600);
  } catch {
    // The directory mode already keeps the file private if chmod is unsupported.
  }
  return db;
}

export function emptyInbox(appId: string): CachedInbox {
  return { appId, reviews: [], next: "", fetchedAt: "" };
}

export function rememberReviews(cacheDir: string, appId: string, reviews: Review[], next?: string): CachedInbox {
  const db = openInboxDb(cacheDir);
  try {
    const now = new Date().toISOString();
    const upsert = db.query(`
      INSERT INTO reviews (
        id, app_id, store, rating, title, body, nickname, created_date, territory, version,
        response_id, response_body, response_last_modified, response_state, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        app_id = excluded.app_id,
        store = excluded.store,
        rating = excluded.rating,
        title = excluded.title,
        body = excluded.body,
        nickname = excluded.nickname,
        created_date = excluded.created_date,
        territory = excluded.territory,
        version = excluded.version,
        response_id = excluded.response_id,
        response_body = excluded.response_body,
        response_last_modified = excluded.response_last_modified,
        response_state = excluded.response_state,
        updated_at = excluded.updated_at
    `);
    const writeMeta = db.query(`
      INSERT INTO inbox_meta (app_id, next_url, fetched_at) VALUES (?, ?, ?)
      ON CONFLICT(app_id) DO UPDATE SET
        next_url = excluded.next_url,
        fetched_at = excluded.fetched_at
    `);
    const touchMeta = db.query(`
      INSERT INTO inbox_meta (app_id, next_url, fetched_at) VALUES (?, '', ?)
      ON CONFLICT(app_id) DO UPDATE SET fetched_at = excluded.fetched_at
    `);

    const save = db.transaction((items: Review[]) => {
      for (const review of items) {
        const response = review.response;
        upsert.run(
          review.id,
          appId,
          review.store === "play" ? "play" : "apple",
          Number(review.rating) || 0,
          String(review.title || ""),
          String(review.body || ""),
          String(review.nickname || ""),
          String(review.createdDate || ""),
          String(review.territory || ""),
          String(review.version || ""),
          response ? response.id : null,
          response ? response.body : null,
          response ? response.lastModifiedDate : null,
          response ? response.state : null,
          now,
        );
      }
      if (next !== undefined) writeMeta.run(appId, next, now);
      else touchMeta.run(appId, now);
    });
    save(reviews);
    return readInbox(db, appId);
  } finally {
    db.close();
  }
}

export function listCachedInbox(cacheDir: string, appId: string): CachedInbox {
  const db = openInboxDb(cacheDir);
  try {
    return readInbox(db, appId);
  } finally {
    db.close();
  }
}

export function patchCachedReply(cacheDir: string, reviewId: string, response: ReviewResponse | null): boolean {
  const db = openInboxDb(cacheDir);
  try {
    const result = db.query(`
      UPDATE reviews SET
        response_id = ?,
        response_body = ?,
        response_last_modified = ?,
        response_state = ?,
        updated_at = ?
      WHERE id = ?
    `).run(
      response ? response.id : null,
      response ? response.body : null,
      response ? response.lastModifiedDate : null,
      response ? response.state : null,
      new Date().toISOString(),
      reviewId,
    );
    return Number(result.changes) > 0;
  } finally {
    db.close();
  }
}

export function clearCachedReply(cacheDir: string, responseId: string): boolean {
  const db = openInboxDb(cacheDir);
  try {
    const result = db.query(`
      UPDATE reviews SET
        response_id = NULL,
        response_body = NULL,
        response_last_modified = NULL,
        response_state = NULL,
        updated_at = ?
      WHERE response_id = ?
    `).run(new Date().toISOString(), responseId);
    return Number(result.changes) > 0;
  } finally {
    db.close();
  }
}

function readInbox(db: Database, appId: string): CachedInbox {
  const meta = db.query("SELECT app_id, next_url, fetched_at FROM inbox_meta WHERE app_id = ?").get(appId) as MetaRow | null;
  const rows = db.query(`
    SELECT id, app_id, store, rating, title, body, nickname, created_date, territory, version,
           response_id, response_body, response_last_modified, response_state
    FROM reviews
    WHERE app_id = ?
    ORDER BY created_date DESC, id DESC
  `).all(appId) as ReviewRow[];
  return {
    appId,
    reviews: rows.map(rowToReview),
    next: meta?.next_url || "",
    fetchedAt: meta?.fetched_at || "",
  };
}

export function findCachedReview(cacheDir: string, reviewId: string): { appId: string; review: Review } | null {
  const db = openInboxDb(cacheDir);
  try {
    const row = db.query(`
      SELECT id, app_id, store, rating, title, body, nickname, created_date, territory, version,
             response_id, response_body, response_last_modified, response_state
      FROM reviews
      WHERE id = ?
    `).get(reviewId) as ReviewRow | null;
    if (!row) return null;
    return { appId: row.app_id, review: rowToReview(row) };
  } finally {
    db.close();
  }
}

function rowToReview(row: ReviewRow): Review {
  return {
    id: row.id,
    store: row.store === "play" ? "play" : "apple",
    rating: Number(row.rating) || 0,
    title: row.title,
    body: row.body,
    nickname: row.nickname,
    createdDate: row.created_date,
    territory: row.territory,
    version: row.version || "",
    response: row.response_id
      ? {
          id: row.response_id,
          body: row.response_body || "",
          lastModifiedDate: row.response_last_modified || "",
          state: row.response_state || "",
        }
      : null,
  };
}

function ensureColumn(db: Database, table: string, column: string, definition: string): void {
  const columns = db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (columns.some((item) => item.name === column)) return;
  db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
