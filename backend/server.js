import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import dotenv from 'dotenv';
import axios from 'axios';
import https from 'https';
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { spawnSync } from 'child_process';

dotenv.config();

const app = express();
const port = process.env.PORT || 3001;
const caUrl = process.env.CA_URL || 'http://ca:9000';
const caPassword = process.env.CA_PASSWORD || 'changeme';
const dataDir = process.env.DATA_DIR || '/data';
const certificatesDbPath = path.join(dataDir, 'certificates.json');
const acmeCertificatesDbPath = path.join(dataDir, 'acme-certificates.json');
const dockerSocketPath = process.env.DOCKER_SOCKET_PATH || '/var/run/docker.sock';
const dockerApiVersion = process.env.DOCKER_API_VERSION || '1.47';
const acmeLogSourceContainer = process.env.ACME_LOG_SOURCE_CONTAINER || 'ca_authority';
const acmeLogPollIntervalMs = Number(process.env.ACME_LOG_POLL_INTERVAL_MS || 60000);
const acmeLogInitialLookbackSeconds = Number(process.env.ACME_LOG_INITIAL_LOOKBACK_SECONDS || 604800);
const acmeLogOverlapSeconds = Number(process.env.ACME_LOG_OVERLAP_SECONDS || 10);

// Path to the Step CA certificate + key (mounted read-only into the backend container)
const caCertPath = '/home/step/certs/certs/intermediate_ca.crt';
const caKeyPath = '/home/step/certs/secrets/intermediate_ca_key';

// Axios instance with self-signed cert support
const axiosInstance = axios.create({
  httpsAgent: new https.Agent({
    rejectUnauthorized: false
  })
});

function ensureDataDir() {
  fs.mkdirSync(dataDir, { recursive: true });
}

function toPublicCertificate(certificate) {
  const { certPem: _c, keyPem: _k, ...publicCert } = certificate;
  return publicCert;
}

function toFilenameBase(commonName) {
  const safeName = String(commonName || 'certificate')
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return safeName || 'certificate';
}

function loadCertificates() {
  ensureDataDir();

  if (!fs.existsSync(certificatesDbPath)) {
    return new Map();
  }

  try {
    const raw = fs.readFileSync(certificatesDbPath, 'utf8');
    if (!raw.trim()) {
      return new Map();
    }

    const certificates = JSON.parse(raw);
    return new Map(certificates.map((certificate) => [certificate.id, certificate]));
  } catch (error) {
    console.error(`Failed to load certificates from ${certificatesDbPath}:`, error);
    return new Map();
  }
}

function saveCertificates(certificates) {
  ensureDataDir();

  const tmpPath = `${certificatesDbPath}.tmp`;
  const serialized = JSON.stringify(Array.from(certificates.values()), null, 2);
  fs.writeFileSync(tmpPath, serialized);
  fs.renameSync(tmpPath, certificatesDbPath);
}

function loadAcmeTrackerState() {
  ensureDataDir();

  if (!fs.existsSync(acmeCertificatesDbPath)) {
    return {
      lastCheckedAt: null,
      certificates: []
    };
  }

  try {
    const raw = fs.readFileSync(acmeCertificatesDbPath, 'utf8');
    if (!raw.trim()) {
      return {
        lastCheckedAt: null,
        certificates: []
      };
    }

    const parsed = JSON.parse(raw);
    return {
      lastCheckedAt: parsed.lastCheckedAt || null,
      certificates: Array.isArray(parsed.certificates) ? parsed.certificates : []
    };
  } catch (error) {
    console.error(`Failed to load ACME tracker state from ${acmeCertificatesDbPath}:`, error);
    return {
      lastCheckedAt: null,
      certificates: []
    };
  }
}

