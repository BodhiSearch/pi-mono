// Intentionally malformed — verifies the loader captures the syntax
// error as a per-extension descriptor.error without taking down the
// rest of the scan. DO NOT fix the syntax; that's the test.
export default function broken(pi {
  pi.registerCommand('broken', { handler: () => {} });
}
