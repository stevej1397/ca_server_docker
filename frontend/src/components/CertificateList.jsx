import { useState, useEffect } from 'react'
import api from '../services/api'
import './CertificateList.css'

function CertificateList() {
  const [certificates, setCertificates] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [filter, setFilter] = useState('all')

  useEffect(() => {
    fetchCertificates()
  }, [])

  const fetchCertificates = async () => {
    try {
      setLoading(true)
      const response = await api.get('/certificates')
      setCertificates(response.data.certificates || [])
      setError(null)
    } catch (err) {
      setError('Failed to load certificates')
      console.error(err)
    } finally {
      setLoading(false)
    }
  }

  const revokeCertificate = async (id) => {
    if (!window.confirm('Are you sure you want to revoke this certificate?')) {
      return
    }

    try {
      await api.post(`/certificates/${id}/revoke`)
      await fetchCertificates()
    } catch (err) {
      setError('Failed to revoke certificate')
      console.error(err)
    }
  }

  const deleteCertificate = async (id) => {
    if (!window.confirm('Are you sure you want to delete this certificate record?')) {
      return
    }

    try {
      await api.delete(`/certificates/${id}`)
      await fetchCertificates()
    } catch (err) {
      setError('Failed to delete certificate')
      console.error(err)
    }
  }

  const getStatusBadgeClass = (status) => {
    switch(status) {
      case 'issued':
        return 'status-badge'
      case 'revoked':
        return 'status-badge status-revoked'
      case 'expired':
        return 'status-badge status-error'
      default:
        return 'status-badge status-pending'
    }
  }

  const isNearExpiry = (expiresAt) => {
    const now = new Date()
    const expires = new Date(expiresAt)
    const daysUntilExpiry = (expires - now) / (1000 * 60 * 60 * 24)
    return daysUntilExpiry < 30 && daysUntilExpiry > 0
  }

  const filteredCerts = certificates.filter(cert => {
    if (filter === 'all') return true
    return cert.status === filter
  })

  return (
    <div className="certificate-list">
      <div className="list-header">
        <h1>Certificates</h1>
        <button className="btn-primary" onClick={fetchCertificates}>🔄 Refresh</button>
      </div>

      {error && <div className="alert alert-error">{error}</div>}

      <div className="filter-controls">
        <button 
          className={filter === 'all' ? 'filter-btn active' : 'filter-btn'}
          onClick={() => setFilter('all')}
        >
          All ({certificates.length})
        </button>
        <button 
          className={filter === 'issued' ? 'filter-btn active' : 'filter-btn'}
          onClick={() => setFilter('issued')}
        >
          Issued ({certificates.filter(c => c.status === 'issued').length})
        </button>
        <button 
          className={filter === 'revoked' ? 'filter-btn active' : 'filter-btn'}
          onClick={() => setFilter('revoked')}
        >
          Revoked ({certificates.filter(c => c.status === 'revoked').length})
        </button>
      </div>

      {loading ? (
        <div className="loading">Loading certificates...</div>
      ) : filteredCerts.length === 0 ? (
        <div className="empty-state">
          <p>No certificates found</p>
        </div>
      ) : (
        <div className="table-container">
          <table>
            <thead>
              <tr>
                <th>Common Name</th>
                <th>Alt Names</th>
                <th>Status</th>
                <th>Issued</th>
                <th>Expires</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredCerts.map(cert => (
                <tr key={cert.id} className={isNearExpiry(cert.expiresAt) ? 'warning' : ''}>
                  <td className="monospace">{cert.commonName}</td>
                  <td>{cert.altNames?.length > 0 ? cert.altNames.join(', ') : '-'}</td>
                  <td>
                    <span className={getStatusBadgeClass(cert.status)}>
                      {cert.status}
                    </span>
                  </td>
                  <td>{new Date(cert.issuedAt).toLocaleDateString()}</td>
                  <td>
                    {new Date(cert.expiresAt).toLocaleDateString()}
                    {isNearExpiry(cert.expiresAt) && <span className="expiry-warning"> ⚠️</span>}
                  </td>
                  <td className="actions">
                    {cert.status === 'issued' && (
                      <button 
                        className="btn-danger btn-sm"
                        onClick={() => revokeCertificate(cert.id)}
                      >
                        Revoke
                      </button>
                    )}
                    <button 
                      className="btn-delete btn-sm"
                      onClick={() => deleteCertificate(cert.id)}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

export default CertificateList