function saveAcmeTrackerState(state) {
  ensureDataDir();

  const tmpPath = `${acmeCertificatesDbPath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2));
  fs.renameSync(tmpPath, acmeCertificatesDbPath);
}

function parseLogValue(value) {
  if (!value) {
    return '';
  }

  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value);
    } catch {
      return value.slice(1, -1);
    }
  }

  return value;
}

function parseStructuredLogFields(message) {
  const fields = {};
  const pattern = /([A-Za-z][A-Za-z0-9_.-]*)=("(?:\\.|[^"])*"|\S*)/g;
  let match;

  while ((match = pattern.exec(message)) !== null) {
    fields[match[1]] = parseLogValue(match[2]);
  }

  return fields;
}

function decodeDockerLogStream(buffer) {
  if (!buffer || buffer.length === 0) {
    return '';
  }

  // Docker returns multiplexed stdout/stderr frames for non-TTY containers.
  if (buffer.length >= 8 && buffer[1] === 0 && buffer[2] === 0 && buffer[3] === 0) {
    let offset = 0;
    let output = '';

    while (offset + 8 <= buffer.length) {
      const payloadLength = buffer.readUInt32BE(offset + 4);
      offset += 8;

      if (offset + payloadLength > buffer.length) {
        break;
      }

      output += buffer.subarray(offset, offset + payloadLength).toString('utf8');
      offset += payloadLength;
    }

    return output;
  }

  return buffer.toString('utf8');
}

function parseSubjectCommonName(subject = '') {
  const match = String(subject).match(/(?:^|\n)\s*CN\s*=\s*([^\n]+)/);
  return match ? match[1].trim() : '';
}

function parseSubjectAltNames(subjectAltName = '') {
  return String(subjectAltName)
    .split(/\s*,\s*/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const separatorIndex = entry.indexOf(':');
      if (separatorIndex === -1) {
        return { type: 'unknown', value: entry };
      }

      return {
        type: entry.slice(0, separatorIndex).trim(),
        value: entry.slice(separatorIndex + 1).trim()
      };
    });
}

function normalizeIsoDate(value, fallback = null) {
  if (!value) {
    return fallback;
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
}

function parseLoggedCertificate(certificateBase64) {
  if (!certificateBase64) {
    return null;
  }

  try {
    const wrapped = certificateBase64.match(/.{1,64}/g)?.join('\n') || certificateBase64;
    const pem = `-----BEGIN CERTIFICATE-----\n${wrapped}\n-----END CERTIFICATE-----\n`;
    const parsed = new crypto.X509Certificate(pem);
    const altNames = parseSubjectAltNames(parsed.subjectAltName || '');
    const dnsNames = altNames
      .filter((entry) => entry.type === 'DNS')
      .map((entry) => entry.value);

    return {
      commonName: parseSubjectCommonName(parsed.subject),
      dnsNames,
      subjectAltNames: altNames,
      issuer: parsed.issuer,
      serialHex: parsed.serialNumber,
      validFrom: normalizeIsoDate(parsed.validFrom),
      validTo: normalizeIsoDate(parsed.validTo)
    };
  } catch (error) {
    console.error('Failed to parse logged ACME certificate:', error.message);
    return null;
  }
}

function buildAcmeCertificateRecord(dockerTimestamp, fields) {
  if (fields.method !== 'POST') {
    return null;
  }

  if (!fields.path || !fields.path.includes('/acme/') || !fields.path.includes('/certificate/')) {
    return null;
  }

  if (!fields.certificate) {
    return null;
  }

  const parsedCertificate = parseLoggedCertificate(fields.certificate) || {};
  const certificateId = fields.path.split('/').pop() || '';
  const dnsNames = parsedCertificate.dnsNames || [];
  const commonName = parsedCertificate.commonName || dnsNames[0] || '';
  const validFrom = normalizeIsoDate(fields['valid-from'], parsedCertificate.validFrom || dockerTimestamp);
  const expiresAt = normalizeIsoDate(fields['valid-to'], parsedCertificate.validTo);
  const issuedAt = validFrom || normalizeIsoDate(dockerTimestamp);
  const logTimestamp = normalizeIsoDate(dockerTimestamp);

  return {
    id: fields.serial || parsedCertificate.serialHex || certificateId || crypto.randomUUID(),
    certificateId,
    commonName,
    displayName: commonName || dnsNames[0] || 'ACME certificate',
    dnsNames,
    subjectAltNames: parsedCertificate.subjectAltNames || [],
    issuer: fields.issuer || parsedCertificate.issuer || '',
    serial: fields.serial || '',
    serialHex: parsedCertificate.serialHex || '',
    issuedAt,
    validFrom,
    expiresAt,
    provisioner: fields.provisioner || '',
    statusCode: Number(fields.status || 0) || null,
    source: 'step-ca-log',
    sourceContainer: acmeLogSourceContainer,
    log: {
      timestamp: logTimestamp,
      method: fields.method || '',
      path: fields.path || '',
      requestId: fields['request-id'] || '',
      remoteAddress: fields['remote-address'] || '',
      userAgent: fields['user-agent'] || '',
      duration: fields.duration || '',
      durationNs: fields['duration-ns'] || '',
      size: fields.size || '',
      issuer: fields.issuer || '',
      publicKey: fields['public-key'] || ''
    }
  };
}

function isCertificateCurrentlyValid(certificate) {
  if (!certificate?.expiresAt) {
    return false;
  }

  const now = Date.now();
  const validFrom = certificate.validFrom ? new Date(certificate.validFrom).getTime() : null;
  const expiresAt = new Date(certificate.expiresAt).getTime();

  if (Number.isNaN(expiresAt)) {
    return false;
  }

  if (validFrom && !Number.isNaN(validFrom) && validFrom > now) {
    return false;
  }

  return expiresAt > now;
}

function summarizeAcmeCertificates(certificatesList) {
  const validCertificates = certificatesList.filter(isCertificateCurrentlyValid);
  return {
    total: certificatesList.length,
    valid: validCertificates.length,
    expired: certificatesList.length - validCertificates.length
  };
}

function getAcmeCertificatesResponse(state) {
  const certificatesList = [...state.certificates].sort((left, right) => {
    const leftTime = new Date(left.issuedAt || left.log?.timestamp || 0).getTime();
    const rightTime = new Date(right.issuedAt || right.log?.timestamp || 0).getTime();
    return rightTime - leftTime;
  });

  return {
    sourceContainer: acmeLogSourceContainer,
    lastCheckedAt: state.lastCheckedAt,
    ...summarizeAcmeCertificates(certificatesList),
    certificates: certificatesList.map((certificate) => ({
      ...certificate,
      isValid: isCertificateCurrentlyValid(certificate)
    }))
  };
}

function dockerApiGet(pathname) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      socketPath: dockerSocketPath,
      path: `/v${dockerApiVersion}${pathname}`,
      method: 'GET'
    }, (response) => {
      const chunks = [];

      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const body = Buffer.concat(chunks);

        if (response.statusCode && response.statusCode >= 400) {
          reject(new Error(`Docker API request failed with status ${response.statusCode}: ${body.toString('utf8')}`));
          return;
        }

        resolve(body);
      });
    });

    request.on('error', reject);
    request.end();
  });
}

async function readContainerLogsSince(containerName, sinceEpochSeconds) {
  const params = new URLSearchParams({
    stdout: '1',
    stderr: '1',
    timestamps: '1',
    since: String(Math.max(0, sinceEpochSeconds))
  });

  const buffer = await dockerApiGet(`/containers/${encodeURIComponent(containerName)}/logs?${params.toString()}`);
  return decodeDockerLogStream(buffer);
}

async function syncAcmeCertificates() {
  const overlapMs = acmeLogOverlapSeconds * 1000;
  const now = new Date();
  const sinceDate = acmeTrackerState.lastCheckedAt
    ? new Date(Math.max(0, new Date(acmeTrackerState.lastCheckedAt).getTime() - overlapMs))
    : new Date(now.getTime() - acmeLogInitialLookbackSeconds * 1000);
  const sinceEpochSeconds = Math.floor(sinceDate.getTime() / 1000);
  const logsText = await readContainerLogsSince(acmeLogSourceContainer, sinceEpochSeconds);
  const certificateMap = new Map(acmeTrackerState.certificates.map((certificate) => [certificate.id, certificate]));
  let newestTimestamp = acmeTrackerState.lastCheckedAt;

  for (const rawLine of logsText.split('\n')) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    const firstSpace = line.indexOf(' ');
    if (firstSpace === -1) {
      continue;
    }

    const dockerTimestamp = line.slice(0, firstSpace);
    const message = line.slice(firstSpace + 1);
    const fields = parseStructuredLogFields(message);
    const record = buildAcmeCertificateRecord(dockerTimestamp, fields);

    if (!record) {
      const normalizedTimestamp = normalizeIsoDate(dockerTimestamp);
      if (normalizedTimestamp && (!newestTimestamp || normalizedTimestamp > newestTimestamp)) {
        newestTimestamp = normalizedTimestamp;
      }
      continue;
    }

    const existing = certificateMap.get(record.id);
    certificateMap.set(record.id, existing ? { ...existing, ...record } : record);

    if (!newestTimestamp || (record.log?.timestamp && record.log.timestamp > newestTimestamp)) {
      newestTimestamp = record.log.timestamp;
    }
  }

  acmeTrackerState = {
    lastCheckedAt: newestTimestamp || now.toISOString(),
    certificates: [...certificateMap.values()].sort((left, right) => {
      const leftTime = new Date(left.issuedAt || left.log?.timestamp || 0).getTime();
      const rightTime = new Date(right.issuedAt || right.log?.timestamp || 0).getTime();
      return rightTime - leftTime;
    })
  };

  saveAcmeTrackerState(acmeTrackerState);
  acmeTrackerStatus.lastRunAt = now.toISOString();
  acmeTrackerStatus.lastSuccessAt = now.toISOString();
  acmeTrackerStatus.lastError = null;
}

function scheduleAcmeTracker() {
  const run = async () => {
    try {
      await syncAcmeCertificates();
    } catch (error) {
      acmeTrackerStatus.lastRunAt = new Date().toISOString();
      acmeTrackerStatus.lastError = error.message;
      console.error('Failed to sync ACME certificates from Step CA logs:', error);
    }
  };

  run();
  setInterval(run, acmeLogPollIntervalMs);
}

function runOpenSSL(args, opts = {}) {
  const result = spawnSync('openssl', args, { encoding: 'utf8', ...opts });
  if (result.status !== 0) {
    const err = result.stderr || result.stdout || 'Unknown error';
    throw new Error(`OpenSSL failed: ${err}`);
  }
  return result.stdout;
}

function generateX509Certificate(commonName, altNames = [], validityDays = 365, keyType = 'ec') {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stepca-'));
  try {
    const keyPath = path.join(tmpDir, 'cert.key');
    const csrPath = path.join(tmpDir, 'cert.csr');
    const certPath = path.join(tmpDir, 'cert.pem');
    const extPath = path.join(tmpDir, 'openssl.ext');

    // Generate private key. RSA is for devices that can't use EC certs
    // (e.g. UniFi OS, which parses its web cert with node-forge).
    if (keyType === 'rsa') {
      runOpenSSL(['genpkey', '-algorithm', 'RSA', '-pkeyopt', 'rsa_keygen_bits:2048', '-out', keyPath]);
    } else {
      runOpenSSL(['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', keyPath]);
    }

    // Build SAN list: always include the commonName plus any additional altNames.
    const sanNames = new Set([commonName, ...altNames]);
    const sanEntries = Array.from(sanNames).map((name) => {
      // For IP addresses, OpenSSL requires the "IP:" prefix.
      const isIpv4 = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(name);
      const isIpv6 = /^[0-9a-fA-F:]+$/.test(name);
      return isIpv4 || isIpv6 ? `IP:${name}` : `DNS:${name}`;
    });
    const san = sanEntries.length > 0 ? `subjectAltName=${sanEntries.join(',')}` : '';
    const extConfig = ` [ req ]
req_extensions = v3_req
[ v3_req ]
keyUsage = digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth, clientAuth
${san}
`;
    fs.writeFileSync(extPath, extConfig);

    // Create CSR
    runOpenSSL([
      'req',
      '-new',
      '-key', keyPath,
      '-out', csrPath,
      '-subj', `/CN=${commonName}`,
      '-config', extPath
    ]);

    // Sign CSR with the CA key
    const passin = caPassword ? `pass:${caPassword}` : '';
    // Use a simple decimal serial (must be numeric) to avoid OpenSSL parsing errors.
    const serial = String(Date.now());

    const signArgs = [
      'x509',
      '-req',
      '-in', csrPath,
      '-CA', caCertPath,
      '-CAkey', caKeyPath,
      '-set_serial', serial,
      '-out', certPath,
      '-days', String(validityDays),
      '-sha256',
      '-extfile', extPath,
      '-extensions', 'v3_req'
    ];

    if (caPassword) {
      signArgs.push('-passin', passin);
    }

    runOpenSSL(signArgs);

    const certPem = fs.readFileSync(certPath, 'utf8');
    const keyPem = fs.readFileSync(keyPath, 'utf8');
    return { certPem, keyPem };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// Middleware
app.use(cors());
app.use(bodyParser.json());

const certificates = loadCertificates();
let acmeTrackerState = loadAcmeTrackerState();
const acmeTrackerStatus = {
  lastRunAt: null,
  lastSuccessAt: null,
  lastError: null
};

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Get CA health
app.get('/api/ca/health', async (req, res) => {
  try {
    // Step CA provides a simple /health endpoint that returns 200 when healthy.
    await axiosInstance.get(`${caUrl}/health`);
    res.json({ status: 'healthy', acme: true });
  } catch (error) {
    res.status(500).json({ error: 'CA health check failed', details: error.message });
  }
});

// Get CA info
app.get('/api/ca/info', async (req, res) => {
  try {
    // Try to resolve a valid ACME directory endpoint; fallback to the canonical URL.
    const candidatePaths = ['/acme/acme/directory', '/acme/directory'];
    let acmeEndpoint = null;

    for (const path of candidatePaths) {
      try {
        const url = `${caUrl}${path}`;
        const response = await axiosInstance.get(url);
        if (response.status === 200) {
          acmeEndpoint = url;
          break;
        }
      } catch {
        // ignore and try next path
      }
    }

    res.json({
      name: 'Home Lab CA',
      status: 'healthy',
      caUrl: caUrl,
      acmeEndpoint: acmeEndpoint || `${caUrl}/acme/acme/directory`,
      acmeTracker: {
        sourceContainer: acmeLogSourceContainer,
        pollIntervalMs: acmeLogPollIntervalMs,
        lastCheckedAt: acmeTrackerState.lastCheckedAt,
        lastRunAt: acmeTrackerStatus.lastRunAt,
        lastSuccessAt: acmeTrackerStatus.lastSuccessAt,
        lastError: acmeTrackerStatus.lastError,
        ...summarizeAcmeCertificates(acmeTrackerState.certificates)
      }
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get CA info' });
  }
});

// Issue a certificate (x509 PEM signed by the CA)
app.post('/api/certificates/issue', async (req, res) => {
  try {
    const { commonName, altNames, validityDays, keyType = 'ec' } = req.body;

    if (!commonName) {
      return res.status(400).json({ error: 'commonName is required' });
    }
    if (!['ec', 'rsa'].includes(keyType)) {
      return res.status(400).json({ error: "keyType must be 'ec' or 'rsa'" });
    }

    const certId = `cert-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const { certPem, keyPem } = generateX509Certificate(commonName, altNames || [], validityDays || 365, keyType);

    const certificate = {
      id: certId,
      commonName,
      altNames: altNames || [],
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + (validityDays || 365) * 24 * 60 * 60 * 1000).toISOString(),
      status: 'issued',
      acmeUri: `${caUrl}/acme/acme/certificate/${certId}`,
      certPem,
      keyPem
    };

    certificates.set(certId, certificate);
    saveCertificates(certificates);

    res.status(201).json(toPublicCertificate(certificate));
  } catch (error) {
    console.error('Certificate issuance failed:', error);
    res.status(500).json({ error: 'Failed to issue certificate', details: error.message });
  }
});

