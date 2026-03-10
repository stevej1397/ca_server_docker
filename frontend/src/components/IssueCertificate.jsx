import { useState } from 'react'
import api from '../services/api'
import './IssueCertificate.css'

function IssueCertificate({ onSuccess }) {
  const [formData, setFormData] = useState({
    commonName: '',
    altNames: '',
    validityDays: 365
  })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [success, setSuccess] = useState(false)
  const [issuedCert, setIssuedCert] = useState(null)

  const handleChange = (e) => {
    const { name, value } = e.target
    setFormData(prev => ({
      ...prev,
      [name]: value
    }))
  }

  const handleSubmit = async (e) => {
    e.preventDefault()
    
    if (!formData.commonName.trim()) {
      setError('Common Name is required')
      return
    }

    try {
      setLoading(true)
      setError(null)
      
      const altNamesArray = formData.altNames
        .split(',')
        .map(name => name.trim())
        .filter(name => name.length > 0)

      const response = await api.post('/certificates/issue', {
        commonName: formData.commonName,
        altNames: altNamesArray,
        validityDays: parseInt(formData.validityDays)
      })

      setIssuedCert(response.data)
      setSuccess(true)
      setFormData({
        commonName: '',
        altNames: '',
        validityDays: 365
      })

      setTimeout(() => {
        onSuccess()
      }, 2000)
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to issue certificate')
      console.error(err)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="issue-certificate">
      <h1>Issue New Certificate</h1>

      {error && <div className="alert alert-error">{error}</div>}
      
      {success && (
        <div className="alert alert-success">
          ✓ Certificate issued successfully! Redirecting...
        </div>
      )}

      {issuedCert && (
        <div className="card success-details">
          <h2>Certificate Details</h2>
          <table>
            <tbody>
              <tr>
                <td><strong>ID:</strong></td>
                <td className="monospace">{issuedCert.id}</td>
              </tr>
              <tr>
                <td><strong>Common Name:</strong></td>
                <td className="monospace">{issuedCert.commonName}</td>
              </tr>
              <tr>
                <td><strong>Alt Names:</strong></td>
                <td className="monospace">{issuedCert.altNames.length > 0 ? issuedCert.altNames.join(', ') : '-'}</td>
              </tr>
              <tr>
                <td><strong>Issued At:</strong></td>
                <td>{new Date(issuedCert.issuedAt).toLocaleString()}</td>
              </tr>
              <tr>
                <td><strong>Expires At:</strong></td>
                <td>{new Date(issuedCert.expiresAt).toLocaleString()}</td>
              </tr>
              <tr>
                <td><strong>Status:</strong></td>
                <td><span className="status-badge">{issuedCert.status}</span></td>
              </tr>
            </tbody>
          </table>
        </div>
      )}

      <div className="card">
        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label htmlFor="commonName">Common Name (CN) *</label>
            <input
              type="text"
              id="commonName"
              name="commonName"
              value={formData.commonName}
              onChange={handleChange}
              placeholder="e.g., example.local or api.home.lab"
              disabled={loading}
              required
            />
            <small>The primary domain or hostname for the certificate</small>
          </div>

          <div className="form-group">
            <label htmlFor="altNames">Alternative Names (SANs)</label>
            <input
              type="text"
              id="altNames"
              name="altNames"
              value={formData.altNames}
              onChange={handleChange}
              placeholder="e.g., www.example.local, mail.example.local"
              disabled={loading}
            />
            <small>Optional: Comma-separated list of additional domains</small>
          </div>

          <div className="form-group">
            <label htmlFor="validityDays">Validity (Days)</label>
            <input
              type="number"
              id="validityDays"
              name="validityDays"
              value={formData.validityDays}
              onChange={handleChange}
              min="1"
              max="3650"
              disabled={loading}
            />
            <small>How long the certificate will be valid (1-3650 days)</small>
          </div>

          <button 
            type="submit" 
            className="btn-primary btn-large"
            disabled={loading}
          >
            {loading ? 'Issuing...' : '🔐 Issue Certificate'}
          </button>
        </form>
      </div>

      <div className="card info">
        <h2>Tips for Home Lab</h2>
        <ul>
          <li><strong>Internal Domains:</strong> Use .local, .home.lab, or other non-routable TLDs</li>
          <li><strong>Validity:</strong> Longer validity periods reduce renewal operations</li>
          <li><strong>SANs:</strong> Always include all domain variations for your service</li>
          <li><strong>Trust:</strong> Add your CA's root certificate to your devices' trust store</li>
        </ul>
      </div>
    </div>
  )
}

export default IssueCertificate
