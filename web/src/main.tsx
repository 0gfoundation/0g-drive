import React from 'react'
import ReactDOM from 'react-dom/client'
import { setNodeRelay } from '@0gdrive/core'
import App from './App'
import './style.css'

// Storage nodes speak plain HTTP, which an https page may not call: route
// them through this site's relay (api/node.ts). VITE_NODE_RELAY=1 uses the
// relay in local dev too.
if (location.protocol === 'https:' || import.meta.env.VITE_NODE_RELAY) setNodeRelay(`${location.origin}/_node/`)

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
