const fs = require('fs');
const path = require('path');
const { app } = require('electron');

function slugify(text) {
  return text
    .toString()
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')           // Replace spaces with -
    .replace(/[^\w\-]+/g, '')       // Remove all non-word chars
    .replace(/\-\-+/g, '-');        // Replace multiple - with single -
}

function sanitizeFilename(text) {
  if (!text) return "Untitled Meeting";
  let sanitized = text.toString().replace(/[\\/:*?"<>|]/g, '').trim();
  if (!sanitized) {
    sanitized = "Untitled Meeting";
  }
  return sanitized;
}

function getESTDateTimeStrings(date = new Date()) {
  const dOpts = { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' };
  const tOpts = { timeZone: 'America/New_York', hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' };
  
  const dFormatter = new Intl.DateTimeFormat('en-US', dOpts);
  const tFormatter = new Intl.DateTimeFormat('en-US', tOpts);
  
  const dParts = dFormatter.formatToParts(date);
  const year = dParts.find(p => p.type === 'year').value;
  const month = dParts.find(p => p.type === 'month').value;
  const day = dParts.find(p => p.type === 'day').value;
  
  const timeStr = tFormatter.format(date); // HH:mm:ss
  
  const dateStr = `${year}-${month}-${day}`; // YYYY-MM-DD
  const idStr = `${year}-${month}-${day}_${timeStr.replace(/:/g, '-')}`;
  
  return { dateStr, timeStr, idStr };
}

class PersistentSessionManager {
  constructor() {
    this.activeSession = null;
    // Get the userData directory, fallback to current dir if app is not ready/mocked
    try {
      this.sessionsDir = path.join(app.getPath('userData'), 'sessions');
    } catch (e) {
      this.sessionsDir = path.join(process.cwd(), 'sessions');
    }
    this.isIdle = true;
    this._lastWriteTime = 0;
    this._titleGenerated = false;
  }

  async initialize() {
    try {
      if (!fs.existsSync(this.sessionsDir)) {
        fs.mkdirSync(this.sessionsDir, { recursive: true });
      }
      console.log(`[SESSION] Sessions directory: ${this.sessionsDir}`);
    } catch (error) {
      console.error(`[SESSION] Failed to initialize sessions directory: ${error.message}`);
    }
  }

  async startSession() {
    if (!this.isIdle) {
      console.log('[SESSION] Cannot start — session already active');
      return null;
    }

    const { idStr } = getESTDateTimeStrings(new Date());
    const id = idStr;
    this.isIdle = false;
    this._titleGenerated = false;
    const filePath = path.join(this.sessionsDir, `${id}_untitled.md`);

    this.activeSession = {
      id,
      title: "Untitled Meeting",
      startTime: new Date(),
      endTime: null,
      filePath,
      transcriptLines: [],
      summarySnapshot: "",
      structuredFacts: null
    };

    this._writeFileToDisk(true);
    console.log(`[SESSION] Started session ${id}. File: ${filePath}`);
    return { id, startTime: this.activeSession.startTime, filePath };
  }

  appendTranscriptLine(text, timestamp) {
    if (!this.activeSession) return;

    this.activeSession.transcriptLines.push({ timestamp, text });
    this._writeFileToDisk();
    console.log(`[SESSION] Transcript line appended. Total lines: ${this.activeSession.transcriptLines.length}`);
  }

  updateSummary(narrativeText, structuredFacts) {
    if (!this.activeSession) return;

    this.activeSession.summarySnapshot = narrativeText;
    this.activeSession.structuredFacts = structuredFacts;
    this._writeFileToDisk();
    console.log(`[SESSION] Summary snapshot updated. Length: ${narrativeText ? narrativeText.length : 0} chars`);
  }

  async generateAndSetTitle(llmService) {
    if (!this.activeSession) return null;
    if (this.activeSession.transcriptLines.length < 20) {
      console.log(`[SESSION] Not enough transcript for title yet`);
      return null;
    }

    try {
      const summary = this.activeSession.summarySnapshot || "No narrative summary yet.";
      const fullTranscriptText = this.activeSession.transcriptLines.map(l => l.text).join(' ');
      const words = fullTranscriptText.split(/\s+/).filter(Boolean);
      const transcriptExcerpt = words.slice(0, 500).join(' ');

      const prompt = `Based on the following meeting transcript excerpt and summary, generate a concise meeting title.
The title should:

Be 2–5 words
Describe the meeting's main topic or purpose
Sound professional (e.g. "Sprint Planning", "Backend Architecture Review", "Q3 Sales Sync")
NOT include the word "meeting" unless necessary
NOT include dates or times

Summary:
${summary}
First 500 words of transcript:
${transcriptExcerpt}
Respond with ONLY the title. No punctuation at the end. No quotes. No explanation.`;

      console.log(`[LLM REQUEST - TITLE GENERATION]\n${prompt}`);
      const rawResponse = await llmService.callGeminiRaw(prompt, 'TITLE GENERATION');
      console.log(`[LLM RESPONSE - TITLE GENERATION]\n${rawResponse}`);

      if (!rawResponse || typeof rawResponse !== 'string') {
        throw new Error('Invalid response received from LLM for title generation');
      }

      let cleanTitle = rawResponse.trim();
      cleanTitle = cleanTitle.replace(/^["']|["']$/g, '').trim();
      if (cleanTitle.length > 60) {
        cleanTitle = cleanTitle.substring(0, 60);
      }
      if (!cleanTitle) {
        cleanTitle = "Untitled Meeting";
      }

      const id = this.activeSession.id;
      const oldPath = this.activeSession.filePath;
      const newFileName = `${id}_${slugify(cleanTitle)}.md`;
      const newPath = path.join(this.sessionsDir, newFileName);

      this.activeSession.title = cleanTitle;
      this.activeSession.filePath = newPath;

      if (oldPath !== newPath) {
        if (fs.existsSync(oldPath)) {
          try {
            fs.renameSync(oldPath, newPath);
          } catch (renameError) {
            // Fallback: write to new path first, then try deleting old
            fs.writeFileSync(newPath, fs.readFileSync(oldPath));
            try { fs.unlinkSync(oldPath); } catch (unlinkErr) {}
          }
        }
      }

      this._writeFileToDisk(true);
      console.log(`[SESSION] Title generated: "${cleanTitle}". File renamed.`);
      return cleanTitle;
    } catch (error) {
      console.error(`[SESSION] Title generation failed: ${error.message}`);
      return null;
    }
  }

  async stopSession(deps) {
    if (this.isIdle || !this.activeSession) {
      console.log('[SESSION] No active session to stop');
      return null;
    }

    const { BrowserWindow } = require('electron');
    const session = this.activeSession;
    session.endTime = new Date();

    // 1. Broadcast session-stopped IPC event to renderer windows to disable microphone
    BrowserWindow.getAllWindows().forEach((window) => {
      window.webContents.send("session-stopped");
    });
    console.log('[SESSION STOP] Broadcasting session-stopped to disable mic');

    // Wait a brief delay (600ms) for final Whisper audio chunk transcription to finish
    await new Promise(resolve => setTimeout(resolve, 600));

    // 2. Finalize any remaining transcript in the meetingMemoryService buffer
    if (deps.meetingMemoryService) {
      await deps.meetingMemoryService.finalizeRemaining();
    }

    // Now update our session's final summary and facts from meetingMemoryService
    if (deps.meetingMemoryService) {
      const memorySnapshot = deps.meetingMemoryService.getMemorySnapshot();
      session.summarySnapshot = memorySnapshot.layer2;
      session.structuredFacts = memorySnapshot.layer1;
    }

    // 3. Generate the AI meeting title using the final meeting summary (if LLM is available)
    const llmService = deps.meetingMemoryService ? deps.meetingMemoryService.llmService : null;
    if (llmService) {
      try {
        const generatedTitle = await this.generateTitleFromSummary(llmService, session.summarySnapshot, session.transcriptLines);
        if (generatedTitle) {
          session.title = generatedTitle;
        }
      } catch (e) {
        console.error('[SESSION] Final title generation failed:', e.message);
      }
    }

    // 4. No empty files check: If session.transcriptLines.length === 0, clean up/delete any existing file and do not save
    if (session.transcriptLines.length === 0) {
      console.log('[SESSION] Empty session ended. Cleaning up temporary file.');
      if (fs.existsSync(session.filePath)) {
        try {
          fs.unlinkSync(session.filePath);
        } catch (err) {
          console.error('[SESSION] Failed to delete empty session file:', err.message);
        }
      }

      this._resetContext(deps);
      this.activeSession = null;
      this.isIdle = true;
      return null;
    }

    // 5. Date-based Storage & Duplicate Handling
    const { dateStr: dateDirName } = getESTDateTimeStrings(session.startTime);
    const dateDir = path.join(this.sessionsDir, dateDirName);

    if (!fs.existsSync(dateDir)) {
      fs.mkdirSync(dateDir, { recursive: true });
    }

    const baseName = sanitizeFilename(session.title);
    let fileName = `${baseName}.md`;
    let newPath = path.join(dateDir, fileName);
    let counter = 2;
    while (fs.existsSync(newPath)) {
      fileName = `${baseName} (${counter}).md`;
      newPath = path.join(dateDir, fileName);
      counter++;
    }

    const oldPath = session.filePath;
    session.filePath = newPath;

    // Force write completed state to the new path
    this._writeFileToDisk(true);

    // Clean up/delete the old intermediate file if it exists and is different from the new path
    if (oldPath && oldPath !== newPath && fs.existsSync(oldPath)) {
      try {
        fs.unlinkSync(oldPath);
      } catch (unlinkErr) {
        console.error('[SESSION] Failed to delete old temporary session file:', unlinkErr.message);
      }
    }

    const durationMs = session.endTime - session.startTime;
    const durationMinutes = Math.round(durationMs / 60000);

    console.log(`[SESSION] Session ended.
ID: ${session.id}
Title: ${session.title}
Duration: ${durationMinutes} min
Transcript lines: ${session.transcriptLines.length}
File: ${session.filePath}`);

    // 6. Reset all meeting-specific context
    this._resetContext(deps);

    const result = {
      id: session.id,
      title: session.title,
      duration: durationMinutes,
      filePath: session.filePath
    };

    this.activeSession = null;
    this.isIdle = true;
    
    // Broadcast session-cleared so renderer UI clears its text/views
    BrowserWindow.getAllWindows().forEach((window) => {
      window.webContents.send("session-cleared");
    });

    return result;
  }

  async generateTitleFromSummary(llmService, summaryText, transcriptLines) {
    try {
      const summary = summaryText || "No narrative summary yet.";
      const fullTranscriptText = transcriptLines.map(l => l.text).join(' ');
      const words = fullTranscriptText.split(/\s+/).filter(Boolean);
      const transcriptExcerpt = words.slice(0, 500).join(' ');

      const prompt = `Based on the following meeting transcript excerpt and summary, generate a concise meeting title.
The title should:

Be 2–5 words
Describe the meeting's main topic or purpose
Sound professional (e.g. "Sprint Planning", "Backend Architecture Review", "Q3 Sales Sync")
NOT include the word "meeting" unless necessary
NOT include dates or times

Summary:
${summary}
First 500 words of transcript:
${transcriptExcerpt}
Respond with ONLY the title. No punctuation at the end. No quotes. No explanation.`;

      console.log(`[LLM REQUEST - TITLE GENERATION]\n${prompt}`);
      const rawResponse = await llmService.callGeminiRaw(prompt, 'TITLE GENERATION');
      console.log(`[LLM RESPONSE - TITLE GENERATION]\n${rawResponse}`);

      if (!rawResponse || typeof rawResponse !== 'string') {
        throw new Error('Invalid response received from LLM for title generation');
      }

      let cleanTitle = rawResponse.trim();
      cleanTitle = cleanTitle.replace(/^["']|["']$/g, '').trim();
      if (cleanTitle.length > 60) {
        cleanTitle = cleanTitle.substring(0, 60);
      }
      return cleanTitle || null;
    } catch (error) {
      console.error(`[SESSION] Title generation failed: ${error.message}`);
      return null;
    }
  }

  _resetContext(deps) {
    // Reset MeetingMemoryService
    if (deps.meetingMemoryService) {
      deps.meetingMemoryService.clear();
      console.log('[SESSION RESET] MeetingMemoryService cleared');
    }

    // Reset SessionManager conversation history
    if (deps.sessionManager) {
      if (typeof deps.sessionManager.clearHistory === 'function') {
        deps.sessionManager.clearHistory();
      } else if (typeof deps.sessionManager.clear === 'function') {
        deps.sessionManager.clear();
      } else {
        deps.sessionManager.sessionMemory = [];
      }
      console.log('[SESSION RESET] SessionManager conversation history cleared');
    }

    // Clear transcript buffer
    if (deps.transcriptBuffer) {
      if (Array.isArray(deps.transcriptBuffer)) {
        deps.transcriptBuffer.length = 0;
      } else if (deps.transcriptBuffer.segments && Array.isArray(deps.transcriptBuffer.segments)) {
        deps.transcriptBuffer.segments.length = 0;
        if ('lastAnswerAt' in deps.transcriptBuffer) {
          deps.transcriptBuffer.lastAnswerAt = 0;
        }
      } else if (typeof deps.transcriptBuffer.clear === 'function') {
        deps.transcriptBuffer.clear();
      }
      console.log('[SESSION RESET] Transcript buffer cleared');
    }

    // Clear main's meeting transcript store (transcriptStore service)
    try {
      const transcriptStore = require('./transcript-store');
      if (transcriptStore && typeof transcriptStore.clear === 'function') {
        transcriptStore.clear();
        console.log('[SESSION RESET] transcriptStore service cleared');
      }
    } catch (e) {
      console.warn('[SESSION RESET] Failed to clear transcriptStore:', e.message);
    }
  }

  async renameSession(sessionId, newTitle) {
    try {
      const sessions = await this.listSessions();
      const targetSession = sessions.find(s => s.id === sessionId);
      if (!targetSession) {
        console.warn(`[SESSION] Session not found for rename: ${sessionId}`);
        return false;
      }

      const oldPath = targetSession.filePath;
      let content = fs.readFileSync(oldPath, 'utf8');

      // Replace the title line
      content = content.replace(/^#\s+.+$/m, `# ${newTitle}`);

      // If active session is the one being renamed, update it
      if (this.activeSession && this.activeSession.id === sessionId) {
        this.activeSession.title = newTitle;
      }

      const dateDir = path.dirname(oldPath);
      const baseName = sanitizeFilename(newTitle);
      let fileName = `${baseName}.md`;
      let newPath = path.join(dateDir, fileName);

      if (newPath !== oldPath) {
        let counter = 2;
        while (fs.existsSync(newPath)) {
          fileName = `${baseName} (${counter}).md`;
          newPath = path.join(dateDir, fileName);
          counter++;
        }
      }

      fs.writeFileSync(oldPath, content, 'utf8');
      fs.renameSync(oldPath, newPath);

      if (this.activeSession && this.activeSession.id === sessionId) {
        this.activeSession.filePath = newPath;
      }

      console.log(`[SESSION] Session ${sessionId} renamed to "${newTitle}" at ${newPath}`);
      return true;
    } catch (error) {
      console.error(`[SESSION] Error renaming session ${sessionId}:`, error);
      return false;
    }
  }

  async listSessions() {
    try {
      if (!fs.existsSync(this.sessionsDir)) {
        return [];
      }
      const sessions = [];
      const entries = fs.readdirSync(this.sessionsDir, { withFileTypes: true });

      const processFile = (filePath, fileName, defaultDate) => {
        try {
          const content = fs.readFileSync(filePath, 'utf8');
          const titleMatch = content.match(/^#\s+(.+)$/m);
          const title = titleMatch ? titleMatch[1].trim() : 'Untitled Meeting';

          const dateMatch = content.match(/-\s+\*\*Date:\*\*\s+(.+)$/m);
          const date = dateMatch ? dateMatch[1].trim() : defaultDate;

          const startMatch = content.match(/-\s+\*\*Start:\*\*\s+(.+)$/m);
          const startTime = startMatch ? startMatch[1].trim() : '';

          const endMatch = content.match(/-\s+\*\*End:\*\*\s+(.+)$/m);
          const endTime = endMatch ? endMatch[1].trim() : '';

          const durationMatch = content.match(/-\s+\*\*Duration:\*\*\s+(.+)$/m);
          const duration = durationMatch ? durationMatch[1].trim() : '';

          const idMatch = content.match(/-\s+\*\*Session ID:\*\*\s+(.+)$/m);
          const id = idMatch ? idMatch[1].trim() : fileName.replace('.md', '');

          sessions.push({
            id,
            title,
            date,
            startTime,
            endTime: endTime || 'Completed',
            duration: duration || 'N/A',
            filePath
          });
        } catch (fileErr) {
          console.error(`[SESSION] Error reading file ${filePath}:`, fileErr);
        }
      };

      for (const entry of entries) {
        const fullPath = path.join(this.sessionsDir, entry.name);
        if (entry.isDirectory()) {
          if (/^\d{4}-\d{2}-\d{2}$/.test(entry.name)) {
            const files = fs.readdirSync(fullPath);
            for (const file of files) {
              if (file.endsWith('.md')) {
                processFile(path.join(fullPath, file), file, entry.name);
              }
            }
          }
        } else if (entry.isFile() && entry.name.endsWith('.md')) {
          // Backward compatibility for root-level sessions
          processFile(fullPath, entry.name, '');
        }
      }

      sessions.sort((a, b) => b.id.localeCompare(a.id));
      console.log(`[SESSION] Listing sessions. Found: ${sessions.length} files`);
      return sessions;
    } catch (error) {
      console.error('[SESSION] Error listing sessions:', error);
      return [];
    }
  }

  async deleteSession(sessionId) {
    try {
      const sessions = await this.listSessions();
      let targetPath = null;
      const targetSession = sessions.find(s => s.id === sessionId);
      if (targetSession) {
        targetPath = targetSession.filePath;
      } else {
        const entries = fs.readdirSync(this.sessionsDir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(this.sessionsDir, entry.name);
          if (entry.isDirectory()) {
            if (/^\d{4}-\d{2}-\d{2}$/.test(entry.name)) {
              const files = fs.readdirSync(fullPath);
              const foundFile = files.find(file => file.startsWith(sessionId + '_') || file === `${sessionId}.md`);
              if (foundFile) {
                targetPath = path.join(fullPath, foundFile);
                break;
              }
            }
          } else if (entry.isFile() && entry.name.startsWith(sessionId + '_')) {
            targetPath = fullPath;
            break;
          }
        }
      }

      if (!targetPath) {
        console.warn(`[SESSION] Session file not found for delete: ${sessionId}`);
        return false;
      }

      fs.unlinkSync(targetPath);
      console.log(`[SESSION] Deleted session ${sessionId} at ${targetPath}`);

      const dateDir = path.dirname(targetPath);
      if (dateDir !== this.sessionsDir) {
        const files = fs.readdirSync(dateDir);
        if (files.length === 0) {
          fs.rmdirSync(dateDir);
          console.log(`[SESSION] Cleaned up empty date directory: ${dateDir}`);
        }
      }
      return true;
    } catch (error) {
      console.error(`[SESSION] Error deleting session ${sessionId}:`, error);
      return false;
    }
  }

  async getSessionContent(sessionId) {
    try {
      const sessions = await this.listSessions();
      let targetPath = null;
      const targetSession = sessions.find(s => s.id === sessionId);
      if (targetSession) {
        targetPath = targetSession.filePath;
      } else {
        const entries = fs.readdirSync(this.sessionsDir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(this.sessionsDir, entry.name);
          if (entry.isDirectory()) {
            if (/^\d{4}-\d{2}-\d{2}$/.test(entry.name)) {
              const files = fs.readdirSync(fullPath);
              const foundFile = files.find(file => file.startsWith(sessionId + '_') || file === `${sessionId}.md`);
              if (foundFile) {
                targetPath = path.join(fullPath, foundFile);
                break;
              }
            }
          } else if (entry.isFile() && entry.name.startsWith(sessionId + '_')) {
            targetPath = fullPath;
            break;
          }
        }
      }

      if (!targetPath) {
        console.warn(`[SESSION] Session file not found for get content: ${sessionId}`);
        return null;
      }
      return fs.readFileSync(targetPath, 'utf8');
    } catch (error) {
      console.error(`[SESSION] Error getting session content for ${sessionId}:`, error);
      return null;
    }
  }

  _writeFileToDisk(force = false) {
    if (!this.activeSession) return;

    const now = Date.now();
    if (!force && (now - this._lastWriteTime < 3000)) {
      return;
    }
    this._lastWriteTime = now;

    const session = this.activeSession;
    const { dateStr, timeStr: startStr } = getESTDateTimeStrings(session.startTime);
    const endStr = session.endTime ? getESTDateTimeStrings(session.endTime).timeStr : "In Progress";

    let durationStr = "In Progress";
    if (session.endTime) {
      const diffMs = session.endTime - session.startTime;
      const diffMins = Math.round(diffMs / 60000);
      durationStr = `${diffMins} min`;
    }

    let md = `# ${session.title}\n\n`;
    md += `## Metadata\n`;
    md += `- **Date:** ${dateStr}\n`;
    md += `- **Start:** ${startStr}\n`;
    md += `- **End:** ${endStr}\n`;
    md += `- **Duration:** ${durationStr}\n`;
    md += `- **Session ID:** ${session.id}\n\n`;

    md += `## Summary\n\n`;
    if (session.summarySnapshot && session.summarySnapshot.trim()) {
      md += `${session.summarySnapshot.trim()}\n\n`;
    } else {
      md += `_Summary not yet generated._\n\n`;
    }

    md += `## Structured Facts\n\n`;

    // Decisions
    md += `### Decisions\n`;
    if (session.structuredFacts && Array.isArray(session.structuredFacts.decisions) && session.structuredFacts.decisions.length > 0) {
      session.structuredFacts.decisions.forEach(d => {
        md += `- ${d.text} (Owner: ${d.owner || 'None'}, At: ${d.timestamp || 'None'})\n`;
      });
    } else {
      md += `_None recorded._\n`;
    }
    md += `\n`;

    // Action Items
    md += `### Action Items\n`;
    if (session.structuredFacts && Array.isArray(session.structuredFacts.action_items) && session.structuredFacts.action_items.length > 0) {
      session.structuredFacts.action_items.forEach(ai => {
        md += `- ${ai.text} (Owner: ${ai.owner || 'None'}, Due: ${ai.due || 'None'})\n`;
      });
    } else {
      md += `_None recorded._\n`;
    }
    md += `\n`;

    // Constraints
    md += `### Constraints\n`;
    if (session.structuredFacts && Array.isArray(session.structuredFacts.constraints) && session.structuredFacts.constraints.length > 0) {
      session.structuredFacts.constraints.forEach(c => {
        md += `- ${c.text} (Raised by: ${c.raised_by || 'None'})\n`;
      });
    } else {
      md += `_None recorded._\n`;
    }
    md += `\n`;

    // Key Facts
    md += `### Key Facts\n`;
    if (session.structuredFacts && Array.isArray(session.structuredFacts.key_facts) && session.structuredFacts.key_facts.length > 0) {
      session.structuredFacts.key_facts.forEach(kf => {
        md += `- ${kf.text} (At: ${kf.timestamp || 'None'})\n`;
      });
    } else {
      md += `_None recorded._\n`;
    }
    md += `\n`;

    md += `## Transcript\n\n`;
    if (session.transcriptLines && session.transcriptLines.length > 0) {
      session.transcriptLines.forEach(line => {
        md += `[${line.timestamp}] ${line.text}\n`;
      });
    } else {
      md += `_No transcript recorded yet._\n`;
    }

    try {
      fs.writeFileSync(session.filePath, md, 'utf8');
      console.log(`[SESSION] File written: ${session.filePath}`);
    } catch (err) {
      console.error(`[SESSION] Failed to write session file to disk: ${err.message}`);
    }
  }

  getStatus() {
    return {
      isIdle: this.isIdle,
      activeSession: this.activeSession ? {
        id: this.activeSession.id,
        title: this.activeSession.title,
        startTime: this.activeSession.startTime,
        transcriptLineCount: this.activeSession.transcriptLines.length,
        filePath: this.activeSession.filePath
      } : null
    };
  }
}

module.exports = PersistentSessionManager;
