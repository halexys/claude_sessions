import { Component } from 'react'

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error) {
    return { error: error?.message || String(error) }
  }

  render() {
    if (this.state.error) {
      return (
        <div className="min-h-screen bg-slate-900 flex items-center justify-center p-6">
          <div className="w-full max-w-sm bg-red-950 border border-red-800 rounded-2xl p-6">
            <h2 className="text-red-400 font-bold text-lg mb-3">Error JS</h2>
            <pre className="text-red-300 text-xs whitespace-pre-wrap break-all">{this.state.error}</pre>
            <button
              onClick={() => this.setState({ error: null })}
              className="mt-4 w-full py-3 bg-slate-700 text-white rounded-xl"
            >
              Reintentar
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
