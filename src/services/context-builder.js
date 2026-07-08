const transcriptStore = require('./transcript-store');
const logger = require('../core/logger').createServiceLogger('CONTEXT_BUILDER');

class ContextBuilder {
  constructor() {
    this.lastAnswerTimestamp = Date.now();
  }

  async build(manualText = '', meetingMemoryService, documentService, strategy = 'since-last-answer') {
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
    
    const promptParts = [];

    // Prioritized context assembly:
    // 3. Meeting Summary
    // 4. Structured Facts
    // 5. Recent Transcript
    // 6. Relevant Document Chunks
    // 7. Current User Question
    
    if (meetingMemoryService) {
      const memorySnapshot = meetingMemoryService.getMemorySnapshot();
      const layer1 = memorySnapshot.layer1 || { decisions: [], action_items: [], constraints: [], key_facts: [] };
      const layer2 = memorySnapshot.layer2 || '';
      const layer3 = memorySnapshot.layer3 || '';

      // 3. Meeting Summary (Narrative)
      if (layer2 && layer2.trim()) {
        promptParts.push(`=== MEETING SUMMARY ===\n${layer2.trim()}`);
      }

      // 4. Structured Facts
      const decisionsStr = (layer1.decisions || []).map(d => `- ${d.text} (owner: ${d.owner || 'null'}, at ${d.timestamp || 'null'})`).join("\n");
      const actionItemsStr = (layer1.action_items || []).map(ai => `- ${ai.text} (owner: ${ai.owner || 'null'}, due: ${ai.due || 'null'})`).join("\n");
      const constraintsStr = (layer1.constraints || []).map(c => `- ${c.text} (raised by: ${c.raised_by || 'null'})`).join("\n");
      const keyFactsStr = (layer1.key_facts || []).map(kf => `- ${kf.text} (at ${kf.timestamp || 'null'})`).join("\n");

      const factsList = [];
      if (decisionsStr) factsList.push(`Decisions:\n${decisionsStr}`);
      if (actionItemsStr) factsList.push(`Action Items:\n${actionItemsStr}`);
      if (constraintsStr) factsList.push(`Constraints:\n${constraintsStr}`);
      if (keyFactsStr) factsList.push(`Key Facts:\n${keyFactsStr}`);

      if (factsList.length > 0) {
        promptParts.push(`=== STRUCTURED FACTS ===\n${factsList.join('\n\n')}`);
      }

      // 5. Recent Transcript
      if (layer3 && layer3.trim()) {
        promptParts.push(`=== RECENT TRANSCRIPT ===\n${layer3.trim()}`);
      }
    }

    // 6. Relevant Document Chunks
    if (documentService) {
      const query = (manual + " " + transcriptText).trim();
      if (query) {
        try {
          // Retrieve only up to 3 chunks (~1000 tokens maximum) to respect prompt token budget
          const relevantChunks = await documentService.retrieveRelevantChunks(query, 3);
          if (relevantChunks && relevantChunks.trim()) {
            promptParts.push(relevantChunks.trim());
          }
        } catch (docErr) {
          logger.error('Failed to retrieve relevant document chunks:', docErr);
        }
      }
    }

    // 7. Current User Question (Combined manual question and recent speech transcript)
    const userParts = [manual, transcriptText].filter(Boolean);
    const userPrompt = userParts.join('\n\n').trim();
    if (userPrompt) {
      promptParts.push(`=== USER QUESTION ===\n${userPrompt}`);
    }
    
    const finalPrompt = promptParts.join('\n\n').trim();
    
    logger.debug('Context built successfully:', {
      strategy,
      manualLength: manual.length,
      transcriptLength: transcriptText.length,
      promptLength: finalPrompt.length
    });
    
    return finalPrompt;
  }
  
  resetAnswerTimestamp() {
    this.lastAnswerTimestamp = Date.now();
    logger.info('ContextBuilder lastAnswerTimestamp reset to now');
  }
}

module.exports = new ContextBuilder();
