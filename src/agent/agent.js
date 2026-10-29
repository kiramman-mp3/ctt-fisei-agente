import OpenAI from 'openai';
import { config } from '../config.js';
import { buildSystemPrompt } from './prompt.js';
import { TOOL_DEFINITIONS, TOOL_HANDLERS } from './tools.js';
import { buildPrefilledUrl, profileHasPrefillData } from './enrollment-link.js';
import {
  outputViolation,
  catalogPriceSet,
  securityNote,
  SAFE_REPLY,
  CONTAINMENT_REPLY,
  SANITIZED_INJECTION_USER,
  PRICE_CORRECTION_NOTE,
} from '../core/guard.js';
import { getCourses } from '../scraper/courses.js';

const MAX_STEPS = 5;
/** Incluye el razonamiento de modelos como gpt-oss: con 600 las respuestas se cortaban. */
export const MAX_COMPLETION_TOKENS = 1200;
/** Tope duro de caracteres para historial + resumen + perfil antes del LLM. */
export const CONTEXT_BUDGET_CHARS = 6000;

const FALLBACK =
  'Uy, se me complicó responder en este momento 🙏. Escríbenos a talleresfisei@uta.edu.ec o ctt.fisei@uta.edu.ec y te ayudamos enseguida.';

/** Quita el razonamiento que algunos modelos devuelven dentro del contenido. */
export const stripThinking = (text) => String(text).replace(/<think>[\s\S]*?(<\/think>|$)/g, '').trim();

/**
 * Quita líneas de relleno que algunos modelos generan al degenerar ("…", "¡…", "Oops… …").
 * Una línea es relleno si casi no tiene letras o si mezcla puntos suspensivos con muy poco texto.
 */
export function removeFiller(text) {
  let removed = 0;
  const lines = String(text)
    .split('\n')
    .filter((line) => {
      const visible = line.replace(/\s/g, '');
      if (!visible) return true;
      const letters = (line.match(/\p{L}/gu) ?? []).length;
      const ellipses = (line.match(/…|\.\.\./g) ?? []).length;
      const filler = letters / visible.length < 0.4 || (ellipses >= 2 && letters < 25) || (ellipses >= 1 && letters < 8);
      if (filler) removed++;
      return !filler;
    });
  return { text: lines.join('\n').replace(/\n{3,}/g, '\n\n').trim(), removed };
}

/** Ajusta el Markdown que algunos modelos generan igual al formato de cada canal. */
export function formatForChannel(text, channel) {
  let out = stripThinking(text).replace(/^#{1,6}\s+/gm, '').replace(/^\s*[-*]\s+/gm, '• ');
  out = channel === 'whatsapp' ? out.replace(/\*\*(.+?)\*\*/g, '*$1*') : out.replace(/\*\*(.+?)\*\*/g, '$1').replace(/__(.+?)__/g, '$1');
  return out.trim();
}

export function createLlmClient() {
  // Sin clave el cliente igual se crea: las llamadas fallan y el agente usa la respuesta de respaldo.
  return new OpenAI({ apiKey: config.llm.apiKey || 'sin-configurar', baseURL: config.llm.baseURL, timeout: 60_000, maxRetries: 0 });
}

/**
 * Llama al primer modelo de la lista y pasa al siguiente si se alcanza el límite
 * de tokens (429). En proveedores con límite por modelo, multiplica la capacidad.
 */
export async function complete(client, models, request, reasoningEffort = config.llm.reasoningEffort) {
  let lastError;
  // Dos vueltas: si todos los modelos están sin cupo, se espera un momento y se reintenta.
  for (const [i, model] of [...models, ...models].entries()) {
    if (i === models.length) await new Promise((r) => setTimeout(r, 3000));
    const body = { ...request, model };
    // Groq: gpt-oss acepta low/medium/high; en qwen3 se desactiva el razonamiento para ahorrar tokens.
    if (reasoningEffort && /gpt-oss/i.test(model)) body.reasoning_effort = reasoningEffort;
    if (reasoningEffort && /qwen3/i.test(model)) body.reasoning_effort = 'none';
    try {
      return await client.chat.completions.create(body);
    } catch (err) {
      lastError = err;
      if (err?.status !== 429 && !(err?.status >= 500)) throw err;
      console.warn(`[llm] ${model} sin cupo (429), probando el siguiente modelo`);
    }
  }
  throw lastError;
}

/**
 * Recorta el historial al presupuesto restante. El resumen y el perfil ya están
 * reservados fuera de este recorte y siempre se inyectan.
 */
export function trimHistoryToBudget(history, budgetChars) {
  if (budgetChars <= 0) return [];
  const trimmed = [];
  let used = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const row = history[i];
    const len = String(row.content ?? '').length;
    if (used + len > budgetChars && trimmed.length) break;
    used += len;
    trimmed.unshift(row);
  }
  return trimmed;
}

/**
 * Pipeline de inferencia: arma el contexto (prompt + resumen + historial
 * acotado), ejecuta el ciclo de herramientas y valida la respuesta.
 * No persiste nada: eso lo hace ConversationService.
 */
