import { Component, ReactNode } from 'react';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error?: Error;
}

/**
 * Catches render errors in child components and shows a recovery card
 * instead of a blank white screen.
 */
export default class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: any) {
    console.error('[ErrorBoundary]', error, info);
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;
      return (
        <div className="error-boundary">
          <div className="error-boundary-title">Something went wrong</div>
          <div className="error-boundary-message">
            An unexpected error occurred. Try reloading the app. If the issue persists, report it on GitHub.
          </div>
          {this.state.error && (
            <div className="error-boundary-details">
              {this.state.error.message}
              {this.state.error.stack && '\n\n' + this.state.error.stack.slice(0, 500)}
            </div>
          )}
          <button className="btn primary" onClick={() => window.location.reload()}>
            Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
