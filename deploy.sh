#!/bin/bash
# Deploy the unified Anima MCP server to Cloud Run.
# Run from the mcp-server/ directory: ./deploy.sh [tag]
set -euo pipefail

PROJECT_ID="anima-labs"
REGION="us-central1"
REPO="anima"
TAG="${1:-latest}"
IMAGE="$REGION-docker.pkg.dev/$PROJECT_ID/$REPO/mcp-server:$TAG"

echo "=== Building $IMAGE ==="
docker build --platform=linux/amd64 -t "$IMAGE" -f Dockerfile .

echo "=== Pushing $IMAGE ==="
docker push "$IMAGE"

echo "=== Deploying mcp-server ==="
gcloud run deploy mcp-server \
  --image="$IMAGE" \
  --region="$REGION" \
  --project="$PROJECT_ID" \
  --platform=managed \
  --min-instances=1 \
  --max-instances=10 \
  --memory=512Mi \
  --cpu=1 \
  --port=8080 \
  --concurrency=80 \
  --allow-unauthenticated \
  --set-env-vars=NODE_ENV=production \
  --set-secrets=ANIMA_API_URL=API_URL:latest

echo "=== Done ==="
gcloud run services describe mcp-server --region="$REGION" --format="value(status.url)"
