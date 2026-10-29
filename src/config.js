// Carga .env (si existe) y expone la configuración de la aplicación.
try {
  process.loadEnvFile();
} catch {
  // Sin archivo .env: se usan solo las variables del entorno.
}

const env = process.env;

export const config = {
  llm: {
    apiKey: env.LLM_API_KEY ?? '',
    baseURL: env.LLM_BASE_URL || 'https://api.groq.com/openai/v1',
    // Lista separada por comas: si un modelo responde 429 (límite de tokens) se usa el siguiente.
    models: (env.LLM_MODEL || 'openai/gpt-oss-120b').split(',').map((m) => m.trim()).filter(Boolean),
    analyzerModels: (env.LLM_ANALYZER_MODEL || env.LLM_MODEL || 'openai/gpt-oss-20b').split(',').map((m) => m.trim()).filter(Boolean),
    reasoningEffort: env.LLM_REASONING_EFFORT || '',
  },
  stt: {
    apiKey: env.STT_API_KEY ?? '',
    baseURL: env.STT_BASE_URL || 'https://api.groq.com/openai/v1',
    model: env.STT_MODEL || 'whisper-large-v3-turbo',
  },
  handoverTimeoutMin: env.HANDOVER_TIMEOUT_MIN ? Number(env.HANDOVER_TIMEOUT_MIN) : 15,
  telegram: {
    token: env.TELEGRAM_BOT_TOKEN ?? '',
  },
  whatsapp: {
    enabled: env.WHATSAPP_ENABLED === 'true',
    chromePath: env.CHROME_PATH || undefined,
    dataPath: env.WWEBJS_DATA_PATH || '.wwebjs_auth',
    // Número que muestra la landing pública aunque la sesión esté desconectada (sin + ni espacios).
    publicNumber: (env.PUBLIC_WHATSAPP_NUMBER ?? '').replace(/\D/g, ''),
  },
  dashboard: {
    port: Number(env.PORT || env.DASHBOARD_PORT || 3000),
    user: env.DASHBOARD_USER || 'admin',
    password: env.DASHBOARD_PASSWORD ?? '',
  },
  dbPath: env.DB_PATH || 'data/agente.db',
  coursesRefreshHours: Number(env.COURSES_REFRESH_HOURS || 6),
  coursesUrl: 'https://ctt-talleresfisei.uta.edu.ec/',
};
