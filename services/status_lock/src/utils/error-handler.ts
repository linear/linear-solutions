/**
 * Centralized error handling and retry logic
 */

import logger from './logger';

/**
 * Custom error class for enforcement-related errors
 */
export class EnforcementError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly retryable: boolean,
    public readonly context?: any
  ) {
    super(message);
    this.name = 'EnforcementError';
  }
}

/**
 * Sleep utility for retry delays
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Retry a function with exponential backoff
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: {
    maxRetries?: number;
    backoffMs?: number;
    operation?: string;
  } = {}
): Promise<T> {
  const { maxRetries = 3, backoffMs = 1000, operation = 'operation' } = options;
  
  let lastError: Error;
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;
      
      // Don't retry non-retryable errors
      if (error instanceof EnforcementError && !error.retryable) {
        throw error;
      }
      
      // If this wasn't the last attempt, retry with backoff
      if (attempt < maxRetries) {
        const delay = backoffMs * Math.pow(2, attempt);
        logger.warn(`${operation} failed (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${delay}ms`, {
          error: (error as Error).message,
          attempt: attempt + 1
        });
        await sleep(delay);
      }
    }
  }
  
  // All retries exhausted
  logger.error(`${operation} failed after ${maxRetries + 1} attempts`, {
    error: lastError!.message
  });
  throw lastError!;
}

/**
 * Graceful degradation - try operation but don't throw if it fails
 */
export async function tryGracefully<T>(
  fn: () => Promise<T>,
  fallback: T,
  operation: string
): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    logger.warn(`${operation} failed, using fallback`, {
      error: (error as Error).message
    });
    return fallback;
  }
}

/**
 * Wrap async handler to catch and log errors
 */
export function asyncHandler(
  fn: (...args: any[]) => Promise<any>
): (...args: any[]) => Promise<any> {
  return async (...args: any[]) => {
    try {
      return await fn(...args);
    } catch (error) {
      logger.error('Unhandled error in async handler', {
        error: (error as Error).message,
        stack: (error as Error).stack
      });
      throw error;
    }
  };
}

