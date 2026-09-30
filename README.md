# Home Lab Self-Hosted Certificate Authority

A complete Docker-based ACME-compatible Certificate Authority with a web interface for managing certificates in your home lab.

## Features

- 🔐 **ACME Compatible** - Use with `certbot` or other ACME clients
- 🌐 **Web Interface** - Intuitive dashboard to manage certificates
- 📋 **Certificate Management** - Issue, view, revoke, and track certificates
- 📊 **Dashboard** - Monitor CA health and certificate expiration
- 🐳 **Docker Compose** - Easy single-command deployment
- 🏠 **Home Lab Ready** - Optimized for internal networks

## Architecture

```
┌─────────────────────────────────────────┐
│         Web Browser (Port 3000)         │
├─────────────────────────────────────────┤
│  React Frontend (Node.js + Nginx)       │
├─────────────────────────────────────────┤
│  Node.js Backend API (Port 3001)        │
├─────────────────────────────────────────┤
│  Step Certificate Authority (Port 9000) │
└─────────────────────────────────────────┘
```

### Components

1. **Step CA** - The certificate authority running on Port 9000
2. **Backend API** - Node.js/Express server exposing certificate operations
3. **Frontend** - React single-page application with dashboard and management tools

## Prerequisites

- Docker & Docker Compose
- macOS, Linux, or Windows with Docker installed

## Pre-Deployment

No pre-deployment steps are required. Docker named volumes will be created automatically on first run.

## Quick Start

### 1. Clone/Navigate to the Project

```bash
cd /Users/stephenscalaro/workspace/ca_server
```

### 2. Build and Start

```bash
docker-compose up -d
```

This will:
- Build the Step CA container
- Build the backend API container
- Build the frontend container
- Initialize the CA with ACME support
- Start all services
- Persist data using Docker named volumes

### 3. Access the Web Interface

Open your browser to: **http://localhost:3000**

## Usage

### Access Points

- **Web UI**: http://localhost:3000
- **Backend API**: http://localhost:3001/api
- **CA Direct**: http://localhost:9000 (internal only)
- **ACME Directory**: http://localhost:9000/acme/acme/directory

### Issue a Certificate via Web UI

1. Navigate to "Issue Certificate" button
2. Enter the Common Name (CN) - e.g., `example.local` or `api.home.lab`
3. (Optional) Add Alternative Names (SANs) - comma separated
4. Set validity period (1-3650 days, default 365)
5. Click "Issue Certificate"

### Issue a Certificate via ACME (Certbot)

```bash
certbot certonly \
  --server http://localhost:9000/acme/acme/directory \
  --standalone \
  --domain example.local \
  --domain www.example.local \
  --email admin@example.local
```

## Configuration

### Environment Variables

Create a `.env` file to override defaults:

```bash
cp .env.example .env
```

Key variables:
- `CA_PASSWORD` - CA administrator password (default: changeme)
- `ADMIN_USERNAME` - Backend admin username
- `ADMIN_PASSWORD` - Backend admin password (default: changeme)
- `CERT_DURATION` - Default certificate validity (default: 2160h = 90 days)

### Persistence

Certificates and CA configuration are stored in Docker named volumes:

- `ca_certs` - CA certificates and keys
- `ca_config` - CA configuration files

Named volumes are managed by Docker and persist data across container restarts and updates. To backup or inspect the data:

```bash
# List volumes
docker volume ls

# Inspect a volume
docker volume inspect ca_certs

# Backup a volume (example)
docker run --rm -v ca_certs:/data -v $(pwd):/backup alpine tar czf /backup/ca_certs.tar.gz -C /data .
```

## API Endpoints

### CA Health
```
GET /api/ca/health
GET /api/ca/info
```

### Certificate Management
```
POST   /api/certificates/issue      - Issue new certificate
GET    /api/certificates            - List all certificates
GET    /api/certificates/:id        - Get certificate details
POST   /api/certificates/:id/revoke - Revoke certificate
DELETE /api/certificates/:id        - Delete certificate record
```

