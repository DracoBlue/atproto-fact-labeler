import { getConfig } from '../config/index.ts';
import { openDatabase, type DbLike } from './runtime-sqlite.ts';

let _db: DbLike | undefined;

export async function getDbAsync(): Promise<DbLike> {
  if (_db) return _db;
  const cfg = getConfig();
  const db = await openDatabase(cfg.SQLITE_PATH);
  db.pragma?.('journal_mode = WAL');
  db.pragma?.('synchronous = NORMAL');
  db.pragma?.('foreign_keys = ON');
  migrate(db);
  _db = db;
  return db;
}

/**
 * Synchronous getter. Throws if the DB hasn't been opened yet. The first call
 * must be `getDbAsync()` in the entrypoint so the dynamic import resolves.
 */
export function getDb(): DbLike {
  if (!_db) {
    throw new Error('Database not initialised — call getDbAsync() during startup first.');
  }
  return _db;
}

export function closeDb(): void {
  _db?.close();
  _db = undefined;
}

function migrate(db: DbLike): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS claim_review (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      source_url      TEXT    NOT NULL,
      publisher       TEXT    NOT NULL,
      publisher_url   TEXT,
      claim_reviewed  TEXT    NOT NULL,
      claim_author    TEXT,
      rating_native   TEXT,
      rating_url      TEXT,
      review_date     TEXT,
      lang            TEXT,
      sd_license      TEXT,
      attribution     TEXT    NOT NULL,
      ingested_at     TEXT    NOT NULL DEFAULT (datetime('now')),
      UNIQUE(source_url)
    );

    CREATE INDEX IF NOT EXISTS idx_claim_review_publisher ON claim_review(publisher);
    CREATE INDEX IF NOT EXISTS idx_claim_review_lang ON claim_review(lang);
    CREATE INDEX IF NOT EXISTS idx_claim_review_review_date ON claim_review(review_date);

    -- FTS5 virtual table over claim_reviewed text for cross-lingual fuzzy match.
    -- We use unicode61 with diacritic removal so DE/FR/ES tokens normalise.
    CREATE VIRTUAL TABLE IF NOT EXISTS claim_review_fts USING fts5(
      claim_reviewed,
      content='claim_review',
      content_rowid='id',
      tokenize='unicode61 remove_diacritics 2'
    );

    -- Keep FTS in sync via triggers.
    CREATE TRIGGER IF NOT EXISTS claim_review_ai
      AFTER INSERT ON claim_review BEGIN
        INSERT INTO claim_review_fts(rowid, claim_reviewed)
          VALUES (new.id, new.claim_reviewed);
      END;
    CREATE TRIGGER IF NOT EXISTS claim_review_ad
      AFTER DELETE ON claim_review BEGIN
        INSERT INTO claim_review_fts(claim_review_fts, rowid, claim_reviewed)
          VALUES ('delete', old.id, old.claim_reviewed);
      END;
    CREATE TRIGGER IF NOT EXISTS claim_review_au
      AFTER UPDATE ON claim_review BEGIN
        INSERT INTO claim_review_fts(claim_review_fts, rowid, claim_reviewed)
          VALUES ('delete', old.id, old.claim_reviewed);
        INSERT INTO claim_review_fts(rowid, claim_reviewed)
          VALUES (new.id, new.claim_reviewed);
      END;

    CREATE TABLE IF NOT EXISTS post_cache (
      uri          TEXT PRIMARY KEY,
      cid          TEXT NOT NULL,
      did          TEXT NOT NULL,
      text         TEXT NOT NULL,
      lang         TEXT,
      indexed_at   TEXT,
      seen_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS claim (
      id                       INTEGER PRIMARY KEY AUTOINCREMENT,
      post_uri                 TEXT    NOT NULL REFERENCES post_cache(uri),
      atomic_text              TEXT    NOT NULL,
      decontextualized_text    TEXT,
      span_start               INTEGER,
      span_end                 INTEGER,
      lang                     TEXT,
      is_falsifiable           INTEGER NOT NULL DEFAULT 1,
      entities_json            TEXT,
      confidence               REAL,
      extractor_version        TEXT,
      extracted_at             TEXT    NOT NULL DEFAULT (datetime('now')),
      status                   TEXT    NOT NULL DEFAULT 'proposed'
                                          CHECK (status IN ('proposed','accepted','rejected'))
    );

    CREATE INDEX IF NOT EXISTS idx_claim_post_uri ON claim(post_uri);
    CREATE INDEX IF NOT EXISTS idx_claim_status   ON claim(status);

    CREATE TABLE IF NOT EXISTS verdict (
      id                       INTEGER PRIMARY KEY AUTOINCREMENT,
      claim_id                 INTEGER NOT NULL REFERENCES claim(id),
      post_uri                 TEXT    NOT NULL,
      label                    TEXT    NOT NULL
                                          CHECK (label IN ('true','false','mixed','unknown','disputed','outdated')),
      valid_at                 TEXT,
      verified_at              TEXT    NOT NULL DEFAULT (datetime('now')),
      verifier_kind            TEXT    NOT NULL
                                          CHECK (verifier_kind IN ('feed','model','human','quorum')),
      verifier_id              TEXT,
      confidence               REAL,
      rationale                TEXT,
      status                   TEXT    NOT NULL DEFAULT 'proposed'
                                          CHECK (status IN ('proposed','accepted','rejected','superseded')),
      supersedes               INTEGER REFERENCES verdict(id)
    );

    CREATE INDEX IF NOT EXISTS idx_verdict_post_uri ON verdict(post_uri);
    CREATE INDEX IF NOT EXISTS idx_verdict_status   ON verdict(status);

    CREATE TABLE IF NOT EXISTS evidence (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      verdict_id       INTEGER NOT NULL REFERENCES verdict(id),
      source_url       TEXT    NOT NULL,
      publisher        TEXT,
      rating_native    TEXT,
      reviewed_at      TEXT,
      retrieved_at     TEXT    NOT NULL DEFAULT (datetime('now')),
      retrieval_method TEXT,
      license          TEXT,
      attribution      TEXT,
      claim_review_id  INTEGER REFERENCES claim_review(id)
    );

    CREATE INDEX IF NOT EXISTS idx_evidence_verdict_id ON evidence(verdict_id);

    CREATE TABLE IF NOT EXISTS proposal (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      post_uri            TEXT    NOT NULL,
      claim_id            INTEGER NOT NULL REFERENCES claim(id),
      verdict_id          INTEGER NOT NULL REFERENCES verdict(id),
      created_at          TEXT    NOT NULL DEFAULT (datetime('now')),
      decided_at          TEXT,
      decision            TEXT    CHECK (decision IN ('accept','reject','defer')),
      decided_by          TEXT,
      hitl_ref            TEXT,        -- e.g. telegram message id, terminal session id
      -- Trigger source: where did this proposal originate from? Used by the
      -- mention-reply feature so we know whose post to reply to after accept.
      trigger_reason      TEXT,        -- 'mention' | 'mention-reply' | 'watchlist' | 'firehose' | 'report'
      trigger_source_uri  TEXT,        -- e.g. Alice's mention post URI
      trigger_source_cid  TEXT,
      trigger_root_uri    TEXT,        -- thread root for the reply target
      trigger_root_cid    TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_proposal_decision ON proposal(decision);

    -- Append-only log: which mention-source post URIs have we already
    -- replied to with an authenticated PDS write? proposal_id is nullable so
    -- diagnostic replies (no-claim / no-match) can be recorded too.
    CREATE TABLE IF NOT EXISTS mention_reply (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      proposal_id         INTEGER REFERENCES proposal(id),
      reply_kind          TEXT    NOT NULL DEFAULT 'verdict'
                                    CHECK (reply_kind IN ('verdict','no-claim','no-match')),
      reply_uri           TEXT    NOT NULL,
      reply_cid           TEXT    NOT NULL,
      replied_to_uri      TEXT    NOT NULL,
      replied_at          TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    -- One reply per mention-source URI, regardless of kind.
    CREATE UNIQUE INDEX IF NOT EXISTS ux_mention_reply_to_uri
      ON mention_reply(replied_to_uri);

    CREATE TABLE IF NOT EXISTS label_emit (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      post_uri    TEXT    NOT NULL,
      post_cid    TEXT    NOT NULL,
      val         TEXT    NOT NULL,
      neg         INTEGER NOT NULL DEFAULT 0,
      cts         TEXT    NOT NULL,
      exp         TEXT,
      verdict_id  INTEGER REFERENCES verdict(id),
      emitted_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_label_emit_post_uri ON label_emit(post_uri);

    CREATE TABLE IF NOT EXISTS kv_state (
      k TEXT PRIMARY KEY,
      v TEXT NOT NULL
    );
  `);

  // Idempotent post-create migrations for databases created by earlier
  // versions of this schema. Each ALTER fails silently if the column
  // already exists.
  addColumnIfMissing(db, 'proposal', 'trigger_reason', 'TEXT');
  addColumnIfMissing(db, 'proposal', 'trigger_source_uri', 'TEXT');
  addColumnIfMissing(db, 'proposal', 'trigger_source_cid', 'TEXT');
  addColumnIfMissing(db, 'proposal', 'trigger_root_uri', 'TEXT');
  addColumnIfMissing(db, 'proposal', 'trigger_root_cid', 'TEXT');
  addColumnIfMissing(db, 'proposal', 'trigger_source_lang', 'TEXT');
  addColumnIfMissing(db, 'mention_reply', 'reply_kind', "TEXT NOT NULL DEFAULT 'verdict'");
}

function addColumnIfMissing(db: DbLike, table: string, col: string, type: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (cols.some((c) => c.name === col)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
}
