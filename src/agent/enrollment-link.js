const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
/** @type {Map<string, { fields: ReturnType<typeof parseFormFields>, expires: number }>} */
const cache = new Map();

const normalizeLabel = (text) =>
  String(text ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9+#\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** Sinónimos de etiquetas del formulario → clave de perfil. */
const LABEL_ALIASES = [
  { key: 'nombres', patterns: ['nombres', 'nombre', 'primer nombre', 'segundo nombre'] },
  { key: 'apellidos', patterns: ['apellidos', 'apellido', 'primer apellido', 'segundo apellido'] },
  {
    key: 'nombre_completo',
    patterns: ['nombre completo', 'nombres y apellidos', 'nombre y apellido', 'nombres completos'],
  },
  {
    key: 'cedula',
    patterns: ['cedula', 'ci', 'documento', 'numero de cedula', 'identificacion', 'documento de identidad'],
  },
  {
    key: 'correo',
    patterns: ['correo', 'email', 'e mail', 'correo electronico', 'mail', 'correo institucional'],
  },
  {
    key: 'telefono',
    patterns: ['telefono', 'celular', 'telefono celular', 'movil', 'whatsapp', 'numero de telefono', 'numero celular'],
  },
  {
    key: 'tipo',
    patterns: [
      'tipo de participante',
      'tipo de aspirante',
      'tipo',
      'categoria',
      'perfil',
      'eres estudiante',
      'tipo de usuario',
    ],
  },
  {
    key: 'curso',
    patterns: ['curso', 'taller', 'nombre del curso', 'curso de interes', 'curso al que aspira', 'programa'],
  },
];

const TIPO_LABELS = {
  estudiante_uta: ['estudiante uta', 'estudiante', 'alumno uta', 'alumna uta'],
  graduado_uta: [
    'graduado',
    'graduado uta',
    'egresado',
    'docente',
    'administrativo',
    'graduado docente administrativo',
    'graduado / docente / administrativo',
    'graduado-docente-administrativo',
  ],
  publico: ['publico', 'publico general', 'publico externo', 'general', 'externo'],
};

export function clearFormFieldsCache() {
  cache.clear();
}

export function setFormFieldsCache(formUrl, fields) {
  cache.set(normalizeFormUrl(formUrl), { fields, expires: Date.now() + CACHE_TTL_MS });
}

function normalizeFormUrl(formUrl) {
  try {
    const u = new URL(formUrl);
    u.hash = '';
    // Misma ficha con o sin query de prellenado.
    u.search = '';
    return u.toString().replace(/\/$/, '');
  } catch {
    return String(formUrl).split('?')[0].replace(/\/$/, '');
  }
}

function getCached(formUrl) {
  const key = normalizeFormUrl(formUrl);
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expires) {
    cache.delete(key);
    return null;
  }
  return hit.fields;
}

/**
 * Extrae campos subibles desde el HTML público de un Google Form
 * (`var FB_PUBLIC_LOAD_DATA_ = ...`).
 */
export function parseFormFields(html) {
  const match = String(html).match(/FB_PUBLIC_LOAD_DATA_\s*=\s*([\s\S]*?);\s*(?:<\/script>|$)/i);
  if (!match) return [];
  let data;
  try {
    data = JSON.parse(match[1]);
  } catch {
    return [];
  }
  const questions = data?.[1]?.[1];
  if (!Array.isArray(questions)) return [];

  const fields = [];
  for (const q of questions) {
    if (!Array.isArray(q) || !q[4]?.[0]) continue;
    const entryId = q[4][0][0];
    if (entryId == null) continue;
    const options = Array.isArray(q[4][0][1])
      ? q[4][0][1].map((opt) => (Array.isArray(opt) ? String(opt[0] ?? '') : String(opt ?? ''))).filter(Boolean)
      : [];
    fields.push({
      label: String(q[1] ?? ''),
      entryId: Number(entryId),
      type: Number(q[3] ?? 0),
      options,
    });
  }
  return fields;
}

/** Descarga el HTML público del form y devuelve sus campos. Caché 6 h; ante fallo, []. */
export async function getFormFields(formUrl) {
  try {
    const cached = getCached(formUrl);
    if (cached) return cached;
    const res = await fetch(formUrl, {
      headers: { 'User-Agent': 'CTT-FISEI-Agente/1.0' },
      redirect: 'follow',
    });
    if (!res.ok) return [];
    const fields = parseFormFields(await res.text());
    setFormFieldsCache(formUrl, fields);
    return fields;
  } catch {
    return [];
  }
}

/** Parte un nombre completo en nombres / apellidos con heurística en español. */
export function splitFullName(fullName) {
  const parts = String(fullName ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!parts.length) return { nombres: '', apellidos: '' };
  if (parts.length === 1) return { nombres: parts[0], apellidos: '' };
  if (parts.length === 2) return { nombres: parts[0], apellidos: parts[1] };
  if (parts.length === 3) return { nombres: parts[0], apellidos: parts.slice(1).join(' ') };
  const mid = Math.ceil(parts.length / 2);
  return { nombres: parts.slice(0, mid).join(' '), apellidos: parts.slice(mid).join(' ') };
}

