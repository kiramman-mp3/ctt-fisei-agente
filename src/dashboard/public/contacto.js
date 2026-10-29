/**
 * Landing pública de contacto con QR para Telegram y WhatsApp.
 * Generador QR mínimo propio (modo byte, ECC M, versiones 1–10). Sin dependencias.
 */

// TODO: sustituir por el @usuario real del bot de Telegram (no está fijado en el repo).
const TELEGRAM_BOT = '';
// TODO: sustituir por el número internacional sin + ni espacios (ej. 593999999999).
const WHATSAPP_NUMBER = '';

const WEB_OFICIAL = 'https://ctt-talleresfisei.uta.edu.ec/';
const OFERTABLES = (reg) => reg === 'próxima' || (typeof reg === 'string' && reg.startsWith('abierta'));

/* ---------- Generador QR (ISO/IEC 18004, subconjunto mínimo) ---------- */

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

const gfMul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);

/** Capacidad de datos (codewords) por versión con ECC nivel M (v1–6 basta para URLs). */
const DATA_CW_M = [0, 16, 28, 44, 64, 86, 108];
/** [codewords EC por bloque, nº de bloques] — ECC M. */
const EC_M = [null, [10, 1], [16, 1], [26, 1], [18, 2], [24, 2], [16, 4]];

const ALIGN_POS = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34]];

function rsGenerator(ecLen) {
  let poly = [1];
  for (let i = 0; i < ecLen; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly;
}

function rsEncode(data, ecLen) {
  const gen = rsGenerator(ecLen);
  const res = data.concat(new Array(ecLen).fill(0));
  for (let i = 0; i < data.length; i++) {
    const factor = res[i];
    if (!factor) continue;
    for (let j = 0; j < gen.length; j++) res[i + j] ^= gfMul(gen[j], factor);
  }
  return res.slice(data.length);
}

function chooseVersion(byteLen) {
  const need = byteLen + 3; // modo + longitud + terminador, en codewords
  for (let v = 1; v <= 6; v++) {
    if (DATA_CW_M[v] >= need) return v;
  }
  throw new Error('Texto demasiado largo para el QR (máx. ~100 caracteres)');
}

function encodeData(text, version) {
  const bytes = [...new TextEncoder().encode(text)];
  const capacity = DATA_CW_M[version];
  const bits = [];
  const push = (val, len) => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1);
  };

  push(0b0100, 4); // modo byte
  push(bytes.length, version >= 10 ? 16 : 8);
  for (const b of bytes) push(b, 8);
  const maxBits = capacity * 8;
  const term = Math.min(4, maxBits - bits.length);
  push(0, term);
  while (bits.length % 8) bits.push(0);

  const codewords = [];
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
    codewords.push(b);
  }
  const pad = [0xec, 0x11];
  let p = 0;
  while (codewords.length < capacity) codewords.push(pad[p++ % 2]);
  return codewords;
}

function interleave(version, data) {
  const [ecLen, nBlocks] = EC_M[version];
  const totalData = DATA_CW_M[version];
  const shortBlocks = nBlocks - (totalData % nBlocks);
  const shortLen = Math.floor(totalData / nBlocks);
  const blocks = [];
  let offset = 0;
  for (let i = 0; i < nBlocks; i++) {
    const len = shortLen + (i < shortBlocks ? 0 : 1);
    const block = data.slice(offset, offset + len);
    offset += len;
    blocks.push({ data: block, ec: rsEncode(block, ecLen) });
  }
  const out = [];
  const maxData = Math.max(...blocks.map((b) => b.data.length));
  for (let i = 0; i < maxData; i++) {
    for (const b of blocks) if (i < b.data.length) out.push(b.data[i]);
  }
  for (let i = 0; i < ecLen; i++) {
    for (const b of blocks) out.push(b.ec[i]);
  }
  return out;
}

function moduleSize(version) {
  return 21 + (version - 1) * 4;
}

