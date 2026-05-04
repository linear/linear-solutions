import { RateLimitConfig, Logger } from '../types';

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

  async executeWithRetry<T>(fn: () => Promise<T>, context: string): Promise<T> {
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

        const isRateLimit = this.isRateLimitError(error);
        const isNetworkError = this.isNetworkError(error);
        const retryAfter = this.getRetryAfterDelay(error);

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

    this.logger.error(`❌ ${context} failed after ${this.retryOptions.maxRetries} retries: ${lastError?.message || 'Unknown error'}`);
    throw lastError || new Error(`Failed after ${this.retryOptions.maxRetries} retries`);
  }

  private async waitForNextRequest(): Promise<void> {
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;
    if (timeSinceLastRequest < this.delayBetweenRequests) {
      await this.sleep(this.delayBetweenRequests - timeSinceLastRequest);
    }
    this.lastRequestTime = Date.now();
  }

  private calculateDelay(attempt: number, retryAfter?: number): number {
    if (retryAfter) {
      return Math.min(retryAfter, this.retryOptions.maxDelayMs);
    }
    const exponentialDelay = this.retryOptions.initialDelayMs *
      Math.pow(this.retryOptions.backoffMultiplier, attempt);
    const jitter = exponentialDelay * 0.1 * (Math.random() * 2 - 1);
    return Math.min(exponentialDelay + jitter, this.retryOptions.maxDelayMs);
  }

  private isRateLimitError(error: any): boolean {
    if (error.status === 429 || error.statusCode === 429) return true;
    if (error.response?.status === 429) return true;
    if (error.errors) {
      for (const err of error.errors) {
        if (err.extensions?.code === 'RATE_LIMITED' ||
            err.message?.toLowerCase().includes('rate limit')) {
          return true;
        }
      }
    }
    const msg = error.message?.toLowerCase() || '';
    return msg.includes('rate limit') || msg.includes('too many requests') || msg.includes('429');
  }

  private isNetworkError(error: any): boolean {
    const msg = error.message?.toLowerCase() || '';
    const code = error.code?.toUpperCase() || '';
    const networkPatterns = [
      'fetch failed', 'network error', 'network request failed', 'failed to fetch',
      'econnrefused', 'econnreset', 'etimedout', 'timeout', 'socket hang up',
      'getaddrinfo', 'dns', 'tcp', 'ssl', 'tls', 'connection',
      'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH',
    ];
    if (networkPatterns.some(p => msg.includes(p.toLowerCase()))) return true;
    if (networkPatterns.some(p => code.includes(p.toUpperCase()))) return true;
    const status = error.status || error.statusCode || error.response?.status;
    return !!(status && [408, 502, 503, 504, 522, 524].includes(status));
  }

  private shouldNotRetry(error: any): boolean {
    const msg = error.message?.toLowerCase() || '';
    const status = error.status || error.statusCode || error.response?.status;
    if (status && [401, 403, 400, 422, 404].includes(status)) return true;
    const authErrors = ['unauthorized', 'authentication', 'invalid token', 'invalid api key', 'forbidden', 'access denied'];
    if (authErrors.some(p => msg.includes(p))) return true;
    if (error.errors) {
      for (const err of error.errors) {
        const code = err.extensions?.code?.toUpperCase();
        if (code === 'AUTHENTICATION_ERROR' || code === 'FORBIDDEN' || code === 'BAD_USER_INPUT') {
          return true;
        }
      }
    }
    return false;
  }

  private getRetryAfterDelay(error: any): number | undefined {
    const retryAfter = error.response?.headers?.['retry-after'] || error.headers?.['retry-after'];
    if (retryAfter) {
      const seconds = parseInt(retryAfter, 10);
      if (!isNaN(seconds)) return seconds * 1000;
      const retryDate = new Date(retryAfter);
      if (!isNaN(retryDate.getTime())) return Math.max(0, retryDate.getTime() - Date.now());
    }
    if (error.errors) {
      for (const err of error.errors) {
        if (err.extensions?.resetAt) {
          return Math.max(0, new Date(err.extensions.resetAt).getTime() - Date.now());
        }
      }
    }
    return undefined;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