export class CourseAgent {
  constructor({ client = createLlmClient(), models = config.llm.models } = {}) {
    this.client = client;
    this.models = models;
    this.fallback = FALLBACK;
  }

  buildMessages({ channel, history, text, flags = [], summary, profile }) {
    const context = [];
    if (summary) context.push(`Resumen de lo conversado antes: ${summary}`);
    if (profile && Object.keys(profile).length) context.push(`Perfil conocido del prospecto: ${JSON.stringify(profile)}`);
    const contextBlock = context.join('\n');

    const userPayload = flags.includes('inyeccion_alta')
      ? SANITIZED_INJECTION_USER + securityNote(flags)
      : text + securityNote(flags);

    const reserved = contextBlock.length + userPayload.length;
    const historyBudget = Math.max(0, CONTEXT_BUDGET_CHARS - reserved);
    const boundedHistory = trimHistoryToBudget(history, historyBudget);

    return [
      { role: 'system', content: buildSystemPrompt(channel) },
      ...(context.length ? [{ role: 'system', content: contextBlock }] : []),
      // Los mensajes del operador salen con la identidad del bot, así que el modelo los ve como propios.
      ...boundedHistory.map(({ role, content }) => ({ role: role === 'user' ? 'user' : 'assistant', content })),
      { role: 'user', content: userPayload },
    ];
  }

  async respond(input) {
    // Inyección de severidad alta: contención sin exponer el texto crudo al modelo.
    if (input.flags?.includes('inyeccion_alta')) {
      return { answer: CONTAINMENT_REPLY, courses: [], usage: { in: 0, out: 0 }, handover: null, blocked: true };
    }

    const messages = this.buildMessages(input);
    const courses = new Set();
    const usage = { in: 0, out: 0 };
    let handover = null;
    let models = this.models;
    let regenerated = false;
    let priceRegenerated = false;

    for (let step = 0; step < MAX_STEPS; step++) {
      const completion = await complete(this.client, models, {
        messages,
        tools: TOOL_DEFINITIONS,
        temperature: 0.5,
        max_tokens: MAX_COMPLETION_TOKENS,
      });
      usage.in += completion.usage?.prompt_tokens ?? 0;
      usage.out += completion.usage?.completion_tokens ?? 0;

      const message = completion.choices[0].message;
      const calls = message.tool_calls ?? [];
      if (!calls.length) {
        const cleaned = removeFiller(formatForChannel(message.content ?? '', input.channel));
        // Respuesta degenerada: se vuelve a pedir una vez, empezando por otro modelo de la lista.
        if (cleaned.removed >= 3 && !regenerated && this.models.length > 1) {
          console.warn(`[agent] ${completion.model} generó ${cleaned.removed} líneas de relleno; se regenera con otro modelo`);
          regenerated = true;
          models = [...this.models.slice(1), this.models[0]];
          step--;
          continue;
        }
        const answer = cleaned.text;
        if (!answer) throw new Error('Respuesta vacía del modelo');
        const violation = outputViolation(answer, catalogPriceSet(getCourses()));
        if (violation === 'prices' && !priceRegenerated) {
          priceRegenerated = true;
          messages.push({ role: 'assistant', content: message.content ?? answer });
          messages.push({ role: 'user', content: PRICE_CORRECTION_NOTE });
          step--;
          continue;
        }
        if (violation) return { answer: SAFE_REPLY, courses: [...courses], usage, handover, blocked: true };
        return { answer, courses: [...courses], usage, handover };
      }

      messages.push({ role: 'assistant', content: message.content ?? null, tool_calls: calls });
      for (const call of calls) {
        const result = await this.runTool(call, courses, input);
        if (call.function.name === 'transferir_a_asesor' && result.ok) handover = result.handover;
        messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
      }
    }
    throw new Error('Se superó el número máximo de pasos del agente');
  }

  async runTool(call, courses, input = {}) {
    const handler = TOOL_HANDLERS[call.function.name];
    if (!handler) return { error: `Herramienta desconocida: ${call.function.name}` };
    let args;
    try {
      args = JSON.parse(call.function.arguments || '{}');
    } catch {
      return { error: 'Argumentos inválidos' };
    }
    const result = handler(args);
    // Formulario prellenado con los datos de ESTA conversación (se pasan por parámetro, sin estado global).
    if (call.function.name === 'ver_curso' && result.inscripcion?.includes('docs.google.com/forms')) {
      const profile = { ...input.profile, nombre_completo: input.name || undefined, curso: result.nombre };
      if (profileHasPrefillData(profile)) {
        const prefilled = await buildPrefilledUrl(result.inscripcion, profile);
        if (/[?&]entry\.\d+=/.test(prefilled)) {
          result.inscripcion = prefilled;
          result.nota_inscripcion = 'Formulario prellenado con los datos conocidos; pide a la persona que los revise antes de enviar.';
        }
      }
    }
    if (call.function.name === 'ver_curso' && !result.error) courses.add(result.id);
    if (call.function.name === 'buscar_cursos' && result.length <= 3) result.forEach((c) => courses.add(c.id));
    return result;
  }
}
