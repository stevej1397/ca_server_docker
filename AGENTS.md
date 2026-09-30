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
