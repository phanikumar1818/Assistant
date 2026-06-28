const transcriptStore = require('./transcript-store');
const logger = require('../core/logger').createServiceLogger('CONTEXT_BUILDER');

class ContextBuilder {
  constructor() {
    this.lastAnswerTimestamp = Date.now();
  }

  build(manualText = '', strategy = 'since-last-answer') {
    const manual = (manualText || '').trim();
    let transcriptSegments = [];
    
    if (strategy === 'last-n-seconds') {
      // Default to last 120 seconds of transcription
      transcriptSegments = transcriptStore.getLastNSeconds(120);
    } else {
      // since-last-answer strategy (default)
      transcriptSegments = transcriptStore.getSince(this.lastAnswerTimestamp);
    }
    
    // Combine segments into one string
    const transcriptText = transcriptSegments.map(s => s.text).join(' ').trim();
    
    // Update lastAnswerTimestamp for next time
    this.lastAnswerTimestamp = Date.now();
    
    // Combine manualText and transcriptText
    const parts = [manual, transcriptText].filter(Boolean);
    const prompt = parts.join('\n\n').trim();
    
    logger.debug('Context built successfully:', {
      strategy,
      manualLength: manual.length,
      transcriptLength: transcriptText.length,
      promptLength: prompt.length
    });
    
    return prompt;
  }
  
  resetAnswerTimestamp() {
    this.lastAnswerTimestamp = Date.now();
    logger.info('ContextBuilder lastAnswerTimestamp reset to now');
  }
}

module.exports = new ContextBuilder();
