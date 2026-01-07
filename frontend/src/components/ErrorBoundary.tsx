import { Component, type ReactNode, type ErrorInfo } from 'react';

interface ErrorBoundaryProps {
  readonly children: ReactNode;
  readonly onError?: (error: Error, errorInfo: ErrorInfo) => void;
}

interface ErrorBoundaryState {
  readonly hasError: boolean;
  readonly error: Error | null;
  readonly errorInfo: ErrorInfo | null;
}

interface LogContext {
  readonly service: string;
  readonly error?: string;
  readonly errorName?: string;
  readonly componentStack?: string;
  readonly timestamp: string;
  readonly correlationId?: string;
}

const SERVICE_NAME = 'ErrorBoundary';

const generateCorrelationId = (): string => {
  return `error_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
};

const sanitizeErrorMessage = (message: string): string => {
  const maxLength = 500;
  const sanitized = message
    .replace(/password[=:]\s*[^\s,;'"]+/gi, 'password=***')
    .replace(/api[_-]?key[=:]\s*[^\s,;'"]+/gi, 'api_key=***')
    .replace(/token[=:]\s*[^\s,;'"]+/gi, 'token=***')
    .replace(/secret[=:]\s*[^\s,;'"]+/gi, 'secret=***')
    .replace(/authorization[=:]\s*[^\s,;'"]+/gi, 'authorization=***');

  return sanitized.length > maxLength ? `${sanitized.substring(0, maxLength)}...` : sanitized;
};

const sanitizeComponentStack = (stack: string): string => {
  const maxLength = 1000;
  return stack.length > maxLength ? `${stack.substring(0, maxLength)}...` : stack;
};

const structuredLog = (level: 'error' | 'warn' | 'info', context: LogContext): void => {
  const payload = JSON.stringify({
    level,
    ...context,
  });

  if (typeof window === 'undefined') {
    return;
  }

  try {
    if (level === 'error' && 'console' in window && typeof window.console.error === 'function') {
      window.console.error(payload);
    } else if (level === 'warn' && 'console' in window && typeof window.console.warn === 'function') {
      window.console.warn(payload);
    } else if (level === 'info' && 'console' in window && typeof window.console.info === 'function') {
      window.console.info(payload);
    }
  } catch {
  }
};

const validateError = (error: unknown): error is Error => {
  return error !== null && typeof error === 'object' && 'message' in error && 'name' in error;
};

const validateErrorInfo = (errorInfo: unknown): errorInfo is ErrorInfo => {
  return (
    errorInfo !== null &&
    typeof errorInfo === 'object' &&
    'componentStack' in errorInfo &&
    typeof (errorInfo as { componentStack?: unknown }).componentStack === 'string'
  );
};

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  private correlationId: string | null = null;

  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      errorInfo: null,
    };
  }

  static getDerivedStateFromError(error: unknown): Partial<ErrorBoundaryState> {
    if (!validateError(error)) {
      return {
        hasError: true,
        error: new Error('Unknown error occurred'),
        errorInfo: null,
      };
    }

    return {
      hasError: true,
      error,
      errorInfo: null,
    };
  }

  componentDidCatch(error: unknown, errorInfo: unknown): void {
    this.correlationId = generateCorrelationId();

    const validatedError: Error = validateError(error)
      ? error
      : new Error(typeof error === 'string' ? error : 'Unknown error occurred');

    const validatedErrorInfo: ErrorInfo | null = validateErrorInfo(errorInfo)
      ? errorInfo
      : null;

    this.setState({
      error: validatedError,
      errorInfo: validatedErrorInfo,
    });

    if (this.props.onError && typeof this.props.onError === 'function') {
      try {
        this.props.onError(validatedError, validatedErrorInfo || ({} as ErrorInfo));
      } catch (callbackError) {
        structuredLog('error', {
          service: SERVICE_NAME,
          error: callbackError instanceof Error ? callbackError.message : String(callbackError),
          timestamp: new Date().toISOString(),
          correlationId: this.correlationId,
        });
      }
    }

    const sanitizedMessage = sanitizeErrorMessage(validatedError.message || 'Unknown error');
    const sanitizedStack = validatedErrorInfo
      ? sanitizeComponentStack(validatedErrorInfo.componentStack || '')
      : undefined;

    structuredLog('error', {
      service: SERVICE_NAME,
      error: sanitizedMessage,
      errorName: validatedError.name || 'Error',
      componentStack: sanitizedStack,
      timestamp: new Date().toISOString(),
      correlationId: this.correlationId,
    });
  }

  private handleReset = (): void => {
    this.setState({
      hasError: false,
      error: null,
      errorInfo: null,
    });
    this.correlationId = null;
  };

  private handleReload = (): void => {
    if (typeof window !== 'undefined' && window.location) {
      window.location.reload();
    }
  };

  render(): ReactNode {
    if (this.state.hasError) {
      const isDev = (import.meta as { env?: { DEV?: boolean } }).env?.DEV ?? false;
      const error = this.state.error;
      const errorInfo = this.state.errorInfo;

      const safeErrorMessage = error
        ? sanitizeErrorMessage(error.toString())
        : 'An unknown error occurred';

      const safeComponentStack = errorInfo?.componentStack
        ? sanitizeComponentStack(errorInfo.componentStack)
        : null;

      return (
        <div className="min-h-screen flex items-center justify-center bg-gray-50 p-4">
          <div className="max-w-2xl w-full bg-white rounded-xl border border-gray-200 shadow-sm p-6 sm:p-8">
            <div className="mb-6">
              <h1 className="text-2xl font-bold text-gray-900 mb-2">Something went wrong</h1>
              <div className="bg-red-50 border border-red-200 rounded-lg p-4">
                <h2 className="text-sm font-semibold text-red-900 mb-2">An error occurred</h2>
                <div className="space-y-4">
                  <p className="text-sm text-red-700">
                    We&apos;re sorry, but something unexpected happened. Please try refreshing the
                    page.
                  </p>
                  {isDev && error && (
                    <div className="bg-gray-50 rounded-lg p-4 border border-gray-200">
                      <div className="space-y-2">
                        <p className="text-sm font-medium text-gray-900">
                          Error Details (Development Only):
                        </p>
                        <p className="text-xs text-gray-600 font-mono">{safeErrorMessage}</p>
                        {safeComponentStack && (
                          <p className="text-xs text-gray-600 font-mono whitespace-pre-wrap">
                            {safeComponentStack}
                          </p>
                        )}
                      </div>
                    </div>
                  )}
                  <div className="flex gap-3">
                    <button
                      onClick={this.handleReset}
                      type="button"
                      className="px-4 py-2 bg-purple-600 text-white rounded-lg text-sm font-medium hover:bg-purple-700 transition-colors focus:outline-none focus:ring-2 focus:ring-purple-500 focus:ring-offset-2"
                    >
                      Try Again
                    </button>
                    <button
                      onClick={this.handleReload}
                      type="button"
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
