import { useState, useEffect } from 'react'
import api from '../services/api'
import './Dashboard.css'

function Dashboard({ caHealth, caInfo }) {
  const [certCount, setCertCount] = useState(0)
  const [expiringSoon, setExpiringSoon] = useState(0)

  useEffect(() => {
    const fetchStats = async () => {
      try {
        const response = await api.get('/certificates')
        setCertCount(response.data.total)
        
        const now = new Date()
        const thirtyDaysFromNow = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000)
        
        const expiring = response.data.certificates.filter(cert => {
          const expiresAt = new Date(cert.expiresAt)
          return expiresAt <= thirtyDaysFromNow && expiresAt > now && cert.status === 'issued'
        }).length
        
        setExpiringSoon(expiring)
      } catch (error) {
        console.error('Failed to fetch stats:', error)
      }
    }

    fetchStats()
  }, [])

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
          <h3>Total Certificates</h3>
          <p className="stat-value">{certCount}</p>
          <p className="stat-detail">Issued certificates</p>
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
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

export default Dashboard
