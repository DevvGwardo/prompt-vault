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

// Hot-path indexes
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_prompts_created_at ON prompts(created_at DESC)`); } catch (e) {}
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_prompts_pinned_created ON prompts(pinned DESC, created_at DESC)`); } catch (e) {}
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_prompts_source ON prompts(source)`); } catch (e) {}
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_recent_created_at ON recent_captures(created_at DESC)`); } catch (e) {}
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_training_created_at ON training_labels(created_at DESC)`); } catch (e) {}

// ---- Prepared statements ----
const LIST_SUMMARY_COLS = `
  id, title, substr(text, 1, 220) AS text, tags, source, cwd,
  score, verdict, reasons, dimensions, pinned, created_at
`;

const stmts = {
  insertPrompt: db.prepare(`
    INSERT INTO prompts (text, title, tags, source, cwd, score, verdict, reasons, dimensions, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  getById: db.prepare(`SELECT * FROM prompts WHERE id = ?`),
  allPrompts: db.prepare(`SELECT * FROM prompts ORDER BY created_at DESC`),
  allTexts: db.prepare(`SELECT text FROM prompts`),
  listBrowse: db.prepare(`
    SELECT ${LIST_SUMMARY_COLS} FROM prompts
    ORDER BY pinned DESC, created_at DESC
    LIMIT ? OFFSET ?
  `),
  listBrowseTotal: db.prepare(`SELECT COUNT(*) AS total FROM prompts`),
  ftsSearch: db.prepare(`
    SELECT p.id, p.title, substr(p.text, 1, 220) AS text, p.tags, p.source, p.cwd,
           p.score, p.verdict, p.reasons, p.dimensions, p.pinned, p.created_at
    FROM prompts_fts f
    JOIN prompts p ON p.id = f.rowid
    WHERE prompts_fts MATCH ?
    ORDER BY p.pinned DESC, rank
    LIMIT ?
  `),
  ftsSearchFull: db.prepare(`
    SELECT p.* FROM prompts_fts f JOIN prompts p ON p.id = f.rowid
    WHERE prompts_fts MATCH ? ORDER BY p.pinned DESC, rank LIMIT ?
  `),
  deletePrompt: db.prepare(`DELETE FROM prompts WHERE id = ?`),
  togglePinRead: db.prepare(`SELECT pinned FROM prompts WHERE id = ?`),
  togglePinWrite: db.prepare(`UPDATE prompts SET pinned = ? WHERE id = ?`),
  count: db.prepare(`SELECT COUNT(*) as c FROM prompts`),
  countPinned: db.prepare(`SELECT COUNT(*) as c FROM prompts WHERE pinned = 1`),
  maxCreated: db.prepare(`SELECT COALESCE(MAX(created_at), 0) as m FROM prompts`),
  insertVersion: db.prepare(`INSERT INTO prompt_versions (prompt_id, text, created_at) VALUES (?, ?, ?)`),
  countVersions: db.prepare(`SELECT COUNT(*) as c FROM prompt_versions WHERE prompt_id = ?`),
  trimVersions: db.prepare(`
    DELETE FROM prompt_versions WHERE id IN (
      SELECT id FROM prompt_versions WHERE prompt_id = ? ORDER BY created_at ASC LIMIT ?
    )
  `),
  getVersions: db.prepare(`SELECT * FROM prompt_versions WHERE prompt_id = ? ORDER BY created_at DESC LIMIT 20`),
  getVersion: db.prepare(`SELECT * FROM prompt_versions WHERE id = ?`),
  deleteVersion: db.prepare(`DELETE FROM prompt_versions WHERE id = ?`),
  insertRecent: db.prepare(`
    INSERT INTO recent_captures (text, title, source, cwd, score, verdict, reasons, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `),
  getRecent: db.prepare(`SELECT * FROM recent_captures ORDER BY created_at DESC LIMIT ?`),
  getRecentById: db.prepare(`SELECT * FROM recent_captures WHERE id = ?`),
  deleteRecent: db.prepare(`DELETE FROM recent_captures WHERE id = ?`),
  countRecent: db.prepare(`SELECT COUNT(*) as c FROM recent_captures`),
  maxRecentCreated: db.prepare(`SELECT COALESCE(MAX(created_at), 0) as m FROM recent_captures`),
  upsertLabel: db.prepare(`
    INSERT INTO training_labels (prompt_id, label, created_at)
    VALUES (?, ?, ?)
    ON CONFLICT(prompt_id) DO UPDATE SET label = excluded.label, created_at = excluded.created_at
  `),
  labelMap: db.prepare(`SELECT prompt_id, label FROM training_labels`),
  labelsFull: db.prepare(`
    SELECT t.prompt_id, t.label, t.created_at AS trained_at, p.text, p.score, p.verdict
    FROM training_labels t
    JOIN prompts p ON p.id = t.prompt_id
    ORDER BY t.created_at DESC
  `),
  deleteLabel: db.prepare(`DELETE FROM training_labels WHERE prompt_id = ?`),
  countLabels: db.prepare(`SELECT COUNT(*) as c FROM training_labels`),
  kvSet: db.prepare(`INSERT OR REPLACE INTO kv_store (key, value) VALUES (?, ?)`),
  kvGet: db.prepare(`SELECT value FROM kv_store WHERE key = ?`),
  kvDelete: db.prepare(`DELETE FROM kv_store WHERE key = ?`),
  topForTemplate: db.prepare(`
    SELECT id, text, score, verdict FROM prompts
    WHERE score >= ? ORDER BY score DESC, created_at DESC LIMIT ?
  `),
  byVerdict: db.prepare(`SELECT verdict, COUNT(*) as c FROM prompts GROUP BY verdict`),
  bySource: db.prepare(`SELECT source, COUNT(*) as c FROM prompts GROUP BY source`),
  weekCount: db.prepare(`SELECT COUNT(*) as c FROM prompts WHERE created_at >= ?`),
  scoreStats: db.prepare(`
    SELECT
      COUNT(*) as total,
      COALESCE(AVG(score), 0) as avg_score,
      COALESCE(MIN(score), 0) as min_score,
      COALESCE(MAX(score), 0) as max_score
    FROM prompts
  `),
  histogram: db.prepare(`
    SELECT CAST(score / 10 AS INTEGER) as bucket, COUNT(*) as c
    FROM prompts GROUP BY bucket ORDER BY bucket
  `),
  allTags: db.prepare(`SELECT tags FROM prompts WHERE tags IS NOT NULL AND tags != ''`),
  allCreated: db.prepare(`SELECT created_at FROM prompts ORDER BY created_at DESC`),
  updateScore: db.prepare(`UPDATE prompts SET score = ?, verdict = ?, reasons = ?, dimensions = ? WHERE id = ?`),
  selectIdsTexts: db.prepare(`SELECT id, text FROM prompts`)
};

