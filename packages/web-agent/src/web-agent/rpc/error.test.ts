import { describe, expect, test } from 'vitest';
import { deserializeError, serializeError } from './error';

describe('serializeError / deserializeError', () => {
  test('round-trips an Error subclass preserving message + name + stack', () => {
    class CustomError extends Error {
      constructor(message: string) {
        super(message);
        this.name = 'CustomError';
      }
    }

    const original = new CustomError('boom');
    const serialized = serializeError(original);
    expect(serialized).toEqual({
      name: 'CustomError',
      message: 'boom',
      stack: original.stack,
    });

    const rehydrated = deserializeError(serialized);
    expect(rehydrated).toBeInstanceOf(Error);
    expect(rehydrated.name).toBe('CustomError');
    expect(rehydrated.message).toBe('boom');
    expect(rehydrated.stack).toBe(original.stack);
  });

  test('serialises a string error as the message body', () => {
    const serialized = serializeError('just a string');
    expect(serialized).toEqual({
      name: 'Error',
      message: 'just a string',
    });
  });

  test('serialises an object via JSON.stringify', () => {
    const serialized = serializeError({ kind: 'oops', code: 42 });
    expect(serialized.name).toBe('Error');
    expect(serialized.message).toBe('{"kind":"oops","code":42}');
  });

  test('handles values that cannot be JSON.stringified without throwing', () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    const serialized = serializeError(cyclic);
    expect(serialized.name).toBe('Error');
    expect(typeof serialized.message).toBe('string');
  });

  test('rehydrates without a stack when none was captured', () => {
    const rehydrated = deserializeError({ name: 'NoStack', message: 'hi' });
    expect(rehydrated.message).toBe('hi');
    expect(rehydrated.name).toBe('NoStack');
  });
});
