/**
 * Landing pública de contacto con QR para Telegram y WhatsApp.
 * El servidor entrega el bot, el número y los códigos QR ya generados (/api/public/contact),
 * así que la página no necesita configuración ni un generador de QR propio.
 */

const WEB_OFICIAL = 'https://ctt-talleresfisei.uta.edu.ec/';

function fallback(box, ...paragraphs) {
  const wrap = document.createElement('div');
  wrap.className = 'fallback';
  for (const parts of paragraphs) {
    const p = document.createElement('p');
    p.append(...parts);
    wrap.append(p);
  }
  box.replaceChildren(wrap);
}

function officialLink(text, path = '') {
  const a = document.createElement('a');
  a.href = `${WEB_OFICIAL}${path}`;
  a.target = '_blank';
  a.rel = 'noopener';
  a.textContent = text;
  return a;
}

function setupCanal(channel, data, { qrId, linkId, todoId, unavailable }) {
  const img = document.getElementById(qrId);
  const link = document.getElementById(linkId);
  const note = document.getElementById(todoId);

  if (!data) {
    note.hidden = false;
    note.textContent = unavailable;
    link.setAttribute('aria-disabled', 'true');
    link.removeAttribute('href');
    return;
  }
  img.src = data.qr;
  img.hidden = false;
  link.href = data.url;
  link.setAttribute('aria-disabled', 'false');
  if (channel === 'whatsapp' && data.online === false) {
    note.hidden = false;
    note.textContent = 'El asistente de WhatsApp está reconectándose; si no responde enseguida, usa Telegram.';
  }
}

async function loadContact() {
  const unavailable = {
    telegram: 'Telegram no está disponible en este momento. Escríbenos a talleresfisei@uta.edu.ec.',
    whatsapp: 'WhatsApp no está disponible en este momento. Usa Telegram o escríbenos a talleresfisei@uta.edu.ec.',
  };
  let data = { telegram: null, whatsapp: null };
  try {
    const res = await fetch('/api/public/contact');
    if (res.ok) data = await res.json();
  } catch {
    // Sin servidor se muestran los avisos de canal no disponible.
  }
  setupCanal('telegram', data.telegram, { qrId: 'qr-telegram', linkId: 'tg-link', todoId: 'tg-todo', unavailable: unavailable.telegram });
  setupCanal('whatsapp', data.whatsapp, { qrId: 'qr-whatsapp', linkId: 'wa-link', todoId: 'wa-todo', unavailable: unavailable.whatsapp });
}

async function loadCursos() {
  const box = document.getElementById('cursos-lista');
  try {
    const res = await fetch('/api/public/courses');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const ofertables = await res.json();
    if (!ofertables.length) {
      fallback(
        box,
        ['Ahora mismo no hay cursos con inscripción abierta.'],
        ['Revisa la ', officialLink('oferta en la web del CTT', 'course.php'), '.'],
      );
      return;
    }
    box.replaceChildren(
      ...ofertables.map((c) => {
        const item = document.createElement('article');
        item.className = 'curso-item';
        const title = document.createElement('a');
        title.href = c.url;
        title.target = '_blank';
        title.rel = 'noopener';
        title.textContent = c.name;
        const meta = document.createElement('p');
        meta.className = 'curso-meta';
        const pill = document.createElement('span');
        pill.className = `pill${c.registration === 'próxima' ? ' proxima' : ''}`;
        pill.textContent = c.registration === 'próxima' ? 'Inscripción por abrir' : 'Inscripción abierta';
        meta.append(pill);
        const bits = [c.hours ? `${c.hours} h` : null, c.modality, c.courseDates].filter(Boolean);
        if (bits.length) meta.append(document.createTextNode(bits.join(' · ')));
        item.append(title, meta);
        return item;
      }),
    );
  } catch {
    fallback(box, ['No se pudo cargar la oferta.'], ['Consulta los cursos en la ', officialLink('web oficial del CTT-FISEI'), '.']);
  }
}

loadContact();
loadCursos();