`POST /api/certificates/issue` takes `{ commonName, altNames, validityDays, keyType }`.
`keyType` is `"ec"` (P-256, the default) or `"rsa"` (2048-bit) for devices that can't use EC certs.

### ACME
```
GET /api/acme/directory - Get ACME directory
```

## Devices Using This CA

These hosts on the network get their HTTPS certs from this CA or trust it. The
root CA SHA-256 fingerprint is
`17:FA:3F:91:F7:AA:0C:EF:8B:7E:8C:0F:68:57:FB:F1:0F:AC:43:B1:4D:7D:A1:21:24:52:F2:EB:61:05:06:04`.

### Unraid WebGUI

Handled by the `step-ca-webgui-acme` plugin in `unraid-plugin/` (acme.sh + cron on the Unraid host).

### Proxmox cluster (`pve-01.lan` … `pve-05.lan`, 192.168.20.51–55)

The built-in Proxmox ACME client is used. There is nothing in this repo for it.

- Each node trusts the root: `/usr/local/share/ca-certificates/step-ca-root.crt`, then `update-ca-certificates`.
- One cluster-wide ACME account named `default`, with directory `https://step-ca.lan:9000/acme/acme/directory`.
- Each node has `pvenode config set --acme domains=pve-0X.lan` and uses the http-01 challenge.
- Certs last 90 days. `pve-daily-update.timer` on each node renews them when fewer than 30 days are left.

If an order or renewal hangs at `pending`, the CA can't reach the node. Check
`docker logs ca_authority | grep pve-0X` for `could not connect to validation target`. Then check:

- DNS from inside the CA: `docker exec ca_authority getent hosts pve-0X.lan`. Two typos in DNS records caused this once already.
- Port 80 on the node is reachable from the CA.

To force a renewal on a node: `pvenode acme cert renew --force`.

### UniFi Dream Machine Pro (`unifi.lan`, 192.168.1.1)

UniFi OS can't use a custom ACME server. `udm-cert/udm-cert-deploy.sh` issues an RSA cert through the backend and installs it over SSH.
See [udm-cert/README.md](udm-cert/README.md) for how it works, scheduling, troubleshooting and rollback.

### Homarr dashboard (container `homarr`)

Homarr trusts Node's public CAs plus every `.crt`/`.pem` in `/mnt/user/appdata/homarr/appdata/trusted-certificates`.
You can also manage that folder from Management → Tools → Certificates in the Homarr UI.

- `home-lab-root-ca.crt` in that folder is this CA's root. It is required: the intermediate alone gives `UNABLE_TO_GET_ISSUER_CERT`.
- The container still has `NODE_TLS_REJECT_UNAUTHORIZED=0` in its Unraid template, which turns off TLS checking entirely.
  It can be removed now that the root is trusted. Check each integration afterward.

To test a host from inside Homarr, using the same trust list Homarr builds and with checking forced on, change `URL`:

```bash
docker exec -e NODE_TLS_REJECT_UNAUTHORIZED=1 -e URL=https://unifi.lan/ homarr node -e 'const tls=require("tls"),fs=require("fs"),d="/appdata/trusted-certificates";const ca=tls.rootCertificates.concat(fs.readdirSync(d).filter(f=>/\.(crt|pem)$/.test(f)).map(f=>fs.readFileSync(d+"/"+f,"utf8")));require("https").get(process.env.URL,{ca},r=>console.log("OK",r.statusCode)).on("error",e=>console.log("FAIL",e.code))'
```

- `UNABLE_TO_GET_ISSUER_CERT` means the CA isn't trusted.
- `ERR_TLS_CERT_ALTNAME_INVALID` means the cert doesn't cover the name or IP in the URL.

## Recent Changes

- **Persistence**: Switched to Docker named volumes for better portability and to avoid host filesystem permission issues.
- **CA Initialization**: Fixed compatibility with Step CA v0.24.2, including correct flags and password handling.
- **Container Setup**: Updated Dockerfile to build both `step-ca` and `step` binaries from source.

