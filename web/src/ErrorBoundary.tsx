import { Component, type ErrorInfo, type ReactNode } from 'react'

/**
 * Last line of defence: an error while rendering would otherwise unmount
 * the whole app and leave a blank page. Shows what went wrong and a reload
 * instead. Nothing is lost by reloading — the drive lives on 0G.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[app] render failed', error, info.componentStack)
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <div className="crash" role="alert">
        <h1>Something went wrong</h1>
        <p className="muted">
          The page hit an error and stopped. Your files are safe — they're stored on 0G, not in this page.
        </p>
        <pre className="crash-detail">{error.message}</pre>
        <button className="btn primary" onClick={() => location.reload()}>
          Reload
        </button>
      </div>
    )
  }
}
