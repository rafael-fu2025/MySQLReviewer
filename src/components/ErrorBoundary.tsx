import { Component, type ErrorInfo, type ReactNode } from 'react';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * Last line of defence for route render and lazy-chunk failures. Without it,
 * React unmounts the whole tree and the browser shows an empty page until the
 * user manually reloads.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[mylens] UI render failed:', error, info.componentStack);
  }

  private readonly retry = (): void => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="flex min-h-screen items-center justify-center bg-canvas p-6">
        <div className="route-error-card">
          <div className="flex items-center gap-3">
            <div className="route-error-icon">!</div>
            <div>
              <div className="text-lg font-bold text-ink">This page could not load.</div>
              <div className="text-xs text-muted">
                Your accounts, connections, history, and challenges remain saved on this machine.
              </div>
            </div>
          </div>

          <details className="route-error-details">
            <summary>Technical details</summary>
            <pre className="route-error-pre">{error.message}</pre>
          </details>

          <div className="flex flex-wrap gap-2">
            <button type="button" className="button button-primary" onClick={this.retry}>
              Try again
            </button>
            <button
              type="button"
              className="button button-secondary"
              onClick={() => window.location.reload()}
            >
              Reload app
            </button>
          </div>
        </div>
      </div>
    );
  }
}
