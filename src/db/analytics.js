// Consultas agregadas para el dashboard. `since` es una fecha ISO (o null para todo).

const where = (since, channel, alias = 'm') => {
  const clauses = [];
  const params = [];
  if (since) {
    clauses.push(`${alias}.created_at >= ?`);
    params.push(since);
  }
  if (channel) {
    clauses.push(`${alias}.channel = ?`);
    params.push(channel);
  }
  return { sql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
};

export function summary(db, { since, channel } = {}) {
  const w = where(since, channel);
  const row = db
    .prepare(
      `SELECT
         SUM(role = 'user') AS questions,
         SUM(role = 'assistant' AND error IS NULL) AS answers,
         SUM(error IS NOT NULL) AS errors,
         COUNT(DISTINCT user_id) AS users,
         ROUND(AVG(CASE WHEN role = 'assistant' AND error IS NULL THEN latency_ms END)) AS avg_latency_ms,
         SUM(COALESCE(tokens_in, 0) + COALESCE(tokens_out, 0)) AS tokens
       FROM messages m ${w.sql}`,
    )
    .get(...w.params);
  const conversations = conversationsCount(db, { since, channel });
  return {
    questions: row.questions ?? 0,
    answers: row.answers ?? 0,
    errors: row.errors ?? 0,
    users: row.users ?? 0,
    conversations,
    avgLatencyMs: row.avg_latency_ms ?? null,
    tokens: row.tokens ?? 0,
  };
}

// Una conversación = mensajes de un usuario separados por menos de 30 minutos.
function conversationsCount(db, { since, channel }) {
  const w = where(since, channel);
  const rows = db
    .prepare(`SELECT user_id, created_at FROM messages m ${w.sql} ORDER BY user_id, created_at`)
    .all(...w.params);
  let count = 0;
  let lastUser = null;
  let lastTime = 0;
  for (const r of rows) {
    const t = Date.parse(r.created_at);
    if (r.user_id !== lastUser || t - lastTime > 30 * 60_000) count++;
    lastUser = r.user_id;
    lastTime = t;
  }
  return count;
}

export function byChannel(db, { since } = {}) {
  const w = where(since, null);
  return db
    .prepare(
      `SELECT channel, SUM(role = 'user') AS questions, COUNT(DISTINCT user_id) AS users
       FROM messages m ${w.sql} GROUP BY channel ORDER BY questions DESC`,
    )
    .all(...w.params);
}

export function byDay(db, { since, channel } = {}) {
  const w = where(since, channel);
  return db
    .prepare(
      `SELECT substr(created_at, 1, 10) AS day, channel, SUM(role = 'user') AS questions
       FROM messages m ${w.sql} GROUP BY day, channel ORDER BY day`,
    )
    .all(...w.params);
}

export function byHour(db, { since, channel } = {}) {
  const w = where(since, channel);
  const rows = db
    .prepare(
      `SELECT CAST(strftime('%H', created_at, 'localtime') AS INTEGER) AS hour, COUNT(*) AS questions
       FROM messages m ${w.sql ? `${w.sql} AND` : 'WHERE'} role = 'user' GROUP BY hour`,
    )
    .all(...w.params);
  const hours = Array.from({ length: 24 }, (_, hour) => ({ hour, questions: 0 }));
  for (const r of rows) hours[r.hour].questions = r.questions;
  return hours;
}

export function byTopic(db, { since, channel } = {}) {
  const w = where(since, channel);
  return db
    .prepare(
      `SELECT topic, COUNT(*) AS questions FROM messages m
       ${w.sql ? `${w.sql} AND` : 'WHERE'} role = 'user' GROUP BY topic ORDER BY questions DESC`,
    )
    .all(...w.params);
}

export function topCourses(db, { since, channel, limit = 10 } = {}) {
  const w = where(since, channel);
  return db
    .prepare(
      `SELECT CAST(j.value AS INTEGER) AS course_id, COUNT(*) AS mentions, COUNT(DISTINCT m.user_id) AS users
       FROM messages m, json_each(m.courses) j
       ${w.sql ? `${w.sql} AND` : 'WHERE'} m.role = 'assistant'
       GROUP BY course_id ORDER BY mentions DESC LIMIT ?`,
    )
    .all(...w.params, limit);
}

export function recentConversations(db, { since, channel, limit = 50 } = {}) {
  const w = where(since, channel);
  return db
    .prepare(
      `SELECT u.id AS user_id, u.channel, u.name, u.external_id,
              COUNT(*) AS messages, SUM(m.role = 'user') AS questions,
              MAX(m.created_at) AS last_at, MIN(m.created_at) AS first_at,
              (SELECT content FROM messages x WHERE x.user_id = u.id AND x.role = 'user'
                 ORDER BY x.id DESC LIMIT 1) AS last_question
       FROM messages m JOIN users u ON u.id = m.user_id ${w.sql}
       GROUP BY u.id ORDER BY last_at DESC LIMIT ?`,
    )
    .all(...w.params, limit);
}

const EVENT_TEXT = {
  handover: 'IA en pausa',
  ia_reanudada: 'IA reanudada',
  operador_toma: 'El operador tomó el control',
  intento_manipulacion: 'Intento de manipulación bloqueado',
  lead_caliente: 'Marcado como lead caliente',
  riesgo: '⚠ Posible riesgo para la persona',
};

/** Mensajes de una conversación intercalados con sus eventos (handover, reanudación, etc.). */
export function conversation(db, userId, limit = 200) {
  const messages = db
    .prepare(
      `SELECT id, user_id, role, content, topic, courses, latency_ms, error, flags, created_at
       FROM messages WHERE user_id = ? ORDER BY id DESC LIMIT ?`,
    )
    .all(userId, limit)
    .map((m) => ({ ...m, courses: JSON.parse(m.courses), flags: JSON.parse(m.flags) }));
  const since = messages.at(-1)?.created_at ?? '';
  const events = db
    .prepare("SELECT id, type, detail, created_at FROM events WHERE user_id = ? AND created_at >= ? AND type != 'operador_toma'")
    .all(userId, since)
    .map((e) => ({
      id: `evt-${e.id}`,
      user_id: userId,
      role: 'system',
      content: [EVENT_TEXT[e.type] ?? e.type, e.type === 'lead_caliente' ? null : e.detail].filter(Boolean).join(' · '),
      created_at: e.created_at,
    }));
  const order = (x) => (typeof x.id === 'number' ? x.id : Number.MAX_SAFE_INTEGER);
  return [...messages, ...events].sort((a, b) => a.created_at.localeCompare(b.created_at) || order(a) - order(b));
}

export function byState(db, { since, channel } = {}) {
  const clauses = [];
  const params = [];
  if (since) {
    clauses.push('last_seen >= ?');
    params.push(since);
  }
  if (channel) {
    clauses.push('channel = ?');
    params.push(channel);
  }
  return db
    .prepare(`SELECT state, COUNT(*) AS users FROM users ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''} GROUP BY state ORDER BY users DESC`)
    .all(...params);
}

export function eventCounts(db, { since, channel } = {}) {
  const w = where(since, channel, 'u');
  const sql = w.sql.replace('u.created_at', 'e.created_at');
  const rows = db
    .prepare(`SELECT e.type, COUNT(*) AS total FROM events e JOIN users u ON u.id = e.user_id ${sql} GROUP BY e.type`)
    .all(...w.params);
  return Object.fromEntries(rows.map((r) => [r.type, r.total]));
}

/** Series para las gráficas SVG: últimos 14 días, embudo y distribución actual. */
export function timeseries(db, { since, channel } = {}) {
  const fourteenAgo = new Date(Date.now() - 14 * 86400_000).toISOString();
  const daySince = since && since > fourteenAgo ? since : fourteenAgo;
  const dayKeys = [];
  for (let i = 13; i >= 0; i--) {
    dayKeys.push(new Date(Date.now() - i * 86400_000).toISOString().slice(0, 10));
  }

  const userClauses = ['first_seen >= ?'];
  const userParams = [daySince];
  if (channel) {
    userClauses.push('channel = ?');
    userParams.push(channel);
  }
  const nuevas = db
    .prepare(
      `SELECT substr(first_seen, 1, 10) AS day, COUNT(*) AS total
       FROM users WHERE ${userClauses.join(' AND ')} GROUP BY day`,
    )
    .all(...userParams);

  const leadClauses = ["e.type = 'lead_caliente'", 'e.created_at >= ?'];
  const leadParams = [daySince];
  let leadFrom = 'events e';
  if (channel) {
    leadFrom = 'events e JOIN users u ON u.id = e.user_id';
    leadClauses.push('u.channel = ?');
    leadParams.push(channel);
  }
  const leads = db
    .prepare(
      `SELECT substr(e.created_at, 1, 10) AS day, COUNT(*) AS total
       FROM ${leadFrom} WHERE ${leadClauses.join(' AND ')} GROUP BY day`,
    )
    .all(...leadParams);

  const msgW = where(daySince, channel);
  const perf = db
    .prepare(
      `SELECT substr(created_at, 1, 10) AS day,
              ROUND(AVG(CASE WHEN latency_ms IS NOT NULL THEN latency_ms END)) AS avg_latency_ms,
              SUM(COALESCE(tokens_in, 0) + COALESCE(tokens_out, 0)) AS tokens
       FROM messages m
       ${msgW.sql ? `${msgW.sql} AND` : 'WHERE'} role = 'assistant' AND error IS NULL
       GROUP BY day`,
    )
    .all(...msgW.params);

  const byDay = Object.fromEntries(
    dayKeys.map((day) => [day, { day, nuevas: 0, leads: 0, avgLatencyMs: null, tokens: 0 }]),
  );
  for (const r of nuevas) if (byDay[r.day]) byDay[r.day].nuevas = r.total;
  for (const r of leads) if (byDay[r.day]) byDay[r.day].leads = r.total;
  for (const r of perf) {
    if (!byDay[r.day]) continue;
    byDay[r.day].avgLatencyMs = r.avg_latency_ms;
    byDay[r.day].tokens = r.tokens ?? 0;
  }

  const stateRows = byState(db, { since, channel });
  const stateMap = Object.fromEntries(stateRows.map((r) => [r.state, r.users]));
  const events = eventCounts(db, { since, channel });

  return {
    days: dayKeys.map((d) => byDay[d]),
    funnel: {
      interesado: stateMap.interesado ?? 0,
      dudoso: stateMap.dudoso ?? 0,
      lead_caliente: stateMap.lead_caliente ?? 0,
      handover: events.handover ?? 0,
    },
    byState: stateRows,
    hasLatency: perf.some((r) => r.avg_latency_ms != null),
    hasTokens: perf.some((r) => (r.tokens ?? 0) > 0),
  };
}

/** Conversaciones para la bandeja del operador, con su último mensaje. */
export function inbox(db, { since, channel, limit = 100 } = {}) {
  const clauses = [];
  const params = [];
  if (since) {
    clauses.push('u.last_seen >= ?');
    params.push(since);
  }
  if (channel) {
    clauses.push('u.channel = ?');
    params.push(channel);
  }
  return db
    .prepare(
      `SELECT u.id AS user_id, u.channel, u.name, u.external_id, u.mode, u.state, u.profile, u.summary,
              u.handover_reason, u.unread, u.last_seen,
              (SELECT content FROM messages x WHERE x.user_id = u.id ORDER BY x.id DESC LIMIT 1) AS last_message,
              (SELECT role FROM messages x WHERE x.user_id = u.id ORDER BY x.id DESC LIMIT 1) AS last_role
       FROM users u ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
       ORDER BY u.last_seen DESC LIMIT ?`,
    )
    .all(...params, limit)
    .map((r) => ({ ...r, profile: JSON.parse(r.profile || '{}') }));
}
