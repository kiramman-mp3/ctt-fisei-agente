import { config } from './config.js';
import { initCourses } from './scraper/courses.js';
import { Store } from './db/store.js';
import { CourseAgent } from './agent/agent.js';
import { ProspectAnalyzer } from './agent/analyzer.js';
import { Transcriber } from './agent/transcriber.js';
import { ConversationService } from './core/conversation-service.js';
import { createTelegramBot } from './channels/telegram.js';
import { createWhatsAppClient } from './channels/whatsapp.js';
import { createDashboard } from './dashboard/server.js';

const courses = await initCourses();
console.log(`[cursos] ${courses.courses.length} cursos cargados (${courses.updatedAt})`);

const store = new Store(config.dbPath);
if (!config.llm.apiKey) console.warn('[agent] Falta LLM_API_KEY: el agente responderá con el mensaje de respaldo.');
const service = new ConversationService({
  store,
  agent: new CourseAgent(),
  analyzer: config.llm.apiKey ? new ProspectAnalyzer() : null,
  handoverTimeoutMin: config.handoverTimeoutMin,
  holdOperatorIdleMin: config.holdOperatorIdleMin,
  holdCooldownMin: config.holdCooldownMin,
});
const transcriber = config.stt.apiKey ? new Transcriber(config.stt) : null;
if (!transcriber) console.warn('[voz] STT_API_KEY no configurado; las notas de voz no se transcribirán.');

// Keep-alive opcional: evita que el host se duerma haciendo GET periódico.
let keepaliveTimer = null;
if (config.keepaliveUrl) {
  const ping = () =>
    fetch(config.keepaliveUrl)
      .then((res) => {
        if (!res.ok) console.warn(`[keepalive] ${res.status} ${config.keepaliveUrl}`);
      })
      .catch((err) => console.warn(`[keepalive] ${err.message}`));
  ping();
  keepaliveTimer = setInterval(ping, 10 * 60_000);
  if (typeof keepaliveTimer.unref === 'function') keepaliveTimer.unref();
  console.log(`[keepalive] ping cada 10 min → ${config.keepaliveUrl}`);
}

let telegramInfo = null;
let telegram = null;
if (config.telegram.token) {
  telegram = createTelegramBot({ token: config.telegram.token, service, transcriber });
  try {
    telegramInfo = await telegram.start();
  } catch (err) {
    console.error(`[telegram] No se pudo iniciar: ${err.message}`);
  }
} else {
  console.warn('[telegram] TELEGRAM_BOT_TOKEN no configurado; canal deshabilitado.');
}

// El canal de WhatsApp siempre queda disponible para iniciar sesión desde el panel;
// arranca solo si WHATSAPP_ENABLED=true o si ya hay una sesión vinculada.
const whatsapp = createWhatsAppClient({
  service,
  transcriber,
  chromePath: config.whatsapp.chromePath,
  dataPath: config.whatsapp.dataPath,
});
if (config.whatsapp.enabled || whatsapp.hasSession()) whatsapp.start();
else console.log('[whatsapp] Listo para vincular: usa "Iniciar sesión" en el panel.');

const app = createDashboard({
  store,
  service,
  whatsapp,
  publicWhatsAppNumber: config.whatsapp.publicNumber,
  auth: config.dashboard,
  telegramInfo: () => (telegramInfo ? { username: telegramInfo.username } : null),
});
const server = app.listen(config.dashboard.port, () => {
  console.log(`[dashboard] http://localhost:${config.dashboard.port}`);
  if (!config.dashboard.password) console.warn('[dashboard] Sin DASHBOARD_PASSWORD: el dashboard es público.');
});

async function shutdown() {
  console.log('Cerrando...');
  if (keepaliveTimer) clearInterval(keepaliveTimer);
  server.close();
  await Promise.allSettled([telegram?.stop(), whatsapp?.stop()]);
  store.close();
  process.exit(0);
}
// Un fallo del navegador de WhatsApp (puppeteer) no debe tumbar Telegram ni el panel.
const BROWSER_ERRORS = /TargetCloseError|ProtocolError|Target closed|Session closed|Execution context was destroyed/;
process.on('unhandledRejection', (err) => console.error('[proceso] Promesa rechazada sin manejar:', err?.stack ?? err));
process.on('uncaughtException', (err) => {
  console.error('[proceso] Excepción no capturada:', err?.stack ?? err);
  if (!BROWSER_ERRORS.test(`${err?.name} ${err?.message}`)) process.exit(1);
});
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
