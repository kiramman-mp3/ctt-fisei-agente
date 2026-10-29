import { Bot, InlineKeyboard } from 'grammy';
import { WELCOME, RESET_DONE, openCourses, splitMessage } from './common.js';

const CHANNEL = 'telegram';
const MAX_LENGTH = 4000;

const userOf = (ctx) => ({
  channel: CHANNEL,
  externalId: ctx.from.id,
  name: [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ') || ctx.from.username,
});

function coursesKeyboard() {
  const keyboard = new InlineKeyboard();
  for (const c of openCourses()) keyboard.text(c.name.slice(0, 60), `curso:${c.id}`).row();
  return keyboard;
}

/** Conector de Telegram: traduce updates del bot a llamadas del ConversationService. */
export function createTelegramBot({ token, service, transcriber = null }) {
  const bot = new Bot(token);
  let stopped = false;

  const sendText = async (chatId, text) => {
    for (const part of splitMessage(text, MAX_LENGTH)) {
      await bot.api.sendMessage(chatId, part, { link_preview_options: { is_disabled: true } });
    }
  };
  service.registerChannel(CHANNEL, sendText);

  async function handle(ctx, text) {
    await ctx.replyWithChatAction('typing');
    const typing = setInterval(() => ctx.replyWithChatAction('typing').catch(() => {}), 4500);
    try {
      const replies = await service.handleIncoming({ ...userOf(ctx), text });
      for (const reply of replies) await sendText(ctx.chat.id, reply);
    } finally {
      clearInterval(typing);
    }
  }

  bot.command('start', async (ctx) => {
    service.reset(userOf(ctx));
    await ctx.reply(WELCOME);
    await ctx.reply('Estos son los cursos con inscripciones abiertas:', { reply_markup: coursesKeyboard() });
  });

  bot.command('cursos', (ctx) =>
    ctx.reply('Cursos con inscripciones abiertas. Toca uno para conocerlo:', { reply_markup: coursesKeyboard() }),
  );

  bot.command('reiniciar', async (ctx) => {
    service.reset(userOf(ctx));
    await ctx.reply(RESET_DONE);
  });

  bot.command('asesor', (ctx) => handle(ctx, 'Quiero hablar con un asesor humano'));

  bot.command('ayuda', (ctx) =>
    ctx.reply(
      'Comandos:\n/cursos - ver cursos abiertos\n/asesor - hablar con una persona del CTT\n/reiniciar - empezar una conversación nueva\n\n' +
        'También puedes escribirme o enviarme una nota de voz.',
    ),
  );

  bot.callbackQuery(/^curso:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const course = openCourses().find((c) => c.id === Number(ctx.match[1]));
    if (!course) return ctx.reply('Ese curso ya no está disponible. Usa /cursos para ver la oferta actual.');
    await handle(ctx, `Me interesa el curso "${course.name}". ¿Me cuentas de qué trata?`);
  });

  bot.on('message:text', (ctx) => handle(ctx, ctx.message.text));

  bot.on(['message:voice', 'message:audio'], async (ctx) => {
    if (!transcriber) {
      return ctx.reply('Por ahora no puedo escuchar audios 🙈. ¿Me lo escribes, por favor?');
    }
    await ctx.replyWithChatAction('typing');
    try {
      const file = await ctx.getFile();
      const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
      const text = await transcriber.transcribeUrl(url, file.file_path.split('/').pop());
      if (!text) return ctx.reply('No logré entender el audio. ¿Me lo escribes, por favor?');
      await handle(ctx, `🎤 ${text}`);
    } catch (err) {
      console.error(`[telegram] audio: ${err.message}`);
      await ctx.reply('No pude procesar el audio. ¿Me lo escribes, por favor?');
    }
  });

  bot.on('message', (ctx) => ctx.reply('Por ahora solo puedo leer texto y notas de voz. ¿Qué te gustaría saber de los cursos?'));

  bot.catch((err) => console.error(`[telegram] ${err.error?.message ?? err.message}`));

  return {
    /** Conecta con reintentos y mantiene el polling vivo ante errores de red o 409. */
    async start() {
      let me = null;
      for (let attempt = 1; !me; attempt++) {
        try {
          me = await bot.api.getMe();
        } catch (err) {
          const wait = Math.min(60, 5 * attempt);
          console.warn(`[telegram] No se pudo conectar (${err.message}); reintento en ${wait} s`);
          await new Promise((r) => setTimeout(r, wait * 1000));
        }
      }
      bot.api
        .setMyCommands([
          { command: 'cursos', description: 'Ver cursos abiertos' },
          { command: 'asesor', description: 'Hablar con una persona del CTT' },
          { command: 'reiniciar', description: 'Empezar una conversación nueva' },
          { command: 'ayuda', description: 'Cómo usar el asistente' },
        ])
        .catch((err) => console.warn(`[telegram] setMyCommands: ${err.message}`));

      // grammY detiene el polling ante un error (p. ej. 409 mientras el contenedor anterior
      // de un despliegue sigue vivo): se vuelve a iniciar en vez de quedar sordo para siempre.
      const poll = () =>
        bot.start({ drop_pending_updates: true }).catch((err) => {
          if (stopped) return;
          const wait = err?.error_code === 409 ? 15 : 5;
          console.warn(`[telegram] Polling detenido (${err.message}); se reanuda en ${wait} s`);
          setTimeout(poll, wait * 1000);
        });
      poll();
      console.log(`[telegram] Bot activo: https://t.me/${me.username}`);
      return me;
    },
    stop: () => {
      stopped = true;
      return bot.stop();
    },
  };
}
