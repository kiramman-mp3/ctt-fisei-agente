import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/db/store.js';
import { createDashboard } from '../src/dashboard/server.js';
import { setCoursesForTest } from '../src/scraper/courses.js';

test('la landing de contacto es pública y el panel sigue protegido', async () => {
  setCoursesForTest([
    { id: 1, status: 'abierto', name: 'Curso abierto', url: 'https://x/1', details: { 'Fechas de inscripciones': 'Del 01 de enero de 2020 al 31 de diciembre de 2099' } },
    { id: 2, status: 'cerrado', name: 'Curso cerrado', url: 'https://x/2' },
  ]);
  const store = new Store(':memory:');
  const app = createDashboard({
    store,
    service: {},
    auth: { user: 'admin', password: 'secreto' },
    telegramInfo: () => ({ username: 'CttBot' }),
    publicWhatsAppNumber: '593900000000',
  });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(`${base}/contacto.html`)).status, 200);
    assert.equal((await fetch(`${base}/contacto.js`)).status, 200);
    assert.equal((await fetch(`${base}/index.html`)).status, 401);
    assert.equal((await fetch(`${base}/api/inbox`)).status, 401);

    const courses = await (await fetch(`${base}/api/public/courses`)).json();
    assert.deepEqual(courses.map((c) => c.id), [1]);

    const contact = await (await fetch(`${base}/api/public/contact`)).json();
    assert.equal(contact.telegram.url, 'https://t.me/CttBot');
    assert.equal(contact.whatsapp.url, 'https://wa.me/593900000000');
    assert.match(contact.telegram.qr, /^data:image\/png;base64,/);
  } finally {
    server.close();
    store.close();
  }
});
