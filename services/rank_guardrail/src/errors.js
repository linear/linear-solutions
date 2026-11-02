// Operator-facing errors. Messages must never contain credentials, webhook secrets,
// request bodies, or Linear API response text: they are printed by the CLI as-is.
export class GuardrailError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'GuardrailError';
    this.code = code;
  }
}

export function fail(code, message) {
  throw new GuardrailError(code, message);
}

const GENERIC = 'Command failed; check configuration, state, team and API connectivity. No credentials logged.';

// Only messages this service wrote itself are shown; anything else (fetch internals,
// filesystem paths, JSON parse output) is replaced with a generic hint.
export function safeMessage(error) {
  return error instanceof GuardrailError ? `${error.code}: ${error.message}` : `unexpected-error: ${GENERIC}`;
}
