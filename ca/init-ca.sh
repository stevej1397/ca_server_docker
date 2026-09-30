#!/bin/bash

set -e

STEPPATH="${STEPPATH:=/home/step/certs}"
CA_PASSWORD="${CA_PASSWORD:=changeme}"
CERT_DURATION="${CERT_DURATION:=2160h}"
MAX_CERT_DURATION="${MAX_CERT_DURATION:=8760h}"
export STEPPATH

configure_acme_provisioner() {
    local provisioner_name="$1"

    if step ca provisioner update "${provisioner_name}" \
        --ca-config "${STEPPATH}/config/ca.json" \
        --x509-default-dur "${CERT_DURATION}" \
        --x509-max-dur "${MAX_CERT_DURATION}" >/dev/null 2>&1; then
        echo "Updated ACME provisioner '${provisioner_name}' with default duration ${CERT_DURATION} and max duration ${MAX_CERT_DURATION}."
        return 0
    fi

    if step ca provisioner add "${provisioner_name}" \
        --type ACME \
        --ca-config "${STEPPATH}/config/ca.json" \
        --x509-default-dur "${CERT_DURATION}" \
        --x509-max-dur "${MAX_CERT_DURATION}" >/dev/null 2>&1; then
        echo "Added ACME provisioner '${provisioner_name}' with default duration ${CERT_DURATION} and max duration ${MAX_CERT_DURATION}."
        return 0
    fi

    echo "Warning: failed to configure ACME provisioner '${provisioner_name}'." >&2
    return 1
}

# Initialize CA if not already initialized
if [ ! -f "${STEPPATH}/config/ca.json" ]; then
    echo "Initializing Step CA..."
    
    step ca init \
        --deployment-type standalone \
        --name "Home Lab CA" \
        --dns localhost \
        --address :9000 \
        --provisioner "admin" \
        --password-file <(echo "${CA_PASSWORD}") \
        --acme \
        || true
    
fi

if [ -f "${STEPPATH}/config/ca.json" ]; then
    cp "${STEPPATH}/config/ca.json" "${STEPPATH}/config/ca.json.bak"
    configure_acme_provisioner "acme" || true
    configure_acme_provisioner "acme-provisioner" || true
fi

# Start Step CA${CA_PASSWORD}
step-ca "${STEPPATH}/config/ca.json" --password-file <(echo "${CA_PASSWORD}")
