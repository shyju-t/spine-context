#!/usr/bin/env bash
# Deploy Spine to Google Cloud Run.
#
# Prereqs (do these once):
#   1. gcloud CLI installed and `gcloud auth login` done
#   2. A GCP project with billing enabled, set as default:
#        gcloud config set project YOUR_PROJECT_ID
#   3. Cloud Run + Cloud Build APIs enabled (the script tries to enable
#      them, but if your account lacks the role, do it via the console)
#   4. .env.local in the repo root with PIONEER_API_KEY and (optionally)
#      GOOGLE_GENERATIVE_AI_API_KEY — these are passed to the running
#      service via --set-env-vars at deploy time, NOT baked into the image.
#
# Usage:
#   ./deploy.sh                       # uses defaults
#   ./deploy.sh --region us-central1  # override region
#   ./deploy.sh --service my-spine    # override service name
#
# What it does:
#   1. gcloud builds submit  — Cloud Build builds the Dockerfile in
#      Google's amd64 environment (avoids Apple Silicon native-binding
#      drama with kuzu)
#   2. gcloud run deploy     — pushes the built image to Cloud Run with
#      the right flags (1 instance max, 8GiB RAM, 5min timeout, env
#      vars for API keys)
#
# After the script finishes it prints the live URL. Open it in a
# browser; that's your demo.

set -euo pipefail

# ───────── defaults you can override via flags ─────────
SERVICE="spine"
REGION="us-central1"
MEMORY="2Gi"
TIMEOUT="300s"   # 5min — covers slow first request after cold start
MIN_INSTANCES=0  # 1 if you want hot, costs ~$5/month
MAX_INSTANCES=1  # Kuzu single-writer; never scale beyond 1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --service) SERVICE="$2"; shift 2 ;;
    --region) REGION="$2"; shift 2 ;;
    --memory) MEMORY="$2"; shift 2 ;;
    --min-instances) MIN_INSTANCES="$2"; shift 2 ;;
    --max-instances) MAX_INSTANCES="$2"; shift 2 ;;
    *) echo "Unknown flag: $1" >&2; exit 1 ;;
  esac
done

# ───────── preflight ─────────

PROJECT_ID="$(gcloud config get-value project 2>/dev/null || true)"
if [[ -z "$PROJECT_ID" || "$PROJECT_ID" == "(unset)" ]]; then
  echo "ERROR: No GCP project set. Run:" >&2
  echo "  gcloud config set project YOUR_PROJECT_ID" >&2
  exit 1
fi

ACCOUNT="$(gcloud config get-value account 2>/dev/null || true)"
if [[ -z "$ACCOUNT" || "$ACCOUNT" == "(unset)" ]]; then
  echo "ERROR: gcloud not authenticated. Run:" >&2
  echo "  gcloud auth login" >&2
  exit 1
fi

if [[ ! -f .env.local ]]; then
  echo "WARN: no .env.local in this directory — the deployed service will boot without API keys." >&2
  echo "      Press ctrl-C to abort, or any key to continue without keys."
  read -r
fi

if [[ ! -d data/spine.db ]]; then
  echo "ERROR: data/spine.db/ does not exist. Did you run ingest + extract?" >&2
  exit 1
fi

echo "──────────────────────────────────────────────────────────"
echo " Spine — Cloud Run deploy"
echo "──────────────────────────────────────────────────────────"
echo "  project:        $PROJECT_ID"
echo "  account:        $ACCOUNT"
echo "  service:        $SERVICE"
echo "  region:         $REGION"
echo "  memory:         $MEMORY"
echo "  min-instances:  $MIN_INSTANCES"
echo "  max-instances:  $MAX_INSTANCES (Kuzu is single-writer; do not raise)"
echo
echo " DB size: $(du -sh data/spine.db 2>/dev/null | cut -f1)"
echo "──────────────────────────────────────────────────────────"
echo "  Press enter to start, ctrl-C to abort."
read -r

# ───────── enable required services (idempotent) ─────────
echo
echo "[1/3] enabling required Google APIs (idempotent)…"
gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com

# ───────── build via Cloud Build ─────────
IMAGE="gcr.io/${PROJECT_ID}/${SERVICE}:$(date +%Y%m%d-%H%M%S)"
echo
echo "[2/3] building image via Cloud Build → ${IMAGE}"
echo "       (this runs Docker in GCP's amd64 environment so the kuzu"
echo "        native binding lands correctly)"
gcloud builds submit . --tag "$IMAGE"

# ───────── collect env vars from .env.local ─────────
ENV_VARS=""
if [[ -f .env.local ]]; then
  # Only pull the keys we actually need at runtime. Skip blank values.
  for key in PIONEER_API_KEY GOOGLE_GENERATIVE_AI_API_KEY GOOGLE_API_KEY; do
    val="$(grep -E "^${key}=" .env.local | head -1 | cut -d= -f2- || true)"
    if [[ -n "$val" ]]; then
      # Strip surrounding quotes if present.
      val="${val%\"}"; val="${val#\"}"
      val="${val%\'}"; val="${val#\'}"
      ENV_VARS+="${key}=${val},"
    fi
  done
  ENV_VARS="${ENV_VARS%,}"
fi

# ───────── deploy ─────────
echo
echo "[3/3] deploying to Cloud Run…"

DEPLOY_FLAGS=(
  --image "$IMAGE"
  --region "$REGION"
  --platform managed
  --allow-unauthenticated
  --port 8080
  --memory "$MEMORY"
  --timeout "$TIMEOUT"
  --min-instances "$MIN_INSTANCES"
  --max-instances "$MAX_INSTANCES"
  --concurrency 80
)

if [[ -n "$ENV_VARS" ]]; then
  DEPLOY_FLAGS+=(--set-env-vars "$ENV_VARS")
fi

gcloud run deploy "$SERVICE" "${DEPLOY_FLAGS[@]}"

# ───────── done ─────────
URL="$(gcloud run services describe "$SERVICE" --region "$REGION" --format='value(status.url)')"
echo
echo "──────────────────────────────────────────────────────────"
echo " ✓ Deployed: $URL"
echo "──────────────────────────────────────────────────────────"
echo "  Inspector:    $URL"
echo "  REST API:     $URL/api/health"
echo "  MCP endpoint: $URL/mcp"
echo
echo "  For Claude Desktop, use this in claude_desktop_config.json:"
echo
echo "    \"spine\": {"
echo "      \"command\": \"npx\","
echo "      \"args\": [\"-y\", \"mcp-remote\", \"$URL/mcp\"]"
echo "    }"
echo
