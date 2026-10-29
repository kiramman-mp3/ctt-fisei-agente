import { existsSync } from 'node:fs';
import { join } from 'node:path';
import wwebjs from 'whatsapp-web.js';
import qrcodeTerminal from 'qrcode-terminal';
import QRCode from 'qrcode';
import { toFile } from 'openai';
import { bus } from '../core/events.js';
import { WELCOME, RESET_DONE, openCourses, splitMessage } from './common.js';

const { Client, LocalAuth } = wwebjs;
const CHANNEL = 'whatsapp';
const MAX_LENGTH = 3500;
const RESET_WORDS = /^(reiniciar|\/reiniciar|nueva conversaci[oó]n)$/i;
const MENU_WORDS = /^(menu|men[uú]|cursos|\/cursos|\/start|inicio)$/i;
const CLIENT_ID = 'ctt-fisei';

/** Estado del canal que muestra el dashboard (incluye el QR mientras no se vincula). */
export const whatsappState = {
  status: 'deshabilitado',
  available: false,
  qrDataUrl: null,
  number: null,
  updatedAt: null,
};

const setState = (patch) => {
  Object.assign(whatsappState, patch, { updatedAt: new Date().toISOString() });
  bus.emit('whatsapp', whatsappState);
};

function coursesMenu() {
  const lines = openCourses().map((c) => `• ${c.name} (${c.hours} h)`);
  return `*Cursos con inscripciones abiertas:*\n${lines.join('\n')}\n\nPregúntame por cualquiera de ellos.`;
}

/**
 * Conector de WhatsApp. El panel controla la sesión: `start` abre WhatsApp Web
 * y publica el QR, `logout` desvincula el teléfono. Cada inicio crea un cliente nuevo.
 */
