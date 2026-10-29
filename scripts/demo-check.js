// Chequeo rápido previo a una demo: entorno, catálogo, health opcional y guiones.
// Uso: npm run demo:check
// BASE_URL opcional (p. ej. http://localhost:3000) para verificar /api/status.
import { readFileSync, existsSync } from 'node:fs';
import { config } from '../src/config.js';
import { isOfferable, registrationStatus } from '../src/agent/tools.js';

const ok = (msg) => console.log(`  ✓ ${msg}`);
const warn = (msg) => console.log(`  ⚠ ${msg}`);
const fail = (msg) => console.log(`  ✗ ${msg}`);

let errors = 0;

console.log('=== demo:check — preparación para la demo ===\n');

console.log('1. Variables de entorno críticas');
const critical = [
  ['LLM_API_KEY', config.llm.apiKey, true],
  ['TELEGRAM_BOT_TOKEN', config.telegram.token, false],
  ['DASHBOARD_PASSWORD', config.dashboard.password, false],
  ['DB_PATH', config.dbPath, true],
];
for (const [name, value, required] of critical) {
  if (value) ok(`${name} definida`);
  else if (required) {
    fail(`${name} falta (necesaria para la demo)`);
    errors++;
  } else warn(`${name} no definida (opcional según el canal/panel)`);
}
if (config.whatsapp.enabled) ok('WHATSAPP_ENABLED=true');
else warn('WhatsApp deshabilitado (WHATSAPP_ENABLED≠true)');

console.log('\n2. Catálogo de cursos');
const cachePath = 'data/courses.json';
if (!existsSync(cachePath)) {
  fail('No existe data/courses.json — ejecuta npm run scrape');
  errors++;
} else {
  try {
    const data = JSON.parse(readFileSync(cachePath, 'utf8'));
    const courses = data.courses ?? [];
    const abiertos = courses.filter((c) => c.status === 'abierto');
    const ofertables = courses.filter((c) => isOfferable(registrationStatus(c)));
    if (!courses.length) {
      fail('El catálogo está vacío');
      errors++;
    } else {
      ok(`${courses.length} cursos totales`);
      ok(`${abiertos.length} con status=abierto en la web`);
      ok(`${ofertables.length} ofertables (inscripción abierta o próxima)`);
      if (data.updatedAt) ok(`actualizado: ${data.updatedAt}`);
      if (!ofertables.length) {
        fail('No hay cursos ofertables: la demo no podrá recomendar inscripción');
        errors++;
      }
    }
  } catch (err) {
    fail(`No se pudo leer el catálogo: ${err.message}`);
    errors++;
  }
}

console.log('\n3. Health del panel (si BASE_URL está definida)');
const baseUrl = (process.env.BASE_URL || '').replace(/\/$/, '');
if (!baseUrl) {
  warn('BASE_URL no definida — se omite /api/status');
} else {
  try {
    const res = await fetch(`${baseUrl}/api/status`);
    if (!res.ok) {
      fail(`GET ${baseUrl}/api/status → HTTP ${res.status}`);
      errors++;
    } else {
      const body = await res.json().catch(() => ({}));
      ok(`GET ${baseUrl}/api/status → ${res.status}`);
      if (body.telegram || body.whatsapp || body.ok !== undefined) {
        ok(`estado: ${JSON.stringify(body).slice(0, 120)}`);
      }
    }
  } catch (err) {
    fail(`No se pudo contactar ${baseUrl}: ${err.message}`);
    errors++;
  }
}

console.log('\n4. Guiones de demo (seed etiquetado [demo])');
const guiones = [
  {
    id: 'demo-precio',
    titulo: 'Objeción de precio resuelta',
    pasos: ['Usuario duda por el precio', 'Sofía refuerza certificado QR y tarifas por audiencia', 'Usuario acepta e inicia inscripción'],
  },
  {
    id: 'demo-inyeccion',
    titulo: 'Inyección bloqueada',
    pasos: ['Usuario pide ignorar instrucciones / curso gratis', 'Se registra intento_manipulacion', 'Respuesta mantiene tarifas publicadas'],
  },
  {
    id: 'demo-frustracion',
    titulo: 'Handover por frustración atendido por operador',
    pasos: ['Usuario expresa frustración', 'IA pausa (mode=human)', 'Operador saluda y retoma la inscripción'],
  },
  {
    id: 'demo-lead',
    titulo: 'Lead caliente con contacto',
    pasos: ['Usuario pide inscribirse', 'Recibe enlace de inscripción', 'Estado lead_caliente y perfil con contacto'],
  },
];
for (const g of guiones) {
  console.log(`  • [${g.id}] ${g.titulo}`);
  for (const paso of g.pasos) console.log(`      – ${paso}`);
}
console.log('\n  Cargar guiones: npm run seed');
console.log('  Evaluar agente:  npm run eval');

console.log('\n--- Resultado ---');
if (errors) {
  console.log(`FAIL: ${errors} problema(s) antes de la demo`);
  process.exit(1);
}
console.log('PASS: listo para la demo (revisa avisos ⚠ si aplica)');
process.exit(0);
