interface ErrorContext {
  readonly action?: string;
  readonly resource?: string;
  readonly details?: string;
}

interface APIErrorLike {
  readonly category?: string;
  readonly message?: string;
}

type ErrorCategory = 'network' | 'timeout' | 'auth' | 'validation' | 'server' | 'client' | 'unknown';

const ERROR_PATTERNS = {
  network: ['network', 'fetch', 'econnreset', 'err_network'] as const,
  timeout: ['timeout', 'econnaborted'] as const,
  auth: ['401', 'unauthorized', 'authentication'] as const,
  permission: ['403', 'forbidden', 'permission'] as const,
  notFound: ['404', 'not found', 'does not exist'] as const,
  validation: ['400', '422', 'validation', 'invalid'] as const,
  server: ['500', 'server error', 'internal error'] as const,
  rateLimit: ['429', 'rate limit', 'too many requests'] as const,
} as const;

const ERROR_MESSAGES = {
  network: "We're having trouble connecting to our servers. Please check your internet connection and try again.",
  timeout: "This is taking longer than expected. Please try again in a moment.",
  auth: "Your session has expired. Please refresh the page to sign in again.",
  permission: "You don't have permission to perform this action. Please contact support if you believe this is an error.",
  notFound: (resource: string) => `The ${resource} you're looking for couldn't be found. It may have been deleted or moved.`,
  validation: (details?: string) => `Please check your input and try again. ${details || ''}`.trim(),
  server: "Something went wrong on our end. We've been notified and are working on it. Please try again in a few minutes.",
  rateLimit: "You're making requests too quickly. Please wait a moment and try again.",
  generic: "Something went wrong. Please try again, or contact support if the problem continues.",
} as const;

const ACTION_PATTERNS = {
  save: ['save', 'update'] as const,
  delete: ['delete'] as const,
  load: ['load', 'fetch', 'get'] as const,
  connect: ['connect', 'integration'] as const,
} as const;

const ACTION_MESSAGES = {
  save: (action: string) => `We couldn't ${action} right now. Please check your connection and try again.`,
  delete: (action: string) => `We couldn't ${action} right now. Please try again, or contact support if the problem continues.`,
  load: (action: string) => `We couldn't ${action} right now. Please refresh the page and try again.`,
  connect: (action: string) => `We couldn't ${action} right now. Please check your credentials and try again.`,
} as const;

const TECHNICAL_PREFIXES = [
  /^Error:?\s*/i,
  /^Failed to\s*/i,
  /^Unable to\s*/i,
  /^Cannot\s*/i,
] as const;

function matchesPattern(message: string, patterns: readonly string[]): boolean {
  const lowerMessage = message.toLowerCase();
  return patterns.some((pattern) => lowerMessage.includes(pattern));
}

function sanitizeErrorMessage(message: string): string {
  if (!message || message.length === 0) {
    return '';
  }

  let sanitized = message.trim();

  for (const prefix of TECHNICAL_PREFIXES) {
    sanitized = sanitized.replace(prefix, '');
  }

  sanitized = sanitized.trim();

  if (sanitized.length === 0) {
    return '';
  }

  sanitized = sanitized.charAt(0).toUpperCase() + sanitized.slice(1);

  if (!sanitized.endsWith('.') && !sanitized.endsWith('!') && !sanitized.endsWith('?')) {
    sanitized += '.';
  }

  return sanitized;
}

function extractErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    return typeof message === 'string' ? message : String(error);
  }
  return String(error);
}

function getActionMessage(action: string): string | null {
  const lowerAction = action.toLowerCase();

  for (const [key, patterns] of Object.entries(ACTION_PATTERNS)) {
    if (patterns.some((pattern) => lowerAction.includes(pattern))) {
      const messageFn = ACTION_MESSAGES[key as keyof typeof ACTION_MESSAGES];
      return messageFn(action);
    }
  }

  return null;
}

export function formatErrorMessage(
  error: unknown,
  context?: ErrorContext
): string {
  const errorMessage = extractErrorMessage(error);
  const lowerMessage = errorMessage.toLowerCase();

  if (matchesPattern(lowerMessage, ERROR_PATTERNS.network)) {
    return ERROR_MESSAGES.network;
  }

  if (matchesPattern(lowerMessage, ERROR_PATTERNS.timeout)) {
    return ERROR_MESSAGES.timeout;
  }

  if (matchesPattern(lowerMessage, ERROR_PATTERNS.auth)) {
    return ERROR_MESSAGES.auth;
  }

  if (matchesPattern(lowerMessage, ERROR_PATTERNS.permission)) {
    return ERROR_MESSAGES.permission;
  }

  if (matchesPattern(lowerMessage, ERROR_PATTERNS.notFound)) {
    const resource = context?.resource || 'item';
    return ERROR_MESSAGES.notFound(resource);
  }

  if (matchesPattern(lowerMessage, ERROR_PATTERNS.validation)) {
    return ERROR_MESSAGES.validation(context?.details);
  }

  if (matchesPattern(lowerMessage, ERROR_PATTERNS.server)) {
    return ERROR_MESSAGES.server;
  }

  if (matchesPattern(lowerMessage, ERROR_PATTERNS.rateLimit)) {
    return ERROR_MESSAGES.rateLimit;
  }

  if (context?.action) {
    const actionMessage = getActionMessage(context.action);
    if (actionMessage) {
      return actionMessage;
    }
  }

  const sanitized = sanitizeErrorMessage(errorMessage);
  if (sanitized.length > 0) {
    return sanitized;
  }

  return ERROR_MESSAGES.generic;
}

function isAPIErrorLike(error: unknown): error is APIErrorLike {
  return (
    error !== null &&
    typeof error === 'object' &&
    'category' in error
  );
}

const CATEGORY_MESSAGE_MAP: Readonly<Record<Exclude<ErrorCategory, 'validation'>, string>> = {
  network: ERROR_MESSAGES.network,
  timeout: ERROR_MESSAGES.timeout,
  auth: ERROR_MESSAGES.auth,
  server: ERROR_MESSAGES.server,
  client: ERROR_MESSAGES.generic,
  unknown: ERROR_MESSAGES.generic,
} as const;

export function formatAPIErrorMessage(error: unknown, context?: ErrorContext): string {
  if (isAPIErrorLike(error)) {
    const category = error.category as ErrorCategory;
    
    if (category === 'validation') {
      return ERROR_MESSAGES.validation(context?.details);
    }

    if (category && category in CATEGORY_MESSAGE_MAP) {
      return CATEGORY_MESSAGE_MAP[category as Exclude<ErrorCategory, 'validation'>];
    }

    return formatErrorMessage(error.message || error, context);
  }

  return formatErrorMessage(error, context);
}