function resolveProfileValues(profile = {}) {
  const p = profile && typeof profile === 'object' ? profile : {};
  const full =
    p.nombre_completo || p.nombreCompleto || p.name || p.nombre || [p.nombres, p.apellidos].filter(Boolean).join(' ');
  const split = splitFullName(full);
  const nombres = p.nombres || split.nombres;
  const apellidos = p.apellidos || split.apellidos;
  return {
    nombres: nombres || undefined,
    apellidos: apellidos || undefined,
    nombre_completo: full || (nombres && apellidos ? `${nombres} ${apellidos}` : nombres || apellidos) || undefined,
    cedula: p.cedula || p.ci || p.documento || undefined,
    correo: p.correo || p.email || p.mail || undefined,
    telefono: p.telefono || p.celular || p.phone || p.whatsapp || undefined,
    tipo: p.tipo || p.tipo_participante || undefined,
    curso: p.curso || p.curso_interes || undefined,
  };
}

function matchLabelKey(label) {
  const n = normalizeLabel(label);
  if (!n) return null;

  for (const alias of LABEL_ALIASES) {
    for (const pattern of alias.patterns) {
      if (n === pattern) return alias.key;
    }
  }

  let best = null;
  for (const alias of LABEL_ALIASES) {
    for (const pattern of alias.patterns) {
      if (n.includes(pattern) && (!best || pattern.length > best.pattern.length)) {
        best = { key: alias.key, pattern };
      }
    }
  }
  // "Nombre del curso" no debe mapearse a nombres; "nombre completo" gana sobre nombre.
  if (best?.key === 'nombres' && (/\bcurso\b/.test(n) || n.includes('taller') || n.includes('programa'))) {
    return 'curso';
  }
  if (best?.key === 'nombres' && (n.includes('completo') || n.includes('apellidos y nombres'))) {
    return 'nombre_completo';
  }
  return best?.key ?? null;
}

function pickTipoOption(options, tipo) {
  if (!tipo || !options?.length) return undefined;
  const candidates = TIPO_LABELS[tipo] || [normalizeLabel(tipo)];
  const normalizedOptions = options.map((o) => ({ raw: o, n: normalizeLabel(o) }));
  for (const cand of candidates) {
    const exact = normalizedOptions.find((o) => o.n === cand);
    if (exact) return exact.raw;
  }
  for (const cand of candidates) {
    const partial = normalizedOptions.find((o) => o.n.includes(cand) || cand.includes(o.n));
    if (partial) return partial.raw;
  }
  return undefined;
}

function valueForField(field, values) {
  const key = matchLabelKey(field.label);
  if (!key) return undefined;
  let value = values[key];
  if (value == null || value === '') return undefined;

  // Selección (multiple choice / dropdown / checkbox): elegir la opción más parecida.
  if ((field.type === 2 || field.type === 3 || field.type === 4) && field.options?.length) {
    if (key === 'tipo') {
      value = pickTipoOption(field.options, values.tipo);
    } else {
      const n = normalizeLabel(value);
      const hit =
        field.options.find((o) => normalizeLabel(o) === n) ||
        field.options.find((o) => normalizeLabel(o).includes(n) || n.includes(normalizeLabel(o)));
      value = hit;
    }
  }
  return value == null || value === '' ? undefined : String(value);
}

function applyPrefill(formUrl, fields, profile) {
  if (!formUrl) return formUrl;
  if (!fields?.length) return formUrl;

  const values = resolveProfileValues(profile);
  const hasAny = Object.values(values).some((v) => v != null && String(v).trim() !== '');
  if (!hasAny) return formUrl;

  const params = new URLSearchParams();
  params.set('usp', 'pp_url');
  let mapped = 0;
  for (const field of fields) {
    const value = valueForField(field, values);
    if (value == null) continue;
    params.set(`entry.${field.entryId}`, value);
    mapped++;
  }
  if (!mapped) return formUrl;

  const base = String(formUrl).split('?')[0];
  return `${base}?${params.toString()}`;
}

/**
 * Arma la URL de Google Form prellenada con los datos conocidos del prospecto.
 * Si no hay mapeo o falla, devuelve la URL original.
 */
export async function buildPrefilledUrl(formUrl, profile = {}) {
  try {
    const fields = await getFormFields(formUrl);
    return applyPrefill(formUrl, fields, profile);
  } catch {
    return formUrl;
  }
}

/** True si el perfil trae algo que podríamos mapear al formulario. */
export function profileHasPrefillData(profile = {}) {
  const values = resolveProfileValues(profile);
  return Object.values(values).some((v) => v != null && String(v).trim() !== '');
}
