export class SourceClient {
  constructor(baseUrl) {
    const address = new URL(baseUrl);
    if (address.hostname !== '127.0.0.1') throw new Error('local source required');
    this.baseUrl = address;
  }

  /**
   * `timeout` bounds the whole read (headers plus body).  Attachment
   * downloads instead pass `headerTimeout`, because a large body may
   * legitimately take longer; their body is guarded by an idle timeout in
   * the attachment store.
   */
  async open(path, { headers = {}, signal = null, timeout = 2000, headerTimeout = null } = {}) {
    const address = new URL(path, this.baseUrl);
    if (address.origin !== this.baseUrl.origin) throw new Error('source origin changed');
    if (headerTimeout === null) {
      const signals = signal ? [AbortSignal.timeout(timeout), signal] : [AbortSignal.timeout(timeout)];
      return fetch(address, { headers, signal: AbortSignal.any(signals) });
    }
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error(`source did not respond within ${headerTimeout}ms`)),
      headerTimeout,
    );
    try {
      const signals = signal ? [controller.signal, signal] : [controller.signal];
      return await fetch(address, { headers, signal: AbortSignal.any(signals) });
    } finally { clearTimeout(timer); }
  }

  async read(path) {
    const response = await this.open(path);
    if (!response.ok) throw new Error(`source ${response.status}: ${path}`);
    return { text: await response.text(), contentType: response.headers.get('content-type') };
  }
}
