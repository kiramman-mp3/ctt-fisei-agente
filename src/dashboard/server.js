import express from 'express';
import QRCode from 'qrcode';
import { timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as analytics from '../db/analytics.js';
import { TOPIC_LABELS } from '../db/topics.js';
import { getCourses, getCoursesUpdatedAt, refreshCourses } from '../scraper/courses.js';
import { whatsappState } from '../channels/whatsapp.js';
import { openCourses } from '../channels/common.js';
import { registrationStatus, isOfferable } from '../agent/tools.js';
import { bus } from '../core/events.js';

const safeEqual = (a, b) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/** Autenticación HTTP básica; se desactiva si no hay contraseña configurada. */
function basicAuth({ user, password }) {
  return (req, res, next) => {
    if (!password || req.method === 'OPTIONS') return next();
    const [scheme, encoded] = (req.headers.authorization ?? '').split(' ');
    if (scheme === 'Basic' && encoded) {
      const [u, ...p] = Buffer.from(encoded, 'base64').toString().split(':');
      if (safeEqual(u, user) && safeEqual(p.join(':'), password)) return next();
    }
    res.set('WWW-Authenticate', 'Basic realm="Dashboard CTT-FISEI"').status(401).send('Autenticación requerida');
  };
}

// La API queda abierta a cualquier origen (requisito del jurado: sin restricciones de CORS).
function cors(req, res, next) {
  res.set({
    'Access-Control-Allow-Origin': req.headers.origin ?? '*',
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    Vary: 'Origin',
  });
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
}

const RANGES = { '24h': 1, '7d': 7, '30d': 30, '90d': 90 };

function filters(req) {
  const days = RANGES[req.query.range];
  const since = days ? new Date(Date.now() - days * 86400_000).toISOString() : null;
  const channel = ['telegram', 'whatsapp'].includes(req.query.channel) ? req.query.channel : null;
  return { since, channel };
}

export function createDashboard({ store, service, auth, telegramInfo, whatsapp = null, publicWhatsAppNumber = '' }) {
  const app = express();
  const db = store.db;
  app.disable('x-powered-by');
  app.use(cors);

  // ---------- Rutas públicas (landing de contacto): no piden la contraseña del panel ----------
  const publicDir = fileURLToPath(new URL('./public', import.meta.url));
  const PUBLIC_FILES = new Set(['/contacto.html', '/contacto.css', '/contacto.js']);
  const publicStatic = express.static(publicDir);
  app.use((req, res, next) => (PUBLIC_FILES.has(req.path) || req.path.startsWith('/img/') ? publicStatic(req, res, next) : next()));

  const qr = (url) => QRCode.toDataURL(url, { margin: 1, width: 440, color: { dark: '#012e5a', light: '#ffffff' } });

  app.get('/api/public/contact', async (_req, res) => {
    // Mientras Telegram se conecta no hay username todavía.
    const tg = telegramInfo()?.username ? telegramInfo() : null;
    const number = publicWhatsAppNumber || whatsappState.number || null;
    const telegramUrl = tg ? `https://t.me/${tg.username}` : null;
    const whatsappUrl = number ? `https://wa.me/${number}` : null;
    res.json({
      telegram: tg && { username: tg.username, url: telegramUrl, qr: await qr(telegramUrl) },
      whatsapp: whatsappUrl && { number, url: whatsappUrl, online: whatsappState.status === 'conectado', qr: await qr(whatsappUrl) },
    });
  });

  // Solo datos públicos de la oferta vigente (lo mismo que muestra la web del CTT).
  app.get('/api/public/courses', (_req, res) => {
    res.json(
      getCourses()
        .map((c) => ({ c, registration: registrationStatus(c) }))
        .filter(({ registration }) => isOfferable(registration))
        .map(({ c, registration }) => ({
          id: c.id,
          name: c.name,
          hours: c.hours,
          registration,
          modality: c.details?.['Modalidad'] ?? null,
          courseDates: c.details?.['Fecha del curso'] ?? null,
          url: c.url,
        })),
    );
  });

  // ---------- Panel del operador: requiere autenticación ----------
  app.use(basicAuth(auth));
  app.use(express.json({ limit: '32kb' }));
  app.use(express.static(publicDir));

  const status = () => {
    const courses = getCourses();
    return {
      telegram: telegramInfo(),
      whatsapp: whatsappState,
      courses: {
        total: courses.length,
        open: openCourses().length,
        updatedAt: getCoursesUpdatedAt(),
      },
    };
  };

  bus.on('whatsapp', () => bus.emit('status', status()));

  // Server-Sent Events: el dashboard recibe mensajes y cambios de estado sin recargar.
  app.get('/api/events', (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    const send = (event) => (data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    const listeners = { message: send('message'), conversation: send('conversation'), status: send('status') };
    for (const [event, fn] of Object.entries(listeners)) bus.on(event, fn);
    listeners.status(status());
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 25_000);
    req.on('close', () => {
      clearInterval(heartbeat);
      for (const [event, fn] of Object.entries(listeners)) bus.off(event, fn);
    });
  });

  app.get('/api/overview', (req, res) => {
    const f = filters(req);
    const names = new Map(getCourses().map((c) => [c.id, c.name]));
    res.json({
      summary: analytics.summary(db, f),
      events: analytics.eventCounts(db, f),
      byState: analytics.byState(db, f),
      byChannel: analytics.byChannel(db, f),
      byDay: analytics.byDay(db, f),
      byHour: analytics.byHour(db, f),
      byTopic: analytics.byTopic(db, f).map((t) => ({ ...t, label: TOPIC_LABELS[t.topic] ?? t.topic })),
      topCourses: analytics.topCourses(db, f).map((c) => ({ ...c, name: names.get(c.course_id) ?? `Curso ${c.course_id}` })),
    });
  });

  app.get('/api/analytics/timeseries', (req, res) => {
    res.json(analytics.timeseries(db, filters(req)));
  });

  app.get('/api/courses', (_req, res) => {
    const order = { abierta: 0, próxima: 1, 'abierta (confirmar fechas)': 2, vencida: 3, cerrada: 4 };
    const courses = getCourses()
      .map((c) => ({
        id: c.id,
        name: c.name,
        hours: c.hours,
        registration: registrationStatus(c),
        modality: c.details?.['Modalidad'] ?? null,
        registrationDates: c.details?.['Fechas de inscripciones'] ?? null,
        courseDates: c.details?.['Fecha del curso'] ?? null,
        schedule: c.details?.['Horario'] ?? null,
        prices: c.details?.['Precio para los asistentes'] ?? null,
        description: c.description ?? null,
        url: c.url,
        registrationUrl: c.registrationUrl ?? null,
      }))
      .sort((a, b) => order[a.registration] - order[b.registration] || b.id - a.id);
    res.json(courses);
  });

  app.get('/api/inbox', (req, res) => res.json(analytics.inbox(db, filters(req))));

  app.get('/api/conversations/:userId', (req, res) => {
    const conversation = store.getConversation(req.params.userId);
    if (!conversation) return res.status(404).json({ error: 'Conversación no encontrada' });
    res.json({ conversation, messages: analytics.conversation(db, req.params.userId) });
  });

  app.post('/api/conversations/:userId/messages', async (req, res) => {
    const text = String(req.body?.text ?? '').trim();
    if (!text) return res.status(400).json({ error: 'El mensaje está vacío' });
    if (text.length > 3000) return res.status(400).json({ error: 'El mensaje es demasiado largo' });
    try {
      res.json(await service.sendOperatorMessage(req.params.userId, text));
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  app.post('/api/conversations/:userId/mode', (req, res) => {
    const mode = req.body?.mode;
    if (!['ai', 'human'].includes(mode)) return res.status(400).json({ error: 'mode debe ser "ai" o "human"' });
    if (!store.getConversation(req.params.userId)) return res.status(404).json({ error: 'Conversación no encontrada' });
    const reason = mode === 'human' ? 'El operador tomó el control' : 'El operador devolvió la conversación a la IA';
    if (mode === 'human') store.addEvent(req.params.userId, 'operador_toma', reason);
    res.json(service.setMode(req.params.userId, mode, reason));
  });

  app.post('/api/conversations/:userId/read', (req, res) => {
    service.markRead(req.params.userId);
    res.json({ ok: true });
  });

  app.get('/api/status', (_req, res) => res.json(status()));

  // Sesión de WhatsApp controlada desde el panel: iniciar muestra el QR, cerrar desvincula el teléfono.
  app.post('/api/whatsapp/start', (_req, res) => {
    if (!whatsapp) return res.status(503).json({ error: 'El canal de WhatsApp no está disponible en este servidor' });
    whatsapp.start();
    res.json(whatsappState);
  });

  app.post('/api/whatsapp/logout', async (_req, res) => {
    if (!whatsapp) return res.status(503).json({ error: 'El canal de WhatsApp no está disponible en este servidor' });
    await whatsapp.logout();
    res.json(whatsappState);
  });

  app.post('/api/courses/refresh', async (_req, res) => {
    try {
      const data = await refreshCourses();
      bus.emit('status', status());
      res.json({ total: data.courses.length, updatedAt: data.updatedAt });
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  return app;
}
