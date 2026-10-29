import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/db/store.js';
import { createDashboard } from '../src/dashboard/server.js';
import { setCoursesForTest } from '../src/scraper/courses.js';
import { DEMO_OPERATOR, hashPassword, verifyPassword } from '../src/auth/operators.js';

function startServer() {
  setCoursesForTest([
    { id: 1, status: 'abierto', name: 'Curso abierto', url: 'https://x/1', details: { 'Fechas de inscripciones': 'Del 01 de enero de 2020 al 31 de diciembre de 2099' } },
    { id: 2, status: 'cerrado', name: 'Curso cerrado', url: 'https://x/2' },
  ]);
  const store = new Store(':memory:');
  const app = createDashboard({
    store,
    service: {},
    telegramInfo: () => ({ username: 'CttBot' }),
    publicWhatsAppNumber: '593900000000',
  });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  return { store, server, base };
}

test('las contraseñas se guardan con hash y se verifican', () => {
  const hash = hashPassword('secreto');
  assert.match(hash, /^scrypt\$/);
  assert.equal(verifyPassword('secreto', hash), true);
  assert.equal(verifyPassword('otra', hash), false);
});

test('la landing y el login son públicos; el panel pide sesión', async () => {
  const { store, server, base } = startServer();
  try {
    assert.equal((await fetch(`${base}/contacto.html`)).status, 200);
    assert.equal((await fetch(`${base}/login.html`)).status, 200);
    const panel = await fetch(`${base}/`, { redirect: 'manual' });
    assert.equal(panel.status, 302);
    assert.equal(panel.headers.get('location'), '/login.html');
    assert.equal((await fetch(`${base}/api/inbox`)).status, 401);

    const courses = await (await fetch(`${base}/api/public/courses`)).json();
    assert.deepEqual(courses.map((c) => c.id), [1]);
    const contact = await (await fetch(`${base}/api/public/contact`)).json();
    assert.equal(contact.telegram.url, 'https://t.me/CttBot');
    assert.equal(contact.whatsapp.url, 'https://wa.me/593900000000');
  } finally {
    server.close();
    store.close();
  }
});

test('el operador de demostración inicia sesión y accede al panel', async () => {
  const { store, server, base } = startServer();
  const login = (body) =>
    fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    assert.equal((await login({ username: 'admin', password: 'mala' })).status, 401);

    const ok = await login(DEMO_OPERATOR);
    assert.equal(ok.status, 200);
    const cookie = ok.headers.get('set-cookie').split(';')[0];
    assert.match(cookie, /^ctt_session=[0-9a-f]{64}$/);

    const me = await (await fetch(`${base}/api/auth/me`, { headers: { cookie } })).json();
    assert.equal(me.username, 'admin');
    assert.equal((await fetch(`${base}/api/inbox`, { headers: { cookie } })).status, 200);

    await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: { cookie } });
    assert.equal((await fetch(`${base}/api/inbox`, { headers: { cookie } })).status, 401);
  } finally {
    server.close();
    store.close();
  }
});
