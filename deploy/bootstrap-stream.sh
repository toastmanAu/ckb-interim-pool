#!/usr/bin/env bash
# bootstrap-stream.sh — create the shared POOL_V1 stream centrally.
#
# With community-run edges, the stream must exist BEFORE any edge connects:
# edges are permissioned to append messages only ($JS.API.STREAM.MSG.*) and
# cannot create the stream themselves. Run once on the central host with the
# ingest credential.
#
#   POOL_NATS_URL=tls://nats:4222 \
#   POOL_NATS_TLS_CA=/etc/wyltek-pool/nats-tls/ca.crt \
#   POOL_NATS_TLS_CERT=/etc/wyltek-pool/nats-tls/ingest.crt \
#   POOL_NATS_TLS_KEY=/etc/wyltek-pool/nats-tls/ingest.key \
#   deploy/bootstrap-stream.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"

URL="${POOL_NATS_URL:-nats://127.0.0.1:4223}"
STREAM="${POOL_STREAM:-POOL_V1}"

node -e "
const { connect } = require('nats');
(async () => {
  const opts = { servers: '$URL' };
  const ca = process.env.POOL_NATS_TLS_CA, cert = process.env.POOL_NATS_TLS_CERT, key = process.env.POOL_NATS_TLS_KEY;
  if (ca) opts.tls = { caFile: ca, certFile: cert, keyFile: key };
  const nc = await connect(opts);
  const jsm = await nc.jetstreamManager();
  try {
    const info = await jsm.streams.info('$STREAM');
    console.log('stream exists:', info.config.name, '| subjects:', info.config.subjects.join(','));
  } catch {
    await jsm.streams.add({ name: '$STREAM', subjects: ['pool.v1.edge.>'], retention: 'workqueue' });
    console.log('stream created:', '$STREAM');
  }
  await nc.close();
})();
"
