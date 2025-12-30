/**
 * Utility functions to format error messages in a user-friendly way
 */

interface ErrorContext {
  action?: string; // e.g., "save article", "load articles", "connect integration"
  resource?: string; // e.g., "article", "settings", "store"
  details?: string; // Additional context
}

/**
 * Formats a raw error message into a user-friendly message
 */
export function formatErrorMessage(
  error: unknown,
  context?: ErrorContext
): string {
  const errorMessage = error instanceof Error ? error.message : String(error);
  const lowerMessage = errorMessage.toLowerCase();

  // Network/Connection errors
  if (
    lowerMessage.includes('network') ||
    lowerMessage.includes('fetch') ||
    lowerMessage.includes('econnreset') ||
    lowerMessage.includes('err_network')
  ) {
    return "We're having trouble connecting to our servers. Please check your internet connection and try again.";
  }

  // Timeout errors
  if (
    lowerMessage.includes('timeout') ||
    lowerMessage.includes('econnaborted')
  ) {
    return "This is taking longer than expected. Please try again in a moment.";
  }

  // Authentication errors
  if (
    lowerMessage.includes('401') ||
    lowerMessage.includes('unauthorized') ||
    lowerMessage.includes('authentication')
  ) {
    return "Your session has expired. Please refresh the page to sign in again.";
  }

  // Permission errors
  if (
    lowerMessage.includes('403') ||
    lowerMessage.includes('forbidden') ||
    lowerMessage.includes('permission')
  ) {
    return "You don't have permission to perform this action. Please contact support if you believe this is an error.";
  }

  // Not found errors
  if (
    lowerMessage.includes('404') ||
    lowerMessage.includes('not found') ||
    lowerMessage.includes('does not exist')
  ) {
    const resource = context?.resource || 'item';
    return `The ${resource} you're looking for couldn't be found. It may have been deleted or moved.`;
  }

  // Validation errors
  if (
    lowerMessage.includes('400') ||
    lowerMessage.includes('422') ||
    lowerMessage.includes('validation') ||
    lowerMessage.includes('invalid')
  ) {
    const action = context?.action || 'complete this action';
    return `Please check your input and try again. ${context?.details || ''}`;
  }

  // Server errors
  if (
    lowerMessage.includes('500') ||
    lowerMessage.includes('server error') ||
    lowerMessage.includes('internal error')
  ) {
    return "Something went wrong on our end. We've been notified and are working on it. Please try again in a few minutes.";
  }

  // Rate limiting
  if (
    lowerMessage.includes('429') ||
    lowerMessage.includes('rate limit') ||
    lowerMessage.includes('too many requests')
  ) {
    return "You're making requests too quickly. Please wait a moment and try again.";
  }

  // Specific action-based messages
  if (context?.action) {
    const action = context.action;
    
    if (action.includes('save') || action.includes('update')) {
      return `We couldn't ${action} right now. Please check your connection and try again.`;
    }
    
    if (action.includes('delete')) {
      return `We couldn't ${action} right now. Please try again, or contact support if the problem continues.`;
    }
    
    if (action.includes('load') || action.includes('fetch') || action.includes('get')) {
      return `We couldn't ${action} right now. Please refresh the page and try again.`;
    }
    
    if (action.includes('connect') || action.includes('integration')) {
      return `We couldn't ${action} right now. Please check your credentials and try again.`;
    }
  }

  // Generic fallback - try to make the error message more friendly
  if (errorMessage && errorMessage.length > 0) {
    // Remove technical prefixes
    let friendly = errorMessage
      .replace(/^Error:?\s*/i, '')
      .replace(/^Failed to\s*/i, '')
      .replace(/^Unable to\s*/i, '')
      .replace(/^Cannot\s*/i, '')
      .trim();

    // Capitalize first letter
    if (friendly.length > 0) {
      friendly = friendly.charAt(0).toUpperCase() + friendly.slice(1);
    }

    // Add period if missing
    if (friendly.length > 0 && !friendly.endsWith('.') && !friendly.endsWith('!') && !friendly.endsWith('?')) {
      friendly += '.';
    }

    return friendly;
  }

  return "Something went wrong. Please try again, or contact support if the problem continues.";
}

/**
 * Formats API errors specifically
 */
export function formatAPIErrorMessage(error: unknown, context?: ErrorContext): string {
  // Check if it's an APIError with category
  if (error && typeof error === 'object' && 'category' in error) {
    const apiError = error as { category?: string; message?: string };
    
    switch (apiError.category) {
      case 'network':
        return "We're having trouble connecting to our servers. Please check your internet connection and try again.";
      case 'timeout':
        return "This is taking longer than expected. Please try again in a moment.";
      case 'auth':
        return "Your session has expired. Please refresh the page to sign in again.";
      case 'validation':
        return `Please check your input and try again. ${context?.details || ''}`;
      case 'server':
        return "Something went wrong on our end. We've been notified and are working on it. Please try again in a few minutes.";
      default:
        return formatErrorMessage(apiError.message || error, context);
    }
  }

  return formatErrorMessage(error, context);
}