export function createWhatsAppClient({ service, chromePath, dataPath, transcriber = null }) {
  let client = null;
  let starting = null;
  let restarting = false;
  const seen = new Set();

  const sendText = async (to, text) => {
    if (!client || whatsappState.status !== 'conectado') throw new Error('WhatsApp no está conectado');
    for (const part of splitMessage(text, MAX_LENGTH)) await client.sendMessage(to, part);
  };
  service.registerChannel(CHANNEL, sendText);
  setState({ status: 'desconectado', available: true });

  function createClient() {
    const c = new Client({
      authStrategy: new LocalAuth({ clientId: CLIENT_ID, dataPath }),
      puppeteer: {
        headless: true,
        executablePath: chromePath,
        // Flags para contenedores con poca CPU/RAM (Azure App Service B1).
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--no-zygote',
          '--no-first-run',
          '--disable-extensions',
          '--disable-background-networking',
          '--disable-default-apps',
          '--disable-sync',
          '--mute-audio',
        ],
      },
    });
    attach(c);
    return c;
  }

  function attach(wa) {
    wa.on('qr', async (qr) => {
      console.log('[whatsapp] Escanea este código QR desde WhatsApp > Dispositivos vinculados:');
      qrcodeTerminal.generate(qr, { small: true });
      setState({ status: 'esperando QR', qrDataUrl: await QRCode.toDataURL(qr, { margin: 1, width: 280 }) });
    });

    wa.on('authenticated', () => setState({ status: 'autenticado', qrDataUrl: null }));
    wa.on('auth_failure', (msg) => setState({ status: `error de autenticación: ${msg}` }));
    let readyCount = 0;
    wa.on('ready', () => {
      readyCount++;
      setState({ status: 'conectado', qrDataUrl: null, number: wa.info?.wid?.user ?? null });
      console.log(`[whatsapp] Conectado como ${whatsappState.number}`);
      // Si WhatsApp Web se recarga solo, whatsapp-web.js deja de emitir mensajes:
      // se reinicia el cliente (la sesión guardada evita volver a escanear el QR).
      if (readyCount > 1 && wa === client) restart('WhatsApp Web se recargó');
    });
    wa.on('disconnected', (reason) => {
      setState({ status: 'desconectado', qrDataUrl: null, number: null });
      console.warn(`[whatsapp] Desconectado: ${reason}`);
      if (wa === client) client = null;
      // whatsapp-web.js sigue usando la página justo después del evento: cerrar el navegador
      // en ese instante provoca TargetCloseError, así que se espera un momento.
      setTimeout(() => wa.destroy().catch(() => {}), 3000);
    });

    const onMessage = (msg) =>
      handleMessage(wa, msg).catch((err) => console.error(`[whatsapp] Error con el mensaje de ${msg.from}:`, err?.stack ?? err));
    wa.on('message', onMessage);
    // Respaldo: algunas versiones de WhatsApp Web solo disparan message_create. `seen` evita duplicados.
    wa.on('message_create', (msg) => {
      if (!msg.fromMe) onMessage(msg);
    });
  }

  /** Envía al chat del mensaje; si sendMessage falla, responde citando el mensaje. */
  async function sendTo(wa, msg, text) {
    for (const part of splitMessage(text, MAX_LENGTH)) {
      try {
        await wa.sendMessage(msg.from, part);
      } catch (err) {
        console.warn(`[whatsapp] sendMessage falló (${err?.message}), usando reply`);
        await msg.reply(part);
      }
    }
  }

  async function handleMessage(wa, msg) {
    // Solo chats privados de texto; se ignoran grupos, estados y mensajes repetidos.
    if (msg.fromMe || msg.isStatus || msg.from.endsWith('@g.us') || msg.from === 'status@broadcast') return;
    if (seen.has(msg.id._serialized)) return;
    seen.add(msg.id._serialized);
    if (seen.size > 5000) seen.clear();

    const contact = await msg.getContact().catch(() => null);
    const user = { channel: CHANNEL, externalId: msg.from, name: contact?.pushname || contact?.name || null };

    let text = msg.body?.trim() ?? '';
    if ((msg.type === 'ptt' || msg.type === 'audio') && transcriber) {
      const media = await msg.downloadMedia();
      const file = await toFile(Buffer.from(media.data, 'base64'), 'nota.ogg');
      text = await transcriber.transcribe(file);
      if (!text) return msg.reply('No logré entender el audio. ¿Me lo escribes, por favor?');
      text = `🎤 ${text}`;
    } else if (msg.type !== 'chat') {
      await msg.reply('Por ahora solo puedo leer texto y notas de voz. ¿Qué te gustaría saber de los cursos?');
      return;
    }
    if (!text) return;

    if (RESET_WORDS.test(text)) {
      service.reset(user);
      await sendTo(wa, msg, RESET_DONE);
      return;
    }
    if (MENU_WORDS.test(text)) {
      await sendTo(wa, msg, `${WELCOME}\n\n${coursesMenu()}`);
      return;
    }

    // El indicador "escribiendo" es opcional: si WhatsApp Web cambia su API interna no debe bloquear la respuesta.
    const chat = await msg.getChat().catch(() => null);
    await chat?.sendStateTyping().catch(() => {});
    const replies = await service.handleIncoming({ ...user, text });
    await chat?.clearState().catch(() => {});
    for (const reply of replies) await sendTo(wa, msg, reply);
  }

  /** Abre WhatsApp Web; si no hay sesión guardada se publica el QR en el panel. */
  function start() {
    if (client) return starting;
    setState({ status: 'iniciando', qrDataUrl: null });
    client = createClient();
    starting = client.initialize().catch((err) => {
      console.error(`[whatsapp] No se pudo iniciar: ${err.message}`);
      setState({ status: 'error al iniciar', qrDataUrl: null });
      client = null;
    });
    return starting;
  }

  /** Cierra el navegador y vuelve a abrir WhatsApp Web con la sesión guardada. */
  async function restart(reason) {
    if (restarting || !client) return;
    restarting = true;
    console.warn(`[whatsapp] Reiniciando el cliente: ${reason}`);
    const old = client;
    client = null;
    try {
      await old.destroy().catch(() => {});
      await start();
    } finally {
      restarting = false;
    }
  }

  // Vigilancia: si la sesión dejó de estar conectada sin avisar, se reinicia el cliente.
  setInterval(async () => {
    if (!client || restarting || whatsappState.status !== 'conectado') return;
    const state = await Promise.race([
      client.getState().catch(() => null),
      new Promise((resolve) => setTimeout(() => resolve('SIN_RESPUESTA'), 15_000)),
    ]);
    if (state !== 'CONNECTED') restart(`estado ${state ?? 'desconocido'}`);
  }, 60_000).unref();

  return {
    start,
    /** Desvincula el teléfono y borra la sesión guardada. */
    async logout() {
      if (!client) return;
      const c = client;
      client = null;
      await c.logout().catch(() => {});
      await c.destroy().catch(() => {});
      setState({ status: 'desconectado', qrDataUrl: null, number: null });
    },
    hasSession: () => existsSync(join(dataPath, `session-${CLIENT_ID}`)),
    async stop() {
      await client?.destroy().catch(() => {});
    },
  };
}
