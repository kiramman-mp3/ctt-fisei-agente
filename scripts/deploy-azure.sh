#!/usr/bin/env bash
# Despliega el agente en Azure App Service (contenedor Linux) con la imagen
# construida en Azure Container Registry. Es idempotente: volver a ejecutarlo
# reconstruye la imagen y reinicia la app con la versión actual del código.
#
# Requisitos: Azure CLI con sesión iniciada (az login) y un archivo .env con
# LLM_API_KEY y TELEGRAM_BOT_TOKEN. Los secretos van a la configuración de la
# app en Azure, nunca al repositorio.
set -euo pipefail
# En Git Bash (Windows) evita que rutas como /home/data se conviertan en C:/Program Files/Git/...
export MSYS_NO_PATHCONV=1

RG="${RG:-rg-ctt-fisei-agente}"
LOCATION="${LOCATION:-eastus2}"
ACR="${ACR:-cttfiseiagente}"
PLAN="${PLAN:-plan-ctt-fisei-agente}"
APP="${APP:-ctt-fisei-asistente}"
SKU="${SKU:-B2}"
IMAGE="ctt-fisei-agente:$(git rev-parse --short HEAD)"

# Lee una variable de .env sin ejecutar el archivo (los valores pueden tener espacios).
env_value() {
  grep -E "^$1=" .env 2>/dev/null | head -1 | cut -d= -f2-
}

for required in LLM_API_KEY TELEGRAM_BOT_TOKEN; do
  if [ -z "$(env_value "$required")" ]; then
    echo "Falta $required en .env" >&2
    exit 1
  fi
done

echo "==> Grupo de recursos $RG ($LOCATION)"
az group create -n "$RG" -l "$LOCATION" -o none

echo "==> Registro de contenedores $ACR"
if ! az acr show -n "$ACR" -g "$RG" -o none 2>/dev/null; then
  az acr create -n "$ACR" -g "$RG" -l "$LOCATION" --sku Basic --admin-enabled true -o none
fi

# Las suscripciones Azure for Students no permiten ACR Tasks (az acr build),
# así que la imagen se construye con Docker local y se sube al registro.
echo "==> Construyendo la imagen $IMAGE con Docker"
docker build --platform linux/amd64 -t "$ACR.azurecr.io/$IMAGE" -t "$ACR.azurecr.io/ctt-fisei-agente:latest" .
az acr login -n "$ACR"
docker push "$ACR.azurecr.io/$IMAGE"
docker push "$ACR.azurecr.io/ctt-fisei-agente:latest"

REGISTRY="https://$ACR.azurecr.io"
ACR_USER="$(az acr credential show -n "$ACR" --query username -o tsv)"
ACR_PASS="$(az acr credential show -n "$ACR" --query 'passwords[0].value' -o tsv)"

echo "==> Plan de App Service $PLAN ($SKU, Linux)"
if ! az appservice plan show -n "$PLAN" -g "$RG" -o none 2>/dev/null; then
  az appservice plan create -n "$PLAN" -g "$RG" -l "$LOCATION" --is-linux --sku "$SKU" -o none
else
  # B1 (1 núcleo) no alcanza para vincular WhatsApp Web: Chrome satura la CPU y el teléfono cancela.
  az appservice plan update -n "$PLAN" -g "$RG" --sku "$SKU" -o none
fi

echo "==> Web App $APP"
if ! az webapp show -n "$APP" -g "$RG" -o none 2>/dev/null; then
  az webapp create -n "$APP" -g "$RG" -p "$PLAN" \
    --container-image-name "$IMAGE" \
    --container-registry-url "$REGISTRY" \
    --container-registry-user "$ACR_USER" \
    --container-registry-password "$ACR_PASS" -o none
fi
az webapp config container set -n "$APP" -g "$RG" \
  --container-image-name "$ACR.azurecr.io/$IMAGE" \
  --container-registry-url "$REGISTRY" \
  --container-registry-user "$ACR_USER" \
  --container-registry-password "$ACR_PASS" -o none

# Siempre encendida: el bot de Telegram usa long polling y WhatsApp mantiene un navegador abierto.
az webapp config set -n "$APP" -g "$RG" --always-on true --http20-enabled true -o none

echo "==> Configuración de la app"
# /home es persistente en App Service (base SQLite). La sesión de WhatsApp va en disco
# local porque Chrome no puede guardar su perfil en el almacenamiento compartido.
az webapp config appsettings set -n "$APP" -g "$RG" -o none --settings \
  WEBSITES_PORT=3000 \
  WEBSITES_ENABLE_APP_SERVICE_STORAGE=true \
  WEBSITES_CONTAINER_START_TIME_LIMIT=600 \
  DB_PATH=/home/data/agente.db \
  SQLITE_JOURNAL=DELETE \
  WWEBJS_DATA_PATH=/tmp/wwebjs \
  LLM_API_KEY="$(env_value LLM_API_KEY)" \
  LLM_BASE_URL="$(env_value LLM_BASE_URL)" \
  LLM_MODEL="$(env_value LLM_MODEL)" \
  LLM_ANALYZER_MODEL="$(env_value LLM_ANALYZER_MODEL)" \
  LLM_REASONING_EFFORT="$(env_value LLM_REASONING_EFFORT)" \
  STT_API_KEY="$(env_value STT_API_KEY)" \
  STT_BASE_URL="$(env_value STT_BASE_URL)" \
  STT_MODEL="$(env_value STT_MODEL)" \
  TELEGRAM_BOT_TOKEN="$(env_value TELEGRAM_BOT_TOKEN)" \
  HANDOVER_TIMEOUT_MIN="$(env_value HANDOVER_TIMEOUT_MIN)" \
  PUBLIC_WHATSAPP_NUMBER="$(env_value PUBLIC_WHATSAPP_NUMBER)" \
  WHATSAPP_ENABLED=false

# El acceso al panel ahora vive en la base de datos (tabla operators); se limpian las variables antiguas.
az webapp config appsettings delete -n "$APP" -g "$RG" --setting-names DASHBOARD_USER DASHBOARD_PASSWORD -o none

az webapp restart -n "$APP" -g "$RG" -o none

echo
echo "Listo: https://$APP.azurewebsites.net"
echo "Acceso al panel: usuario admin, contraseña CttFisei2026 (cámbiala con npm run operator)"
