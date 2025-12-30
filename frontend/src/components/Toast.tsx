import { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';

export type ToastType = 'success' | 'error' | 'warning' | 'info';

export interface Toast {
  readonly id: string;
  readonly message: string;
  readonly type: ToastType;
  readonly duration?: number;
}

interface ToastProps {
  readonly toast: Toast;
  readonly onDismiss: (id: string) => void;
}

function ToastComponent({ toast, onDismiss }: ToastProps): JSX.Element {
  const [isVisible, setIsVisible] = useState(false);
  const [isExiting, setIsExiting] = useState(false);

  useEffect(() => {
    // Trigger enter animation
    requestAnimationFrame(() => {
      setIsVisible(true);
    });

    // Auto-dismiss
    if (toast.duration !== 0) {
      const timer = setTimeout(() => {
        handleDismiss();
      }, toast.duration || 5000);

      return () => clearTimeout(timer);
    }
  }, [toast.duration]);

  const handleDismiss = useCallback(() => {
    setIsExiting(true);
    setTimeout(() => {
      onDismiss(toast.id);
    }, 300);
  }, [toast.id, onDismiss]);

  const typeStyles = {
    success: 'bg-green-50 border-green-200 text-green-800',
    error: 'bg-red-50 border-red-200 text-red-800',
    warning: 'bg-yellow-50 border-yellow-200 text-yellow-800',
    info: 'bg-blue-50 border-blue-200 text-blue-800',
  };

  const iconStyles = {
    success: 'text-green-400',
    error: 'text-red-400',
    warning: 'text-yellow-400',
    info: 'text-blue-400',
  };

  const icons = {
    success: (
      <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20" aria-hidden="true">
        <path
          fillRule="evenodd"
          d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
          clipRule="evenodd"
        />
      </svg>
    ),
    error: (
      <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20" aria-hidden="true">
        <path
          fillRule="evenodd"
          d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z"
          clipRule="evenodd"
        />
      </svg>
    ),
    warning: (
      <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20" aria-hidden="true">
        <path
          fillRule="evenodd"
          d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z"
          clipRule="evenodd"
        />
      </svg>
    ),
    info: (
      <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20" aria-hidden="true">
        <path
          fillRule="evenodd"
          d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z"
          clipRule="evenodd"
        />
      </svg>
    ),
  };

  return (
    <div
      className={`
        ${typeStyles[toast.type]} 
        border rounded-lg shadow-lg p-4 mb-3 
        flex items-start gap-3 
        max-w-md w-full
        transition-all duration-300 ease-in-out
        ${isVisible && !isExiting ? 'opacity-100 translate-x-0' : 'opacity-0 translate-x-full'}
      `}
      role="alert"
      aria-live={toast.type === 'error' ? 'assertive' : 'polite'}
      aria-atomic="true"
    >
      <div className={`flex-shrink-0 ${iconStyles[toast.type]}`} aria-hidden="true">
        {icons[toast.type]}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium">{toast.message}</p>
      </div>
      <button
        onClick={handleDismiss}
        className="flex-shrink-0 text-gray-400 hover:text-gray-600 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-gray-500 rounded"
        aria-label="Dismiss notification"
      >
        <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20" aria-hidden="true">
          <path
            fillRule="evenodd"
            d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
            clipRule="evenodd"
          />
        </svg>
      </button>
    </div>
  );
}

interface ToastContainerProps {
  readonly toasts: readonly Toast[];
  readonly onDismiss: (id: string) => void;
}

export function ToastContainer({ toasts, onDismiss }: ToastContainerProps): JSX.Element | null {
  if (typeof window === 'undefined') return null;

  const container = document.getElementById('toast-container') || document.body;

  return createPortal(
    <div
      className="fixed top-4 right-4 z-50 flex flex-col items-end"
      role="region"
      aria-label="Notifications"
      aria-live="polite"
    >
      {toasts.map((toast) => (
        <ToastComponent key={toast.id} toast={toast} onDismiss={onDismiss} />
      ))}
    </div>,
    container,
  );
}

let toastIdCounter = 0;

class ToastManager {
  private toasts: Toast[] = [];
  private listeners: Set<(toasts: Toast[]) => void> = new Set();

  subscribe(listener: (toasts: Toast[]) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    this.listeners.forEach((listener) => listener([...this.toasts]));
  }

  show(message: string, type: ToastType = 'info', options?: { readonly duration?: number }): string {
    const id = `toast-${++toastIdCounter}-${Date.now()}`;
    const toast: Toast = {
      id,
      message,
      type,
      duration: options?.duration,
    };

    this.toasts.push(toast);
    this.notify();
    return id;
  }

  dismiss(id: string): void {
    this.toasts = this.toasts.filter((t) => t.id !== id);
    this.notify();
  }
}

export const toastManager = new ToastManager();

export function useToast(): {
  readonly showToast: (message: string, type?: ToastType, options?: { readonly duration?: number }) => string;
  readonly dismissToast: (id: string) => void;
  readonly toasts: readonly Toast[];
} {
  const [toasts, setToasts] = useState<Toast[]>([]);

  useEffect(() => {
    const unsubscribe = toastManager.subscribe(setToasts);
    return unsubscribe;
  }, []);

  const showToast = useCallback((message: string, type: ToastType = 'info', options?: { readonly duration?: number }): string => {
    return toastManager.show(message, type, options);
  }, []);

  const dismissToast = useCallback((id: string): void => {
    toastManager.dismiss(id);
  }, []);

  return {
    showToast,
    dismissToast,
    toasts,
  };
}

