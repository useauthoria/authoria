import { useState, useEffect, useCallback, useMemo, useRef, memo } from 'react';
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

interface ToastOptions {
  readonly duration?: number;
}

interface UseToastReturn {
  readonly showToast: (
    message: string,
    type?: ToastType,
    options?: ToastOptions,
  ) => string;
  readonly dismissToast: (id: string) => void;
  readonly toasts: readonly Toast[];
}

type ToastListener = (toasts: Toast[]) => void;

const DEFAULT_DURATION = 5000;
const EXIT_ANIMATION_DURATION = 300;
const MIN_DURATION = 0;
const MAX_DURATION = 60000;
const MAX_MESSAGE_LENGTH = 1000;
const MAX_TOASTS = 10;

const TYPE_STYLES = {
  success: 'bg-green-50 border-green-200 text-green-800',
  error: 'bg-red-50 border-red-200 text-red-800',
  warning: 'bg-yellow-50 border-yellow-200 text-yellow-800',
  info: 'bg-blue-50 border-blue-200 text-blue-800',
} as const satisfies Record<ToastType, string>;

const ICON_STYLES = {
  success: 'text-green-400',
  error: 'text-red-400',
  warning: 'text-yellow-400',
  info: 'text-blue-400',
} as const satisfies Record<ToastType, string>;

const SUCCESS_ICON = (
  <svg
    className="w-5 h-5"
    fill="currentColor"
    viewBox="0 0 20 20"
    aria-hidden="true"
  >
    <path
      fillRule="evenodd"
      d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
      clipRule="evenodd"
    />
  </svg>
);

const ERROR_ICON = (
  <svg
    className="w-5 h-5"
    fill="currentColor"
    viewBox="0 0 20 20"
    aria-hidden="true"
  >
    <path
      fillRule="evenodd"
      d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z"
      clipRule="evenodd"
    />
  </svg>
);

const WARNING_ICON = (
  <svg
    className="w-5 h-5"
    fill="currentColor"
    viewBox="0 0 20 20"
    aria-hidden="true"
  >
    <path
      fillRule="evenodd"
      d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z"
      clipRule="evenodd"
    />
  </svg>
);

const INFO_ICON = (
  <svg
    className="w-5 h-5"
    fill="currentColor"
    viewBox="0 0 20 20"
    aria-hidden="true"
  >
    <path
      fillRule="evenodd"
      d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z"
      clipRule="evenodd"
    />
  </svg>
);

const ICONS = {
  success: SUCCESS_ICON,
  error: ERROR_ICON,
  warning: WARNING_ICON,
  info: INFO_ICON,
} as const satisfies Record<ToastType, JSX.Element>;

const CLOSE_ICON = (
  <svg
    className="w-5 h-5"
    fill="currentColor"
    viewBox="0 0 20 20"
    aria-hidden="true"
  >
    <path
      fillRule="evenodd"
      d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
      clipRule="evenodd"
    />
  </svg>
);

const isToastType = (type: string | undefined): type is ToastType => {
  return (
    type === 'success' ||
    type === 'error' ||
    type === 'warning' ||
    type === 'info'
  );
};

const validateMessage = (message: string): string => {
  if (!message || typeof message !== 'string') {
    return '';
  }
  const trimmed = message.trim();
  if (trimmed.length === 0) {
    return '';
  }
  if (trimmed.length > MAX_MESSAGE_LENGTH) {
    return trimmed.slice(0, MAX_MESSAGE_LENGTH) + '...';
  }
  return trimmed;
};

const validateDuration = (duration: number | undefined): number | undefined => {
  if (duration === undefined || duration === null) {
    return undefined;
  }
  if (typeof duration !== 'number' || !Number.isFinite(duration)) {
    return undefined;
  }
  if (duration < MIN_DURATION) {
    return MIN_DURATION;
  }
  if (duration > MAX_DURATION) {
    return MAX_DURATION;
  }
  return Math.floor(duration);
};

const getDuration = (duration: number | undefined): number => {
  const validated = validateDuration(duration);
  if (validated === undefined || validated === 0) {
    return DEFAULT_DURATION;
  }
  return validated;
};