function makeMatrix(version) {
  const n = moduleSize(version);
  const m = Array.from({ length: n }, () => Array(n).fill(null));
  const reserved = Array.from({ length: n }, () => Array(n).fill(false));

  const set = (r, c, v, res = true) => {
    if (r < 0 || c < 0 || r >= n || c >= n) return;
    m[r][c] = v;
    if (res) reserved[r][c] = true;
  };

  const finder = (r0, c0) => {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const rr = r0 + r;
        const cc = c0 + c;
        if (rr < 0 || cc < 0 || rr >= n || cc >= n) continue;
        const on =
          r >= 0 && r <= 6 && c >= 0 && c <= 6 && (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4));
        set(rr, cc, on);
      }
    }
  };

  finder(0, 0);
  finder(0, n - 7);
  finder(n - 7, 0);

  for (let i = 8; i < n - 8; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }

  const positions = ALIGN_POS[version];
  for (const r of positions) {
    for (const c of positions) {
      if (m[r][c] !== null) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const ring = Math.max(Math.abs(dr), Math.abs(dc));
          set(r + dr, c + dc, ring === 0 || ring === 2);
        }
      }
    }
  }

  // Zona de formato (reservada en blanco; se rellena después).
  for (let i = 0; i < 9; i++) {
    set(8, i, false);
    set(i, 8, false);
    set(8, n - 1 - i, false);
    set(n - 1 - i, 8, false);
  }
  set(n - 8, 8, true); // dark module

  if (version >= 7) {
    for (let i = 0; i < 6; i++) {
      for (let j = 0; j < 3; j++) {
        set(i, n - 11 + j, false);
        set(n - 11 + j, i, false);
      }
    }
  }

  return { m, reserved, n };
}

function placeData(matrix, reserved, data) {
  const n = matrix.length;
  let bit = 0;
  const bits = [];
  for (const b of data) for (let i = 7; i >= 0; i--) bits.push((b >>> i) & 1);

  let upward = true;
  for (let col = n - 1; col > 0; col -= 2) {
    if (col === 6) col--;
    for (let i = 0; i < n; i++) {
      const row = upward ? n - 1 - i : i;
      for (let c = 0; c < 2; c++) {
        const cc = col - c;
        if (reserved[row][cc]) continue;
        matrix[row][cc] = bit < bits.length ? bits[bit++] === 1 : false;
      }
    }
    upward = !upward;
  }
}

