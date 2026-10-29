import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseFormFields,
  getFormFields,
  buildPrefilledUrl,
  splitFullName,
  setFormFieldsCache,
  clearFormFieldsCache,
  profileHasPrefillData,
} from '../src/agent/enrollment-link.js';

/** HTML mínimo con FB_PUBLIC_LOAD_DATA_ al estilo de un formulario CTT. */
const SAMPLE_HTML = `<!DOCTYPE html><html><head><title>Inscripción</title></head><body>
<script type="text/javascript">var FB_PUBLIC_LOAD_DATA_ = [null,["Inscripción CTT",[[1,"Nombres",null,0,[[111111111,null,1]]],[2,"Apellidos",null,0,[[222222222,null,1]]],[3,"Nombre completo",null,0,[[333333333,null,0]]],[4,"Cédula",null,0,[[444444444,null,1]]],[5,"Correo electrónico",null,0,[[555555555,null,1]]],[6,"Teléfono / Celular",null,0,[[666666666,null,1]]],[7,"Tipo de participante",null,2,[[777777777,[["Estudiante UTA",null,null,null,0],["Graduado / Docente / Administrativo",null,null,null,0],["Público general",null,null,null,0]],1]]],[8,"Nombre del curso",null,3,[[888888888,[["Python desde cero",null,null,null,0],["Redes y ciberseguridad",null,null,null,0]],1]]]],null,null,null,[0,0],null,null,"Inscripción CTT",48],"/forms","Inscripción",null,null,null,"0",null,0,0,"","",0,"e/1FAIpQLSeExampleFormId",1];</script>
</body></html>`;

const FORM_URL = 'https://docs.google.com/forms/d/e/1FAIpQLSeExampleFormId/viewform';

beforeEach(() => {
  clearFormFieldsCache();
});

test('parseFormFields extrae label, entryId, type y options', () => {
  const fields = parseFormFields(SAMPLE_HTML);
  assert.equal(fields.length, 8);
  assert.deepEqual(
    fields.find((f) => f.entryId === 111111111),
    { label: 'Nombres', entryId: 111111111, type: 0, options: [] },
  );
  const tipo = fields.find((f) => f.entryId === 777777777);
  assert.equal(tipo.type, 2);
  assert.deepEqual(tipo.options, [
    'Estudiante UTA',
    'Graduado / Docente / Administrativo',
    'Público general',
  ]);
});

test('parseFormFields ante HTML inválido o sin datos devuelve []', () => {
  assert.deepEqual(parseFormFields('<html></html>'), []);
  assert.deepEqual(parseFormFields('var FB_PUBLIC_LOAD_DATA_ = {no:1};'), []);
});

test('getFormFields usa caché y no vuelve a descargar', async () => {
  let fetches = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    fetches += 1;
    return { ok: true, text: async () => SAMPLE_HTML };
  };
  try {
    const a = await getFormFields(FORM_URL);
    const b = await getFormFields(`${FORM_URL}?usp=pp_url`);
    assert.equal(a.length, 8);
    assert.equal(b.length, 8);
    assert.equal(fetches, 1);
  } finally {
    globalThis.fetch = original;
  }
});

test('getFormFields ante fallo de red o HTTP devuelve []', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('offline');
  };
  try {
    assert.deepEqual(await getFormFields(FORM_URL), []);
  } finally {
    globalThis.fetch = original;
  }

  globalThis.fetch = async () => ({ ok: false, status: 404, text: async () => '' });
  try {
    assert.deepEqual(await getFormFields(FORM_URL), []);
  } finally {
    globalThis.fetch = original;
  }
});

test('splitFullName parte nombres y apellidos', () => {
  assert.deepEqual(splitFullName('Ana Ruiz'), { nombres: 'Ana', apellidos: 'Ruiz' });
  assert.deepEqual(splitFullName('Juan Carlos Pérez'), {
    nombres: 'Juan',
    apellidos: 'Carlos Pérez',
  });
  assert.deepEqual(splitFullName('María José Pérez López'), {
    nombres: 'María José',
    apellidos: 'Pérez López',
  });
  assert.deepEqual(splitFullName('Solo'), { nombres: 'Solo', apellidos: '' });
});

