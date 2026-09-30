# Unraid Step CA WebGUI ACME Plugin

This plugin is meant for Unraid systems that should obtain their WebGUI certificate from the Step CA ACME endpoint exposed by this repository.

## What it does

- Uses `acme.sh` against your Step CA ACME directory.
- Downloads the Step CA root bundle from `roots.pem`.
- Issues or renews a certificate for the Unraid WebGUI hostname.
- Writes the custom certificate bundle Unraid expects at `/boot/config/ssl/certs/[servername]_unraid_bundle.pem`.
- Optionally enables `use_ssl yes` and reloads the WebGUI after install.
- Adds a managed cron entry for auto-renewal when enabled.

## Defaults for this repo

- ACME directory: `https://step-ca.lan:9000/acme/acme/directory`
- Root bundle: `https://step-ca.lan:9000/roots.pem`

Those defaults come from [docker-compose.yml](/mnt/user/docker_compose/ca_server_docker/docker-compose.yml).

## Important Unraid behavior

- The certificate must match the active Unraid `server name` plus `Local TLD`, or a wildcard for that Local TLD.
- Unraid expects the custom bundle file name to be `/boot/config/ssl/certs/[servername]_unraid_bundle.pem`.
- The bundle installed by this plugin contains the full certificate chain followed by the private key.
- Browsers and other clients still need to trust your Step CA root certificate separately.

## Files

- `src/step-ca-webgui-acme.page`: Unraid settings page
- `src/scripts/step-ca-webgui-acme.sh`: ACME, install, validation, and cron logic
- `build-plugin.sh`: Generates the distributable `.plg`
- `step-ca-webgui-acme.plg`: Generated plugin file

## Build

From this repo:

```bash
cd /mnt/user/docker_compose/ca_server_docker/unraid-plugin
chmod +x build-plugin.sh
./build-plugin.sh
```

If you plan to publish the plugin, set these first so the generated metadata points at your repo:

```bash
export PLUGIN_URL="https://raw.githubusercontent.com/<owner>/<repo>/main/unraid-plugin/step-ca-webgui-acme.plg"
export SUPPORT_URL="https://github.com/<owner>/<repo>"
./build-plugin.sh
```

## Install on Unraid

1. Copy `step-ca-webgui-acme.plg` to a location Unraid can read, or publish it at a raw URL.
2. Install it from the Unraid Plugins page.
3. Open `Settings -> Step CA WebGUI ACME`.
4. Confirm the ACME directory URL and root bundle URL.
5. Save, then run `Save and Issue Cert`.

## Challenge modes

- `standalone`: Uses HTTP-01 on port `80`
- `alpn`: Uses TLS-ALPN-01 on port `443`

Both modes are set up to temporarily stop the Unraid WebGUI during issuance so the ACME client can bind the needed port.
