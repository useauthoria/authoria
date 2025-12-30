/**
 * Error Boundary Component
 * Catches React errors and displays a user-friendly error UI
 */
import { Component, ReactNode, ErrorInfo } from 'react';

interface ErrorBoundaryProps {
  children: ReactNode;
  onError?: (error: Error, errorInfo: ErrorInfo) => void;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      errorInfo: null,
    };
  }

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return {
      hasError: true,
      error,
    };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    this.setState({
      error,
      errorInfo,
    });

    if (this.props.onError) {
      this.props.onError(error, errorInfo);
    }

    console.error('ErrorBoundary caught an error:', error, errorInfo);
  }

  handleReset = (): void => {
    this.setState({
      hasError: false,
      error: null,
      errorInfo: null,
    });
  };

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-gray-50 p-4">
          <div className="max-w-2xl w-full bg-white rounded-xl border border-gray-200 shadow-sm p-6 sm:p-8">
            <div className="mb-6">
              <h1 className="text-2xl font-bold text-gray-900 mb-2">Something went wrong</h1>
              <div className="bg-red-50 border border-red-200 rounded-lg p-4">
                <h2 className="text-sm font-semibold text-red-900 mb-2">An error occurred</h2>
                <div className="space-y-4">
                  <p className="text-sm text-red-700">
                    We're sorry, but something unexpected happened. Please try refreshing the page.
                  </p>
                  {import.meta.env.DEV && this.state.error && (
                    <div className="bg-gray-50 rounded-lg p-4 border border-gray-200">
                      <div className="space-y-2">
                        <p className="text-sm font-medium text-gray-900">Error Details (Development Only):</p>
                        <p className="text-xs text-gray-600 font-mono">{this.state.error.toString()}</p>
                        {this.state.errorInfo && (
                          <p className="text-xs text-gray-600 font-mono whitespace-pre-wrap">
                            {this.state.errorInfo.componentStack}
                          </p>
                        )}
                      </div>
                    </div>
                  )}
                  <div className="flex gap-3">
                    <button
                      onClick={this.handleReset}
                      className="px-4 py-2 bg-purple-600 text-white rounded-lg text-sm font-medium hover:bg-purple-700 transition-colors focus:outline-none focus:ring-2 focus:ring-purple-500 focus:ring-offset-2"
                    >
                      Try Again
                    </button>
                    <button
                      onClick={() => window.location.reload()}
                      className="px-4 py-2 border border-gray-300 text-gray-700 rounded-lg text-sm font-medium hover:bg-gray-50 transition-colors focus:outline-none focus:ring-2 focus:ring-purple-500 focus:ring-offset-2"
                    >
                      Refresh Page
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