function maskFn(id) {
  return [
    (r, c) => (r + c) % 2 === 0,
    (r) => r % 2 === 0,
    (r, c) => c % 3 === 0,
    (r, c) => (r + c) % 3 === 0,
    (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
    (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
    (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
    (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
  ][id];
}

function applyMask(matrix, reserved, id) {
  const n = matrix.length;
  const out = matrix.map((row) => row.slice());
  const mask = maskFn(id);
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (!reserved[r][c] && mask(r, c)) out[r][c] = !out[r][c];
    }
  }
  return out;
}

function formatBits(maskId) {
  // ECC M = 00
  let data = (0b00 << 3) | maskId;
  let d = data << 10;
  const gen = 0b10100110111;
  for (let i = 14; i >= 10; i--) {
    if ((d >>> i) & 1) d ^= gen << (i - 10);
  }
  return ((data << 10) | d) ^ 0b101010000010010;
}

function drawFormat(matrix, maskId) {
  const n = matrix.length;
  const bits = formatBits(maskId);
  const coords = [
    // horizontal junto al finder izquierdo / vertical
    [
      [8, 0],
      [8, 1],
      [8, 2],
      [8, 3],
      [8, 4],
      [8, 5],
      [8, 7],
      [8, 8],
      [7, 8],
      [5, 8],
      [4, 8],
      [3, 8],
      [2, 8],
      [1, 8],
      [0, 8],
    ],
    // espejo
    [
      [n - 1, 8],
      [n - 2, 8],
      [n - 3, 8],
      [n - 4, 8],
      [n - 5, 8],
      [n - 6, 8],
      [n - 7, 8],
      [8, n - 8],
      [8, n - 7],
      [8, n - 6],
      [8, n - 5],
      [8, n - 4],
      [8, n - 3],
      [8, n - 2],
      [8, n - 1],
    ],
  ];
  for (const group of coords) {
    for (let i = 0; i < 15; i++) {
      const [r, c] = group[i];
      matrix[r][c] = ((bits >>> (14 - i)) & 1) === 1;
    }
  }
  matrix[n - 8][8] = true;
}

function versionBits(version) {
  let d = version << 12;
  const gen = 0b1111100100101;
  for (let i = 17; i >= 12; i--) {
    if ((d >>> i) & 1) d ^= gen << (i - 12);
  }
  return (version << 12) | d;
}

function drawVersion(matrix, version) {
  if (version < 7) return;
  const n = matrix.length;
  const bits = versionBits(version);
  let k = 0;
  for (let i = 0; i < 6; i++) {
    for (let j = 0; j < 3; j++) {
      const bit = ((bits >>> k) & 1) === 1;
      matrix[i][n - 11 + j] = bit;
      matrix[n - 11 + j][i] = bit;
      k++;
    }
  }
}

function penalty(matrix) {
  const n = matrix.length;
  let score = 0;

  for (let r = 0; r < n; r++) {
    let run = 1;
    for (let c = 1; c < n; c++) {
      if (matrix[r][c] === matrix[r][c - 1]) {
        run++;
        if (run === 5) score += 3;
        else if (run > 5) score += 1;
      } else run = 1;
    }
  }
  for (let c = 0; c < n; c++) {
    let run = 1;
    for (let r = 1; r < n; r++) {
      if (matrix[r][c] === matrix[r - 1][c]) {
        run++;
        if (run === 5) score += 3;
        else if (run > 5) score += 1;
      } else run = 1;
    }
  }

  for (let r = 0; r < n - 1; r++) {
    for (let c = 0; c < n - 1; c++) {
      const v = matrix[r][c];
      if (v === matrix[r][c + 1] && v === matrix[r + 1][c] && v === matrix[r + 1][c + 1]) score += 3;
    }
  }

  const pattern = (row) => {
    let s = 0;
    const str = row.map((b) => (b ? '1' : '0')).join('');
    const re = /10111010000|00001011101/g;
    let m;
    while ((m = re.exec(str))) {
      s += 40;
      re.lastIndex = m.index + 1;
    }
    return s;
  };
  for (let r = 0; r < n; r++) score += pattern(matrix[r]);
  for (let c = 0; c < n; c++) score += pattern(matrix.map((row) => row[c]));

  let dark = 0;
  for (const row of matrix) for (const cell of row) if (cell) dark++;
  const pct = (dark * 100) / (n * n);
  score += Math.floor(Math.abs(pct - 50) / 5) * 10;
  return score;
}

function buildQr(text) {
  const version = chooseVersion(new TextEncoder().encode(text).length);
  const data = interleave(version, encodeData(text, version));
  const { m, reserved, n } = makeMatrix(version);
  placeData(m, reserved, data);

  let best = null;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const masked = applyMask(m, reserved, mask);
    drawFormat(masked, mask);
    drawVersion(masked, version);
    const score = penalty(masked);
    if (score < bestScore) {
      bestScore = score;
      best = masked;
    }
  }
  return { modules: best, size: n };
}

function drawQr(canvas, text) {
  const { modules, size } = buildQr(text);
  const quiet = 2;
  const total = size + quiet * 2;
  const scale = Math.max(4, Math.floor(220 / total));
  const px = total * scale;
  canvas.width = px;
  canvas.height = px;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, px, px);
  ctx.fillStyle = '#012e5a';
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (!modules[r][c]) continue;
      ctx.fillRect((c + quiet) * scale, (r + quiet) * scale, scale, scale);
    }
  }
}

/* ---------- Página ---------- */

