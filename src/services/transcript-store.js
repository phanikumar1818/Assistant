const logger = require('../core/logger').createServiceLogger('TRANSCRIPT_STORE');

class TranscriptStore {
  constructor() {
    this.segments = [];
  }

  append({ text, startMs, endMs }) {
    const trimmed = (text || '').trim();
    if (!trimmed) return null;

    const now = Date.now();
    const segment = {
      text: trimmed,
      startMs: typeof startMs === 'number' ? startMs : now,
      endMs: typeof endMs === 'number' ? endMs : now + 1000
    };

    this.segments.push(segment);
    logger.debug('Appended segment to store:', segment);
    return segment;
  }

  getSince(timestampMs) {
    return this.segments.filter(s => s.startMs >= timestampMs);
  }

  getLastNSeconds(n) {
    const cutoff = Date.now() - (n * 1000);
    return this.segments.filter(s => s.startMs >= cutoff);
  }

  getAll() {
    return [...this.segments];
  }

  clear() {
    this.segments = [];
    logger.info('TranscriptStore cleared');
  }
}

module.exports = new TranscriptStore();