const ToastComponent = memo(function ToastComponent({
  toast,
  onDismiss,
}: ToastProps): JSX.Element {
  const isMountedRef = useRef(true);
  const [isVisible, setIsVisible] = useState(false);
  const [isExiting, setIsExiting] = useState(false);
  const animationFrameRef = useRef<number | null>(null);
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const exitTimerRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const handleDismiss = useCallback(() => {
    if (!isMountedRef.current) {
      return;
    }
    setIsExiting(true);
    exitTimerRef.current = setTimeout(() => {
      if (isMountedRef.current) {
        onDismiss(toast.id);
      }
    }, EXIT_ANIMATION_DURATION);
  }, [toast.id, onDismiss]);

  useEffect(() => {
    if (animationFrameRef.current !== null) {
      cancelAnimationFrame(animationFrameRef.current);
    }

    animationFrameRef.current = requestAnimationFrame(() => {
      if (isMountedRef.current) {
        setIsVisible(true);
      }
    });

    if (toast.duration !== 0) {
      const duration = getDuration(toast.duration);
      timerRef.current = setTimeout(() => {
        if (isMountedRef.current) {
          handleDismiss();
        }
      }, duration);
    }

    return () => {
      if (animationFrameRef.current !== null) {
        cancelAnimationFrame(animationFrameRef.current);
      }
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
      }
      if (exitTimerRef.current !== null) {
        clearTimeout(exitTimerRef.current);
      }
    };
  }, [toast.duration, handleDismiss]);

  const typeStyles = useMemo(() => TYPE_STYLES[toast.type], [toast.type]);
  const iconStyles = useMemo(() => ICON_STYLES[toast.type], [toast.type]);
  const icon = useMemo(() => ICONS[toast.type], [toast.type]);
  const ariaLive = useMemo(
    () => (toast.type === 'error' ? 'assertive' : 'polite'),
    [toast.type],
  );
  const className = useMemo(
    () =>
      `${typeStyles} border rounded-lg shadow-lg p-4 mb-3 flex items-start gap-3 max-w-md w-full transition-all duration-300 ease-in-out ${
        isVisible && !isExiting
          ? 'opacity-100 translate-x-0'
          : 'opacity-0 translate-x-full'
      }`,
    [typeStyles, isVisible, isExiting],
  );

  return (
    <div
      className={className}
      role="alert"
      aria-live={ariaLive}
      aria-atomic="true"
    >
      <div className={`flex-shrink-0 ${iconStyles}`} aria-hidden="true">
        {icon}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium">{toast.message}</p>
      </div>
      <button
        onClick={handleDismiss}
        type="button"
        className="flex-shrink-0 text-gray-400 hover:text-gray-600 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-gray-500 rounded"
        aria-label="Dismiss notification"
      >
        {CLOSE_ICON}
      </button>
    </div>
  );
});

interface ToastContainerProps {
  readonly toasts: readonly Toast[];
  readonly onDismiss: (id: string) => void;
}

const getContainer = (): HTMLElement | null => {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return null;
  }
  const container = document.getElementById('toast-container');
  return container || document.body;
};

export function ToastContainer({
  toasts,
  onDismiss,
}: ToastContainerProps): JSX.Element | null {
  const container = useMemo(() => getContainer(), []);

  if (!container) {
    return null;
  }

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
  private readonly toasts: Toast[] = [];
  private readonly listeners: Set<ToastListener> = new Set();

  subscribe(listener: ToastListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    const toastsCopy = [...this.toasts];
    this.listeners.forEach((listener) => {
      try {
        listener(toastsCopy);
      } catch {
      }
    });
  }

  show(
    message: string,
    type: ToastType = 'info',
    options?: ToastOptions,
  ): string {
    const validatedMessage = validateMessage(message);
    if (validatedMessage.length === 0) {
      throw new Error('Toast message cannot be empty');
    }

    const validatedType = isToastType(type) ? type : 'info';
    const validatedDuration = validateDuration(options?.duration);

    const id = `toast-${++toastIdCounter}-${Date.now()}`;
    const toast: Toast = {
      id,
      message: validatedMessage,
      type: validatedType,
      duration: validatedDuration,
    };

    this.toasts.push(toast);

    if (this.toasts.length > MAX_TOASTS) {
      const removed = this.toasts.shift();
      if (removed) {
      }
    }

    this.notify();
    return id;
  }

  dismiss(id: string): void {
    if (!id || typeof id !== 'string') {
      return;
    }
    const initialLength = this.toasts.length;
    this.toasts.splice(
      0,
      this.toasts.length,
      ...this.toasts.filter((t) => t.id !== id),
    );
    if (this.toasts.length !== initialLength) {
      this.notify();
    }
  }

  clear(): void {
    if (this.toasts.length === 0) {
      return;
    }
    this.toasts.length = 0;
    this.notify();
  }
}

export const toastManager = new ToastManager();

export function useToast(): UseToastReturn {
  const [toasts, setToasts] = useState<readonly Toast[]>([]);

  useEffect(() => {
    const unsubscribe = toastManager.subscribe(setToasts);
    return unsubscribe;
  }, []);

  const showToast = useCallback(
    (
      message: string,
      type: ToastType = 'info',
      options?: ToastOptions,
    ): string => {
      try {
        return toastManager.show(message, type, options);
      } catch {
        return '';
      }
    },
    [],
  );

  const dismissToast = useCallback(
    (id: string): void => {
      toastManager.dismiss(id);
    },
    [],
  );

  return useMemo(
    () => ({
      showToast,
      dismissToast,
      toasts,
    }),
    [showToast, dismissToast, toasts],
  );
}
