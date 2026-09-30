# AGENTS.md

## Purpose

This repo is a Docker Compose stack for a Smallstep CA service, its backend/frontend, and the matching Unraid WebGUI ACME plugin.

Use this file as the quick-start reference for environment-specific behavior on this host so future work can start in the right place immediately.

## Critical Environment Notes

- The shell session starts in `/root`, not in this repository.
- In this environment, tool `workdir` can be unreliable. Prefer explicit `cd /mnt/user/docker_compose/ca_server_docker && ...` in shell commands.
- The correct project directory is:

```bash
/mnt/user/docker_compose/ca_server_docker
```

- `rg` is not installed on this host right now. Use `grep`, `find`, `sed`, and `ls` as fallback tools.
- Docker access is available from the host, and inspecting the live Unraid system is allowed for this project.

## Live Stack Notes

- Main compose file:

```bash
/mnt/user/docker_compose/ca_server_docker/docker-compose.yml
```

- Live container names:
  - `ca_authority`
  - `ca_backend`
  - `ca_frontend`

- The Step CA container is reachable from the host as:

```bash
https://step-ca.lan:9000
```

## Unraid-Specific Paths

- Installed Unraid plugin script:

```bash
/usr/local/emhttp/plugins/step-ca-webgui-acme/scripts/step-ca-webgui-acme.sh
```

- Plugin persistent data:

```bash
/boot/config/plugins/step-ca-webgui-acme
```

- Active Unraid WebGUI certificate bundle:

```bash
/boot/config/ssl/certs/N5-Pro_unraid_bundle.pem
```

- Plugin log file:

```bash
/boot/config/plugins/step-ca-webgui-acme/logs/issue.log
```

## ACME And CA Notes

- The Unraid plugin uses `acme.sh` stored under `/boot/config/plugins/step-ca-webgui-acme/acme.sh`.
- Renewal runs from cron on the Unraid host, not from inside the CA stack.
- The plugin script in this repo was updated to:
  - invoke `acme.sh` through `sh`
  - force renewal based on the real installed certificate expiry
- The CA bootstrap script in this repo was updated so ACME provisioners honor:
  - default duration: `2160h` (90 days)
  - max duration: `8760h` (1 year)

## Other Devices Using This CA

See the "Devices Using This CA" section of `README.md` for the user-facing details. What an agent needs to know:

- Backend `POST /api/certificates/issue` signs directly with the intermediate key via openssl; it does not go through step-ca.
  - It accepts `keyType: "ec"` (default) or `"rsa"`.
  - `./backend` is bind-mounted into `ca_backend`, so `docker restart ca_backend` applies server.js edits.
  - The JWK `admin` provisioner has no claims, so `step ca certificate` through it only gives 24h certs. Use the backend for long-lived manual certs.
- Proxmox `pve-01.lan`–`pve-05.lan` (192.168.20.51–55): native `pvenode acme` with the http-01 challenge and a cluster account named `default`. Nothing in this repo. Failed validations show up in `docker logs ca_authority` as `could not connect to validation target`; the usual cause is DNS inside the container. The DNS servers are 192.168.1.2 (caches) and 192.168.1.1.
- UDM Pro `unifi.lan` / 192.168.1.1 (UniFi OS 5.x): `udm-cert/udm-cert-deploy.sh`, documented in `udm-cert/README.md`.
  - Reachable over SSH as `root@unifi.lan` with the key in `/root/.ssh`, which is persisted at `/boot/config/ssh/root`.
  - The cert **must be RSA**: `unifi-core` parses `/data/unifi-core/config/unifi-core.crt` with node-forge and regenerates its self-signed cert if parsing fails.
  - Issued files and `deploy.log` are in `/mnt/user/appdata/ca-issued-certs/unifi.lan/`.
  - Runs daily at 03:27 from `/boot/config/plugins/dynamix/udm-cert.cron`, installed by the user on 2026-09-29.
    `update_cron` merges that file into `/etc/cron.d/root`, so check with `grep udm /etc/cron.d/root`, not `crontab -l`.
    The auto-mode classifier blocks agents from installing cron jobs; give the user the command instead.
- Homarr (container `homarr`, Unraid template `/boot/config/plugins/dockerMan/templates-user/my-homarr.xml`):
  - Integrations trust `/mnt/user/appdata/homarr/appdata/trusted-certificates/*.crt|*.pem` on top of Node's public roots, re-read on every request. `home-lab-root-ca.crt` there is this CA's root.
  - Custom widgets use plain global `fetch` and ignore that folder, so the template sets `NODE_EXTRA_CA_CERTS` to the same root file.
  - `NODE_TLS_REJECT_UNAUTHORIZED=0` was removed on 2026-09-29, so TLS checking is on.
  - Integrations and custom widgets are in `appdata/db/db.sqlite` (tables `integration` and `custom_widget_definition`). Open it with `sqlite3 "file:...?immutable=1"`.
  - Recreate the container with `/usr/local/emhttp/plugins/dynamix.docker.manager/scripts/rebuild_container homarr`. Autostart is off, so run `docker start homarr` afterward.

## Practical Workflow

- Always start shell commands with:

```bash
cd /mnt/user/docker_compose/ca_server_docker && ...
```

- If checking live CA behavior, prefer:

```bash
docker logs --tail 100 ca_authority
docker exec ca_authority sh -lc 'cat /home/step/certs/config/ca.json'
```

- If checking live Unraid plugin behavior, prefer:

```bash
sed -n '1,260p' /boot/config/plugins/step-ca-webgui-acme/step-ca-webgui-acme.cfg
sed -n '1,260p' /boot/config/plugins/step-ca-webgui-acme/step-ca-webgui-acme.state
tail -n 200 /boot/config/plugins/step-ca-webgui-acme/logs/issue.log
```

- If verifying the installed WebGUI cert, use:

```bash
openssl x509 -in /boot/config/ssl/certs/N5-Pro_unraid_bundle.pem -noout -subject -issuer -startdate -enddate
```
