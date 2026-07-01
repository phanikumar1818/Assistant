const fs = require('fs');
const path = require('path');
const logger = require('../core/logger').createServiceLogger('MEMORY');

class MeetingMemoryService {
  constructor(llmService) {
    this.llmService = llmService;
    this.layer1 = { decisions: [], action_items: [], constraints: [], key_facts: [] };
    this.layer2 = "";            // narrative summary string
    this.layer3 = "";            // recent raw transcript string
    this.unprocessedBuffer = ""; // transcript not yet incorporated into layers 1 & 2
    this.lastUpdateTokenCount = 0;
    this.UPDATE_TRIGGER_TOKENS = 600; // trigger update when buffer exceeds this
    this.isUpdating = false;
  }

  log(msg, level = 'info') {
    console.log(msg);
    if (level === 'error') {
      logger.error(msg);
    } else if (level === 'warn') {
      logger.warn(msg);
    } else {
      logger.info(msg);
    }
  }

  appendTranscript(text, timestamp) {
    if (!text || !text.trim()) return;
    const cleanText = text.trim();

    // Append new transcript text to unprocessedBuffer
    if (this.unprocessedBuffer) {
      this.unprocessedBuffer += " " + cleanText;
    } else {
      this.unprocessedBuffer = cleanText;
    }

    // Append new transcript text to layer3
    if (this.layer3) {
      this.layer3 += " " + cleanText;
    } else {
      this.layer3 = cleanText;
    }

    // Trim layer3 to last 300 tokens (split by words, keep last N words where N ≈ 300 * 0.75 ≈ 225 words)
    const words = this.layer3.split(/\s+/).filter(Boolean);
    if (words.length > 225) {
      this.layer3 = words.slice(-225).join(" ");
    }

    // Check for topic-shift keywords
    const lowerText = cleanText.toLowerCase();
    const topicShiftKeywords = [
      "okay moving on",
      "next topic",
      "different topic",
      "before we finish",
      "one more thing",
      "let's switch",
      "changing gears",
      "actually let's talk about"
    ];
    const hasTopicShift = topicShiftKeywords.some(keyword => lowerText.includes(keyword));

    // Estimates token count of unprocessedBuffer (word count * 1.33 as approximation)
    const bufferWords = this.unprocessedBuffer.split(/\s+/).filter(Boolean).length;
    const tokenEstimate = Math.ceil(bufferWords * 1.33);

    this.log(`[MEMORY] Buffer size: ~${tokenEstimate} tokens. Trigger threshold: ${this.UPDATE_TRIGGER_TOKENS}`);

    // Trigger update cycle if threshold exceeded or topic-shift detected
    if (tokenEstimate > this.UPDATE_TRIGGER_TOKENS || hasTopicShift) {
      this.triggerUpdateCycle();
    }
  }

  async triggerUpdateCycle() {
    if (this.isUpdating) {
      this.log(`[MEMORY] Update cycle already in progress. Buffering new transcript.`);
      return;
    }

    const chunkToProcess = this.unprocessedBuffer;
    this.unprocessedBuffer = "";

    const wordsCount = chunkToProcess.split(/\s+/).filter(Boolean).length;
    const tokens = Math.ceil(wordsCount * 1.33);

    this.log(`[MEMORY UPDATE] Starting update cycle. Chunk size: ~${tokens} tokens`);
    this.isUpdating = true;

    try {
      // Parallel execution of Layer 1 extraction and Layer 2 update
      await Promise.all([
        this.extractFacts(chunkToProcess).catch(err => {
          this.log(`[LLM ERROR - FACT EXTRACTION] ${err.message}`, 'error');
        }),
        this.updateNarrative(chunkToProcess).catch(err => {
          this.log(`[LLM ERROR - NARRATIVE UPDATE] ${err.message}`, 'error');
        })
      ]);
    } catch (error) {
      this.log(`[MEMORY] Unexpected error in parallel update cycle: ${error.message}`, 'error');
    } finally {
      this.isUpdating = false;
      const totalFacts = this.layer1.decisions.length + 
                         this.layer1.action_items.length + 
                         this.layer1.constraints.length + 
                         this.layer1.key_facts.length;
      this.log(`[MEMORY UPDATE] Cycle complete. L1 facts: ${totalFacts}, L2 length: ${this.layer2.length} chars`);
    }
  }

  async extractFacts(chunk) {
    try {
      const promptTemplate = fs.readFileSync(path.join(__dirname, '../../prompts/fact-extraction.txt'), 'utf8');

      const existingFactsStr = JSON.stringify(this.layer1, null, 2);
      const prompt = promptTemplate
        .replace('{{EXISTING_FACTS}}', existingFactsStr)
        .replace('{{TRANSCRIPT_CHUNK}}', chunk);

      this.log(`[LLM REQUEST - FACT EXTRACTION]\n${prompt}`);

      const rawResponse = await this.llmService.callGeminiRaw(prompt, 'FACT EXTRACTION');

      this.log(`[LLM RESPONSE - FACT EXTRACTION]\n${rawResponse}`);

      let cleanJson = rawResponse.trim();
      // Strip markdown JSON codeblock if present
      if (cleanJson.startsWith('```')) {
        cleanJson = cleanJson.replace(/^```json\s*/i, '').replace(/```$/, '').trim();
      }

      let parsed;
      try {
        parsed = JSON.parse(cleanJson);
      } catch (jsonErr) {
        this.log(`[LLM ERROR - FACT EXTRACTION] Invalid JSON response. Skipping update.`, 'error');
        return;
      }

      const newDecisions = Array.isArray(parsed.decisions) ? parsed.decisions : [];
      const newActionItems = Array.isArray(parsed.action_items) ? parsed.action_items : [];
      const newConstraints = Array.isArray(parsed.constraints) ? parsed.constraints : [];
      const newKeyFacts = Array.isArray(parsed.key_facts) ? parsed.key_facts : [];

      this.layer1.decisions.push(...newDecisions);
      this.layer1.action_items.push(...newActionItems);
      this.layer1.constraints.push(...newConstraints);
      this.layer1.key_facts.push(...newKeyFacts);

      this.log(`[MEMORY] New facts extracted — decisions: ${newDecisions.length}, action_items: ${newActionItems.length}, constraints: ${newConstraints.length}, key_facts: ${newKeyFacts.length}`);
    } catch (err) {
      this.log(`[LLM ERROR - FACT EXTRACTION] ${err.message}`, 'error');
      throw err;
    }
  }

