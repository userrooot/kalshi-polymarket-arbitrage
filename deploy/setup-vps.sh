#!/usr/bin/env bash
# Runs ON the VPS (Ubuntu 22.04/24.04). Idempotent. Never prints secrets (no `set -x`).
# Env: SKIP_TESTS=1 skips `bun test`.
set -euo pipefail

APP="$HOME/btcarb"
BUN="$HOME/.bun/bin/bun"
log() { printf '\n== %s ==\n' "$*"; }
warn() { printf 'WARNING: %s\n' "$*" >&2; }

[ -d "$APP" ] || { echo "$APP not found; run deploy.ps1/deploy.sh first" >&2; exit 1; }
# Files packed on Windows may have CRLF endings (this script itself is fixed by deploy.* before it runs).
sed -i 's/\r$//' "$APP"/deploy/*.sh "$APP"/deploy/btcarb.service

log "apt packages"
sudo apt-get update -y
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y chrony curl unzip git ca-certificates

log "chrony: Amazon Time Sync Service (169.254.169.123)"
AWS_LINE='server 169.254.169.123 prefer iburst minpoll 4 maxpoll 4'
if [ -d /etc/chrony/sources.d ] && grep -qE '^[[:space:]]*sourcedir[[:space:]]+/etc/chrony/sources\.d' /etc/chrony/chrony.conf 2>/dev/null; then
  # Ubuntu 22.04+ chrony 4.x: drop-in .sources file
  echo "$AWS_LINE" | sudo tee /etc/chrony/sources.d/aws.sources >/dev/null
  echo "wrote /etc/chrony/sources.d/aws.sources"
else
  if ! grep -qF '169.254.169.123' /etc/chrony/chrony.conf; then
    printf '\n# Amazon Time Sync Service\n%s\n' "$AWS_LINE" | sudo tee -a /etc/chrony/chrony.conf >/dev/null
    echo "appended to /etc/chrony/chrony.conf"
  else
    echo "chrony.conf already references 169.254.169.123"
  fi
fi
sudo systemctl enable chrony >/dev/null 2>&1 || true
sudo systemctl restart chrony
sleep 3
chronyc tracking || warn "chronyc tracking failed"
chronyc sources || warn "chronyc sources failed"

log "Bun"
if [ ! -x "$BUN" ]; then
  curl -fsSL https://bun.sh/install | bash
fi
"$BUN" --version

cd "$APP"

log ".env"
( umask 077; [ -f .env ] || : > .env )
if [ ! -s .env ]; then
  if [ -f .env.example ]; then
    cat .env.example > .env
    warn "no .env uploaded; created from .env.example (no Kalshi keys: Kalshi WS feed disabled)"
  else
    warn "no .env and no .env.example; using an empty .env"
  fi
fi
chmod 600 .env
sed -i 's/\r$//' .env  # CRLF from Windows editors (in place, keeps mode 600)

# Set KEY=VALUE in .env in place, without printing the value. Uses awk so values need no escaping.
set_env() {
  local key="$1" val="$2" tmp
  tmp="$(mktemp "$APP/.env.XXXXXX")"
  KEY="$key" VAL="$val" awk '
    BEGIN { k=ENVIRON["KEY"]; v=ENVIRON["VAL"]; done=0 }
    $0 ~ "^[[:space:]]*" k "=" { if (!done) { print k "=" v; done=1 }; next }
    { print }
    END { if (!done) print k "=" v }
  ' .env > "$tmp"
  chmod 600 "$tmp"
  mv "$tmp" .env
  echo "set $key"
}
set_env RECORD_MD 1
set_env HOST 127.0.0.1
if [ -d secrets ]; then
  chmod 700 secrets
  find secrets -maxdepth 1 -type f -exec chmod 600 {} +
  # newest upload wins if several PEMs accumulated over deploys
  pem="$(find secrets -maxdepth 1 -type f -name '*.pem' -printf '%T@ %p\n' | sort -rn | head -n1 | cut -d' ' -f2- || true)"
  if [ -n "$pem" ]; then
    chmod 600 "$pem"
    set_env KALSHI_PRIVATE_KEY_PATH "./$pem"
  else
    warn "no .pem in secrets/; KALSHI_PRIVATE_KEY_PATH left unchanged"
  fi
else
  warn "no secrets/ directory; Kalshi private key not configured"
fi
chmod 600 .env

log "bun install"
if ! "$BUN" install --frozen-lockfile; then
  warn "frozen lockfile install failed (lock mismatch?); falling back to plain bun install"
  "$BUN" install
fi

if [ "${SKIP_TESTS:-0}" = "1" ]; then
  echo "SKIP_TESTS=1: skipping bun test"
else
  log "bun test"
  "$BUN" test
fi

log "check-vps"
bash deploy/check-vps.sh || warn "check-vps reported problems"

log "latency probe (writes data/latency.json)"
mkdir -p data
"$BUN" run probe --no-demo || warn "probe failed; continuing (data/latency.json may be missing)"

log "systemd unit"
# The unit is written for user "ubuntu"; adapt it if this account differs.
sed -e "s#/home/ubuntu#$HOME#g" -e "s#^User=ubuntu\$#User=$(id -un)#" deploy/btcarb.service \
  | sudo tee /etc/systemd/system/btcarb.service >/dev/null
sudo chmod 644 /etc/systemd/system/btcarb.service
sudo systemctl daemon-reload
sudo systemctl enable btcarb
if systemctl is-active --quiet btcarb; then
  sudo systemctl restart btcarb
else
  sudo systemctl start btcarb
fi
sleep 3
systemctl status btcarb --no-pager || true

cat <<'M'

Done.
  Logs:       journalctl -u btcarb -f
  Restart:    sudo systemctl restart btcarb      Stop: sudo systemctl stop btcarb
  Dashboard:  bound to 127.0.0.1 only. From your PC:
              ssh -i <key.pem> -L 3000:localhost:3000 ubuntu@<host>   then open http://localhost:3000
  Data:       ~/btcarb/data (latency.json, recordings)
M
