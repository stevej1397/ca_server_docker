#!/bin/bash
# Issue a certificate for the UniFi Dream Machine from the local step CA and
# install it over SSH. Safe to run daily: it only acts when the cert the UDM is
# serving is missing, not from this CA, missing a name, or close to expiry.
#
# Usage: udm-cert-deploy.sh [--force]

set -euo pipefail

UDM_SSH="${UDM_SSH:-root@unifi.lan}"
UDM_CONNECT="${UDM_CONNECT:-192.168.1.1:443}"
# First name becomes the CN; all names go in the SAN list.
CERT_NAMES=(${CERT_NAMES:-unifi.lan 192.168.1.1})
VALIDITY_DAYS="${VALIDITY_DAYS:-90}"
RENEW_DAYS="${RENEW_DAYS:-30}"
OUT_DIR="${OUT_DIR:-/mnt/user/appdata/ca-issued-certs/unifi.lan}"
CA_CONTAINER="${CA_CONTAINER:-ca_authority}"
BACKEND_CONTAINER="${BACKEND_CONTAINER:-ca_backend}"
REMOTE_DIR="/data/unifi-core/config"
LOG_FILE="${OUT_DIR}/deploy.log"

FORCE=0
[ "${1:-}" = "--force" ] && FORCE=1

mkdir -p "${OUT_DIR}"
chmod 700 "${OUT_DIR}"
WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT

log() {
  echo "$(date '+%Y-%m-%d %H:%M:%S') $*" | tee -a "${LOG_FILE}"
}

udm() {
  ssh -o BatchMode=yes -o ConnectTimeout=10 -o LogLevel=ERROR "${UDM_SSH}" "$@"
}

# Verify chain, names and (optionally) remaining lifetime of a PEM cert.
cert_ok() {
  local cert="$1" min_seconds="$2" name
  openssl verify -CAfile "${WORK}/root.crt" -untrusted "${WORK}/intermediate.crt" "${cert}" >/dev/null 2>&1 || return 1
  openssl x509 -in "${cert}" -noout -checkend "${min_seconds}" >/dev/null 2>&1 || return 1
  for name in "${CERT_NAMES[@]}"; do
    if [[ "${name}" =~ ^[0-9.]+$|: ]]; then
      openssl x509 -in "${cert}" -noout -checkip "${name}" | grep -q 'does match' || return 1
    else
      openssl x509 -in "${cert}" -noout -checkhost "${name}" | grep -q 'does match' || return 1
    fi
  done
}

fetch_served_cert() {
  echo | timeout 10 openssl s_client -connect "${UDM_CONNECT}" -servername "${CERT_NAMES[0]}" 2>/dev/null \
    | openssl x509 > "$1" 2>/dev/null
}

fingerprint() {
  openssl x509 -in "$1" -noout -fingerprint -sha256 | cut -d= -f2
}

docker exec "${CA_CONTAINER}" cat /home/step/certs/certs/root_ca.crt > "${WORK}/root.crt"
docker exec "${CA_CONTAINER}" cat /home/step/certs/certs/intermediate_ca.crt > "${WORK}/intermediate.crt"

if [ "${FORCE}" -eq 0 ] && fetch_served_cert "${WORK}/served.crt" \
  && cert_ok "${WORK}/served.crt" $((RENEW_DAYS * 86400)); then
  log "UDM cert OK, expires $(openssl x509 -in "${WORK}/served.crt" -noout -enddate | cut -d= -f2); nothing to do."
  exit 0
fi

log "Issuing new UDM cert for: ${CERT_NAMES[*]} (${VALIDITY_DAYS} days)"
# RSA is required: unifi-core parses its cert with node-forge, which rejects EC
# certs, and then regenerates its own self-signed cert over ours.
REQ="$(jq -cn --arg cn "${CERT_NAMES[0]}" --argjson days "${VALIDITY_DAYS}" \
  '{commonName: $cn, altNames: $ARGS.positional, validityDays: $days, keyType: "rsa"}' --args "${CERT_NAMES[@]:1}")"
