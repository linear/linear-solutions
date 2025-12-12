import { RateLimitConfig, Logger } from '../types';

/**
 * RateLimiter provides comprehensive rate limiting and retry protection for API requests.
 * 
 * Features:
 * - Automatic retry with exponential backoff for transient errors
 * - Detection and retry of rate limit errors (HTTP 429, GraphQL rate limit errors)
 * - Detection and retry of network errors (timeouts, connection failures, DNS issues)
 * - Smart error classification (won't retry auth errors or validation errors)
 * - Respects Retry-After headers from APIs
 * - Configurable minimum delay between requests
 * - Jitter to prevent thundering herd
 * - Clear logging of retry attempts and delays with specific error context
 */
export interface RetryOptions {
  maxRetries: number;
  initialDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
}

export class RateLimiter {
  private lastRequestTime: number = 0;
  private retryOptions: RetryOptions;
  private delayBetweenRequests: number;

  constructor(
    private logger: Logger,
    rateLimitConfig?: RateLimitConfig
  ) {
    this.retryOptions = {
      maxRetries: rateLimitConfig?.maxRetries ?? 5,
      initialDelayMs: rateLimitConfig?.initialDelayMs ?? 1000,
      maxDelayMs: rateLimitConfig?.maxDelayMs ?? 60000,
      backoffMultiplier: rateLimitConfig?.backoffMultiplier ?? 2,
    };
    this.delayBetweenRequests = rateLimitConfig?.delayBetweenRequestsMs ?? 100;
  }

  /**
   * Execute a function with retry logic and exponential backoff
   */
  async executeWithRetry<T>(
    fn: () => Promise<T>,
    context: string
  ): Promise<T> {
    // Ensure minimum delay between requests
    await this.waitForNextRequest();

    let lastError: Error | null = null;
    
    for (let attempt = 0; attempt <= this.retryOptions.maxRetries; attempt++) {
      try {
        const result = await fn();
        
        if (attempt > 0) {
          this.logger.info(`✓ ${context} succeeded after ${attempt} ${attempt === 1 ? 'retry' : 'retries'}`);
        }
        
        return result;
      } catch (error: any) {
        lastError = error;
        
        // Check if this is a rate limit error or a network error
        const isRateLimit = this.isRateLimitError(error);
        const isNetworkError = this.isNetworkError(error);
        const retryAfter = this.getRetryAfterDelay(error);
        
        // Don't retry certain types of errors
        if (!isRateLimit && !isNetworkError && this.shouldNotRetry(error)) {
          this.logger.error(`❌ ${context} failed with non-retryable error: ${error.message}`);
          throw error;
        }
        
        if (attempt < this.retryOptions.maxRetries) {
          const delay = this.calculateDelay(attempt, retryAfter);
          
          if (isRateLimit) {
            this.logger.warn(
              `⚠️  Rate limit hit for ${context}. Waiting ${(delay / 1000).toFixed(1)}s before retry ${attempt + 1}/${this.retryOptions.maxRetries}...`
            );
          } else if (isNetworkError) {
            this.logger.warn(
              `⚠️  Network error for ${context}: ${error.message}. Retrying in ${(delay / 1000).toFixed(1)}s (${attempt + 1}/${this.retryOptions.maxRetries})...`
            );
          } else {
            this.logger.warn(
              `⚠️  Request failed for ${context}: ${error.message}. Retrying in ${(delay / 1000).toFixed(1)}s (${attempt + 1}/${this.retryOptions.maxRetries})...`
            );
          }
          
          await this.sleep(delay);
        }
      }
    }
    
    // All retries exhausted
    this.logger.error(`❌ ${context} failed after ${this.retryOptions.maxRetries} retries: ${lastError?.message || 'Unknown error'}`);
    throw lastError || new Error(`Failed after ${this.retryOptions.maxRetries} retries`);
  }

  /**
   * Wait to ensure minimum delay between requests
   */
  private async waitForNextRequest(): Promise<void> {
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;
    
    if (timeSinceLastRequest < this.delayBetweenRequests) {
      const waitTime = this.delayBetweenRequests - timeSinceLastRequest;
      await this.sleep(waitTime);
    }
    
    this.lastRequestTime = Date.now();
  }

  /**
   * Calculate delay with exponential backoff
   */
  private calculateDelay(attempt: number, retryAfter?: number): number {
    if (retryAfter) {
      // Respect Retry-After header if provided
      return Math.min(retryAfter, this.retryOptions.maxDelayMs);
    }
    
    // Exponential backoff: initialDelay * (multiplier ^ attempt)
    const exponentialDelay = this.retryOptions.initialDelayMs * 
      Math.pow(this.retryOptions.backoffMultiplier, attempt);
    
    // Add jitter (random ±10%) to prevent thundering herd
    const jitter = exponentialDelay * 0.1 * (Math.random() * 2 - 1);
    
    return Math.min(
      exponentialDelay + jitter,
      this.retryOptions.maxDelayMs
    );
  }

