#!/usr/bin/env bash
# gen-nats-tls.sh — generate a CA + server/client certs for the mTLS event bus.
#
# Client cert CN = NATS username (see nats-server.conf authorization).
# Outputs to deploy/nats-tls/:
#   ca.crt ca.key  server.crt server.key
#   edge-au.crt edge-au.key  edge-eu.crt edge-eu.key  ingest.crt ingest.key
#
# Distribute:  server.crt+key → central NATS host
#              edge-<region>.crt+key+ca.crt → that region's edge host only
#              ingest.crt+key+ca.crt → the central accounting host
set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)/deploy/nats-tls"
mkdir -p "$DIR"
cd "$DIR"

if [ -f ca.crt ]; then
  echo "certs already exist in $DIR — delete to regenerate"
  exit 1
fi

SERVER_CN="${NATS_SERVER_CN:-pool-nats}"
# community edges: onboard with `deploy/gen-nats-tls.sh new-edge <edge-id>`
CLIENTS=(edge-au edge-eu edge-us ingest)
if [ "${1:-}" = "new-edge" ]; then
  E="${2:?usage: gen-nats-tls.sh new-edge <edge-id>}"
  openssl genrsa -out "$E.key" 2048 2>/dev/null
  openssl req -new -key "$E.key" -subj "/CN=${E}" -out "$E.csr"
  printf 'subjectAltName = DNS:%s
' "$E" > "$E-ext.cnf"
  openssl x509 -req -in "$E.csr" -CA ca.crt -CAkey ca.key -CAcreateserial \
    -out "$E.crt" -days 825 -sha256 -extfile "$E-ext.cnf"
  rm -f "$E.csr" "$E-ext.cnf"
  echo "edge credential issued: $E.crt/$E.key (CN=$E — add a matching nats-server.conf user entry + edge id)"
  exit 0
fi

# ── CA ───────────────────────────────────────────────────────────────────────
openssl genrsa -out ca.key 4096 2>/dev/null
openssl req -x509 -new -nodes -key ca.key -sha256 -days 3650 \
  -subj "/CN=pool-nats-ca" -out ca.crt

# ── server cert (SAN: localhost + common hostnames) ─────────────────────────
openssl genrsa -out server.key 2048 2>/dev/null
openssl req -new -key server.key -subj "/CN=${SERVER_CN}" -out server.csr
cat > server-ext.cnf <<EOF
subjectAltName = DNS:localhost, DNS:${SERVER_CN}, IP:127.0.0.1
EOF
openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
  -out server.crt -days 825 -sha256 -extfile server-ext.cnf
rm -f server.csr server-ext.cnf

# ── client certs (CN = NATS user; SAN DNS required for the 2.10 user-map) ───
for c in "${CLIENTS[@]}"; do
  openssl genrsa -out "$c.key" 2048 2>/dev/null
  openssl req -new -key "$c.key" -subj "/CN=${c}" -out "$c.csr"
  cat > "$c-ext.cnf" <<EOF
subjectAltName = DNS:${c}
EOF
  openssl x509 -req -in "$c.csr" -CA ca.crt -CAkey ca.key -CAcreateserial \
    -out "$c.crt" -days 825 -sha256 -extfile "$c-ext.cnf"
  rm -f "$c.csr" "$c-ext.cnf"
done

chmod 600 *.key
echo "TLS material generated in $DIR"
ls -1 "$DIR"
