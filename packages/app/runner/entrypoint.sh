#!/bin/sh
set -eu

# Cloudflare writes this CA at start when the Worker intercepts HTTPS egress. It is absent under plain docker run.
# The process runs as node, so it cannot update the system store. It points Node and git at a bundle in /tmp instead.
ca=/etc/cloudflare/certs/cloudflare-containers-ca.crt
if [ -f "$ca" ]; then
  bundle=/tmp/ca-certificates.crt
  cat /etc/ssl/certs/ca-certificates.crt "$ca" > "$bundle"
  export NODE_EXTRA_CA_CERTS="$ca" GIT_SSL_CAINFO="$bundle" SSL_CERT_FILE="$bundle"
fi

cd /app/packages/app
exec node --experimental-sqlite --disable-warning=ExperimentalWarning --import tsx runner/main.ts
