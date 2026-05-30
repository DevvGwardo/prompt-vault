const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_DIR = process.env.PROMPT_VAULT_DIR || path.join(require('os').homedir(), '.prompt-vault');
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

const DB_PATH = path.join(DB_DIR, 'vault.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ---- Prompts table ----
db.exec(`
  CREATE TABLE IF NOT EXISTS prompts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    text TEXT NOT NULL,
    title TEXT DEFAULT '',
    tags TEXT DEFAULT '',
    source TEXT DEFAULT '',
    cwd TEXT DEFAULT '',
    score REAL DEFAULT 0,
    verdict TEXT DEFAULT '',
    reasons TEXT DEFAULT '',
    dimensions TEXT DEFAULT '',
    pinned INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL
  );
`);

// Migration: add columns added after initial schema
try { db.exec(`ALTER TABLE prompts ADD COLUMN pinned INTEGER DEFAULT 0`); } catch (e) {}
try { db.exec(`ALTER TABLE prompts ADD COLUMN dimensions TEXT DEFAULT ''`); } catch (e) {}
try { db.exec(`ALTER TABLE prompts ADD COLUMN cwd TEXT DEFAULT ''`); } catch (e) {}

// ---- Recent captures table ----
db.exec(`
  CREATE TABLE IF NOT EXISTS recent_captures (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    text TEXT NOT NULL,
    title TEXT DEFAULT '',
    source TEXT DEFAULT '',
    cwd TEXT DEFAULT '',
    score REAL DEFAULT 0,
    verdict TEXT DEFAULT '',
    reasons TEXT DEFAULT '',
    created_at INTEGER NOT NULL
  );
`);

// ---- Training labels table ----
db.exec(`
  CREATE TABLE IF NOT EXISTS training_labels (
    prompt_id INTEGER PRIMARY KEY,
    label TEXT NOT NULL CHECK(label IN ('good','bad','implicit_good','implicit_bad')),
    created_at INTEGER NOT NULL
  );
`);

// ---- KV store ----
db.exec(`
  CREATE TABLE IF NOT EXISTS kv_store (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

// ---- FTS5 full-text search ----
try {
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS prompts_fts USING fts5(id UNINDEXED, text, title, tags, content='prompts', content_rowid='id')`);
  // FTS triggers for keeping fts in sync
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS prompts_ai AFTER INSERT ON prompts BEGIN
      INSERT INTO prompts_fts(rowid, text, title, tags) VALUES (new.id, new.text, new.title, new.tags);
    END;
    CREATE TRIGGER IF NOT EXISTS prompts_ad AFTER DELETE ON prompts BEGIN
      INSERT INTO prompts_fts(prompts_fts, rowid, text, title, tags) VALUES ('delete', old.id, old.text, old.title, old.tags);
    END;
    CREATE TRIGGER IF NOT EXISTS prompts_au AFTER UPDATE ON prompts BEGIN
      INSERT INTO prompts_fts(prompts_fts, rowid, text, title, tags) VALUES ('delete', old.id, old.text, old.title, old.tags);
      INSERT INTO prompts_fts(rowid, text, title, tags) VALUES (new.id, new.text, new.title, new.tags);
    END;
  `);
} catch (e) {}

// ---- Prompt versions table ----
db.exec(`
  CREATE TABLE IF NOT EXISTS prompt_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    prompt_id INTEGER NOT NULL,
    text TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY(prompt_id) REFERENCES prompts(id) ON DELETE CASCADE
  );
`);
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_pv_prompt ON prompt_versions(prompt_id, created_at DESC)`); } catch (e) {}

// ---- Functions ----

// Analyzer returns reasons as an array and dimensions as an object; the table
// stores them as a ", "-joined string and JSON respectively.
function serializeReasons(reasons) {
  return Array.isArray(reasons) ? reasons.join(', ') : (reasons || '');
}
function serializeDimensions(dimensions) {
  return (dimensions && typeof dimensions === 'object') ? JSON.stringify(dimensions) : (dimensions || '');
}

