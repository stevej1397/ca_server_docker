import { useState, useEffect } from 'react'
import api from '../services/api'
import './Dashboard.css'

function Dashboard({ caHealth, caInfo }) {
  const [certCount, setCertCount] = useState(0)
  const [expiringSoon, setExpiringSoon] = useState(0)
  const [acmeCertificates, setAcmeCertificates] = useState([])
  const [acmeTracker, setAcmeTracker] = useState(null)

  useEffect(() => {
    const fetchStats = async () => {
      try {
        const [certificateResponse, acmeResponse] = await Promise.all([
          api.get('/certificates'),
          api.get('/acme/certificates').catch(() => null),
        ])

        setCertCount(certificateResponse.data.total)
        
        const now = new Date()
        const thirtyDaysFromNow = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000)
        
        const expiring = certificateResponse.data.certificates.filter(cert => {
          const expiresAt = new Date(cert.expiresAt)
          return expiresAt <= thirtyDaysFromNow && expiresAt > now && cert.status === 'issued'
        }).length
        
        setExpiringSoon(expiring)

        if (acmeResponse?.data) {
          setAcmeTracker({
            total: acmeResponse.data.total,
            valid: acmeResponse.data.valid,
            expired: acmeResponse.data.expired,
            lastCheckedAt: acmeResponse.data.lastCheckedAt,
            lastSuccessAt: acmeResponse.data.tracker?.lastSuccessAt,
            lastError: acmeResponse.data.tracker?.lastError,
          })
          setAcmeCertificates(acmeResponse.data.certificates || [])
        }
      } catch (error) {
        console.error('Failed to fetch stats:', error)
      }
    }

    fetchStats()
    const interval = setInterval(fetchStats, 30000)
    return () => clearInterval(interval)
  }, [])

  const recentAcmeCertificates = acmeCertificates.slice(0, 5)

  const formatDateTime = (value) => {
    if (!value) {
      return 'Unknown'
    }

    const date = new Date(value)
    if (Number.isNaN(date.getTime())) {
      return value
    }

    return date.toLocaleString()
  }

  return (
    <div className="dashboard">
      <h1>Dashboard</h1>
      
      <div className="stats-grid">
        <div className="stat-card">
          <h3>CA Status</h3>
          {caHealth ? (
            <div>
              <p className="stat-value">
                <span className="status-badge status-healthy">🟢 Healthy</span>
              </p>
              <p className="stat-detail">CA is operational and accepting requests</p>
            </div>
          ) : (
            <div>
              <p className="stat-value">
                <span className="status-badge status-error">🔴 Offline</span>
              </p>
              <p className="stat-detail">Unable to reach CA service</p>
            </div>
          )}
        </div>

        <div className="stat-card">
          <h3>Certificates</h3>
          <p className="stat-value">{certCount}</p>
          <p className="stat-detail">App-issued certificates</p>
          <p className="stat-subdetail">
            ACME valid: {acmeTracker?.valid ?? 0}
          </p>
          <p className="stat-detail">
            {acmeTracker?.lastError
              ? 'Tracker has a sync error'
              : `${acmeTracker?.total ?? 0} observed in Step CA logs`}
          </p>
        </div>

        <div className="stat-card">
          <h3>Expiring Soon</h3>
          <p className="stat-value">{expiringSoon}</p>
          <p className="stat-detail">Within 30 days</p>
        </div>

        <div className="stat-card">
          <h3>ACME Endpoint</h3>
          <p className="stat-value">Active</p>
          <p className="stat-detail">{caInfo?.acmeEndpoint || 'Initializing...'}</p>
        </div>
      </div>

      <div className="info-section">
        <h2>Getting Started</h2>
        <div className="info-card">
          <h3>1. Issue Certificates</h3>
          <p>Click "Issue Certificate" to generate new certificates for your services.</p>
        </div>
        <div className="info-card">
          <h3>2. Use ACME Protocol</h3>
          <p>Configure your services to use this CA's ACME endpoint for automatic certificate provisioning.</p>
        </div>
        <div className="info-card">
          <h3>3. Manage Certificates</h3>
          <p>View all issued certificates, monitor expiration dates, and revoke certificates as needed.</p>
        </div>
      </div>

      <div className="card">
        <h2>Recent ACME Certificates</h2>
        {acmeTracker?.lastError && (
          <p className="tracker-error">{acmeTracker.lastError}</p>
        )}
        {recentAcmeCertificates.length > 0 ? (
          <table>
            <thead>
              <tr>
                <th>Certificate</th>
                <th>Expires</th>
                <th>Source</th>
              </tr>
            </thead>
            <tbody>
              {recentAcmeCertificates.map((certificate) => (
                <tr key={certificate.id}>
                  <td>
                    <div>{certificate.displayName}</div>
                    <div className="acme-cert-detail monospace">
                      {(certificate.dnsNames && certificate.dnsNames.length > 0
                        ? certificate.dnsNames.join(', ')
                        : certificate.log?.path) || 'No SANs captured'}
                    </div>
                  </td>
                  <td>{formatDateTime(certificate.expiresAt)}</td>
                  <td>
                    <div>{certificate.provisioner || 'acme'}</div>
                    <div className="acme-cert-detail">
                      {certificate.log?.userAgent || 'Unknown client'}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p>No ACME-issued certificates have been observed in the Step CA logs yet.</p>
        )}
        <p className="stat-detail">
          Last synced: {formatDateTime(acmeTracker?.lastSuccessAt || acmeTracker?.lastCheckedAt)}
        </p>
      </div>

      {caInfo && (
        <div className="card">
          <h2>CA Information</h2>
          <table>
            <tbody>
              <tr>
                <td><strong>CA Name:</strong></td>
                <td>{caInfo.name}</td>
              </tr>
              <tr>
                <td><strong>CA URL:</strong></td>
                <td className="monospace">{caInfo.caUrl}</td>
              </tr>
              <tr>
                <td><strong>ACME Directory:</strong></td>
                <td className="monospace">{caInfo.acmeEndpoint}</td>
              </tr>
              <tr>
                <td><strong>Root Certificate:</strong></td>
                <td>
                  <div>
                    <a
                      href="/api/ca/root"
                      target="_blank"
                      rel="noopener noreferrer"
                      download
                    >
                      Download CA root cert
                    </a>
                  </div>
                  <div>
                    <a
                      href="/api/ca/intermediate"
                      target="_blank"
                      rel="noopener noreferrer"
                      download
                    >
                      Download CA intermediate cert
                    </a>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

export default Dashboard
