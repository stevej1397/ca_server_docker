import { useState, useEffect } from 'react'
import './App.css'
import Dashboard from './components/Dashboard'
import CertificateList from './components/CertificateList'
import IssueCertificate from './components/IssueCertificate'
import api from './services/api'

function App() {
  const [currentPage, setCurrentPage] = useState('dashboard')
  const [caHealth, setCaHealth] = useState(null)
  const [caInfo, setCaInfo] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const fetchCAStatus = async () => {
      try {
        const [health, info] = await Promise.all([
          api.get('/ca/health').catch(() => null),
          api.get('/ca/info').catch(() => null),
        ])
        setCaHealth(health?.data)
        setCaInfo(info?.data)
      } catch (error) {
        console.error('Failed to fetch CA status:', error)
      } finally {
        setLoading(false)
      }
    }
    
    fetchCAStatus()
    const interval = setInterval(fetchCAStatus, 30000)
    return () => clearInterval(interval)
  }, [])

  const renderPage = () => {
    switch(currentPage) {
      case 'dashboard':
        return <Dashboard caHealth={caHealth} caInfo={caInfo} />
      case 'certificates':
        return <CertificateList />
      case 'issue':
        return <IssueCertificate onSuccess={() => setCurrentPage('certificates')} />
      default:
        return <Dashboard caHealth={caHealth} caInfo={caInfo} />
    }
  }

  return (
    <div className="app">
      <nav className="navbar">
        <div className="nav-container">
          <h1 className="nav-logo">🔐 Home Lab CA</h1>
          <ul className="nav-menu">
            <li><button onClick={() => setCurrentPage('dashboard')} className={currentPage === 'dashboard' ? 'active' : ''}>Dashboard</button></li>
            <li><button onClick={() => setCurrentPage('certificates')} className={currentPage === 'certificates' ? 'active' : ''}>Certificates</button></li>
            <li><button onClick={() => setCurrentPage('issue')} className="btn-primary">+ Issue Certificate</button></li>
          </ul>
        </div>
      </nav>

      <main className="main-content">
        {loading && <div className="loading">Loading...</div>}
        {!loading && renderPage()}
      </main>

      <footer className="footer">
        <p>&copy; 2024 Home Lab Certificate Authority</p>
      </footer>
    </div>
  )
}

export default App
