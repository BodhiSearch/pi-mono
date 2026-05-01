export interface PortByteStream {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
}

/**
 * Build a pair of byte-streams over a `MessagePort` so both ends of the ACP
 * connection can speak the same `{ readable, writable }` shape that
 * `ndJsonStream` consumes on stdio. The port is switched into message mode
 * here; callers must not call `port.start()` themselves.
 */
export function createMessagePortStream(port: MessagePort): PortByteStream {
  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      port.onmessage = event => {
        const data = event.data;
        if (data instanceof Uint8Array) {
          controller.enqueue(data);
        } else if (data instanceof ArrayBuffer) {
          controller.enqueue(new Uint8Array(data));
        } else if (typeof data === 'string') {
          controller.enqueue(new TextEncoder().encode(data));
        }
      };
      port.onmessageerror = event => {
        controller.error(new Error(`MessagePort message error: ${String(event.data)}`));
      };
      port.start();
    },
    cancel() {
      port.onmessage = null;
      port.onmessageerror = null;
      port.close();
    },
  });

  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      // Copy to a standalone buffer to survive structured-clone across
      // the MessagePort boundary.
      const out = new Uint8Array(chunk.byteLength);
      out.set(chunk);
      port.postMessage(out, [out.buffer]);
    },
    close() {
      port.close();
    },
    abort() {
      port.close();
    },
  });

  return { readable, writable };
}
