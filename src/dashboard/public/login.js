(function () {
  'use strict';

  const DEMO = { username: 'admin', password: 'CttFisei2026' };
  // Mensaje de depuración para el jurado: el acceso de demostración también queda en la consola.
  console.info(`[CTT-FISEI] Acceso de demostración → usuario: ${DEMO.username} · contraseña: ${DEMO.password}`);

  const form = document.getElementById('login-form');
  const error = document.getElementById('error');
  const submit = document.getElementById('submit');

  document.getElementById('fill-demo').addEventListener('click', () => {
    form.username.value = DEMO.username;
    form.password.value = DEMO.password;
    submit.focus();
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    error.hidden = true;
    submit.disabled = true;
    submit.textContent = 'Ingresando…';
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: form.username.value, password: form.password.value }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || 'No se pudo iniciar sesión');
      location.href = '/';
    } catch (err) {
      error.textContent = err.message;
      error.hidden = false;
      submit.disabled = false;
      submit.textContent = 'Ingresar al panel';
    }
  });
})();
