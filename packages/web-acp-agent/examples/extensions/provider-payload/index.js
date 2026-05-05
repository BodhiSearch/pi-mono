export default function providerPayload(pi) {
  pi.on('before_provider_request', async event => {
    await pi.session.appendEntry('provider-payload', {
      hook: 'before_provider_request',
      hasPayload: typeof event.payload === 'object' && event.payload !== null,
    });
  });

  pi.on('after_provider_response', async event => {
    await pi.session.appendEntry('provider-payload', {
      hook: 'after_provider_response',
      status: event.status,
      hasHeaders: typeof event.headers === 'object' && event.headers !== null,
    });
  });
}