const updateStmtCache = new Map();

function serializeReasons(reasons) {
  return Array.isArray(reasons) ? reasons.join(', ') : (reasons || '');
}
function serializeDimensions(dimensions) {
  return (dimensions && typeof dimensions === 'object') ? JSON.stringify(dimensions) : (dimensions || '');
}

function createPrompt({ text, title, tags, source, cwd, score, verdict, reasons, dimensions }) {
  const now = Date.now();
  const info = stmts.insertPrompt.run(
    text, title || '', tags || '', source || '', cwd || '',
    score || 0, verdict || '', serializeReasons(reasons), serializeDimensions(dimensions), now
  );
  return stmts.getById.get(info.lastInsertRowid);
}

function allTexts() {
  return stmts.allTexts.all().map(r => r.text);
}

function reanalyzeAll(analyzeFn) {
  const rows = stmts.selectIdsTexts.all();
  const tx = db.transaction(() => {
    for (const r of rows) {
      const a = analyzeFn(r.text);
      stmts.updateScore.run(
        a.score || 0, a.verdict || '', serializeReasons(a.reasons),
        serializeDimensions(a.dimensions), r.id
      );
    }
  });
  tx();
  return { changed: rows.length };
}

function getById(id) {
  return stmts.getById.get(id);
}

function allPrompts() {
  return stmts.allPrompts.all();
}

function buildFtsQuery(q) {
  const tokens = q.match(/[\p{L}\p{N}_]+/gu) || [];
  if (!tokens.length) return null;
  return tokens.map(t => `"${t}"*`).join(' ');
}

/**
 * Lightweight paginated list for UI / HTTP / picker.
 * Returns summary rows (text truncated to 220 chars) unless fullText is true.
 */
