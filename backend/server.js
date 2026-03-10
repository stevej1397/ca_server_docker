import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import dotenv from 'dotenv';
import axios from 'axios';

dotenv.config();

const app = express();
const port = process.env.PORT || 3001;
const caUrl = process.env.CA_URL || 'http://ca:9000';

// Middleware
app.use(cors());
app.use(bodyParser.json());

// In-memory storage for certificates (for demo purposes)
const certificates = new Map();

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Get CA health
app.get('/api/ca/health', async (req, res) => {
  try {
    const response = await axios.get(`${caUrl}/health`);
    res.json(response.data);
  } catch (error) {
    res.status(500).json({ error: 'CA health check failed', details: error.message });
  }
});

// Get CA info
app.get('/api/ca/info', async (req, res) => {
  try {
    // In a real implementation, you would query CA details
    res.json({
      name: 'Home Lab CA',
      status: 'healthy',
      caUrl: caUrl,
      acmeEndpoint: `${caUrl}/acme/acme/directory`
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get CA info' });
  }
});

// Issue a certificate
app.post('/api/certificates/issue', async (req, res) => {
  try {
    const { commonName, altNames, validityDays } = req.body;
    
    if (!commonName) {
      return res.status(400).json({ error: 'commonName is required' });
    }

    // Validate input
    const certId = `cert-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    
    const certificate = {
      id: certId,
      commonName,
      altNames: altNames || [],
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + (validityDays || 365) * 24 * 60 * 60 * 1000).toISOString(),
      status: 'issued',
      acmeUri: `${caUrl}/acme/acme/certificate/${certId}`
    };

    certificates.set(certId, certificate);
    res.status(201).json(certificate);
  } catch (error) {
    res.status(500).json({ error: 'Failed to issue certificate', details: error.message });
  }
});

// List all certificates
app.get('/api/certificates', (req, res) => {
  try {
    const certs = Array.from(certificates.values());
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

// Revoke a certificate
app.post('/api/certificates/:id/revoke', (req, res) => {
  try {
    const cert = certificates.get(req.params.id);
    if (!cert) {
      return res.status(404).json({ error: 'Certificate not found' });
    }
    
    cert.status = 'revoked';
    cert.revokedAt = new Date().toISOString();
    
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
    res.json({ message: 'Certificate deleted' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete certificate' });
  }
});

// Get ACME directory (proxy to CA)
app.get('/api/acme/directory', async (req, res) => {
  try {
    const response = await axios.get(`${caUrl}/acme/acme/directory`);
    res.json(response.data);
  } catch (error) {
    res.status(500).json({ error: 'Failed to get ACME directory' });
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
});
