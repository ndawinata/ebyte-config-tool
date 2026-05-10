/**
 * Web Serial wrapper for continuous RX streaming + raw TX.
 * One instance per physical USB-serial device (multi-device terminals).
 */

export class StreamingSerial {
  constructor() {
    this.port = null;
    this.reader = null;
    this.writer = null;
    this._closing = false;
    this._readLoopRunning = false;
  }

  static isSupported() {
    return 'serial' in navigator;
  }

  async requestPort() {
    if (!StreamingSerial.isSupported()) {
      throw new Error('Web Serial is not supported in this browser.');
    }
    this.port = await navigator.serial.requestPort();
    return this.port;
  }

  hasPort() {
    return this.port != null;
  }

  isOpen() {
    return !!(this.port && this.writer && this.reader && !this._closing);
  }

  async open(options = {}) {
    if (!this.port) throw new Error('No port selected.');
    const opts = {
      baudRate: 9600,
      dataBits: 8,
      stopBits: 1,
      parity: 'none',
      bufferSize: 4096,
      flowControl: 'none',
      ...options,
    };
    await this.port.open(opts);
    this._closing = false;
    this.writer = this.port.writable.getWriter();
    this.reader = this.port.readable.getReader();
  }

  /**
   * Start background reads. onChunk receives a Uint8Array for each chunk.
   * Call once after open().
   */
  startReader(onChunk) {
    if (this._readLoopRunning) return;
    this._readLoopRunning = true;
    (async () => {
      try {
        while (!this._closing && this.reader) {
          const { value, done } = await this.reader.read();
          if (done) break;
          if (value && value.length && typeof onChunk === 'function') {
            onChunk(new Uint8Array(value));
          }
        }
      } catch (err) {
        if (!this._closing) console.warn('StreamingSerial read:', err);
      } finally {
        this._readLoopRunning = false;
      }
    })();
  }

  async write(bytes) {
    if (!this.writer) throw new Error('Port is not open.');
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    await this.writer.write(u8);
  }

  async close() {
    this._closing = true;
    try {
      if (this.reader) {
        await this.reader.cancel().catch(() => {});
        try {
          this.reader.releaseLock();
        } catch (_) {}
      }
    } catch (_) {}
    this.reader = null;
    try {
      if (this.writer) {
        await this.writer.close().catch(() => {});
        try {
          this.writer.releaseLock?.();
        } catch (_) {}
      }
    } catch (_) {}
    this.writer = null;
    try {
      if (this.port) await this.port.close().catch(() => {});
    } catch (_) {}
    this.port = null;
    this._readLoopRunning = false;
  }

  getPortLabel() {
    if (!this.port) return '—';
    const info = this.port.getInfo?.() || {};
    const v = info.usbVendorId ? info.usbVendorId.toString(16).padStart(4, '0').toUpperCase() : '----';
    const p = info.usbProductId ? info.usbProductId.toString(16).padStart(4, '0').toUpperCase() : '----';
    return `USB ${v}:${p}`;
  }
}
