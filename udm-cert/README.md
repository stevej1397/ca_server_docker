# UniFi Dream Machine Pro certificate

The UDM Pro (`unifi.lan` / `192.168.1.1`) serves a certificate issued by this CA
instead of its built-in self-signed `unifi.local` cert. UniFi OS can't use a
custom ACME server, so `udm-cert-deploy.sh` issues the cert through the CA
backend and installs it over SSH.

## How it works

`udm-cert-deploy.sh` runs on the Unraid host:

1. Connects to `192.168.1.1:443` and checks the cert being served. If it chains
   to this CA's root, covers `unifi.lan` and `192.168.1.1`, and has more than
   30 days left, it logs "nothing to do" and exits.
2. Otherwise it asks `ca_backend` (`POST /api/certificates/issue`) for a
   90-day **RSA** cert and checks the chain, names, and key match.
3. Over SSH as `root@unifi.lan` (key in `/root/.ssh`, which lives on the flash
   at `/boot/config/ssh/root`), it:
   - saves the original self-signed pair once as `unifi-core.{crt,key}.orig`
   - saves the current pair as `unifi-core.{crt,key}.prev`
   - writes the full chain and key to `/data/unifi-core/config/unifi-core.{crt,key}`
   - runs `systemctl restart unifi-core`
4. Waits up to 2 minutes for the UDM to serve the new cert. If it doesn't, the
   script restores `.prev`, restarts `unifi-core` again, and exits 1.

On success the cert, key, and full chain are copied to
`/mnt/user/appdata/ca-issued-certs/unifi.lan/` (a root-only folder), and each
run is logged to `deploy.log` in the same folder.

Run it by hand at any time. `--force` issues and installs a new cert even when
the current one is fine:

```bash
/mnt/user/docker_compose/ca_server_docker/udm-cert/udm-cert-deploy.sh --force
```

Settings are environment variables at the top of the script: `UDM_SSH`,
`UDM_CONNECT`, `CERT_NAMES`, `VALIDITY_DAYS`, `RENEW_DAYS`, `OUT_DIR`.

## Why RSA, and why not the file-swap from older guides

UniFi OS 5.x (`unifi-core`) checks `unifi-core.crt` at startup. It regenerates its
own self-signed cert over the file when any of these is true:

- the cert can't be parsed, or
- the key doesn't match, or
- fewer than 7 days are left.

It parses the cert with node-forge, which only handles RSA. EC certs (the
backend's default) therefore look invalid, and `unifi-core` overwrites them;
its log then shows `Self signed certificate needs regenerated, regenerating`.
That's why the script requests `keyType: "rsa"`, which was added to the
backend's issue endpoint for this purpose.

## Scheduling

The script is meant to run daily. It's cheap when nothing needs doing. It also
catches a firmware update that resets the cert, because the served cert would
then no longer chain to this CA. To install the cron job so it survives reboots:

```bash
cat > /boot/config/plugins/dynamix/udm-cert.cron <<'EOF'
# UniFi Dream Machine web cert from step-ca (see ca_server_docker/udm-cert/README.md)
27 3 * * * /mnt/user/docker_compose/ca_server_docker/udm-cert/udm-cert-deploy.sh > /dev/null 2>&1
EOF
update_cron
```

Check it with `grep udm /etc/cron.d/root`. `update_cron` merges every
`/boot/config/plugins/dynamix/*.cron` file into the system crontab at
`/etc/cron.d/root`, so plain `crontab -l` won't show it.

## Troubleshooting

- **See what happened:** `tail -n 50 /mnt/user/appdata/ca-issued-certs/unifi.lan/deploy.log`
- **See what the UDM is serving:**
  `echo | openssl s_client -connect 192.168.1.1:443 2>/dev/null | openssl x509 -noout -subject -issuer -enddate`
- **The UDM replaced the cert:** look for `Self signed certificate` in the UDM's logs:
  `ssh root@unifi.lan 'grep -h "Self signed certificate" /data/unifi-core/logs/*.log | tail'`
- **SSH fails:** check that SSH is still enabled in the UniFi console and that
  `/root/.ssh/id_rsa.pub` is still in the UDM's authorized keys. A firmware update can reset them.
- **Issuing fails:** check that `ca_backend` is running (`docker logs --tail 50 ca_backend`).
- **Go back to the stock self-signed cert:**
  ```bash
  ssh root@unifi.lan 'cd /data/unifi-core/config && cp -p unifi-core.crt.orig unifi-core.crt && cp -p unifi-core.key.orig unifi-core.key && systemctl restart unifi-core'
  ```
  Remove the cron file first, or the next run will put this CA's cert back.
