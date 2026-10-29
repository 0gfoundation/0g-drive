import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { allowedParents, parentOrigin } from './bridge'
import './style.css'

// The assistant only runs inside the drive's panel. Opened on its own (or
// framed by a page that isn't an allowed drive) it shows a pointer to the
// drive instead. The host also redirects direct visits (vercel.json); this
// covers browsers that don't send Sec-Fetch-Dest. Dev keeps the standalone
// page for working on the assistant by itself.
function Elsewhere() {
  const drive = allowedParents().find((o) => !o.includes('*'))
  return (
    <main className="elsewhere">
      <h1>0G Assistant</h1>
      <p>The assistant is part of 0GDrive. Open it with the Ask button inside the drive.</p>
      {drive && <a href={drive}>Go to 0GDrive</a>}
    </main>
  )
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>{parentOrigin || import.meta.env.DEV ? <App /> : <Elsewhere />}</React.StrictMode>
)
