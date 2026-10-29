import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

// Acceso de demostración para el jurado de la hackathon: se crea en la base de datos
// solo si todavía no existe ningún operador. Cambia la contraseña con `npm run operator`.
export const DEMO_OPERATOR = { username: 'admin', password: 'CttFisei2026' };

export const SESSION_COOKIE = 'ctt_session';
export const SESSION_DAYS = 7;

/** Hash con scrypt y sal aleatoria: "scrypt$<sal>$<hash>". */
export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(String(password), salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(password, stored) {
  const [scheme, salt, hash] = String(stored ?? '').split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'hex');
  const actual = scryptSync(String(password), salt, expected.length);
  return timingSafeEqual(expected, actual);
}

/** Operadores del panel y sus sesiones, guardados en la misma base SQLite. */
export class OperatorAuth {
  constructor(db) {
    this.db = db;
  }

  /** Crea el operador de demostración si la tabla está vacía. */
  ensureDefaultOperator() {
    const { total } = this.db.prepare('SELECT COUNT(*) AS total FROM operators').get();
    if (total === 0) this.setOperator(DEMO_OPERATOR.username, DEMO_OPERATOR.password);
  }

  /** Crea el operador o cambia su contraseña. */
  setOperator(username, password) {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO operators (username, password_hash, created_at) VALUES (?, ?, ?)
         ON CONFLICT(username) DO UPDATE SET password_hash = excluded.password_hash`,
      )
      .run(String(username).trim(), hashPassword(password), now);
  }

  /** Devuelve el token de sesión si las credenciales son correctas, o null. */
  login(username, password) {
    const operator = this.db
      .prepare('SELECT id, username, password_hash FROM operators WHERE username = ?')
      .get(String(username ?? '').trim());
    // Se verifica igual contra un hash ficticio para no revelar si el usuario existe.
    const ok = verifyPassword(password, operator?.password_hash ?? hashPassword('x'));
    if (!operator || !ok) return null;

    const token = randomBytes(32).toString('hex');
    const now = Date.now();
    this.db
      .prepare('INSERT INTO sessions (token, operator_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .run(token, operator.id, new Date(now).toISOString(), new Date(now + SESSION_DAYS * 86400_000).toISOString());
    this.db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(new Date(now).toISOString());
    return { token, username: operator.username };
  }

  /** Operador dueño de una sesión vigente, o null. */
  session(token) {
    if (!token) return null;
    return (
      this.db
        .prepare(
          `SELECT o.username FROM sessions s JOIN operators o ON o.id = s.operator_id
           WHERE s.token = ? AND s.expires_at > ?`,
        )
        .get(token, new Date().toISOString()) ?? null
    );
  }

  logout(token) {
    if (token) this.db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  }
}