test('buildPrefilledUrl mapea etiquetas, tipo y curso; URL-encode correcto', async () => {
  setFormFieldsCache(FORM_URL, parseFormFields(SAMPLE_HTML));
  const url = await buildPrefilledUrl(FORM_URL, {
    nombres: 'María José',
    apellidos: 'Pérez López',
    cedula: '1801234567',
    correo: 'maria@uta.edu.ec',
    telefono: '099 123 4567',
    tipo: 'estudiante_uta',
    curso: 'Python desde cero',
  });
  const parsed = new URL(url);
  assert.equal(parsed.searchParams.get('usp'), 'pp_url');
  assert.equal(parsed.searchParams.get('entry.111111111'), 'María José');
  assert.equal(parsed.searchParams.get('entry.222222222'), 'Pérez López');
  assert.equal(parsed.searchParams.get('entry.444444444'), '1801234567');
  assert.equal(parsed.searchParams.get('entry.555555555'), 'maria@uta.edu.ec');
  assert.equal(parsed.searchParams.get('entry.666666666'), '099 123 4567');
  assert.equal(parsed.searchParams.get('entry.777777777'), 'Estudiante UTA');
  assert.equal(parsed.searchParams.get('entry.888888888'), 'Python desde cero');
  // Espacios y caracteres especiales quedan codificados en la URL serializada.
  assert.match(url, /Mar%C3%ADa/);
  assert.ok(profileHasPrefillData({ correo: 'a@b.c' }));
  assert.equal(profileHasPrefillData({}), false);
});

test('buildPrefilledUrl parte nombre_completo cuando faltan nombres/apellidos', async () => {
  setFormFieldsCache(FORM_URL, parseFormFields(SAMPLE_HTML));
  const url = await buildPrefilledUrl(FORM_URL, {
    nombre_completo: 'Ana Lucía Gómez Vera',
    tipo: 'publico',
  });
  const parsed = new URL(url);
  assert.equal(parsed.searchParams.get('entry.111111111'), 'Ana Lucía');
  assert.equal(parsed.searchParams.get('entry.222222222'), 'Gómez Vera');
  assert.equal(parsed.searchParams.get('entry.333333333'), 'Ana Lucía Gómez Vera');
  assert.equal(parsed.searchParams.get('entry.777777777'), 'Público general');
});

test('buildPrefilledUrl elige la opción de graduado más parecida', async () => {
  setFormFieldsCache(FORM_URL, parseFormFields(SAMPLE_HTML));
  const url = await buildPrefilledUrl(FORM_URL, { tipo: 'graduado_uta' });
  assert.equal(new URL(url).searchParams.get('entry.777777777'), 'Graduado / Docente / Administrativo');
});

test('buildPrefilledUrl hace fallback a la URL original sin mapeo o sin campos', async () => {
  assert.equal(await buildPrefilledUrl(FORM_URL, { nombres: 'Ana' }), FORM_URL);

  setFormFieldsCache(FORM_URL, []);
  assert.equal(await buildPrefilledUrl(FORM_URL, { nombres: 'Ana' }), FORM_URL);

  setFormFieldsCache(FORM_URL, parseFormFields(SAMPLE_HTML));
  assert.equal(await buildPrefilledUrl(FORM_URL, {}), FORM_URL);
});

test('buildPrefilledUrl solo incluye campos con valor', async () => {
  setFormFieldsCache(FORM_URL, parseFormFields(SAMPLE_HTML));
  const url = await buildPrefilledUrl(FORM_URL, { correo: 'solo@uta.edu.ec' });
  const parsed = new URL(url);
  assert.equal(parsed.searchParams.get('entry.555555555'), 'solo@uta.edu.ec');
  assert.equal(parsed.searchParams.get('entry.111111111'), null);
  assert.equal(parsed.searchParams.get('entry.777777777'), null);
});
