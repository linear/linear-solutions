"""GraphQL client for the Linear API.

Handles authentication, cursor pagination, retries with exponential backoff
on 429/5xx responses, and optional client-side rate limiting.
"""

from __future__ import annotations

import logging
import random
import time
from typing import Any, Iterator

import httpx

LINEAR_GRAPHQL_ENDPOINT = "https://api.linear.app/graphql"

log = logging.getLogger(__name__)


class LinearAPIError(RuntimeError):
    """Raised when the Linear API returns errors that cannot be retried."""


def _is_complexity_error(exc: "LinearAPIError") -> bool:
    msg = str(exc).lower()
    return "too complex" in msg or "complexity" in msg


class LinearClient:
    def __init__(
        self,
        api_key: str,
        *,
        endpoint: str = LINEAR_GRAPHQL_ENDPOINT,
        timeout: float = 60.0,
        max_retries: int = 8,
        backoff_base: float = 2.0,
        backoff_cap: float = 60.0,
        max_rps: float | None = None,
    ) -> None:
        if not api_key:
            raise ValueError("LINEAR_API_KEY is required")
        self._endpoint = endpoint
        self._max_retries = max_retries
        self._backoff_base = backoff_base
        self._backoff_cap = backoff_cap
        self._min_interval = 1.0 / max_rps if max_rps and max_rps > 0 else 0.0
        self._last_request_at: float = 0.0
        self._client = httpx.Client(
            timeout=timeout,
            headers={
                "Authorization": api_key,
                "Content-Type": "application/json",
                "User-Agent": "linear-backup/0.1",
            },
        )

    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> "LinearClient":
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()

    def execute(self, query: str, variables: dict[str, Any] | None = None) -> dict[str, Any]:
        """Execute a GraphQL query, returning the `data` payload.

        Retries on 429 and 5xx with exponential backoff. Raises LinearAPIError
        on GraphQL-level errors or once retries are exhausted.
        """
        payload = {"query": query, "variables": variables or {}}
        attempt = 0
        while True:
            self._throttle()
            try:
                response = self._client.post(self._endpoint, json=payload)
            except httpx.TransportError as exc:
                if attempt >= self._max_retries:
                    raise LinearAPIError(f"Transport error after retries: {exc}") from exc
                self._sleep_backoff(attempt)
                attempt += 1
                continue

            if response.status_code == 429 or response.status_code >= 500:
                if attempt >= self._max_retries:
                    raise LinearAPIError(
                        f"HTTP {response.status_code} after {attempt} retries: {response.text[:500]}"
                    )
                retry_after = self._parse_retry_after(response)
                if retry_after is not None:
                    log.warning(
                        "Linear API returned %s; sleeping %.1fs before retry (attempt %d)",
                        response.status_code,
                        retry_after,
                        attempt + 1,
                    )
                    time.sleep(retry_after)
                else:
                    self._sleep_backoff(attempt)
                attempt += 1
                continue

            if response.status_code >= 400:
                raise LinearAPIError(
                    f"HTTP {response.status_code}: {response.text[:500]}"
                )

            body = response.json()
            if "errors" in body and body["errors"]:
                # Some Linear errors (e.g. RATELIMITED) are retryable even at 200
                if self._is_retryable_gql_error(body["errors"]) and attempt < self._max_retries:
                    self._sleep_backoff(attempt)
                    attempt += 1
                    continue
                raise LinearAPIError(f"GraphQL errors: {body['errors']}")

            return body.get("data") or {}

    def paginate(
        self,
        query: str,
        variables: dict[str, Any],
        connection_path: list[str],
        *,
        page_size: int = 100,
        min_page_size: int = 5,
    ) -> Iterator[dict[str, Any]]:
        """Yield every node from a paginated Linear connection.

        `connection_path` is the dotted path from `data` to the connection
        object (e.g. ["issues"] or ["team", "issues"]).

        If Linear rejects a page with a complexity error, we halve the page
        size and retry until we either fit under the budget or drop below
        `min_page_size` (in which case we re-raise).
        """
        cursor: str | None = None
        current_page_size = page_size
        while True:
            page_vars = dict(variables)
            page_vars["first"] = current_page_size
            page_vars["after"] = cursor
            try:
                data = self.execute(query, page_vars)
            except LinearAPIError as exc:
                if _is_complexity_error(exc) and current_page_size > min_page_size:
                    new_size = max(min_page_size, current_page_size // 2)
                    log.warning(
                        "Query too complex at page_size=%d; retrying at %d",
                        current_page_size,
                        new_size,
                    )
                    current_page_size = new_size
                    continue
                raise
            conn = data
            for key in connection_path:
                if conn is None:
                    break
                conn = conn.get(key)
            if not conn:
                return
            for node in conn.get("nodes", []) or []:
                yield node
            page_info = conn.get("pageInfo") or {}
            if not page_info.get("hasNextPage"):
                return
            cursor = page_info.get("endCursor")
            if not cursor:
                return

    def _throttle(self) -> None:
        if not self._min_interval:
            return
        now = time.monotonic()
        wait = self._min_interval - (now - self._last_request_at)
        if wait > 0:
            time.sleep(wait)
        self._last_request_at = time.monotonic()

    def _sleep_backoff(self, attempt: int) -> None:
        delay = min(self._backoff_cap, self._backoff_base * (2 ** attempt))
        jitter = random.uniform(0, delay * 0.25)
        total = delay + jitter
        log.warning("Backing off for %.1fs (attempt %d)", total, attempt + 1)
        time.sleep(total)

    @staticmethod
    def _parse_retry_after(response: httpx.Response) -> float | None:
        value = response.headers.get("Retry-After")
        if not value:
            return None
        try:
            return float(value)
        except ValueError:
            return None

    @staticmethod
    def _is_retryable_gql_error(errors: list[dict[str, Any]]) -> bool:
        for err in errors:
            ext = err.get("extensions") or {}
            code = (ext.get("code") or err.get("type") or "").upper()
            if code in {"RATELIMITED", "RATE_LIMITED", "INTERNAL_SERVER_ERROR"}:
                return True
        return False
