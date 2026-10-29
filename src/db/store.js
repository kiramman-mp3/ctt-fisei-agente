import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { classifyTopic } from './topics.js';

// Cada usuario de un canal tiene una única conversación (tabla `users`) con su
// estado de atención: modo IA/humano, termómetro del prospecto, perfil y resumen.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL,
  external_id TEXT NOT NULL,
  name TEXT,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  session_started_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id),
  channel TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  topic TEXT,
  courses TEXT NOT NULL DEFAULT '[]',
  latency_ms INTEGER,
  tokens_in INTEGER,
  tokens_out INTEGER,
  error TEXT,
  flags TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id),
  type TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_user ON messages(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);
CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at);
`;

// Columnas agregadas después de la primera versión; se aplican sobre bases existentes.
const MIGRATIONS = [
  ['users', 'mode', "TEXT NOT NULL DEFAULT 'ai'"],
  ['users', 'state', "TEXT NOT NULL DEFAULT 'nuevo'"],
  ['users', 'profile', "TEXT NOT NULL DEFAULT '{}'"],
  ['users', 'summary', 'TEXT'],
  ['users', 'handover_reason', 'TEXT'],
  ['users', 'unread', 'INTEGER NOT NULL DEFAULT 0'],
  ['messages', 'flags', "TEXT NOT NULL DEFAULT '[]'"],
];

export const STATES = ['nuevo', 'interesado', 'dudoso', 'frustrado', 'lead_caliente'];

/** Tope duro de caracteres del historial enviado al LLM (alineado con el agente). */
export const CONTEXT_MAX_CHARS = 6000;

const parseConversation = (row) =>
  row && { ...row, profile: JSON.parse(row.profile || '{}') };

export class Store {
  constructor(path) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    // WAL no funciona sobre discos de red (Azure Files /home): ahí se usa SQLITE_JOURNAL=DELETE.
    const journal = ['WAL', 'DELETE', 'TRUNCATE'].includes(process.env.SQLITE_JOURNAL) ? process.env.SQLITE_JOURNAL : 'WAL';
    this.db.exec(`PRAGMA journal_mode = ${journal}; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;`);
    this.db.exec(SCHEMA);
    this.migrate();
  }

  migrate() {
    for (const [table, column, definition] of MIGRATIONS) {
      const columns = this.db.prepare(`PRAGMA table_info(${table})`).all();
      if (!columns.some((c) => c.name === column)) {
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
      }
    }
  }

  upsertUser({ channel, externalId, name }, now = new Date().toISOString()) {
    const id = `${channel}:${externalId}`;
    this.db
      .prepare(
        `INSERT INTO users (id, channel, external_id, name, first_seen, last_seen, session_started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET last_seen = excluded.last_seen,
           name = COALESCE(excluded.name, users.name)`,
      )
      .run(id, channel, String(externalId), name ?? null, now, now, now);
    return id;
  }

  getConversation(userId) {
    return parseConversation(this.db.prepare('SELECT * FROM users WHERE id = ?').get(userId));
  }

  /** Actualiza campos del estado de atención (mode, state, profile, summary, handover_reason, unread). */
  updateConversation(userId, patch) {
    const allowed = ['mode', 'state', 'profile', 'summary', 'handover_reason', 'unread'];
    const entries = Object.entries(patch).filter(([k, v]) => allowed.includes(k) && v !== undefined);
    if (!entries.length) return this.getConversation(userId);
    const sets = entries.map(([k]) => `${k} = ?`).join(', ');
    const values = entries.map(([k, v]) => (k === 'profile' ? JSON.stringify(v) : v));
    this.db.prepare(`UPDATE users SET ${sets} WHERE id = ?`).run(...values, userId);
    return this.getConversation(userId);
  }

  /** Inicia una conversación nueva: el historial previo deja de enviarse al LLM. */
  resetSession(userId, now = new Date().toISOString()) {
    this.db
      .prepare("UPDATE users SET session_started_at = ?, summary = NULL, mode = 'ai', handover_reason = NULL WHERE id = ?")
      .run(now, userId);
  }

  addMessage({ userId, channel, role, content, courses = [], latencyMs, tokensIn, tokensOut, error, flags = [], createdAt }) {
    const topic = role === 'user' ? classifyTopic(content) : null;
    const created = createdAt ?? new Date().toISOString();
    const result = this.db
      .prepare(
        `INSERT INTO messages (user_id, channel, role, content, topic, courses, latency_ms, tokens_in, tokens_out, error, flags, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        userId,
        channel,
        role,
        content,
        topic,
        JSON.stringify(courses),
        latencyMs ?? null,
        tokensIn ?? null,
        tokensOut ?? null,
        error ?? null,
        JSON.stringify(flags),
        created,
      );
    if (role === 'user') this.db.prepare('UPDATE users SET unread = unread + 1, last_seen = ? WHERE id = ?').run(created, userId);
    return this.getMessage(Number(result.lastInsertRowid));
  }

  getMessage(id) {
    const m = this.db
      .prepare('SELECT id, user_id, channel, role, content, topic, courses, latency_ms, error, flags, created_at FROM messages WHERE id = ?')
      .get(id);
    return m && { ...m, courses: JSON.parse(m.courses), flags: JSON.parse(m.flags) };
  }

  addEvent(userId, type, detail = null, createdAt = new Date().toISOString()) {
    this.db.prepare('INSERT INTO events (user_id, type, detail, created_at) VALUES (?, ?, ?, ?)').run(userId, type, detail, createdAt);
  }

  /**
   * Últimos mensajes de la sesión actual en orden cronológico, recortados a un
   * presupuesto duro de caracteres (~tokens estimados × 4) para la ventana de contexto.
   * El resumen y el perfil viven en `users` y el agente los inyecta aparte.
   */
  getHistory(userId, { limit = 10, maxChars = CONTEXT_MAX_CHARS } = {}) {
    const rows = this.db
      .prepare(
        `SELECT role, content FROM messages m JOIN users u ON u.id = m.user_id
         WHERE m.user_id = ? AND m.created_at >= u.session_started_at AND m.error IS NULL
         ORDER BY m.id DESC LIMIT ?`,
      )
      .all(userId, limit);
    const history = [];
    let used = 0;
    for (const row of rows) {
      const len = String(row.content ?? '').length;
      if (used + len > maxChars && history.length) break;
      used += len;
      history.unshift(row);
    }
    return history;
  }

  close() {
    this.db.close();
  }
}
