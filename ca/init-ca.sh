#!/bin/bash

set -e

STEPPATH="${STEPPATH:=/home/step/certs}"
CA_PASSWORD="${CA_PASSWORD:=changeme}"
export STEPPATH

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
        --with-db=false \
        --acme \
        || true
    
    # Configure CA for ACME
    if [ -f "${STEPPATH}/config/ca.json" ]; then
        # Backup original config
        cp "${STEPPATH}/config/ca.json" "${STEPPATH}/config/ca.json.bak"
        
        # Add ACME configuration using step CLI
        step ca provisioner add acme-provisioner --type ACME || true
    fi
fi

# Start Step CA${CA_PASSWORD}
step-ca "${STEPPATH}/config/ca.json" --password-file <(echo "changeme")