  async updateNarrative(chunk) {
    try {
      const promptTemplate = fs.readFileSync(path.join(__dirname, '../../prompts/narrative-update.txt'), 'utf8');

      const currentNarrative = this.layer2 || "No narrative summary yet.";
      const prompt = promptTemplate
        .replace('{{CURRENT_NARRATIVE}}', currentNarrative)
        .replace('{{TRANSCRIPT_CHUNK}}', chunk);

      this.log(`[LLM REQUEST - NARRATIVE UPDATE]\n${prompt}`);

      const rawResponse = await this.llmService.callGeminiRaw(prompt, 'NARRATIVE UPDATE');

      this.log(`[LLM RESPONSE - NARRATIVE UPDATE]\n${rawResponse}`);

      this.layer2 = rawResponse.trim();
      this.log(`[MEMORY] Narrative updated. New length: ${this.layer2.length} chars`);
      
      if (this.onSummaryUpdate) {
        this.onSummaryUpdate(this.layer2, this.layer1);
      }
    } catch (err) {
      this.log(`[LLM ERROR - NARRATIVE UPDATE] ${err.message}`, 'error');
      throw err;
    }
  }

  getContextForQuestion() {
    const decisionsStr = this.layer1.decisions.map(d => `${d.text} (owner: ${d.owner || 'null'}, at ${d.timestamp || 'null'})`).join("\n");
    const actionItemsStr = this.layer1.action_items.map(ai => `${ai.text} (owner: ${ai.owner || 'null'}, due: ${ai.due || 'null'})`).join("\n");
    const constraintsStr = this.layer1.constraints.map(c => `${c.text} (raised by: ${c.raised_by || 'null'})`).join("\n");
    const keyFactsStr = this.layer1.key_facts.map(kf => `${kf.text} (at ${kf.timestamp || 'null'})`).join("\n");

    const context = `=== MEETING MEMORY ===
[STRUCTURED FACTS]

Decisions:
${decisionsStr}

Action Items:
${actionItemsStr}

Constraints:
${constraintsStr}

Key Facts:
${keyFactsStr}

[MEETING NARRATIVE]

${this.layer2}

[RECENT TRANSCRIPT]

${this.layer3}

=== END MEETING MEMORY ===`;

    const l1WordCount = JSON.stringify(this.layer1).split(/\s+/).filter(Boolean).length;
    const l1TokenEstimate = Math.ceil(l1WordCount * 1.33);

    const l2WordCount = (this.layer2 || "").split(/\s+/).filter(Boolean).length;
    const l2TokenEstimate = Math.ceil(l2WordCount * 1.33);

    const l3WordCount = (this.layer3 || "").split(/\s+/).filter(Boolean).length;
    const l3TokenEstimate = Math.ceil(l3WordCount * 1.33);

    const total = l1TokenEstimate + l2TokenEstimate + l3TokenEstimate;

    this.log(`[CONTEXT ASSEMBLED] L1: ${l1TokenEstimate} tokens | L2: ${l2TokenEstimate} tokens | L3: ${l3TokenEstimate} tokens | Total: ${total} tokens`);

    return context;
  }

  getMemorySnapshot() {
    const bufferWords = (this.unprocessedBuffer || "").split(/\s+/).filter(Boolean).length;
    const bufferTokenEstimate = Math.ceil(bufferWords * 1.33);

    return {
      layer1: this.layer1,
      layer2: this.layer2,
      layer3: this.layer3,
      unprocessedBuffer: this.unprocessedBuffer,
      bufferTokenEstimate
    };
  }

  exportSession() {
    return {
      "exported_at": new Date().toISOString(),
      "structured_facts": { ...this.layer1 },
      "narrative_summary": this.layer2,
      "session_stats": {
        "total_decisions": this.layer1.decisions.length,
        "total_action_items": this.layer1.action_items.length,
        "total_constraints": this.layer1.constraints.length,
        "total_key_facts": this.layer1.key_facts.length
      }
    };
  }

  async finalizeRemaining() {
    this.log(`[MEMORY] Finalizing remaining transcript in buffer.`);
    while (this.isUpdating) {
      this.log(`[MEMORY] Waiting for existing update cycle to finish...`);
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    if (this.unprocessedBuffer && this.unprocessedBuffer.trim()) {
      await this.triggerUpdateCycle();
    }
  }

  clear() {
    this.layer1 = { decisions: [], action_items: [], constraints: [], key_facts: [] };
    this.layer2 = "";
    this.layer3 = "";
    this.unprocessedBuffer = "";
    this.lastUpdateTokenCount = 0;
    this.isUpdating = false;
    this.log(`[MEMORY] Meeting memory cleared.`);
  }
}

module.exports = MeetingMemoryService;
