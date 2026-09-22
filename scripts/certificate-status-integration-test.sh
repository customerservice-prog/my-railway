#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

TOKEN="$(openssl rand -hex 32)"
TMP="$(mktemp -d)"
CONTAINER="my-railway-cert-test-$$"

cleanup() {
  set +e
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  rm -rf "$TMP"
}
trap cleanup EXIT

mkdir -p "$TMP/data"

openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout "$TMP/key.pem" \
  -out "$TMP/cert.pem" \
  -days 30 \
  -subj "/CN=cert.test" \
  -addext "subjectAltName=DNS:cert.test,DNS:*.wild.test" \
  >/dev/null 2>&1

CERT_B64="$(base64 -w0 "$TMP/cert.pem")"

node - "$TMP/data/acme.json" "$CERT_B64" <<'NODE'
const fs=require("fs");
const [file,certificate]=process.argv.slice(2);
const payload={
  letsencrypt:{
    Account:{},
    Certificates:[
      {
        domain:{main:"cert.test",sans:["*.wild.test"]},
        certificate,
        key:""
      }
    ]
  }
};
fs.writeFileSync(file,JSON.stringify(payload),{mode:0o600});
NODE

docker run -d --rm \
  --name "$CONTAINER" \
  -p 127.0.0.1:18090:8090 \
  -e "PLATFORM_UPDATER_TOKEN=$TOKEN" \
  -e "HOST_PROJECT_DIR=$TMP" \
  -e "PLATFORM_UPDATE_REF=0000000000000000000000000000000000000000" \
  -v "$TMP:$TMP" \
  my-railway-updater:local >/dev/null

for _ in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:18090/healthz >/dev/null 2>&1; then break; fi
  sleep 1
done
curl -fsS http://127.0.0.1:18090/healthz >/dev/null

curl -fsS \
  -H "Authorization: Bearer $TOKEN" \
  "http://127.0.0.1:18090/certificate?hostname=cert.test" \
  > /tmp/cert-status-exact.json

node - <<'NODE'
const fs=require("fs");
const x=JSON.parse(fs.readFileSync("/tmp/cert-status-exact.json","utf8"));
if(!x.found || x.expired || Number(x.daysRemaining)<20) process.exit(1);
if(!Array.isArray(x.names) || !x.names.includes("cert.test")) process.exit(1);
if(!x.validFrom || !x.validTo) process.exit(1);
NODE

curl -fsS \
  -H "Authorization: Bearer $TOKEN" \
  "http://127.0.0.1:18090/certificate?hostname=app.wild.test" \
  > /tmp/cert-status-wildcard.json

node - <<'NODE'
const fs=require("fs");
const x=JSON.parse(fs.readFileSync("/tmp/cert-status-wildcard.json","utf8"));
if(!x.found || x.expired) process.exit(1);
if(!x.names.includes("*.wild.test")) process.exit(1);
NODE

curl -fsS \
  -H "Authorization: Bearer $TOKEN" \
  "http://127.0.0.1:18090/certificate?hostname=missing.test" \
  > /tmp/cert-status-missing.json

node - <<'NODE'
const fs=require("fs");
const x=JSON.parse(fs.readFileSync("/tmp/cert-status-missing.json","utf8"));
if(x.found!==false) process.exit(1);
NODE

STATUS="$(curl -sS -o /tmp/cert-status-invalid.json -w '%{http_code}' \
  -H "Authorization: Bearer $TOKEN" \
  "http://127.0.0.1:18090/certificate?hostname=not_a_hostname")"
test "$STATUS" = "400"

echo "My Railway certificate-status integration test passed."
