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
      this.detailedSummaryDir = path.join(app.getPath('userData'), 'detailed_summary');
    } catch (e) {
      this.sessionsDir = path.join(process.cwd(), 'sessions');
      this.detailedSummaryDir = path.join(process.cwd(), 'detailed_summary');
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
      if (!fs.existsSync(this.detailedSummaryDir)) {
        fs.mkdirSync(this.detailedSummaryDir, { recursive: true });
      }
      console.log(`[SESSION] Sessions directory: ${this.sessionsDir}`);
      console.log(`[SESSION] Detailed summary directory: ${this.detailedSummaryDir}`);
    } catch (error) {
      console.error(`[SESSION] Failed to initialize sessions directories: ${error.message}`);
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
      structuredFacts: null,
      detailedSummary: ""
    };

    await this._writeFileToDisk(true);
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

      await this._writeFileToDisk(true);
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

    // Generate and save detailed summary to a separate file in detailed_summary directory
    if (llmService && session.transcriptLines.length > 0) {
      try {
        console.log('[SESSION] Generating detailed summary...');
        const detailedSummary = await this.generateDetailedSummary(llmService, session.transcriptLines);
        if (detailedSummary) {
          session.detailedSummary = detailedSummary;

          const detailedSummaryDateDir = path.join(this.detailedSummaryDir, dateDirName);
          if (!fs.existsSync(detailedSummaryDateDir)) {
            fs.mkdirSync(detailedSummaryDateDir, { recursive: true });
          }

          const detailedSummaryFilePath = path.join(detailedSummaryDateDir, fileName);
          let detailedSummaryMd = `# Detailed Summary: ${session.title}\n\n`;
          detailedSummaryMd += `${detailedSummary.trim()}\n`;

          fs.writeFileSync(detailedSummaryFilePath, detailedSummaryMd, 'utf8');
          console.log(`[SESSION] Detailed summary written to: ${detailedSummaryFilePath}`);
        }
      } catch (e) {
        console.error('[SESSION] Detailed summary generation or writing failed:', e.message);
      }
    }

    // Force write completed state to the new path
    await this._writeFileToDisk(true);

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

  async generateDetailedSummary(llmService, transcriptLines) {
    try {
      const fullTranscriptText = transcriptLines.map(l => `[${l.timestamp}] ${l.text}`).join('\n');

      const prompt = `You are a professional meeting assistant. Your task is to write a highly detailed, comprehensive meeting summary based on the provided meeting transcript. You must preserve all key concrete details (names, roles, years, former companies, projects, specific tools, numbers, decisions, and technology stack components) at all costs. Do not generalize or write high-level summaries that discard this information.

Format the summary with markdown headings and detailed bullet lists. The structure must contain a brief "# Meeting Summary" section followed by specific topical sections covering all aspects of the meeting, and end with an "# Action Items" section. Structure your headings based on the actual topics of the meeting.

Here is an example of the expected detail density, structure, and formatting:

=== EXPECTED STRUCTURE & STYLE EXAMPLE ===
# Meeting Summary
This meeting was primarily an introductory onboarding conversation between the new team member and their manager/team lead. The discussion focused on the team's structure, healthcare domain, onboarding expectations, and the technical environment rather than active project work.

# Team & Organization
The manager introduced themselves and explained they have been with the Medicaid team for about six years.
- Their primary responsibilities are chronic conditions and medication management, including diabetes, pharmacy initiatives, provider outreach, and other long-term health programs.
- The broader organization is divided into multiple functional squads, including: Chronic conditions, Maternity and women's health, Quality, and other healthcare-focused initiatives.
- The team is currently undergoing organizational changes because Chris is transitioning into a Quality-focused role, so responsibilities and team assignments are still being finalized.
- Because of this, the new hire's long-term project assignment has not yet been determined.

# Healthcare Domain Overview
The manager explained the team's primary objectives:
- Improve member health outcomes.
- Support government healthcare programs (primarily Medicaid).
- Work with HEDIS quality measures, which are government metrics used to evaluate health plan performance.
- Improve risk adjustment so the government can accurately reimburse health plans based on member health complexity.
- Develop initiatives that improve quality while also reducing healthcare costs.

# New Hire Background
The new hire shared previous experience:
- Approximately 3 years as a Data Scientist.
- Worked at Nordstrom, building data pipelines and preparing data for machine learning models, with emphasis on seasonality and inventory optimization.
- Previously worked at Highmark, focusing on insurance fraud detection, healthcare analytics, and identifying high-risk patient populations.
- Primary technologies: Python, SQL.
- Uses AI coding assistants (Claude, Cursor, etc.) mainly to improve productivity while still learning and understanding the underlying implementation.

# Technical Stack Discussed
The manager introduced the team's primary technologies:
- Google Cloud Platform (GCP) as the primary cloud environment.
- AI Workbench cloud development environments.
- BigQuery for querying large healthcare datasets.
- Internal Python libraries that abstract complex SQL queries.
- GitHub repositories containing team code.
- Cloud Composer / Apache Airflow for workflow orchestration.
- Google Kubernetes Engine (GKE) containers for application deployment.
- SSH tunneling and remote development setup as part of onboarding.

# Onboarding Guidance
While waiting for access, the manager recommended:
- Complete onboarding tasks.
- Learn GCP and Airflow concepts.
- Review healthcare and Medicaid documentation.
- Learn the fundamentals of Medicaid, HEDIS, and risk adjustment.
- Explore repositories and production pipelines once system access is available.

# Action Items
- Complete onboarding activities.
- Wait for access to GitHub, GCP, AI Workbench, and internal systems.
- Explore repositories and pipelines after access is granted.
- Study Medicaid, HEDIS, and risk adjustment concepts.
- Project assignment will be finalized after current team restructuring.
- Reach out to teammates whenever onboarding questions arise.
=== END OF EXAMPLE ===

Now, write the detailed meeting summary for the following transcript, strictly adhering to the example's structure, detail density, and style. Ensure all names, technologies, numbers, details, and action items discussed in the transcript are preserved.

Do NOT add a conversational intro (like "Here is the summary:") or outro. Start directly with the first markdown header.

Transcript:
${fullTranscriptText}`;

      console.log(`[LLM REQUEST - DETAILED SUMMARY] Sending transcript with ${transcriptLines.length} lines`);
      const rawResponse = await llmService.callGeminiRaw(prompt, 'DETAILED SUMMARY');
      
      if (!rawResponse || typeof rawResponse !== 'string') {
        throw new Error('Invalid response received from LLM for detailed summary');
      }

      return rawResponse.trim();
    } catch (error) {
      console.error(`[SESSION] Detailed summary generation failed: ${error.message}`);
      return null;
    }
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

      // Rename corresponding docs JSON file
      try {
        const documentService = require('./document.service');
        documentService.renameSessionDocs(oldPath, newPath);
      } catch (docErr) {
        console.error('[SESSION] Failed to rename associated docs JSON:', docErr.message);
      }

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

      // Delete corresponding docs JSON file
      try {
        const documentService = require('./document.service');
        documentService.deleteSessionDocs(targetPath);
      } catch (docErr) {
        console.error('[SESSION] Failed to delete associated docs JSON:', docErr.message);
      }

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
    if (!this.activeSession) return Promise.resolve();

    const now = Date.now();
    if (!force && (now - this._lastWriteTime < 3000)) {
      return Promise.resolve();
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

    return fs.promises.writeFile(session.filePath, md, 'utf8')
      .then(() => {
        console.log(`[SESSION] File written asynchronously: ${session.filePath}`);
      })
      .catch((err) => {
        console.error(`[SESSION] Failed to write session file to disk: ${err.message}`);
        throw err;
      });
  }

  async reopenSession(sessionId, deps) {
    try {
      console.log(`[SESSION] Reopening session ${sessionId}`);
      const sessions = await this.listSessions();
      const targetSession = sessions.find(s => s.id === sessionId);
      if (!targetSession) {
        console.warn(`[SESSION] Reopen failed: Session not found for ID ${sessionId}`);
        return { success: false, error: 'Session not found' };
      }

      const filePath = targetSession.filePath;
      if (!fs.existsSync(filePath)) {
        console.warn(`[SESSION] Reopen failed: File does not exist ${filePath}`);
        return { success: false, error: 'Session file not found' };
      }

      const content = fs.readFileSync(filePath, 'utf8');

      // Parse metadata
      const titleMatch = content.match(/^#\s+(.+)$/m);
      const title = titleMatch ? titleMatch[1].trim() : 'Untitled Meeting';

      const dateMatch = content.match(/-\s+\*\*Date:\*\*\s+(.+)$/m);
      const date = dateMatch ? dateMatch[1].trim() : '';

      const startMatch = content.match(/-\s+\*\*Start:\*\*\s+(.+)$/m);
      const startTime = startMatch ? startMatch[1].trim() : '';

      const endMatch = content.match(/-\s+\*\*End:\*\*\s+(.+)$/m);
      const endTime = endMatch ? endMatch[1].trim() : '';

      // Parse Summary
      let summarySnapshot = '';
      const summaryHeaderIndex = content.indexOf('## Summary');
      const factsHeaderIndex = content.indexOf('## Structured Facts');
      if (summaryHeaderIndex !== -1 && factsHeaderIndex !== -1) {
        summarySnapshot = content.substring(summaryHeaderIndex + '## Summary'.length, factsHeaderIndex).trim();
        if (summarySnapshot === '_Summary not yet generated._') {
          summarySnapshot = '';
        }
      }

      // Parse Structured Facts
      const structuredFacts = { decisions: [], action_items: [], constraints: [], key_facts: [] };
      
      const parseListUnderHeader = (headerText, endHeaderText) => {
        const headerIdx = content.indexOf(headerText);
        if (headerIdx === -1) return [];
        
        let sectionEndIdx = content.length;
        if (endHeaderText) {
          const endIdx = content.indexOf(endHeaderText, headerIdx);
          if (endIdx !== -1) sectionEndIdx = endIdx;
        }
        
        const sectionContent = content.substring(headerIdx + headerText.length, sectionEndIdx);
        const lines = sectionContent.split('\n');
        const items = [];
        
        for (const line of lines) {
          const cleanLine = line.trim();
          if (cleanLine.startsWith('-') && !cleanLine.startsWith('- _') && !cleanLine.includes('_None recorded._')) {
            items.push(cleanLine.substring(1).trim());
          }
        }
        return items;
      };

      // Extract decisions
      const decisionsList = parseListUnderHeader('### Decisions', '### Action Items');
      decisionsList.forEach(item => {
        const match = item.match(/(.+?)\s*\(Owner:\s*(.+?),\s*At:\s*(.+?)\)/i);
        if (match) {
          structuredFacts.decisions.push({
            text: match[1].trim(),
            owner: match[2].trim() === 'None' ? null : match[2].trim(),
            timestamp: match[3].trim() === 'None' ? null : match[3].trim()
          });
        } else {
          structuredFacts.decisions.push({ text: item, owner: null, timestamp: null });
        }
      });

      // Extract action items
      const actionItemsList = parseListUnderHeader('### Action Items', '### Constraints');
      actionItemsList.forEach(item => {
        const match = item.match(/(.+?)\s*\(Owner:\s*(.+?),\s*Due:\s*(.+?)\)/i);
        if (match) {
          structuredFacts.action_items.push({
            text: match[1].trim(),
            owner: match[2].trim() === 'None' ? null : match[2].trim(),
            due: match[3].trim() === 'None' ? null : match[3].trim()
          });
        } else {
          structuredFacts.action_items.push({ text: item, owner: null, due: null });
        }
      });

      // Extract constraints
      const constraintsList = parseListUnderHeader('### Constraints', '### Key Facts');
      constraintsList.forEach(item => {
        const match = item.match(/(.+?)\s*\(Raised by:\s*(.+?)\)/i);
        if (match) {
          structuredFacts.constraints.push({
            text: match[1].trim(),
            raised_by: match[2].trim() === 'None' ? null : match[2].trim()
          });
        } else {
          structuredFacts.constraints.push({ text: item, raised_by: null });
        }
      });

      // Extract key facts
      const keyFactsList = parseListUnderHeader('### Key Facts', '## Transcript');
      keyFactsList.forEach(item => {
        const match = item.match(/(.+?)\s*\(At:\s*(.+?)\)/i);
        if (match) {
          structuredFacts.key_facts.push({
            text: match[1].trim(),
            timestamp: match[2].trim() === 'None' ? null : match[2].trim()
          });
        } else {
          structuredFacts.key_facts.push({ text: item, timestamp: null });
        }
      });

      // Parse Transcript Lines
      const transcriptLines = [];
      const transcriptHeaderIdx = content.indexOf('## Transcript');
      if (transcriptHeaderIdx !== -1) {
        const transcriptSection = content.substring(transcriptHeaderIdx + '## Transcript'.length);
        const lines = transcriptSection.split('\n');
        for (const line of lines) {
          const cleanLine = line.trim();
          if (cleanLine.startsWith('[') && cleanLine.includes(']')) {
            const closingBracketIdx = cleanLine.indexOf(']');
            const timestamp = cleanLine.substring(1, closingBracketIdx).trim();
            const text = cleanLine.substring(closingBracketIdx + 1).trim();
            if (text && text !== '_No transcript recorded yet._') {
              transcriptLines.push({ timestamp, text });
            }
          }
        }
      }

      // Reconstruct start and end date objects safely
      let startTimeDate = new Date();
      if (date && startTime) {
        const parts = startTime.split(':');
        if (parts.length === 3) {
          startTimeDate = new Date(date);
          startTimeDate.setHours(parseInt(parts[0], 10), parseInt(parts[1], 10), parseInt(parts[2], 10));
        }
      }

      let endTimeDate = null;
      if (date && endTime && endTime !== 'In Progress' && endTime !== 'Completed') {
        const parts = endTime.split(':');
        if (parts.length === 3) {
          endTimeDate = new Date(date);
          endTimeDate.setHours(parseInt(parts[0], 10), parseInt(parts[1], 10), parseInt(parts[2], 10));
        }
      }

      // Re-populate active session
      this.activeSession = {
        id: sessionId,
        title,
        startTime: startTimeDate,
        endTime: endTimeDate,
        filePath,
        transcriptLines,
        summarySnapshot,
        structuredFacts,
        detailedSummary: ''
      };
      this.isIdle = false;
      this._titleGenerated = true;

      // Update dependencies
      if (deps.meetingMemoryService) {
        deps.meetingMemoryService.clear();
        deps.meetingMemoryService.layer1 = structuredFacts;
        deps.meetingMemoryService.layer2 = summarySnapshot;
        
        // Populate layer3 with the last 225 words
        const fullTranscriptText = transcriptLines.map(l => l.text).join(' ');
        const words = fullTranscriptText.split(/\s+/).filter(Boolean);
        deps.meetingMemoryService.layer3 = words.slice(-225).join(" ");
      }

      if (deps.sessionManager) {
        deps.sessionManager.clear();
        deps.sessionManager.addConversationEvent({
          role: 'system',
          content: `Meeting "${title}" reopened.`,
          action: 'session_reopened',
          metadata: { sessionId }
        });
      }

      if (deps.transcriptStore) {
        deps.transcriptStore.clear();
        transcriptLines.forEach(line => {
          deps.transcriptStore.append({ text: line.text });
        });
      }

      if (deps.documentService) {
        deps.documentService.clear();
        deps.documentService.setSession(sessionId, filePath);
      }

      console.log(`[SESSION] Successfully reopened session ${sessionId} with ${transcriptLines.length} transcript lines`);
      return { success: true, sessionId, title };
      
    } catch (error) {
      console.error(`[SESSION] Reopen failed for session ${sessionId}:`, error);
      return { success: false, error: error.message };
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
