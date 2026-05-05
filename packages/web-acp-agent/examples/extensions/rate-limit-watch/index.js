export default function rateLimitWatch(pi) {
  pi.on('after_provider_response', async event => {
    const headers = event.headers ?? {};
    const remaining =
      headers['x-ratelimit-remaining-requests'] ??
      headers['x-ratelimit-remaining'] ??
      headers['anthropic-ratelimit-requests-remaining'];
    if (typeof remaining === 'string' && remaining.length > 0) {
      await pi.session.appendEntry('rate-limit', { remaining, status: event.status });
    } else {
      await pi.session.appendEntry('rate-limit', { remaining: null, status: event.status });
    }
  });
}
