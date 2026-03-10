import axios from 'axios'

const API_URL = import.meta.env.REACT_APP_API_URL || 'http://localhost:3001/api'

const api = axios.create({
  baseURL: API_URL,
  timeout: 10000,
})

export default api
