#!/bin/sh
set -eu

# Cloudflare writes this CA at start when the Worker intercepts HTTPS egress. It is absent under plain docker run.
ca=/etc/cloudflare/certs/cloudflare-containers-ca.crt
if [ -f "$ca" ]; then
  cp "$ca" /usr/local/share/ca-certificates/cloudflare-containers-ca.crt
  update-ca-certificates
  export NODE_EXTRA_CA_CERTS="$ca"
fi

cd /app/packages/app
exec node --experimental-sqlite --disable-warning=ExperimentalWarning --import tsx runner/main.ts
