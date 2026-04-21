/**
 * Structured error transport for the RPC boundary.
 *
 * Crossing a Worker boundary loses Error subclasses and stack traces unless
 * we marshal them ourselves. Pattern cribbed from Comlink's throw transfer
 * handler — capture { name, message, stack } on serialise; rehydrate as a
 * real Error on deserialise so callers can `instanceof Error` and inspect
 * the original stack frames.
 */

export interface SerializedError {
  name: string;
  message: string;
  stack?: string;
}

export function serializeError(err: unknown): SerializedError {
  if (err instanceof Error) {
    return {
      name: err.name,
      message: err.message,
      stack: err.stack,
    };
  }
  return {
    name: 'Error',
    message: typeof err === 'string' ? err : safeStringify(err),
  };
}

export function deserializeError(serialized: SerializedError): Error {
  const err = new Error(serialized.message);
  err.name = serialized.name;
  if (serialized.stack) err.stack = serialized.stack;
  return err;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