docker exec -e REQ="${REQ}" "${BACKEND_CONTAINER}" node -e '
  const base = "http://localhost:" + (process.env.PORT || 3001) + "/api/certificates";
  (async () => {
    const res = await fetch(base + "/issue", { method: "POST", headers: { "content-type": "application/json" }, body: process.env.REQ });
    const c = await res.json();
    if (!res.ok) throw new Error(JSON.stringify(c));
    const cert = await (await fetch(`${base}/${c.id}/download`)).text();
    const key = await (await fetch(`${base}/${c.id}/download-key`)).text();
    process.stdout.write(JSON.stringify({ id: c.id, cert, key }));
  })().catch((e) => { console.error(e.message); process.exit(1); });
' > "${WORK}/issued.json"

jq -r .cert "${WORK}/issued.json" > "${WORK}/cert.crt"
jq -r .key "${WORK}/issued.json" > "${WORK}/cert.key"
cat "${WORK}/cert.crt" "${WORK}/intermediate.crt" > "${WORK}/fullchain.crt"

cert_ok "${WORK}/cert.crt" 0 || { log "ERROR: newly issued cert failed validation"; exit 1; }
[ "$(openssl x509 -in "${WORK}/cert.crt" -noout -pubkey | openssl sha256)" = \
  "$(openssl pkey -in "${WORK}/cert.key" -pubout | openssl sha256)" ] || { log "ERROR: key does not match cert"; exit 1; }
NEW_FP="$(fingerprint "${WORK}/cert.crt")"
log "Issued $(jq -r .id "${WORK}/issued.json"), fingerprint ${NEW_FP}"

# Keep the original self-signed pair once, and the previous pair for rollback.
udm "cd ${REMOTE_DIR} \
  && { [ -f unifi-core.crt.orig ] || { cp -p unifi-core.crt unifi-core.crt.orig && cp -p unifi-core.key unifi-core.key.orig; }; } \
  && cp -p unifi-core.crt unifi-core.crt.prev && cp -p unifi-core.key unifi-core.key.prev"
udm "cat > ${REMOTE_DIR}/unifi-core.crt.new" < "${WORK}/fullchain.crt"
udm "cat > ${REMOTE_DIR}/unifi-core.key.new" < "${WORK}/cert.key"
udm "cd ${REMOTE_DIR} \
  && chmod --reference=unifi-core.crt unifi-core.crt.new && chmod --reference=unifi-core.key unifi-core.key.new \
  && mv unifi-core.crt.new unifi-core.crt && mv unifi-core.key.new unifi-core.key \
  && systemctl restart unifi-core"
log "Installed on UDM, restarted unifi-core; waiting for new cert to be served"

for _ in $(seq 1 24); do
  sleep 5
  if fetch_served_cert "${WORK}/served.crt" && [ "$(fingerprint "${WORK}/served.crt")" = "${NEW_FP}" ]; then
    install -m 644 "${WORK}/cert.crt" "${OUT_DIR}/unifi.lan.crt"
    install -m 644 "${WORK}/fullchain.crt" "${OUT_DIR}/unifi.lan-fullchain.crt"
    install -m 644 "${WORK}/intermediate.crt" "${OUT_DIR}/intermediate.crt"
    install -m 600 "${WORK}/cert.key" "${OUT_DIR}/unifi.lan.key"
    log "UDM now serving new cert, expires $(openssl x509 -in "${WORK}/served.crt" -noout -enddate | cut -d= -f2)"
    tail -n 1000 "${LOG_FILE}" > "${WORK}/log" && cat "${WORK}/log" > "${LOG_FILE}"
    exit 0
  fi
done

log "ERROR: UDM is not serving the new cert after 2 minutes; rolling back to previous cert"
udm "cd ${REMOTE_DIR} && cp -p unifi-core.crt.prev unifi-core.crt && cp -p unifi-core.key.prev unifi-core.key && systemctl restart unifi-core"
exit 1
