#!/bin/bash
# Decommission the pre-consolidation MCP infrastructure.
#
# Deletes, in order:
#   1. 6 old Cloud Run services (mcp-agent, mcp-cards, mcp-email, mcp-phone, mcp-platform, mcp-vault)
#   2. Old Artifact Registry images for those services (NOT the 'anima' registry itself — other services live there)
#   3. 7 old GitHub repos (the 6 above + mcp-core)
#   4. Local checkouts at /Users/diyanbogdanov/projects/agenticmail/{mcp-agent,mcp-cards,...,mcp-core,mcp-deploy}
#
# DO NOT run this until you've confirmed:
#   - https://mcp.useanima.sh/mcp serves all 191 tools with your API key
#   - Claude Cowork reconnects successfully via that URL
#   - No other SDKs/integrations still rely on the direct mcp-*-v7ar7whcsq-uc.a.run.app URLs
#
# Rollback: the 7 repos were tagged `pre-consolidation` during Task 0 (prior
# to any of this destructive work). If you need to restore them after
# deletion, that tag is GONE with the repo — not recoverable. If you want a
# forever-archive, run `git bundle create <repo>-archive.bundle --all` in
# each repo first.

set -euo pipefail

PROJECT_ID="anima-labs"
REGION="us-central1"
REGISTRY="us-central1-docker.pkg.dev/anima-labs/anima"
OLD_SERVICES=(mcp-agent mcp-cards mcp-email mcp-phone mcp-platform mcp-vault)
OLD_REPOS=(mcp-agent mcp-cards mcp-email mcp-phone mcp-platform mcp-vault mcp-core)
PARENT_DIR="/Users/diyanbogdanov/projects/agenticmail"
LOCAL_DIRS=(mcp-agent mcp-cards mcp-email mcp-phone mcp-platform mcp-vault mcp-core mcp-deploy)

confirm() {
  read -r -p "Proceed? [y/N] " response
  [[ "$response" =~ ^[Yy]$ ]] || { echo "Aborted."; exit 1; }
}

echo "════════════════════════════════════════════════════════════════"
echo "  Anima MCP Decommission Script"
echo "════════════════════════════════════════════════════════════════"
echo
echo "This will permanently delete:"
echo "  • Cloud Run services: ${OLD_SERVICES[*]}"
echo "  • Artifact Registry images for the above (cache repos too)"
echo "  • GitHub repos: anima-labs-ai/{${OLD_REPOS[*]// /,}}"
echo "  • Local directories: ${LOCAL_DIRS[*]}"
echo
echo "Prerequisite verified?"
echo "  [ ] https://mcp.useanima.sh/mcp serves 191 tools with API key"
echo "  [ ] Claude Cowork reconnects and List_Agents succeeds"
echo "  [ ] No remaining production dependency on mcp-*-v7ar7whcsq-uc.a.run.app URLs"
echo
confirm

echo
echo "── Step 1: Delete Cloud Run services ──────────────────────────"
for svc in "${OLD_SERVICES[@]}"; do
  if gcloud run services describe "$svc" --region="$REGION" --project="$PROJECT_ID" >/dev/null 2>&1; then
    echo "Deleting Cloud Run service: $svc"
    gcloud run services delete "$svc" --region="$REGION" --project="$PROJECT_ID" --quiet
  else
    echo "  (skip) $svc — already gone"
  fi
done

echo
echo "── Step 2: Delete Artifact Registry images ────────────────────"
for svc in "${OLD_SERVICES[@]}"; do
  echo "Purging images for: $svc"
  gcloud artifacts docker images list "$REGISTRY/$svc" \
    --format="value(IMAGE)" 2>/dev/null | while read -r img; do
    [ -n "$img" ] && gcloud artifacts docker images delete "$img" --delete-tags --quiet 2>/dev/null || true
  done
  # Cache repos (one per service)
  gcloud artifacts docker images list "$REGISTRY/$svc-cache" \
    --format="value(IMAGE)" 2>/dev/null | while read -r img; do
    [ -n "$img" ] && gcloud artifacts docker images delete "$img" --delete-tags --quiet 2>/dev/null || true
  done
done

echo
echo "── Step 3: Delete GitHub repos ────────────────────────────────"
echo "About to delete 7 GitHub repos. This is IRREVERSIBLE."
confirm
for repo in "${OLD_REPOS[@]}"; do
  if gh repo view "anima-labs-ai/$repo" >/dev/null 2>&1; then
    echo "Deleting anima-labs-ai/$repo"
    gh repo delete "anima-labs-ai/$repo" --yes
  else
    echo "  (skip) $repo — already gone or inaccessible"
  fi
done

echo
echo "── Step 4: Remove local checkouts ─────────────────────────────"
for d in "${LOCAL_DIRS[@]}"; do
  if [ -d "$PARENT_DIR/$d" ]; then
    # Detect uncommitted work before deleting, except for mcp-deploy
    # which is not a git repo.
    if [ -d "$PARENT_DIR/$d/.git" ] && [ -n "$(cd "$PARENT_DIR/$d" && git status --short 2>/dev/null)" ]; then
      echo "  ⚠ $d has uncommitted changes — skipping delete. Resolve manually."
      continue
    fi
    echo "Removing: $PARENT_DIR/$d"
    rm -rf "$PARENT_DIR/$d"
  else
    echo "  (skip) $d — already gone"
  fi
done

echo
echo "════════════════════════════════════════════════════════════════"
echo "  Decommission complete."
echo "════════════════════════════════════════════════════════════════"
echo
echo "Post-checks:"
echo "  • gcloud run services list --filter='name~mcp'     (should show only mcp-server)"
echo "  • gh repo list anima-labs-ai | grep '^mcp-'         (should be empty)"
echo "  • ls $PARENT_DIR | grep '^mcp-'                     (should show only mcp-server, mcp, mcp-dxt)"