function createPrompt({ text, title, tags, source, cwd, score, verdict, reasons, dimensions }) {
  const now = Date.now();
  const stmt = db.prepare(`
    INSERT INTO prompts (text, title, tags, source, cwd, score, verdict, reasons, dimensions, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(text, title || '', tags || '', source || '', cwd || '', score || 0, verdict || '', serializeReasons(reasons), serializeDimensions(dimensions), now);
  return db.prepare(`SELECT * FROM prompts ORDER BY id DESC LIMIT 1`).get();
}

function allTexts() {
  return db.prepare(`SELECT text FROM prompts`).all().map(r => r.text);
}

function reanalyzeAll(analyzeFn) {
  const rows = db.prepare(`SELECT id, text FROM prompts`).all();
  const upd = db.prepare(`UPDATE prompts SET score = ?, verdict = ?, reasons = ?, dimensions = ? WHERE id = ?`);
  const tx = db.transaction(() => {
    for (const r of rows) {
      const a = analyzeFn(r.text);
      upd.run(a.score || 0, a.verdict || '', serializeReasons(a.reasons), serializeDimensions(a.dimensions), r.id);
    }
  });
  tx();
  return rows.length;
}

function getById(id) {
  return db.prepare(`SELECT * FROM prompts WHERE id = ?`).get(id);
}

function allPrompts() {
  return db.prepare(`SELECT * FROM prompts ORDER BY created_at DESC`).all();
}

function search(q) {
  if (!q || !q.trim()) return allPrompts();
  try {
    return db.prepare(`
      SELECT p.* FROM prompts_fts f JOIN prompts p ON p.id = f.rowid
      WHERE prompts_fts MATCH ? ORDER BY rank LIMIT 200
    `).all(q.trim());
  } catch (e) {
    return allPrompts();
  }
}

function updatePrompt(id, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return getById(id);
  if ('text' in fields) {
    const tx = db.transaction(() => {
      const current = db.prepare(`SELECT text FROM prompts WHERE id = ?`).get(id);
      if (current && current.text !== fields.text) {
        db.prepare(`INSERT INTO prompt_versions (prompt_id, text, created_at) VALUES (?, ?, ?)`).run(id, current.text, Date.now());
        // Cap retained versions per prompt at 20
        const count = db.prepare(`SELECT COUNT(*) as c FROM prompt_versions WHERE prompt_id = ?`).get(id).c;
        if (count > 20) {
          db.prepare(`DELETE FROM prompt_versions WHERE id IN (SELECT id FROM prompt_versions WHERE prompt_id = ? ORDER BY created_at ASC LIMIT ?)`).run(id, count - 20);
        }
      }
      const set = keys.map(k => `${k} = ?`).join(', ');
      db.prepare(`UPDATE prompts SET ${set} WHERE id = ?`).run(...keys.map(k => fields[k]), id);
    });
    tx();
  } else {
    // Single-statement UPDATE is implicitly atomic — no explicit transaction needed
    const set = keys.map(k => `${k} = ?`).join(', ');
    db.prepare(`UPDATE prompts SET ${set} WHERE id = ?`).run(...keys.map(k => fields[k]), id);
  }
  return getById(id);
}

function deletePrompt(id) { return db.prepare(`DELETE FROM prompts WHERE id = ?`).run(id); }

function togglePin(id) {
  const row = getById(id);
  if (!row) return null;
  db.prepare(`UPDATE prompts SET pinned = ? WHERE id = ?`).run(row.pinned ? 0 : 1, id);
  return getById(id);
}

function count() { return db.prepare(`SELECT COUNT(*) as c FROM prompts`).get().c; }

// Single-statement UPDATE is implicitly atomic — transaction needed only when
// version snapshotting and UPDATE must commit together (the 'text' branch above)
function getVersions(promptId) {
  return db.prepare(`SELECT * FROM prompt_versions WHERE prompt_id = ? ORDER BY created_at DESC LIMIT 20`).all(promptId);
}

function restoreVersion(versionId) {
  const version = db.prepare(`SELECT * FROM prompt_versions WHERE id = ?`).get(versionId);
  if (!version) return null;
  // updatePrompt handles snapshoting the current text before overwriting
  return updatePrompt(version.prompt_id, { text: version.text });
}

function deleteVersion(versionId) {
  return db.prepare(`DELETE FROM prompt_versions WHERE id = ?`).run(versionId);
}

// ---- Recent captures ----
function saveRecentCapture({ text, title, source, cwd, score, verdict, reasons }) {
  const stmt = db.prepare(`INSERT INTO recent_captures (text, title, source, cwd, score, verdict, reasons, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  stmt.run(text, title || '', source || '', cwd || '', score || 0, verdict || '', serializeReasons(reasons), Date.now());
}

function getRecentCaptures() {
  return db.prepare(`SELECT * FROM recent_captures ORDER BY created_at DESC LIMIT 50`).all();
}

function deleteRecentCapture(id) {
  return db.prepare(`DELETE FROM recent_captures WHERE id = ?`).run(id);
}

// ---- Training labels ----
function saveTrainingLabel(promptId, label) {
  db.prepare(`
    INSERT INTO training_labels (prompt_id, label, created_at)
    VALUES (?, ?, ?)
    ON CONFLICT(prompt_id) DO UPDATE SET label = excluded.label, created_at = excluded.created_at
  `).run(promptId, label, Date.now());
}

function getTrainingLabels() {
  return db.prepare(`
    SELECT t.prompt_id, t.label, t.created_at AS trained_at, p.text, p.score, p.verdict
    FROM training_labels t
    JOIN prompts p ON p.id = t.prompt_id
    ORDER BY t.created_at DESC
  `).all();
}

function deleteTrainingLabel(promptId) {
  db.prepare(`DELETE FROM training_labels WHERE prompt_id = ?`).run(promptId);
}

// ---- KV store ----
function kvSet(key, value) {
  db.prepare(`INSERT OR REPLACE INTO kv_store (key, value) VALUES (?, ?)`).run(key, value);
}

function kvGet(key) {
  const r = db.prepare(`SELECT value FROM kv_store WHERE key = ?`).get(key);
  return r ? r.value : null;
}

function kvDelete(key) {
  db.prepare(`DELETE FROM kv_store WHERE key = ?`).run(key);
}

// ---- Persisted training model (stored in kv_store) ----
function saveTrainModel(model) {
  kvSet('train_model', JSON.stringify(model));
}
function getTrainModel() {
  const v = kvGet('train_model');
  if (!v) return null;
  try { return JSON.parse(v); } catch (e) { return null; }
}

// ---- Static HTTP handler for popup's save-as-new ----
// small helper: returns the last analysed data so the popup window can save it
let lastAnalysis = null;
function setLastAnalysis(data) { lastAnalysis = data; }
function getLastAnalysis() { return lastAnalysis; }

// ---- Schema check helper (used at startup) ----
function ensureSchema() {
  // existing columns are handled by CREATE TABLE IF NOT EXISTS at the top
  const row = db.prepare(`SELECT COUNT(*) as c FROM pragma_table_info('prompts') WHERE name='pinned'`).get();
  if (row.c === 0) {
    try { db.exec(`ALTER TABLE prompts ADD COLUMN pinned INTEGER DEFAULT 0`); } catch (e) {}
  }
}

module.exports = {
  DB_PATH,
  createPrompt, getById, allPrompts, allTexts, search, reanalyzeAll,
  updatePrompt, deletePrompt, togglePin, count,
  getVersions, restoreVersion, deleteVersion,
  saveRecentCapture, getRecentCaptures, deleteRecentCapture,
  saveTrainingLabel, getTrainingLabels, deleteTrainingLabel,
  kvSet, kvGet, kvDelete,
  saveTrainModel, getTrainModel,
  setLastAnalysis, getLastAnalysis, ensureSchema
};
