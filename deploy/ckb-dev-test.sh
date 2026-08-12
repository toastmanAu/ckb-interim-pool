#!/usr/bin/env bash
# ckb-dev-test.sh — local CKB dev chain for the payout drill.
#
#   deploy/ckb-dev-test.sh           (start)
#   deploy/ckb-dev-test.sh stop
#
# Uses the official nervos/ckb:v0.118.0 image with a dev chain whose
# block_assembler pays the pool key (ckt1qyqdcy57049wv82wjwca8a236c8hgxvp6n7s6gdcsj).
# The pool keypair lives in /tmp/opencode/pool-key.json (generated once).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"

KEY_FILE=/tmp/opencode/pool-key.json
if [ ! -f "$KEY_FILE" ]; then
  node -e "
const { secp256k1 } = require('@noble/curves/secp256k1.js');
const { ckbBlake2b } = require('./src/mining/blake2b.js');
const { bech32Encode } = require('./src/stratum/username.js');
const priv = secp256k1.utils.randomSecretKey();
const pub = secp256k1.getPublicKey(priv, true);
const blake160 = ckbBlake2b(Buffer.from(pub)).subarray(0, 20);
const address = bech32Encode('ckt', Buffer.concat([Buffer.from([0x01, 0x00]), blake160]), 'bech32');
require('fs').writeFileSync('$KEY_FILE', JSON.stringify({ priv: Buffer.from(priv).toString('hex'), pub: Buffer.from(pub).toString('hex'), blake160: blake160.toString('hex'), address }));
console.log('pool key generated:', address);
"
fi
BLAKE160=$(node -e "console.log(require('$KEY_FILE').blake160)")

stop() {
  docker rm -f pool-ckb-dev >/dev/null 2>&1 || true
  echo "dev chain stopped"
}
if [ "${1:-}" = "stop" ]; then stop; exit 0; fi

docker rm -f pool-ckb-dev >/dev/null 2>&1 || true
docker volume rm pool-ckb-data >/dev/null 2>&1 || true
docker run --rm -v pool-ckb-data:/var/lib/ckb nervos/ckb:v0.118.0 init --chain dev >/dev/null 2>&1

# RPC on all interfaces + WS + block assembler → pool address
docker run --rm --entrypoint sh -v pool-ckb-data:/var/lib/ckb nervos/ckb:v0.118.0 -c \
  "sed -i 's|# ws_listen_address = \"127.0.0.1:28114\"|ws_listen_address = \"0.0.0.0:28114\"|' /var/lib/ckb/ckb.toml
   python3 - <<'PY'
import re
p = '/var/lib/ckb/ckb.toml'
s = open(p).read()
s = s.replace('''# [block_assembler]
# code_hash = \"0x9bd7e06f3ecf4be0f2fcd2188b23f1b9fcc88e5d4b65a8637b17723bbda3cce8\"
# args = \"ckb-cli util blake2b --prefix-160 <compressed-pubkey>\"
# hash_type = \"type\"
# message = \"A 0x-prefixed hex string\"''', '''[block_assembler]
code_hash = \"0x9bd7e06f3ecf4be0f2fcd2188b23f1b9fcc88e5d4b65a8637b17723bbda3cce8\"
args = \"0x$BLAKE160\"
hash_type = \"type\"
message = \"0x636b622d6465762d706f6f6c\"''')
open(p, 'w').write(s)
PY
" >/dev/null 2>&1

docker run -d --name pool-ckb-dev -p 8115:8114 -p 28115:28114 -p 8116:8115 \
  -v pool-ckb-data:/var/lib/ckb nervos/ckb:v0.118.0 run >/dev/null
for i in $(seq 1 20); do
  if curl -s --max-time 2 http://127.0.0.1:8115 -X POST -H 'Content-Type: application/json' \
    -d '{"id":1,"jsonrpc":"2.0","method":"get_tip_header","params":[]}' | grep -q result; then
    echo "dev chain up on :8115 (ws :28115) — pool address: $(node -e "console.log(require('$KEY_FILE').address)")"
    exit 0
  fi
  sleep 1
done
echo "dev chain failed to start" >&2
exit 1
