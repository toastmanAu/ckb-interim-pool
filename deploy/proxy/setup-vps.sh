#!/usr/bin/env bash
# setup-vps.sh — one-shot TCP reverse proxy setup on a fresh VPS.
#
# Run ON THE VPS (as root). Requirements: Debian/Ubuntu, nginx available,
# a WireGuard/Tailscale tunnel already established to the home edge host.
#
#   TUNNEL_IP=10.0.0.2 ./setup-vps.sh
#
# Then:
#   - DNS: au.wyltekpool.com → <this VPS public IP>  (grey cloud)
#   - HOME FIREWALL: allow :3333 ONLY from this VPS's tunnel IP
#   - restart the home edge if you enable PROXY protocol (see output)
set -euo pipefail

TUNNEL_IP="${TUNNEL_IP:?set TUNNEL_IP to the home edge host on the tunnel (e.g. 10.0.0.2)}"
LISTEN_PORT="${LISTEN_PORT:-3333}"

apt-get update -qq
apt-get install -y -qq nginx

cat > /etc/nginx/conf.d/pool-stream.conf <<EOF
stream {
  # per-IP connection limit at the proxy (miners appear as this VPS to the edge)
  limit_conn_zone \$binary_remote_addr zone=miners:10m;
  server {
    listen ${LISTEN_PORT};
    proxy_pass ${TUNNEL_IP}:3333;
    proxy_timeout 300s;
    proxy_connect_timeout 5s;
    limit_conn miners 8;
    # PROXY protocol: send the real miner IP to the edge. Requires
    # "proxyProtocol": true in the edge config — only if the edge is not
    # also serving direct LAN miners (the K7). Off by default.
    # proxy_protocol on;
  }
}
EOF

nginx -t && systemctl restart nginx

# ufw (if enabled): open the stratum port
ufw allow "${LISTEN_PORT}/tcp" 2>/dev/null || true

echo "✔ TCP proxy listening on :${LISTEN_PORT} → ${TUNNEL_IP}:3333"
echo "✔ Point DNS: au.wyltekpool.com → $(hostname -I | awk '{print $1}') (grey cloud)"
echo "✔ Home firewall: allow :3333 only from this VPS tunnel IP"