  /**
   * Check if error is a rate limit error
   */
  private isRateLimitError(error: any): boolean {
    // HTTP 429 (Too Many Requests)
    if (error.status === 429 || error.statusCode === 429) {
      return true;
    }
    
    // Jira specific rate limit errors
    if (error.response?.status === 429) {
      return true;
    }
    
    // Linear GraphQL rate limit errors
    if (error.errors) {
      for (const err of error.errors) {
        if (err.extensions?.code === 'RATE_LIMITED' || 
            err.message?.toLowerCase().includes('rate limit')) {
          return true;
        }
      }
    }
    
    // Generic rate limit detection
    const errorMessage = error.message?.toLowerCase() || '';
    if (errorMessage.includes('rate limit') || 
        errorMessage.includes('too many requests') ||
        errorMessage.includes('429')) {
      return true;
    }
    
    return false;
  }

  /**
   * Check if error is a network-related error that should be retried
   */
  private isNetworkError(error: any): boolean {
    const errorMessage = error.message?.toLowerCase() || '';
    const errorCode = error.code?.toUpperCase() || '';
    
    // Common network error patterns
    const networkErrorPatterns = [
      'fetch failed',
      'network error',
      'network request failed',
      'failed to fetch',
      'econnrefused',
      'econnreset',
      'etimedout',
      'timeout',
      'socket hang up',
      'getaddrinfo',
      'dns',
      'tcp',
      'ssl',
      'tls',
      'connection',
      'ENOTFOUND',
      'EHOSTUNREACH',
      'ENETUNREACH',
    ];
    
    // Check error message
    if (networkErrorPatterns.some(pattern => errorMessage.includes(pattern.toLowerCase()))) {
      return true;
    }
    
    // Check error code
    if (networkErrorPatterns.some(pattern => errorCode.includes(pattern.toUpperCase()))) {
      return true;
    }
    
    // Check for specific HTTP status codes that might be transient
    const status = error.status || error.statusCode || error.response?.status;
    if (status && [408, 502, 503, 504, 522, 524].includes(status)) {
      return true;
    }
    
    return false;
  }

  /**
   * Check if error should NOT be retried (e.g., authentication errors, validation errors)
   */
  private shouldNotRetry(error: any): boolean {
    const errorMessage = error.message?.toLowerCase() || '';
    const status = error.status || error.statusCode || error.response?.status;
    
    // Don't retry authentication/authorization errors
    if (status && [401, 403].includes(status)) {
      return true;
    }
    
    // Don't retry validation errors
    if (status && [400, 422].includes(status)) {
      return true;
    }
    
    // Don't retry "not found" errors
    if (status === 404) {
      return true;
    }
    
    // Check for auth-related error messages
    const authErrors = [
      'unauthorized',
      'authentication',
      'invalid token',
      'invalid api key',
      'forbidden',
      'access denied',
    ];
    
    if (authErrors.some(pattern => errorMessage.includes(pattern))) {
      return true;
    }
    
    // GraphQL validation errors
    if (error.errors) {
      for (const err of error.errors) {
        const code = err.extensions?.code?.toUpperCase();
        if (code === 'AUTHENTICATION_ERROR' || 
            code === 'FORBIDDEN' ||
            code === 'BAD_USER_INPUT') {
          return true;
        }
      }
    }
    
    return false;
  }

  /**
   * Extract Retry-After delay from error (in milliseconds)
   */
  private getRetryAfterDelay(error: any): number | undefined {
    // Check for Retry-After header (can be seconds or HTTP date)
    const retryAfter = error.response?.headers?.['retry-after'] || 
                      error.headers?.['retry-after'];
    
    if (retryAfter) {
      // If it's a number, it's seconds
      const seconds = parseInt(retryAfter, 10);
      if (!isNaN(seconds)) {
        return seconds * 1000;
      }
      
      // If it's a date, calculate difference
      const retryDate = new Date(retryAfter);
      if (!isNaN(retryDate.getTime())) {
        return Math.max(0, retryDate.getTime() - Date.now());
      }
    }
    
    // Check for Linear's rate limit reset time
    if (error.errors) {
      for (const err of error.errors) {
        if (err.extensions?.resetAt) {
          const resetTime = new Date(err.extensions.resetAt).getTime();
          return Math.max(0, resetTime - Date.now());
        }
      }
    }
    
    return undefined;
  }

  /**
   * Sleep for specified milliseconds
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Get current retry options (for logging/debugging)
   */
  getRetryOptions(): RetryOptions {
    return { ...this.retryOptions };
  }
}

