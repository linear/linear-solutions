type LogLevel = "info" | "warn" | "error";

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  event: string;
  context?: Record<string, unknown>;
  error?: string;
  stack?: string;
}

function write(level: LogLevel, event: string, context?: Record<string, unknown>, err?: unknown) {
  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    level,
    event,
  };

  if (context && Object.keys(context).length > 0) {
    entry.context = context;
  }

  if (err instanceof Error) {
    entry.error = err.message;
    entry.stack = err.stack;
  } else if (err !== undefined) {
    entry.error = String(err);
  }

  const output = JSON.stringify(entry);

  if (level === "error") {
    console.error(output);
  } else if (level === "warn") {
    console.warn(output);
  } else {
    console.log(output);
  }
}

export const log = {
  info: (event: string, context?: Record<string, unknown>) => write("info", event, context),
  warn: (event: string, context?: Record<string, unknown>) => write("warn", event, context),
  error: (event: string, context?: Record<string, unknown>, err?: unknown) =>
    write("error", event, context, err),
};