function setupCanal({ botOrNumber, kind, canvasId, linkId, todoId, buildUrl, labelReady, labelTodo }) {
  const canvas = document.getElementById(canvasId);
  const link = document.getElementById(linkId);
  const todo = document.getElementById(todoId);
  const value = (botOrNumber || '').trim();

  if (!value) {
    todo.hidden = false;
    todo.textContent = labelTodo;
    link.setAttribute('aria-disabled', 'true');
    link.href = '#';
    link.removeAttribute('target');
    // QR de marcador con TODO visible para que el equipo configure el valor.
    drawQr(canvas, `TODO:${kind}`);
    return;
  }

  const url = buildUrl(value);
  drawQr(canvas, url);
  link.href = url;
  link.textContent = labelReady;
  link.setAttribute('aria-disabled', 'false');
}

async function loadCursos() {
  const box = document.getElementById('cursos-lista');
  try {
    const res = await fetch('/api/courses', { credentials: 'same-origin' });
    if (res.status === 401 || res.status === 403) {
      box.innerHTML = `
        <div class="fallback">
          <p>El listado de cursos del panel requiere autenticación.</p>
          <p>Consulta la oferta vigente en la
            <a href="${WEB_OFICIAL}" target="_blank" rel="noopener">web oficial del CTT-FISEI</a>.
          </p>
        </div>`;
      return;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const courses = await res.json();
    const ofertables = courses.filter((c) => OFERTABLES(c.registration));
    if (!ofertables.length) {
      box.innerHTML = `
        <div class="fallback">
          <p>Ahora mismo no hay cursos con inscripción abierta en el catálogo cargado.</p>
          <p>Revisa la
            <a href="${WEB_OFICIAL}course.php" target="_blank" rel="noopener">oferta en la web del CTT</a>.
          </p>
        </div>`;
      return;
    }
    box.replaceChildren(
      ...ofertables.map((c) => {
        const item = document.createElement('article');
        item.className = 'curso-item';
        const title = document.createElement(c.url ? 'a' : 'span');
        if (c.url) {
          title.href = c.url;
          title.target = '_blank';
          title.rel = 'noopener';
        }
        title.textContent = c.name;
        const meta = document.createElement('p');
        meta.className = 'curso-meta';
        const pill = document.createElement('span');
        pill.className = `pill${c.registration === 'próxima' ? ' proxima' : ''}`;
        pill.textContent = c.registration === 'próxima' ? 'Próxima' : 'Abierta';
        meta.append(pill);
        const bits = [c.hours ? `${c.hours} h` : null, c.modality, c.courseDates].filter(Boolean);
        if (bits.length) meta.append(document.createTextNode(bits.join(' · ')));
        item.append(title, meta);
        return item;
      }),
    );
  } catch {
    box.innerHTML = `
      <div class="fallback">
        <p>No se pudo leer el catálogo desde el panel.</p>
        <p>Ve a la
          <a href="${WEB_OFICIAL}" target="_blank" rel="noopener">web oficial del CTT-FISEI</a>
          para ver los cursos.
        </p>
      </div>`;
  }
}

setupCanal({
  botOrNumber: TELEGRAM_BOT,
  kind: 'telegram',
  canvasId: 'qr-telegram',
  linkId: 'tg-link',
  todoId: 'tg-todo',
  buildUrl: (bot) => `https://t.me/${bot.replace(/^@/, '')}`,
  labelReady: 'Abrir en Telegram',
  labelTodo: 'TODO: configura TELEGRAM_BOT en contacto.js con el @usuario del bot (no aparece en el repo).',
});

setupCanal({
  botOrNumber: WHATSAPP_NUMBER,
  kind: 'whatsapp',
  canvasId: 'qr-whatsapp',
  linkId: 'wa-link',
  todoId: 'wa-todo',
  buildUrl: (num) => `https://wa.me/${num.replace(/\D/g, '')}`,
  labelReady: 'Abrir en WhatsApp',
  labelTodo: 'TODO: configura WHATSAPP_NUMBER en contacto.js con el número internacional (sin +).',
});

loadCursos();