### 1. Domain Names

Use non-routable TLDs for internal services:
- `.local` - Multicast DNS (mDNS)
- `.home.lab` - Custom internal domain
- `.internal` - Organization-specific internal domain

Example:
```
api.home.lab
www.home.lab
grafana.home.lab
```

### 2. Trust the CA Certificate

To avoid browser warnings, trust the CA's root certificate:

**Extract CA certificate from the named volume:**
```bash
# Create a temporary container to copy the certificate
docker run --rm -v ca_certs:/certs alpine cp /certs/certs/root_ca.crt /tmp/root_ca.crt
docker cp $(docker ps -lq):/tmp/root_ca.crt ./root_ca.crt
```

**On macOS:**
```bash
# Add to macOS Keychain
security add-trusted-cert -d -r trustRoot -k ~/Library/Keychains/login.keychain ./root_ca.crt
```

**On Linux:**
```bash
sudo cp root_ca.crt /etc/pki/ca-trust/source/anchors/
sudo update-ca-trust
```

**On Windows:**
```powershell
certutil -addstore "Trusted Root Certification Authorities" root_ca.crt
```

### 3. Certificate Validity Periods

For home lab:
- Short-lived (30-90 days): Auto-renewal via ACME is easier
- Medium-lived (90-365 days): Good balance for home labs
- Long-lived (1-3 years): For internal services that don't change often

### 4. Alternative Names (SANs)

Always include all domain variations:
```
CN: api.home.lab
SANs: www.api.home.lab, api
```

## Docker Commands

### View Logs
```bash
# All services
docker-compose logs -f

# Specific service
docker-compose logs -f ca
docker-compose logs -f backend
docker-compose logs -f frontend
```

### Stop Services
```bash
docker-compose down
```

### Stop and Remove Volumes (Reset CA)
```bash
docker-compose down -v
```

### Rebuild and Restart
```bash
docker-compose up -d --build
```

## Troubleshooting

### CA Health Check Failing

```bash
docker-compose logs ca
```

Wait 30-60 seconds for CA to fully initialize.

### Can't Access Web UI

- Check port 3000 is available: `lsof -i :3000`
- Check backend API: `curl http://localhost:3001/health`
- Check CA: `curl http://localhost:9000/health`

### Certificate Not Found in CA

Check backend logs:
```bash
docker-compose logs backend
```

The default in-memory certificate storage will be lost on container restart. For persistence, modify `backend/server.js` to use a database.

## Advanced Configuration

### Use External Database

Modify `backend/server.js` to use PostgreSQL or MongoDB for certificate persistence.

### Custom CA Configuration

Modify `ca/init-ca.sh` to customize:
- CA name and organization
- Key size
- Provisioners
- Database backend

### Enable HTTPS

Update `docker-compose.yml` to add Traefik or Nginx reverse proxy with SSL termination.

## Security Considerations

⚠️ This is designed for home lab use. For production:

1. **Change Passwords**: Update `ADMIN_PASSWORD` in `.env`
2. **Use Strong Keys**: Ensure higher key sizes in CA configuration
3. **Secure Backend**: Build with proper authentication/authorization
4. **HTTPS Everywhere**: Use TLS for all communication
5. **Backups**: Regularly backup `ca_certs` and `ca_config` volumes
6. **Access Control**: Restrict network access to trusted devices

## Support & Troubleshooting

Review logs:
```bash
docker-compose logs -f
```

Check component status:
```bash
docker-compose ps
```

Restart a component:
```bash
docker-compose restart ca
docker-compose restart backend  
docker-compose restart frontend
```

## License

MIT

## References

- [Step CA Documentation](https://smallstep.com/docs/step-ca/)
- [ACME Protocol RFC 8555](https://tools.ietf.org/html/rfc8555)
- [Certbot Documentation](https://certbot.eff.org/)
