#!/usr/bin/env bash
# Deploy the bot to the VPS from your machine (WSL/macOS/Linux). Run from the repo root.
# Usage: bash deploy/deploy.sh --key ./bot-uk-key.pem [--host H] [--user U] [--env-file .env]
#                              [--kalshi-pem path] [--dry-run] [--skip-tests]
set -euo pipefail

KEY=""; HOST="ec2-51-24-240-139.eu-west-2.compute.amazonaws.com"; USER_NAME="ubuntu"
ENV_FILE=".env"; KALSHI_PEM=""; DRY=0; SKIP_TESTS=0

while [ $# -gt 0 ]; do
  case "$1" in
    --key) KEY="$2"; shift 2;;
    --host) HOST="$2"; shift 2;;
    --user) USER_NAME="$2"; shift 2;;
    --env-file) ENV_FILE="$2"; shift 2;;
    --kalshi-pem) KALSHI_PEM="$2"; shift 2;;
    --dry-run) DRY=1; shift;;
    --skip-tests) SKIP_TESTS=1; shift;;
    -h|--help) sed -n 2,5p "$0"; exit 0;;
    *) echo "unknown option: $1" >&2; exit 2;;
  esac
done

if [ -z "$KEY" ]; then
  [ -f ./bot-uk-key.pem ] && KEY=./bot-uk-key.pem
fi
if [ -z "$KEY" ]; then
  if [ "$DRY" = 1 ]; then KEY=./bot-uk-key.pem; else read -r -p "Path to SSH key (bot-uk-key.pem): " KEY; fi
fi
[ -f package.json ] && [ -d deploy ] || { echo "run from the repo root" >&2; exit 1; }
if [ "$DRY" = 0 ]; then
  [ -f "$KEY" ] || { echo "key not found: $KEY" >&2; exit 1; }
  [ -f "$ENV_FILE" ] || echo "WARNING: $ENV_FILE not found; the VPS will use .env.example (no Kalshi keys)" >&2
  [ -z "$KALSHI_PEM" ] || [ -f "$KALSHI_PEM" ] || { echo "kalshi pem not found: $KALSHI_PEM" >&2; exit 1; }
fi

SSH_OPTS=(-i "$KEY" -o StrictHostKeyChecking=accept-new -o ServerAliveInterval=30)
TARGET="$USER_NAME@$HOST"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
ARCHIVE="$TMP/btcarb.tar.gz"

# Print a command (shell-quoted), run it unless --dry-run.
run() { printf '+'; printf ' %q' "$@"; printf '\n'; [ "$DRY" = 1 ] || "$@"; }

echo "== key permissions =="
run chmod 600 "$KEY"

echo "== pack working tree (tracked + untracked, minus ignored; excluding .git node_modules data .env *.pem) =="
echo "+ git ls-files -co --exclude-standard | grep -vE '^(\\.git/|node_modules/|data/|secrets/)|(^|/)\\.env\$|\\.pem\$' > file-list"
echo "+ tar -czf $ARCHIVE -T file-list"
if [ "$DRY" = 0 ]; then
  git ls-files -co --exclude-standard -z \
    | tr '\0' '\n' \
    | grep -vE '^(\.git/|node_modules/|data/|secrets/)|(^|/)\.env$|\.pem$' > "$TMP/files.txt"
  tar -czf "$ARCHIVE" -T "$TMP/files.txt"
  echo "archive: $(du -h "$ARCHIVE" | cut -f1)"
fi

echo "== upload and extract (existing data/ and .env are preserved) =="
run ssh "${SSH_OPTS[@]}" "$TARGET" "mkdir -p ~/btcarb ~/btcarb/data ~/btcarb/secrets && chmod 700 ~/btcarb/secrets"
run scp "${SSH_OPTS[@]}" "$ARCHIVE" "$TARGET:/tmp/btcarb.tar.gz"
run ssh "${SSH_OPTS[@]}" "$TARGET" "tar -xzf /tmp/btcarb.tar.gz -C ~/btcarb && rm -f /tmp/btcarb.tar.gz && chmod +x ~/btcarb/deploy/*.sh"

echo "== secrets (contents never printed) =="
if [ -f "$ENV_FILE" ] || [ "$DRY" = 1 ]; then
  run scp "${SSH_OPTS[@]}" "$ENV_FILE" "$TARGET:btcarb/.env"
  run ssh "${SSH_OPTS[@]}" "$TARGET" "chmod 600 ~/btcarb/.env"
fi
if [ -n "$KALSHI_PEM" ]; then
  run scp "${SSH_OPTS[@]}" "$KALSHI_PEM" "$TARGET:btcarb/secrets/$(basename "$KALSHI_PEM")"
  run ssh "${SSH_OPTS[@]}" "$TARGET" "chmod 600 ~/btcarb/secrets/*.pem"
fi

echo "== setup on VPS =="
run ssh -t "${SSH_OPTS[@]}" "$TARGET" "SKIP_TESTS=$SKIP_TESTS bash ~/btcarb/deploy/setup-vps.sh"

cat <<EOF

== next steps ==
Dashboard (bound to 127.0.0.1 on the VPS; do NOT open port 3000 in the security group):
  ssh -i $KEY -L 3000:localhost:3000 $TARGET     then open http://localhost:3000
Logs:
  ssh -i $KEY $TARGET "journalctl -u btcarb -f"
EOF
[ "$DRY" = 0 ] || echo "(dry run: nothing was executed)"