// List all certificates
app.get('/api/certificates', (req, res) => {
  try {
    const certs = Array.from(certificates.values()).map(toPublicCertificate);
    res.json({
      total: certs.length,
      certificates: certs
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to list certificates' });
  }
});

// Get a specific certificate
app.get('/api/certificates/:id', (req, res) => {
  try {
    const cert = certificates.get(req.params.id);
    if (!cert) {
      return res.status(404).json({ error: 'Certificate not found' });
    }
    res.json(cert);
  } catch (error) {
    res.status(500).json({ error: 'Failed to get certificate' });
  }
});

// Download the x509 certificate PEM
// By default this returns the leaf certificate plus the issuing intermediate.
// Optional query param: ?chain=0 to download the leaf cert only.
app.get('/api/certificates/:id/download', (req, res) => {
  try {
    const cert = certificates.get(req.params.id);
    if (!cert) {
      return res.status(404).json({ error: 'Certificate not found' });
    }

    const filename = `certificate-${toFilenameBase(cert.commonName)}.pem`;
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'application/x-pem-file');

    const includeChain = !(req.query.chain === '0' || req.query.chain === 'false');
    const certPem = includeChain
      ? `${cert.certPem}\n${fs.readFileSync(caCertPath, 'utf8')}`
      : cert.certPem;

    res.send(certPem);
  } catch (error) {
    res.status(500).json({ error: 'Failed to download certificate' });
  }
});

// Download the private key (for demo purposes)
app.get('/api/certificates/:id/download-key', (req, res) => {
  try {
    const cert = certificates.get(req.params.id);
    if (!cert) {
      return res.status(404).json({ error: 'Certificate not found' });
    }

    const filename = `certificate-${toFilenameBase(cert.commonName)}.key`;
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'application/x-pem-file');
    res.send(cert.keyPem);
  } catch (error) {
    res.status(500).json({ error: 'Failed to download private key' });
  }
});

