"""Linear GraphQL API client with built-in rate limiting and retry support."""

import json
import random
import time
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

LINEAR_API_URL = "https://api.linear.app/graphql"

# Defaults
DEFAULT_MAX_RETRIES = 5
DEFAULT_BASE_DELAY = 0.5  # seconds between requests


class LinearClient:
    """Client for interacting with Linear's GraphQL API.
    
    Features:
    - Automatic retry with exponential backoff on rate limit errors
    - Adaptive throttling based on X-RateLimit-Requests-Remaining header
    - Handles both HTTP 429 and GraphQL-level "ratelimit exceeded" errors
    - Enforces minimum spacing between requests to avoid bursts
    """
    
    def __init__(
        self,
        api_key: str,
        verbose: bool = False,
        max_retries: int = DEFAULT_MAX_RETRIES,
        base_delay: float = DEFAULT_BASE_DELAY,
    ):
        self.api_key = api_key
        self.verbose = verbose
        self.request_count = 0
        self.max_retries = max_retries
        self.base_delay = base_delay

        # Rate limit state (updated from response headers)
        self._remaining = None       # X-RateLimit-Requests-Remaining
        self._reset_at = None        # timestamp when rate limit window resets
        self._last_request_time = 0  # monotonic time of last request

        # Stats
        self._retry_count = 0
        self._rate_limited_count = 0

    def _log(self, message: str):
        if self.verbose:
            print(f"  [API] {message}")

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def execute(self, query: str, variables: dict = None) -> dict:
        """Execute a GraphQL query/mutation with automatic rate limiting and retry.
        
        Rate limit errors (HTTP 429 or GraphQL "ratelimit exceeded") are
        retried up to ``max_retries`` times with exponential back-off.
        Between every request an adaptive delay is applied based on the
        remaining quota reported by Linear's response headers.
        """
        self.request_count += 1

        payload = {"query": query}
        if variables:
            payload["variables"] = variables

        data = json.dumps(payload).encode("utf-8")

        # Enforce minimum delay since last request
        self._enforce_delay()

        for attempt in range(self.max_retries + 1):
            req = Request(
                LINEAR_API_URL,
                data=data,
                headers={
                    "Content-Type": "application/json",
                    "Authorization": self.api_key,
                },
            )

            suffix = f" (attempt {attempt + 1})" if attempt > 0 else ""
            self._log(f"Request #{self.request_count}{suffix}")

            try:
                with urlopen(req) as response:
                    self._last_request_time = time.monotonic()
                    self._parse_rate_limit_headers(response)

                    result = json.loads(response.read().decode("utf-8"))

                    # Check for GraphQL-level rate limit error
                    if "errors" in result:
                        if self._is_rate_limit_error(result["errors"]):
                            if attempt < self.max_retries:
                                wait = self._backoff_delay(attempt)
                                self._rate_limited_count += 1
                                self._retry_count += 1
                                self._log(
                                    f"Rate limited (GraphQL), retrying in {wait:.1f}s "
                                    f"[{attempt + 1}/{self.max_retries}]"
                                )
                                print(f"  \u23f3 Rate limited, waiting {wait:.1f}s before retry...")
                                time.sleep(wait)
                                continue
                        # Non-rate-limit GraphQL error – raise immediately
                        raise Exception(f"GraphQL errors: {result['errors']}")

                    return result.get("data", {})

            except HTTPError as e:
                self._last_request_time = time.monotonic()

                if e.code == 429 and attempt < self.max_retries:
                    self._parse_rate_limit_headers(e)
                    wait = self._backoff_delay(attempt)

                    # Respect Retry-After header if present
                    retry_after = self._get_header(e, "Retry-After")
                    if retry_after:
                        try:
                            wait = max(wait, float(retry_after))
                        except ValueError:
                            pass

                    self._rate_limited_count += 1
                    self._retry_count += 1
                    self._log(
                        f"Rate limited (HTTP 429), retrying in {wait:.1f}s "
                        f"[{attempt + 1}/{self.max_retries}]"
                    )
                    print(f"  \u23f3 Rate limited (429), waiting {wait:.1f}s before retry...")
                    time.sleep(wait)
                    continue

                error_body = e.read().decode("utf-8")
                raise Exception(f"HTTP {e.code}: {error_body}")

            except URLError as e:
                # Transient network errors get one retry
                if attempt < min(1, self.max_retries):
                    wait = self._backoff_delay(attempt)
                    self._retry_count += 1
                    self._log(f"Network error, retrying in {wait:.1f}s: {e.reason}")
                    time.sleep(wait)
                    continue
                raise Exception(f"Network error: {e.reason}")

        raise Exception(
            f"Max retries ({self.max_retries}) exceeded due to rate limiting"
        )

    def rate_limit_delay(self):
        """Legacy method retained for backward compatibility.
        
        Rate limiting is now handled automatically inside ``execute()``
        via adaptive inter-request delays and retry-with-backoff.
        Calling this is a harmless no-op.
        """
        pass

    def get_rate_limit_stats(self) -> dict:
        """Return rate-limit statistics for end-of-run reporting."""
        return {
            "total_requests": self.request_count,
            "rate_limited": self._rate_limited_count,
            "retries": self._retry_count,
            "remaining_quota": self._remaining,
        }

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _is_rate_limit_error(errors: list) -> bool:
        """Return True if any GraphQL error indicates rate limiting."""
        for error in errors:
            msg = error.get("message", "").lower()
            if any(kw in msg for kw in ("ratelimit", "rate limit", "rate_limit", "throttl")):
                return True
            code = error.get("extensions", {}).get("code", "")
            if code in ("RATE_LIMITED", "RATELIMITED"):
                return True
        return False

    def _backoff_delay(self, attempt: int) -> float:
        """Exponential back-off with jitter, capped at 60 s.
        
        If the rate-limit reset time is known from headers, the delay
        is at least long enough to wait for the window to reset.
        """
        backoff = self.base_delay * (2 ** attempt) + random.uniform(0, 1)

        # If we know the reset time, wait at least that long
        if self._reset_at is not None:
            now = time.monotonic()
            reset_wait = self._reset_at - now
            if reset_wait > 0:
                backoff = max(backoff, reset_wait + random.uniform(0.5, 1.5))

        return min(backoff, 60.0)

    def _parse_rate_limit_headers(self, response) -> None:
        """Extract rate-limit info from Linear response headers."""
        try:
            remaining = self._get_header(response, "X-RateLimit-Requests-Remaining")
            if remaining is not None:
                self._remaining = int(remaining)

            reset_ms = self._get_header(response, "X-RateLimit-Requests-Reset")
            if reset_ms is not None:
                # Header value is ms until reset; convert to absolute monotonic time
                self._reset_at = time.monotonic() + (int(reset_ms) / 1000)
        except (ValueError, TypeError):
            pass

    @staticmethod
    def _get_header(response, name: str):
        """Safely read a header from a response or HTTPError."""
        try:
            if hasattr(response, "headers"):
                return response.headers.get(name)
            if hasattr(response, "getheader"):
                return response.getheader(name)
        except Exception:
            pass
        return None

    def _enforce_delay(self) -> None:
        """Ensure adaptive spacing between requests.
        
        The delay increases as the remaining quota decreases:
          remaining < 10   →  3.0 s
          remaining < 50   →  1.5 s
          remaining < 150  →  0.75 s
          otherwise        →  base_delay (0.5 s default)
        
        If no quota info is available (first requests, or headers
        not yet parsed), the base_delay is used.
        """
        if self._last_request_time == 0:
            return  # First request – no delay needed

        if self._remaining is not None:
            if self._remaining < 10:
                required = 3.0
            elif self._remaining < 50:
                required = 1.5
            elif self._remaining < 150:
                required = 0.75
            else:
                required = self.base_delay
        else:
            required = self.base_delay

        elapsed = time.monotonic() - self._last_request_time
        wait = required - elapsed
        if wait > 0:
            self._log(f"Throttle: {wait:.2f}s (remaining quota: {self._remaining})")
            time.sleep(wait)