function listPrompts({ q = '', limit = 100, offset = 0, fullText = false } = {}) {
  const lim = Math.max(1, Math.min(Number(limit) || 100, 500));
  const off = Math.max(0, Number(offset) || 0);
  const query = (q || '').trim();

  if (!query) {
    const rows = fullText
      ? db.prepare(`SELECT * FROM prompts ORDER BY pinned DESC, created_at DESC LIMIT ? OFFSET ?`).all(lim, off)
      : stmts.listBrowse.all(lim, off);
    const { total } = stmts.listBrowseTotal.get();
    return { rows, total, limit: lim, offset: off };
  }

  const match = buildFtsQuery(query);
  if (!match) {
    return listPrompts({ q: '', limit: lim, offset: off, fullText });
  }
  try {
    const rows = fullText
      ? stmts.ftsSearchFull.all(match, lim)
      : stmts.ftsSearch.all(match, lim);
    return { rows, total: rows.length, limit: lim, offset: 0 };
  } catch (e) {
    return { rows: [], total: 0, limit: lim, offset: 0 };
  }
}

/** Backward-compatible search used by older callers. Caps empty browse at 500. */
function search(q, limit) {
  const lim = limit != null ? Number(limit) : ((q && q.trim()) ? 200 : 500);
  const { rows } = listPrompts({ q, limit: lim, fullText: true });
  return rows;
}

function updatePrompt(id, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return getById(id);
  // Whitelist columns to prevent SQL injection via key names
  const allowed = new Set(['text', 'title', 'tags', 'source', 'cwd', 'score', 'verdict', 'reasons', 'dimensions', 'pinned']);
  const safeKeys = keys.filter(k => allowed.has(k));
  if (!safeKeys.length) return getById(id);

  if ('text' in fields) {
    const tx = db.transaction(() => {
      const current = db.prepare(`SELECT text FROM prompts WHERE id = ?`).get(id);
      if (current && current.text !== fields.text) {
        stmts.insertVersion.run(id, current.text, Date.now());
        const count = stmts.countVersions.get(id).c;
        if (count > 20) stmts.trimVersions.run(id, count - 20);
      }
      const cacheKey = safeKeys.join(',');
      let upd = updateStmtCache.get(cacheKey);
      if (!upd) {
        const set = safeKeys.map(k => `${k} = ?`).join(', ');
        upd = db.prepare(`UPDATE prompts SET ${set} WHERE id = ?`);
        updateStmtCache.set(cacheKey, upd);
      }
      upd.run(...safeKeys.map(k => fields[k]), id);
    });
    tx();
  } else {
    const cacheKey = safeKeys.join(',');
    let upd = updateStmtCache.get(cacheKey);
    if (!upd) {
      const set = safeKeys.map(k => `${k} = ?`).join(', ');
      upd = db.prepare(`UPDATE prompts SET ${set} WHERE id = ?`);
      updateStmtCache.set(cacheKey, upd);
    }
    upd.run(...safeKeys.map(k => fields[k]), id);
  }
  return getById(id);
}

function deletePrompt(id) { return stmts.deletePrompt.run(id); }

function togglePin(id) {
  const row = stmts.togglePinRead.get(id);
  if (!row) return null;
  stmts.togglePinWrite.run(row.pinned ? 0 : 1, id);
  return getById(id);
}

function count() { return stmts.count.get().c; }

function getVersions(promptId) {
  return stmts.getVersions.all(promptId);
}

function restoreVersion(versionId) {
  const version = stmts.getVersion.get(versionId);
  if (!version) return null;
  return updatePrompt(version.prompt_id, { text: version.text });
}

function deleteVersion(versionId) {
  return stmts.deleteVersion.run(versionId);
}

// ---- Recent captures ----
function saveRecentCapture({ text, title, source, cwd, score, verdict, reasons }) {
  const info = stmts.insertRecent.run(
    text, title || '', source || '', cwd || '',
    score || 0, verdict || '', serializeReasons(reasons), Date.now()
  );
  return stmts.getRecentById.get(info.lastInsertRowid);
}

function getRecentCaptures(limit = 50) {
  return stmts.getRecent.all(limit);
}

function getRecentCaptureById(id) {
  return stmts.getRecentById.get(id);
}

function deleteRecentCapture(id) {
  return stmts.deleteRecent.run(id);
}

// ---- Training labels ----
function saveTrainingLabel(promptId, label) {
  stmts.upsertLabel.run(promptId, label, Date.now());
}

function getTrainingLabels() {
  return stmts.labelsFull.all();
}

function getTrainingLabelMap() {
  const map = {};
  for (const row of stmts.labelMap.all()) map[row.prompt_id] = row.label;
  return map;
}

function deleteTrainingLabel(promptId) {
  stmts.deleteLabel.run(promptId);
}