// Revoke a certificate
app.post('/api/certificates/:id/revoke', (req, res) => {
  try {
    const cert = certificates.get(req.params.id);
    if (!cert) {
      return res.status(404).json({ error: 'Certificate not found' });
    }
    
    cert.status = 'revoked';
    cert.revokedAt = new Date().toISOString();
    saveCertificates(certificates);
    
    res.json(cert);
  } catch (error) {
    res.status(500).json({ error: 'Failed to revoke certificate' });
  }
});

// Delete a certificate (metadata)
app.delete('/api/certificates/:id', (req, res) => {
  try {
    if (!certificates.has(req.params.id)) {
      return res.status(404).json({ error: 'Certificate not found' });
    }
    certificates.delete(req.params.id);
    saveCertificates(certificates);
    res.json({ message: 'Certificate deleted' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete certificate' });
  }
});

// Get ACME directory (proxy to CA)
app.get('/api/acme/directory', async (req, res) => {
  try {
    const response = await axiosInstance.get(`${caUrl}/acme/acme/directory`);
    res.json(response.data);
  } catch (error) {
    res.status(500).json({ error: 'Failed to get ACME directory' });
  }
});

// List ACME certificates observed in Step CA logs.
app.get('/api/acme/certificates', (req, res) => {
  try {
    res.json({
      ...getAcmeCertificatesResponse(acmeTrackerState),
      tracker: {
        lastRunAt: acmeTrackerStatus.lastRunAt,
        lastSuccessAt: acmeTrackerStatus.lastSuccessAt,
        lastError: acmeTrackerStatus.lastError
      }
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to list ACME certificates' });
  }
});

// Download the CA root certificate (proxy to the CA's /roots.pem)
app.get('/api/ca/root', async (req, res) => {
  try {
    const response = await axiosInstance.get(`${caUrl}/roots.pem`);
    res.setHeader('Content-Disposition', 'attachment; filename="root_ca.pem"');
    res.setHeader('Content-Type', 'application/x-pem-file');
    res.send(response.data);
  } catch (error) {
    res.status(500).json({ error: 'Failed to download CA root certificate' });
  }
});

// Download the issuing intermediate CA certificate.
app.get('/api/ca/intermediate', (req, res) => {
  try {
    res.setHeader('Content-Disposition', 'attachment; filename="intermediate_ca.pem"');
    res.setHeader('Content-Type', 'application/x-pem-file');
    res.send(fs.readFileSync(caCertPath, 'utf8'));
  } catch (error) {
    res.status(500).json({ error: 'Failed to download CA intermediate certificate' });
  }
});

// Error handling
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(port, () => {
  console.log(`CA Backend API listening on port ${port}`);
  console.log(`CA URL: ${caUrl}`);
  console.log(`ACME log source container: ${acmeLogSourceContainer}`);
  scheduleAcmeTracker();
});
