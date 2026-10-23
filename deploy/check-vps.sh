#!/usr/bin/env bash
# Connectivity / latency / clock sanity check. Runs on the VPS or locally. Read-only.
set -uo pipefail

HOSTS=(clob.polymarket.com gamma-api.polymarket.com ws-live-data.polymarket.com
  ws-subscriptions-clob.polymarket.com ws-live-v2.polymarket.com
  api.elections.kalshi.com external-api.kalshi.com external-api-ws.kalshi.com)
SAMPLES=5

# min/median of newline-separated numbers on stdin (milliseconds)
stats() { sort -n | awk '{a[NR]=$1} END{ if(NR==0){print "n/a n/a"; exit} m=(NR%2)?a[(NR+1)/2]:(a[NR/2]+a[NR/2+1])/2; printf "%.1f %.1f\n", a[1], m }'; }

echo "== Connectivity (curl, ${SAMPLES} samples, times in ms; HTTP status of GET /) =="
printf '%-38s %-5s %-15s %-15s %-15s %-15s\n' HOST HTTP "DNS min/med" "TCP min/med" "TLS min/med" "TOTAL min/med"
for h in "${HOSTS[@]}"; do
  dns=""; con=""; tls=""; tot=""; code="---"
  for _ in $(seq "$SAMPLES"); do
    out=$(curl -sS -o /dev/null --max-time 10 -w '%{http_code} %{time_namelookup} %{time_connect} %{time_appconnect} %{time_total}' "https://$h/" 2>/dev/null) || out=""
    [ -z "$out" ] && continue
    read -r c d k t a <<<"$out"
    code=$c
    dns+="$(awk -v x="$d" 'BEGIN{print x*1000}')"$'\n'
    con+="$(awk -v x="$k" 'BEGIN{print x*1000}')"$'\n'
    tls+="$(awk -v x="$t" 'BEGIN{print x*1000}')"$'\n'
    tot+="$(awk -v x="$a" 'BEGIN{print x*1000}')"$'\n'
  done
  if [ -z "$dns" ]; then printf '%-38s %-5s FAILED (DNS/TCP/TLS error or timeout)\n' "$h" "$code"; continue; fi
  f() { printf '%s' "$1" | stats | awk '{printf "%s/%s", $1, $2}'; }
  printf '%-38s %-5s %-15s %-15s %-15s %-15s\n' "$h" "$code" "$(f "$dns")" "$(f "$con")" "$(f "$tls")" "$(f "$tot")"
done
echo "(non-2xx on / is normal for API/websocket hosts; what matters is that DNS/TCP/TLS succeed)"

echo
echo "== Clock (chrony) =="
if command -v chronyc >/dev/null 2>&1; then
  chronyc tracking || true
  off=$(chronyc tracking 2>/dev/null | awk '/^System time/{print $4; exit}')
  if [ -n "${off:-}" ]; then
    awk -v o="$off" 'BEGIN{ if (o<0) o=-o; if (o>0.001) print "WARNING: clock offset " o*1000 " ms > 1 ms"; else print "clock offset OK (" o*1000 " ms)" }'
  fi
else
  echo "chronyc not installed (run deploy/setup-vps.sh)"
fi

echo
echo "== Instance region (IMDSv2, optional) =="
tok=$(curl -sS --max-time 2 -X PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' 2>/dev/null || true)
if [ -n "$tok" ]; then
  echo "region: $(curl -sS --max-time 2 -H "X-aws-ec2-metadata-token: $tok" http://169.254.169.254/latest/meta-data/placement/region 2>/dev/null || echo unknown)"
  echo "az:     $(curl -sS --max-time 2 -H "X-aws-ec2-metadata-token: $tok" http://169.254.169.254/latest/meta-data/placement/availability-zone 2>/dev/null || echo unknown)"
else
  echo "not an EC2 instance, or IMDS unreachable (ignored)"
fi

echo
echo "== Polymarket geoblock check (UNVERIFIED endpoint - verify in docs) =="
curl -sS --max-time 10 -w '\n[HTTP %{http_code}]\n' https://polymarket.com/api/geoblock 2>&1 || echo "request failed"
echo "This endpoint is not confirmed; verify in the Polymarket docs before relying on the response."

cat <<'M'

=========================================================================
REMINDER: access rules and terms of service for the UK must be verified
with EACH venue (Polymarket, Kalshi) BEFORE any real-money trading.
This bot only SIMULATES (paper trading); no orders are ever sent.
=========================================================================
M