// ---- Vault aggregates for dashboard (no full-text rows) ----
function getVaultStats() {
  const score = stmts.scoreStats.get();
  const byVerdict = {};
  for (const r of stmts.byVerdict.all()) byVerdict[r.verdict || 'maybe'] = r.c;
  const bySource = {};
  for (const r of stmts.bySource.all()) bySource[r.source || 'unknown'] = r.c;

  const weekAgo = Date.now() - 7 * 86400000;
  const week = stmts.weekCount.get(weekAgo).c;

  const hist = new Array(11).fill(0); // 0-10..90-100, plus 100
  for (const r of stmts.histogram.all()) {
    const b = Math.max(0, Math.min(10, r.bucket | 0));
    hist[b] = r.c;
  }

  const tagFreq = {};
  for (const r of stmts.allTags.all()) {
    for (const t of String(r.tags).split(/[,;]/).map(s => s.trim()).filter(Boolean)) {
      tagFreq[t] = (tagFreq[t] || 0) + 1;
    }
  }

  // Activity streak: consecutive days with ≥1 prompt ending today or yesterday
  const created = stmts.allCreated.all().map(r => r.created_at);
  const daySet = new Set(created.map(ts => {
    const d = new Date(ts);
    return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  }));
  let streak = 0;
  const cursor = new Date();
  // Allow streak to start from yesterday if nothing today yet
  const todayKey = `${cursor.getFullYear()}-${cursor.getMonth()}-${cursor.getDate()}`;
  if (!daySet.has(todayKey)) cursor.setDate(cursor.getDate() - 1);
  for (;;) {
    const key = `${cursor.getFullYear()}-${cursor.getMonth()}-${cursor.getDate()}`;
    if (!daySet.has(key)) break;
    streak++;
    cursor.setDate(cursor.getDate() - 1);
  }

  const revision = `${stmts.count.get().c}:${stmts.maxCreated.get().m}:${stmts.countRecent.get().c}:${stmts.maxRecentCreated.get().m}:${stmts.countLabels.get().c}`;

  return {
    total: score.total,
    pinned: stmts.countPinned.get().c,
    avgScore: Math.round(score.avg_score * 10) / 10,
    minScore: score.min_score,
    maxScore: score.max_score,
    week,
    byVerdict,
    bySource,
    histogram: hist,
    tags: tagFreq,
    streak,
    recentCount: stmts.countRecent.get().c,
    revision
  };
}

function getTopPromptsForTemplate({ minScore = 65, limit = 15 } = {}) {
  return stmts.topForTemplate.all(minScore, limit);
}

/** Cheap change-detection probe for renderer polling fallback. */
function getRevision() {
  return `${stmts.count.get().c}:${stmts.maxCreated.get().m}:${stmts.countRecent.get().c}:${stmts.maxRecentCreated.get().m}:${stmts.countLabels.get().c}`;
}

// ---- KV store ----
function kvSet(key, value) {
  stmts.kvSet.run(key, value);
}
function kvGet(key) {
  const r = stmts.kvGet.get(key);
  return r ? r.value : null;
}
function kvDelete(key) {
  stmts.kvDelete.run(key);
}

function saveTrainModel(model) {
  kvSet('train_model', JSON.stringify(model));
}
function getTrainModel() {
  const v = kvGet('train_model');
  if (!v) return null;
  try { return JSON.parse(v); } catch (e) { return null; }
}

let lastAnalysis = null;
function setLastAnalysis(data) { lastAnalysis = data; }
function getLastAnalysis() { return lastAnalysis; }

function ensureSchema() {
  const row = db.prepare(`SELECT COUNT(*) as c FROM pragma_table_info('prompts') WHERE name='pinned'`).get();
  if (row.c === 0) {
    try { db.exec(`ALTER TABLE prompts ADD COLUMN pinned INTEGER DEFAULT 0`); } catch (e) {}
  }
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_prompts_created_at ON prompts(created_at DESC)`); } catch (e) {}
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_prompts_pinned_created ON prompts(pinned DESC, created_at DESC)`); } catch (e) {}
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_prompts_source ON prompts(source)`); } catch (e) {}
}

module.exports = {
  DB_PATH,
  createPrompt, getById, allPrompts, allTexts, search, listPrompts, reanalyzeAll,
  updatePrompt, deletePrompt, togglePin, count,
  getVersions, restoreVersion, deleteVersion,
  saveRecentCapture, getRecentCaptures, getRecentCaptureById, deleteRecentCapture,
  saveTrainingLabel, getTrainingLabels, getTrainingLabelMap, deleteTrainingLabel,
  getVaultStats, getTopPromptsForTemplate, getRevision,
  kvSet, kvGet, kvDelete,
  saveTrainModel, getTrainModel,
  setLastAnalysis, getLastAnalysis, ensureSchema
};
