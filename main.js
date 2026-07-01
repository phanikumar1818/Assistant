require("dotenv").config();

const { app, BrowserWindow, globalShortcut, session, ipcMain, desktopCapturer } = require("electron");
const logger = require("./src/core/logger").createServiceLogger("MAIN");
const config = require("./src/core/config");

// Enable Web Speech API and other experimental features
app.commandLine.appendSwitch('enable-speech-dispatcher');
app.commandLine.appendSwitch('enable-experimental-web-platform-features');
app.commandLine.appendSwitch('enable-features', 'WebSpeechAPI');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
// Enable hardware acceleration for audio
app.commandLine.appendSwitch('enable-usermedia-screen-capturing');
app.commandLine.appendSwitch('allow-http-screen-capture');
// Disable sandbox for audio access (needed on some systems)
app.commandLine.appendSwitch('no-sandbox');

// Services
const ocrService = require("./src/services/ocr.service");
const speechService = require("./src/services/speech.service");
const llmService = require("./src/services/llm.service");
const whisperService = require("./src/services/whisper.service");
const transcriptStore = require("./src/services/transcript-store");
const contextBuilder = require("./src/services/context-builder");
const MeetingMemoryService = require("./src/services/meeting-memory.service");
const meetingMemoryService = new MeetingMemoryService(llmService);
const PersistentSessionManager = require("./src/services/persistent-session.manager");
const persistentSession = new PersistentSessionManager();

meetingMemoryService.onSummaryUpdate = (narrative, facts) => {
  persistentSession.updateSummary(narrative, facts);

  // Trigger title generation after first real summary (non-blocking)
  if (persistentSession.activeSession && !persistentSession._titleGenerated) {
    persistentSession._titleGenerated = true;
    persistentSession.generateAndSetTitle(llmService).catch(e => {
      console.log('[SESSION] Title generation failed:', e.message);
    });
  }
};


// Managers
const windowManager = require("./src/managers/window.manager");
const sessionManager = require("./src/managers/session.manager");

let chunkBuffer = '';
let flushScheduled = false;

function scheduleFlush() {
  if (flushScheduled) return;
  flushScheduled = true;
  setTimeout(() => {
    if (chunkBuffer) {
      windowManager.broadcastToAllWindows('ai-chunk', chunkBuffer);
      chunkBuffer = '';
    }
    flushScheduled = false;
  }, 16);
}

class ApplicationController {
  constructor() {
    this.isReady = false;
    this.activeSkill = "meeting-assistant";
    this.codingLanguage = "javascript";
    this.appIcon = "terminal";
    this.fontSize = 13;
    this.bgOpacity = 0.85;
    this.windowGap = 20;
    this.displaySelection = "opened";
    this.includeMicrophone = true;
    this.includeSystemAudio = true;
    this.pendingScreenshot = null; // Store pending screenshot for AI context
    this.meetingTranscript = { segments: [], lastAnswerAt: 0 };
    this.currentRequestId = 0;

    this.loadSettings();

    // Window configurations for reference
    this.windowConfigs = {
      main: { title: "Vysper" },
      chat: { title: "Chat" },
      llmResponse: { title: "AI Response" },
      settings: { title: "Settings" },
    };

    this.setupStealth();
    this.setupEventHandlers();
  }

  loadSettings() {
    const fs = require('fs');
    const path = require('path');
    const settingsPath = path.join(app.getPath('userData'), 'settings.json');
    try {
      if (fs.existsSync(settingsPath)) {
        const raw = fs.readFileSync(settingsPath, 'utf8');
        const settings = JSON.parse(raw);
        if (settings.codingLanguage) this.codingLanguage = settings.codingLanguage;
        if (settings.activeSkill) this.activeSkill = settings.activeSkill;
        if (settings.appIcon) this.appIcon = settings.appIcon;
        if (settings.selectedIcon) this.appIcon = settings.selectedIcon;
        if (settings.fontSize !== undefined) this.fontSize = settings.fontSize;
        if (settings.bgOpacity !== undefined) this.bgOpacity = settings.bgOpacity;
        if (settings.windowGap !== undefined) this.windowGap = settings.windowGap;
        if (settings.displaySelection !== undefined) this.displaySelection = settings.displaySelection;
        if (settings.includeMicrophone !== undefined) this.includeMicrophone = settings.includeMicrophone;
        if (settings.includeSystemAudio !== undefined) this.includeSystemAudio = settings.includeSystemAudio;

        if (settings.windowGap !== undefined) {
          windowManager.windowGap = parseInt(settings.windowGap, 10) || 20;
        }

        logger.info("Persisted settings loaded successfully");
      }
    } catch (e) {
      logger.error("Failed to load settings from file", e.message);
    }
  }

  setupStealth() {
    if (config.get("stealth.disguiseProcess")) {
      process.title = config.get("app.processTitle");
    }

    // Set default stealth app name early
    app.setName("Terminal "); // Default to Terminal stealth mode
    process.title = "Terminal ";

    if (
      process.platform === "darwin" &&
      config.get("stealth.noAttachConsole")
    ) {
      process.env.ELECTRON_NO_ATTACH_CONSOLE = "1";
      process.env.ELECTRON_NO_ASAR = "1";
    }
  }

  setupEventHandlers() {
    app.whenReady().then(() => this.onAppReady());
    app.on("window-all-closed", () => this.onWindowAllClosed());
    app.on("activate", () => this.onActivate());
    app.on("will-quit", () => this.onWillQuit());

    this.setupIPCHandlers();
    this.setupServiceEventHandlers();
  }

  async onAppReady() {
    // Force stealth mode IMMEDIATELY when app is ready
    app.setName("Terminal ");
    process.title = "Terminal ";

    logger.info("Application starting", {
      version: config.get("app.version"),
      environment: config.get("app.isDevelopment")
        ? "development"
        : "production",
      platform: process.platform,
    });

    try {
      // Preload all prompts at startup
      const { promptLoader } = require('./prompt-loader');
      await promptLoader.preloadAllPrompts();

      this.setupPermissions();

      // Small delay to ensure desktop/space detection is accurate
      await new Promise((resolve) => setTimeout(resolve, 200));

      windowManager.setDisplaySelection(this.displaySelection);
      await windowManager.initializeWindows();
      this.setupGlobalShortcuts();

      // Initialize default stealth mode with terminal icon
      this.updateAppIcon("terminal");

      this.isReady = true;

      await persistentSession.initialize();

      logger.info("Application initialized successfully", {
        windowCount: Object.keys(windowManager.getWindowStats().windows).length,
        currentDesktop: "detected",
      });

      sessionManager.addEvent("Application started");
    } catch (error) {
      logger.error("Application initialization failed", {
        error: error.message,
      });
      app.quit();
    }
  }

  setupPermissions() {
    session.defaultSession.setPermissionRequestHandler(
      (webContents, permission, callback) => {
        const allowedPermissions = ["microphone", "camera", "display-capture", "media"];
        const granted = allowedPermissions.includes(permission);

        logger.info("Permission request", { permission, granted });
        callback(granted);
      }
    );

    session.defaultSession.setPermissionCheckHandler(
      (webContents, permission, requestingOrigin, details) => {
        const allowedPermissions = ["microphone", "camera", "display-capture", "media"];
        const granted = allowedPermissions.includes(permission);

        logger.info("Permission check request", { permission, granted });
        return granted;
      }
    );

    this.setupSystemAudioCapture();
  }

  setupSystemAudioCapture() {
    session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
      logger.info("setDisplayMediaRequestHandler invoked", {
        requestVideo: !!request.video,
        requestAudio: !!request.audio,
        userGesture: request.userGesture
      });
      try {
        const sources = await desktopCapturer.getSources({
          types: ["screen", "window"],
          thumbnailSize: { width: 0, height: 0 },
        });

        if (!sources.length) {
          logger.warn("No screen or window sources available for system audio capture");
          callback({});
          return;
        }

        const primarySource =
          sources.find((source) => source.id.startsWith("screen:")) ||
          sources.find((source) => /^screen|^entire|display/i.test(source.name)) ||
          sources[0];

        const response = { video: primarySource };

        if (process.platform === "win32" || process.platform === "linux") {
          response.audio = "loopback";
        }

        logger.info("Granting system audio capture", {
          source: primarySource.name,
          sourceId: primarySource.id,
          platform: process.platform,
          hasLoopback: !!response.audio,
        });

        callback(response);
      } catch (error) {
        logger.error("System audio capture handler failed", { error: error.message });
        callback({});
      }
    });
  }

  setupGlobalShortcuts() {
    const shortcuts = {
      "CommandOrControl+Shift+S": () => this.captureScreenshotForAI(),
      "CommandOrControl+Shift+V": () => windowManager.toggleVisibility(),
      "CommandOrControl+Shift+I": () => windowManager.toggleInteraction(),
      "CommandOrControl+Shift+C": () => windowManager.switchToWindow("chat"),
      "CommandOrControl+Shift+\\": () => this.clearSessionMemory(),
      "CommandOrControl+,": () => windowManager.showSettings(),
      "Alt+A": () => windowManager.toggleInteraction(),
      "Alt+R": () => this.toggleSpeechRecognition(),
      "CommandOrControl+Shift+T": () => windowManager.forceAlwaysOnTopForAllWindows(),
      "CommandOrControl+Shift+Alt+T": () => {
        const results = windowManager.testAlwaysOnTopForAllWindows();
        logger.info('Always-on-top test triggered via shortcut', results);
      },
      // Context-sensitive shortcuts based on interaction mode
      "CommandOrControl+Up": () => this.handleUpArrow(),
      "CommandOrControl+Down": () => this.handleDownArrow(),
      "CommandOrControl+Left": () => this.handleLeftArrow(),
      "CommandOrControl+Right": () => this.handleRightArrow(),
    };

    Object.entries(shortcuts).forEach(([accelerator, handler]) => {
      const success = globalShortcut.register(accelerator, handler);
      if (!success) {
        logger.warn("Global shortcut registration failed - accelerator might be in use by another app", { accelerator });
      } else {
        logger.info("Global shortcut registered", { accelerator });
      }
    });
  }

  setupServiceEventHandlers() {
    // When meeting listening starts, clear stores and reset context timers
    ipcMain.on("web-speech-started", () => {
      logger.info("Meeting audio capture started - clearing TranscriptStore");
      transcriptStore.clear();
      contextBuilder.resetAnswerTimestamp();

      BrowserWindow.getAllWindows().forEach((window) => {
        window.webContents.send("recording-started");
      });
    });

    ipcMain.on("web-speech-stopped", () => {
      logger.info("Meeting audio capture stopped");
      BrowserWindow.getAllWindows().forEach((window) => {
        window.webContents.send("recording-stopped");
      });
    });

    // Handle PCM audio chunks streamed from renderer process
    ipcMain.on("audio-chunk", async (event, float32Array) => {
      try {
        BrowserWindow.getAllWindows().forEach((window) => {
          window.webContents.send("whisper-status", { status: 'transcribing' });
        });

        logger.debug("Received audio chunk for transcription", { samples: float32Array.length });

        // Get the last 2 segments of text to use as prompt context
        const allSegments = transcriptStore.getAll();
        const previousText = allSegments.slice(-2).map(s => s.text).join(" ");

        const result = await whisperService.transcribe(float32Array, previousText);

        BrowserWindow.getAllWindows().forEach((window) => {
          window.webContents.send("whisper-status", { status: 'idle' });
        });

        if (result && result.text) {
          logger.info(`Whisper segment transcribed: "${result.text}" (latency: ${result.durationMs}ms)`);
          const segment = transcriptStore.append({ text: result.text });
          if (segment) {
            // Send new segment back to renderer windows for live rolling preview
            BrowserWindow.getAllWindows().forEach((window) => {
              window.webContents.send("transcript-segment", segment);
            });
          }
        }
      } catch (error) {
        logger.error("Failed to transcribe audio chunk with local Whisper:", error);
        BrowserWindow.getAllWindows().forEach((window) => {
          window.webContents.send("whisper-status", { status: 'idle' });
        });
      }
    });
  }

  setupIPCHandlers() {
    ipcMain.handle("take-screenshot", () => this.triggerScreenshotOCR());

    // Screenshot for AI vision handlers
    ipcMain.handle("capture-screenshot-for-ai", async () => {
      await this.captureScreenshotForAI();
      return { success: true, hasPendingScreenshot: this.hasPendingScreenshot() };
    });

    ipcMain.handle("process-screenshot-with-prompt", async (event, prompt) => {
      return await this.processScreenshotWithPrompt(prompt);
    });

    ipcMain.handle("has-pending-screenshot", () => {
      return { hasPendingScreenshot: this.hasPendingScreenshot() };
    });

    ipcMain.handle("clear-pending-screenshot", () => {
      this.clearPendingScreenshot();
      return { success: true };
    });

    ipcMain.handle("get-pending-screenshot-preview", () => {
      if (!this.pendingScreenshot) {
        return { hasScreenshot: false };
      }
      // Return a thumbnail/preview of the screenshot for UI display
      // We'll return a truncated base64 for preview (smaller size)
      return {
        hasScreenshot: true,
        timestamp: this.pendingScreenshot.capturedAt,
        // Full image for display in chat
        imageData: this.pendingScreenshot.imageData
      };
    });

    // Web Speech API is handled in renderer process
    ipcMain.handle("start-speech-recognition", () => {
      // Web Speech API is handled in renderer, just broadcast the event
      BrowserWindow.getAllWindows().forEach((window) => {
        window.webContents.send("recording-started");
      });
      return { isRecording: true, isSupported: true, message: 'Web Speech API' };
    });

    ipcMain.handle("stop-speech-recognition", () => {
      // Web Speech API is handled in renderer, just broadcast the event
      BrowserWindow.getAllWindows().forEach((window) => {
        window.webContents.send("recording-stopped");
      });
      return { isRecording: false, isSupported: true, message: 'Web Speech API' };
    });

    // Web Speech API handlers - events are handled in renderer
    // These are kept for compatibility but delegate to renderer

    ipcMain.on("chat-window-ready", () => {
      // Send a test message to confirm communication
      setTimeout(() => {
        windowManager.broadcastToAllWindows("transcription-received", {
          text: "Test message from main process - chat window communication is working!",
        });
      }, 1000);
    });

    ipcMain.on("test-chat-window", () => {
      windowManager.broadcastToAllWindows("transcription-received", {
        text: "🧪 IMMEDIATE TEST: Chat window IPC communication test successful!",
      });
    });

    ipcMain.handle("show-all-windows", () => {
      windowManager.showAllWindows();
      return windowManager.getWindowStats();
    });

    ipcMain.handle("hide-all-windows", () => {
      windowManager.hideAllWindows();
      return windowManager.getWindowStats();
    });

    ipcMain.handle("enable-window-interaction", () => {
      windowManager.setInteractive(true);
      return windowManager.getWindowStats();
    });

    ipcMain.handle("disable-window-interaction", () => {
      windowManager.setInteractive(false);
      return windowManager.getWindowStats();
    });

    ipcMain.handle("switch-to-chat", () => {
      windowManager.switchToWindow("chat", false);
      return windowManager.getWindowStats();
    });

    ipcMain.handle("is-chat-open", () => {
      const chatWin = windowManager.getWindow("chat");
      return chatWin ? chatWin.isVisible() : false;
    });

    ipcMain.handle("hide-chat", () => {
      const chatWin = windowManager.getWindow("chat");
      if (chatWin) {
        chatWin.hide();
      }
      return { success: true };
    });

    ipcMain.handle("show-chat", () => {
      const chatWin = windowManager.getWindow("chat");
      if (chatWin) {
        windowManager.showOnCurrentDesktop(chatWin);
      }
      return { success: true };
    });

    ipcMain.handle("switch-to-skills", () => {
      windowManager.switchToWindow("skills");
      return windowManager.getWindowStats();
    });

    ipcMain.handle("resize-window", (event, { width, height }) => {
      let targetWindow = null;
      BrowserWindow.getAllWindows().forEach((win) => {
        if (win.webContents === event.sender) {
          targetWindow = win;
        }
      });

      if (targetWindow) {
        const isResizable = targetWindow.isResizable();
        targetWindow.setResizable(true);
        targetWindow.setSize(width, height);
        targetWindow.setResizable(isResizable);
        logger.debug("Window resized based on sender", { id: targetWindow.id, width, height });
      } else {
        // Fallback to main window
        const mainWindow = windowManager.getWindow("main");
        if (mainWindow) {
          const isResizable = mainWindow.isResizable();
          mainWindow.setResizable(true);
          mainWindow.setSize(width, height);
          mainWindow.setResizable(isResizable);
          logger.debug("Main window resized (fallback)", { width, height });
        }
      }
      return { success: true };
    });

    ipcMain.handle("move-window", (event, { deltaX, deltaY }) => {
      const mainWindow = windowManager.getWindow("main");
      if (mainWindow) {
        const [currentX, currentY] = mainWindow.getPosition();
        const newX = currentX + deltaX;
        const newY = currentY + deltaY;
        mainWindow.setPosition(newX, newY);
        logger.debug("Main window moved", {
          deltaX,
          deltaY,
          from: { x: currentX, y: currentY },
          to: { x: newX, y: newY },
        });
      }
      return { success: true };
    });

    ipcMain.handle("get-session-history", () => {
      return sessionManager.getOptimizedHistory();
    });

    ipcMain.handle("get-memory-snapshot", () => {
      return meetingMemoryService.getMemorySnapshot();
    });

    ipcMain.handle("export-meeting-session", () => {
      return meetingMemoryService.exportSession();
    });

    ipcMain.handle("append-transcript", (event, text, timestamp) => {
      meetingMemoryService.appendTranscript(text, timestamp);
      const estTime = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      }).format(new Date());
      persistentSession.appendTranscriptLine(text, estTime);
      return { success: true };
    });

    ipcMain.handle("clear-session-memory", () => {
      sessionManager.clear();
      meetingMemoryService.clear();
      this.meetingTranscript = { segments: [], lastAnswerAt: 0 };
      windowManager.broadcastToAllWindows("session-cleared");
      return { success: true };
    });

    ipcMain.handle('session:start', async () => {
      console.log('[IPC] session:start received');
      const result = await persistentSession.startSession();
      BrowserWindow.getAllWindows().forEach((window) => {
        window.webContents.send("session-started");
      });
      return result;
    });

    ipcMain.handle('session:stop', async () => {
      console.log('[IPC] session:stop received');
      const result = await persistentSession.stopSession({
        meetingMemoryService,
        sessionManager,
        transcriptBuffer: this.meetingTranscript,
      });
      return result;
    });

    ipcMain.handle('session:status', () => {
      return persistentSession.getStatus();
    });

    ipcMain.handle('session:list', async () => {
      return await persistentSession.listSessions();
    });

    ipcMain.handle('session:delete', async (event, sessionId) => {
      console.log(`[IPC] session:delete received for ${sessionId}`);
      return await persistentSession.deleteSession(sessionId);
    });

    ipcMain.handle('session:rename', async (event, sessionId, newTitle) => {
      console.log(`[IPC] session:rename received for ${sessionId} to "${newTitle}"`);
      return await persistentSession.renameSession(sessionId, newTitle);
    });

    ipcMain.handle('session:get-content', async (event, sessionId) => {
      console.log(`[IPC] session:get-content received for ${sessionId}`);
      return await persistentSession.getSessionContent(sessionId);
    });

    ipcMain.handle('session:open-file', async (event, sessionId) => {
      console.log(`[IPC] session:open-file received for ${sessionId}`);
      const { shell } = require('electron');
      const sessions = await persistentSession.listSessions();
      const target = sessions.find(s => s.id === sessionId);
      if (target && target.filePath) {
        await shell.openPath(target.filePath);
        logger.info(`Opened session file: ${target.filePath}`);
        return { success: true };
      }
      return { success: false, error: 'Session file not found' };
    });


    ipcMain.handle("force-always-on-top", () => {
      windowManager.forceAlwaysOnTopForAllWindows();
      return { success: true };
    });

    ipcMain.handle("test-always-on-top", () => {
      const results = windowManager.testAlwaysOnTopForAllWindows();
      return { success: true, results };
    });

    ipcMain.handle("send-chat-message", async (event, text) => {
      // Check if there's a pending screenshot - if so, process with vision
      if (this.hasPendingScreenshot()) {
        logger.info('Processing chat message with pending screenshot', {
          textLength: text ? text.length : 0,
          hasPendingScreenshot: true
        });

        // Process the screenshot with the user's prompt
        const result = await this.processScreenshotWithPrompt(text);
        return result;
      }

      // Normal chat message processing (no screenshot)
      const manualText = text || '';
      if (manualText.trim()) {
        // Add manual chat message to session memory
        sessionManager.addUserInput(manualText, 'chat');
        logger.debug('Chat message added to session memory', { textLength: manualText.length });
      }

      // Process with local transcript context + manualText using ContextBuilder
      setTimeout(async () => {
        try {
          const compiledPrompt = contextBuilder.build(manualText);
          if (!compiledPrompt) {
            logger.warn("Skipping LLM processing for empty compiled prompt");
            return;
          }

          const meetingMemory = meetingMemoryService.getContextForQuestion();
          const memoryWords = meetingMemory.split(/\s+/).filter(Boolean).length;
          const tokenEstimate = Math.ceil(memoryWords * 1.33);
          console.log(`[QUESTION CONTEXT] Injecting meeting memory into LLM call. Total memory: ~${tokenEstimate} tokens`);
          logger.info(`[QUESTION CONTEXT] Injecting meeting memory into LLM call. Total memory: ~${tokenEstimate} tokens`);

          const compiledPromptWithMemory = meetingMemory + "\n\n" + compiledPrompt;

          const sessionHistory = sessionManager.getOptimizedHistory();

          logger.info("Processing compiled prompt with intelligent LLM response", {
            skill: this.activeSkill,
            promptLength: compiledPromptWithMemory.length
          });

          // Check if current skill needs programming language context
          const skillsRequiringProgrammingLanguage = ['meeting-assistant', 'programming', 'dsa', 'devops', 'system-design', 'data-science'];
          const needsProgrammingLanguage = skillsRequiringProgrammingLanguage.includes(this.activeSkill);

          const requestId = ++this.currentRequestId;
          chunkBuffer = '';
          flushScheduled = false;
          windowManager.broadcastToAllWindows('ai-response-start', { type: 'chat', text: manualText });

          const llmResult = await llmService.processTranscriptionWithIntelligentResponse(
            compiledPromptWithMemory,
            this.activeSkill,
            sessionHistory.recent,
            needsProgrammingLanguage ? this.codingLanguage : null,
            (chunk) => {
              if (requestId !== this.currentRequestId) return;
              chunkBuffer += chunk;
              scheduleFlush();
            }
          );

          if (requestId === this.currentRequestId) {
            if (chunkBuffer) {
              windowManager.broadcastToAllWindows('ai-chunk', chunkBuffer);
              chunkBuffer = '';
            }
            windowManager.broadcastToAllWindows('ai-response-end');

            // Add LLM response to session memory
            sessionManager.addModelResponse(llmResult.response, {
              skill: this.activeSkill,
              processingTime: llmResult.metadata.processingTime,
              usedFallback: llmResult.metadata.usedFallback,
              isTranscriptionResponse: true
            });

            // Send response to chat windows
            this.broadcastTranscriptionLLMResponse(llmResult);
          }

        } catch (error) {
          logger.error("Failed to process chat message with LLM", {
            error: error.message,
            text: manualText.substring(0, 100)
          });
          if (this.currentRequestId === this.currentRequestId) {
            windowManager.broadcastToAllWindows('ai-response-error', error.message);
            windowManager.broadcastToAllWindows('ai-response-end');
          }
          this.broadcastLLMError(error.message);
        }
      }, 10); // Reduced delay for immediate execution

      return { success: true };
    });

    ipcMain.handle("get-skill-prompt", (event, skillName) => {
      try {
        const { promptLoader } = require('./prompt-loader');
        const skillPrompt = promptLoader.getSkillPrompt(skillName);
        return skillPrompt;
      } catch (error) {
        logger.error('Failed to get skill prompt', { skillName, error: error.message });
        return null;
      }
    });

    ipcMain.handle("set-gemini-api-key", (event, apiKey) => {
      llmService.updateApiKey(apiKey);
      return llmService.getStats();
    });

    ipcMain.handle("get-gemini-status", () => {
      return llmService.getStats();
    });

    // Window binding IPC handlers
    ipcMain.handle("set-window-binding", (event, enabled) => {
      return windowManager.setWindowBinding(enabled);
    });

    ipcMain.handle("toggle-window-binding", () => {
      return windowManager.toggleWindowBinding();
    });

    ipcMain.handle("get-window-binding-status", () => {
      return windowManager.getWindowBindingStatus();
    });

    ipcMain.handle("get-window-stats", () => {
      return windowManager.getWindowStats();
    });

    ipcMain.handle("set-window-gap", (event, gap) => {
      return windowManager.setWindowGap(gap);
    });

    ipcMain.handle("move-bound-windows", (event, { deltaX, deltaY }) => {
      windowManager.moveBoundWindows(deltaX, deltaY);
      return windowManager.getWindowBindingStatus();
    });

    ipcMain.handle("test-gemini-connection", async () => {
      return await llmService.testConnection();
    });

    ipcMain.handle("toggle-continuous-listening", () => {
      windowManager.switchToWindow("chat", false);
      windowManager.setInteractive(true);
      BrowserWindow.getAllWindows().forEach((window) => {
        window.webContents.send("toggle-continuous-listening");
      });
      return { success: true };
    });

    ipcMain.handle("run-gemini-diagnostics", async () => {
      try {
        const connectivity = await llmService.checkNetworkConnectivity();
        const apiTest = await llmService.testConnection();

        return {
          success: true,
          connectivity,
          apiTest,
          timestamp: new Date().toISOString()
        };
      } catch (error) {
        return {
          success: false,
          error: error.message,
          timestamp: new Date().toISOString()
        };
      }
    });

    // Settings handlers
    ipcMain.handle("show-settings", () => {
      windowManager.showSettings();

      // Send current settings to the settings window
      const settingsWindow = windowManager.getWindow("settings");
      if (settingsWindow) {
        const currentSettings = this.getSettings();
        setTimeout(() => {
          settingsWindow.webContents.send("load-settings", currentSettings);
        }, 100);
      }

      return { success: true };
    });

    ipcMain.handle("get-settings", () => {
      return this.getSettings();
    });

    ipcMain.handle("get-displays", () => {
      const { screen } = require("electron");
      return screen.getAllDisplays().map((d, index) => ({
        id: d.id,
        label: `Display ${index + 1} (${d.bounds.width}x${d.bounds.height})${d.id === screen.getPrimaryDisplay().id ? ' (Primary)' : ''}`,
        isPrimary: d.id === screen.getPrimaryDisplay().id
      }));
    });

    ipcMain.handle("save-settings", (event, settings) => {
      return this.saveSettings(settings);
    });

    ipcMain.handle("update-app-icon", (event, iconKey) => {
      return this.updateAppIcon(iconKey);
    });

    ipcMain.handle("update-active-skill", (event, skill) => {
      this.activeSkill = skill;
      windowManager.broadcastToAllWindows("skill-changed", { skill });
      return { success: true };
    });

    ipcMain.handle("restart-app-for-stealth", () => {
      // Force restart the app to ensure stealth name changes take effect
      const { app } = require("electron");
      app.relaunch();
      app.exit();
    });

    ipcMain.handle("close-window", (event) => {
      const webContents = event.sender;
      const window = windowManager.windows.forEach((win, type) => {
        if (win.webContents === webContents) {
          win.hide();
          return true;
        }
      });
      return { success: true };
    });

    // LLM window specific handlers
    ipcMain.handle("expand-llm-window", (event, contentMetrics) => {
      windowManager.expandLLMWindow(contentMetrics);
      return { success: true, contentMetrics };
    });

    ipcMain.handle("resize-llm-window-for-content", (event, contentMetrics) => {
      // Use the same expansion logic for now, can be enhanced later
      windowManager.expandLLMWindow(contentMetrics);
      return { success: true, contentMetrics };
    });

    ipcMain.handle("quit-app", () => {
      logger.info("Quit app requested via IPC");
      try {
        // Force quit the application
        const { app } = require("electron");

        // Close all windows first
        windowManager.destroyAllWindows();

        // Unregister shortcuts
        globalShortcut.unregisterAll();

        // Force quit
        app.quit();

        // If the above doesn't work, force exit
        setTimeout(() => {
          process.exit(0);
        }, 2000);
      } catch (error) {
        logger.error("Error during quit:", error);
        process.exit(1);
      }
    });

    // Handle close settings
    ipcMain.on("close-settings", () => {
      const settingsWindow = windowManager.getWindow("settings");
      if (settingsWindow) {
        settingsWindow.hide();
      }
    });

    // Handle save settings (synchronous)
    ipcMain.on("save-settings", (event, settings) => {
      this.saveSettings(settings);
    });

    // Handle update skill
    ipcMain.on("update-skill", (event, skill) => {
      this.activeSkill = skill;
      windowManager.broadcastToAllWindows("skill-updated", { skill });
    });

    // Handle quit app (alternative method)
    ipcMain.on("quit-app", () => {
      logger.info("Quit app requested via IPC (on method)");
      try {
        const { app } = require("electron");
        windowManager.destroyAllWindows();
        globalShortcut.unregisterAll();

        // Terminate local Whisper server
        try {
          whisperService.stopServer();
        } catch (err) { }

        app.quit();
        setTimeout(() => process.exit(0), 1000);
      } catch (error) {
        logger.error("Error during quit (on method):", error);
        process.exit(1);
      }
    });

    // Clipboard write handler
    ipcMain.handle("write-to-clipboard", (event, text) => {
      try {
        const { clipboard } = require("electron");
        clipboard.writeText(text);
        return { success: true };
      } catch (error) {
        logger.error("Clipboard write failed:", error);
        return { success: false, error: error.message };
      }
    });
  }

  toggleSpeechRecognition() {
    windowManager.switchToWindow("chat", false);
    windowManager.setInteractive(true);

    BrowserWindow.getAllWindows().forEach((window) => {
      window.webContents.send("toggle-continuous-listening");
    });

    logger.info("Continuous listening toggle sent to renderer via global shortcut");
  }

  clearSessionMemory() {
    try {
      sessionManager.clear();
      meetingMemoryService.clear();
      windowManager.broadcastToAllWindows("session-cleared");
      logger.info("Session memory cleared via global shortcut");
    } catch (error) {
      logger.error("Error clearing session memory:", error);
    }
  }

  handleUpArrow() {
    const isInteractive = windowManager.getWindowStats().isInteractive;

    if (isInteractive) {
      // Interactive mode: Navigate to previous skill
      this.navigateSkill(-1);
    } else {
      // Non-interactive mode: Move window up
      windowManager.moveBoundWindows(0, -20);
    }
  }

  handleDownArrow() {
    const isInteractive = windowManager.getWindowStats().isInteractive;

    if (isInteractive) {
      // Interactive mode: Navigate to next skill
      this.navigateSkill(1);
    } else {
      // Non-interactive mode: Move window down
      windowManager.moveBoundWindows(0, 20);
    }
  }

  handleLeftArrow() {
    const isInteractive = windowManager.getWindowStats().isInteractive;

    if (!isInteractive) {
      // Non-interactive mode: Move window left
      windowManager.moveBoundWindows(-20, 0);
    }
    // Interactive mode: Left arrow does nothing
  }

  handleRightArrow() {
    const isInteractive = windowManager.getWindowStats().isInteractive;

    if (!isInteractive) {
      // Non-interactive mode: Move window right
      windowManager.moveBoundWindows(20, 0);
    }
    // Interactive mode: Right arrow does nothing
  }

  navigateSkill(direction) {
    const availableSkills = [
      "meeting-assistant",
      "programming",
      "dsa",
      "system-design",
      "behavioral",
      "data-science",
      "sales",
      "presentation",
      "negotiation",
      "devops",
    ];

    const currentIndex = availableSkills.indexOf(this.activeSkill);
    if (currentIndex === -1) {
      logger.warn("Current skill not found in available skills", {
        currentSkill: this.activeSkill,
        availableSkills,
      });
      return;
    }

    // Calculate new index with wrapping
    let newIndex = currentIndex + direction;
    if (newIndex >= availableSkills.length) {
      newIndex = 0; // Wrap to beginning
    } else if (newIndex < 0) {
      newIndex = availableSkills.length - 1; // Wrap to end
    }

    const newSkill = availableSkills[newIndex];
    this.activeSkill = newSkill;

    // Update session manager with the new skill
    sessionManager.setActiveSkill(newSkill);

    logger.info("Skill navigated via global shortcut", {
      from: availableSkills[currentIndex],
      to: newSkill,
      direction: direction > 0 ? "down" : "up",
    });

    // Broadcast the skill change to all windows
    windowManager.broadcastToAllWindows("skill-updated", { skill: newSkill });
  }

  async triggerScreenshotOCR() {
    if (!this.isReady) {
      logger.warn("Screenshot requested before application ready");
      return;
    }

    const startTime = Date.now();

    try {
      windowManager.showLLMLoading();

      const ocrResult = await ocrService.captureAndProcess();

      if (!ocrResult.text || ocrResult.text.trim().length === 0) {
        windowManager.hideLLMResponse();
        this.broadcastOCRError("No text found in screenshot");
        return;
      }

      // Add OCR extracted text to session memory
      sessionManager.addOCREvent(ocrResult.text, {
        processingTime: ocrResult.metadata?.processingTime,
        source: 'screenshot'
      });

      this.broadcastOCRSuccess(ocrResult);

      const sessionHistory = sessionManager.getOptimizedHistory();
      await this.processWithLLM(ocrResult.text, sessionHistory);
    } catch (error) {
      logger.error("Screenshot OCR process failed", {
        error: error.message,
        duration: Date.now() - startTime,
      });

      windowManager.hideLLMResponse();
      this.broadcastOCRError(error.message);

      sessionManager.addConversationEvent({
        role: 'system',
        content: `Screenshot OCR failed: ${error.message}`,
        action: 'ocr_error',
        metadata: {
          error: error.message
        }
      });
    }
  }

  /**
   * Capture screenshot for AI vision analysis
   * Opens chat window for user to provide follow-up context
   */
  async captureScreenshotForAI() {
    if (!this.isReady) {
      logger.warn("Screenshot capture requested before application ready");
      return;
    }

    const startTime = Date.now();

    try {
      logger.info("Capturing screenshot for AI analysis");

      // Capture the screenshot
      const screenshotResult = await ocrService.captureScreenshotForAI();

      if (!screenshotResult.success) {
        throw new Error("Failed to capture screenshot");
      }

      // Store the pending screenshot for when user provides a prompt
      this.pendingScreenshot = {
        imageData: screenshotResult.imageData,
        metadata: screenshotResult.metadata,
        capturedAt: new Date().toISOString()
      };

      logger.info("Screenshot captured and stored for AI context", {
        imageSize: screenshotResult.imageData.base64.length,
        processingTime: Date.now() - startTime
      });

      // Notify all windows that a screenshot is pending
      windowManager.broadcastToAllWindows("screenshot-captured", {
        hasPendingScreenshot: true,
        timestamp: this.pendingScreenshot.capturedAt,
        // Send a small thumbnail preview (first 100 chars of base64 for verification)
        previewAvailable: true
      });

      // Enable interaction mode and show chat window for user to type their prompt
      windowManager.setInteractive(true);
      windowManager.switchToWindow("chat", false);

      // Add system message to session about the screenshot
      sessionManager.addConversationEvent({
        role: 'system',
        content: 'Screenshot captured. Waiting for user prompt...',
        action: 'screenshot_captured',
        metadata: {
          processingTime: Date.now() - startTime,
          hasImage: true
        }
      });

    } catch (error) {
      logger.error("Screenshot capture for AI failed", {
        error: error.message,
        duration: Date.now() - startTime,
      });

      this.pendingScreenshot = null;
      windowManager.broadcastToAllWindows("screenshot-error", {
        error: error.message
      });
    }
  }

  /**
   * Process pending screenshot with user's prompt
   */
  async processScreenshotWithPrompt(userPrompt) {
    if (!this.pendingScreenshot) {
      logger.warn("No pending screenshot to process");
      return { success: false, error: "No screenshot available. Press Ctrl+Shift+S to capture first." };
    }

    const startTime = Date.now();

    try {
      logger.info("Processing screenshot with user prompt", {
        promptLength: userPrompt.length,
        skill: this.activeSkill
      });

      // Add user input to session memory
      sessionManager.addUserInput(userPrompt, 'screenshot_prompt');

      // Get session history for context
      const sessionHistory = sessionManager.getOptimizedHistory();

      // Check if current skill needs programming language context
      const skillsRequiringProgrammingLanguage = ['meeting-assistant', 'programming', 'dsa', 'devops', 'system-design', 'data-science'];
      const needsProgrammingLanguage = skillsRequiringProgrammingLanguage.includes(this.activeSkill);

      const requestId = ++this.currentRequestId;
      chunkBuffer = '';
      flushScheduled = false;
      windowManager.broadcastToAllWindows('ai-response-start', { type: 'screenshot', text: userPrompt });

      // Process with LLM vision
      const llmResult = await llmService.processScreenshotWithPrompt(
        this.pendingScreenshot.imageData,
        userPrompt,
        this.activeSkill,
        sessionHistory.recent,
        needsProgrammingLanguage ? this.codingLanguage : null,
        (chunk) => {
          if (requestId !== this.currentRequestId) return;
          chunkBuffer += chunk;
          scheduleFlush();
        }
      );

      if (requestId === this.currentRequestId) {
        if (chunkBuffer) {
          windowManager.broadcastToAllWindows('ai-chunk', chunkBuffer);
          chunkBuffer = '';
        }
        windowManager.broadcastToAllWindows('ai-response-end');

        logger.info("Screenshot AI processing completed", {
          responseLength: llmResult.response.length,
          skill: this.activeSkill,
          processingTime: llmResult.metadata.processingTime
        });

        // Add LLM response to session memory
        sessionManager.addModelResponse(llmResult.response, {
          skill: this.activeSkill,
          processingTime: llmResult.metadata.processingTime,
          usedFallback: llmResult.metadata.usedFallback,
          isVisionResponse: true
        });

        // Clear the pending screenshot after processing
        this.pendingScreenshot = null;

        // Notify windows that screenshot has been processed
        windowManager.broadcastToAllWindows("screenshot-processed", {
          hasPendingScreenshot: false
        });

        // Send response to chat windows
        this.broadcastTranscriptionLLMResponse(llmResult);
      }

      return { success: true, response: llmResult.response };

    } catch (error) {
      logger.error("Screenshot AI processing failed", {
        error: error.message,
        duration: Date.now() - startTime,
      });

      if (this.currentRequestId === this.currentRequestId) {
        windowManager.broadcastToAllWindows('ai-response-error', error.message);
        windowManager.broadcastToAllWindows('ai-response-end');
      }

      // Don't clear screenshot on error so user can retry
      return { success: false, error: error.message };
    }
  }

  /**
   * Check if there's a pending screenshot
   */
  hasPendingScreenshot() {
    return !!this.pendingScreenshot;
  }

  /**
   * Clear pending screenshot without processing
   */
  clearPendingScreenshot() {
    this.pendingScreenshot = null;
    windowManager.broadcastToAllWindows("screenshot-processed", {
      hasPendingScreenshot: false
    });
    logger.info("Pending screenshot cleared");
  }

  async processWithLLM(text, sessionHistory) {
    try {
      // Add user input to session memory
      sessionManager.addUserInput(text, 'llm_input');

      // Check if current skill needs programming language context
      const skillsRequiringProgrammingLanguage = ['meeting-assistant', 'programming', 'dsa', 'devops', 'system-design', 'data-science'];
      const needsProgrammingLanguage = skillsRequiringProgrammingLanguage.includes(this.activeSkill);

      const requestId = ++this.currentRequestId;
      chunkBuffer = '';
      flushScheduled = false;
      windowManager.broadcastToAllWindows('ai-response-start', { type: 'chat', text: text });

      const llmResult = await llmService.processTextWithSkill(
        text,
        this.activeSkill,
        sessionHistory.recent,
        needsProgrammingLanguage ? this.codingLanguage : null,
        (chunk) => {
          if (requestId !== this.currentRequestId) return;
          chunkBuffer += chunk;
          scheduleFlush();
        }
      );

      if (requestId === this.currentRequestId) {
        if (chunkBuffer) {
          windowManager.broadcastToAllWindows('ai-chunk', chunkBuffer);
          chunkBuffer = '';
        }
        windowManager.broadcastToAllWindows('ai-response-end');

        logger.info("LLM processing completed, showing response", {
          responseLength: llmResult.response.length,
          skill: this.activeSkill,
          programmingLanguage: needsProgrammingLanguage ? this.codingLanguage : 'not applicable',
          processingTime: llmResult.metadata.processingTime,
          responsePreview: llmResult.response.substring(0, 200) + "...",
        });

        // Add LLM response to session memory
        sessionManager.addModelResponse(llmResult.response, {
          skill: this.activeSkill,
          processingTime: llmResult.metadata.processingTime,
          usedFallback: llmResult.metadata.usedFallback,
        });

        windowManager.showLLMResponse(llmResult.response, {
          skill: this.activeSkill,
          processingTime: llmResult.metadata.processingTime,
          usedFallback: llmResult.metadata.usedFallback,
        });

        this.broadcastLLMSuccess(llmResult);
      }
    } catch (error) {
      logger.error("LLM processing failed", {
        error: error.message,
        skill: this.activeSkill,
      });

      if (this.currentRequestId === this.currentRequestId) {
        windowManager.broadcastToAllWindows('ai-response-error', error.message);
        windowManager.broadcastToAllWindows('ai-response-end');
      }

      windowManager.hideLLMResponse();
      sessionManager.addConversationEvent({
        role: 'system',
        content: `LLM processing failed: ${error.message}`,
        action: 'llm_error',
        metadata: {
          error: error.message,
          skill: this.activeSkill
        }
      });

      this.broadcastLLMError(error.message);
    }
  }

  async processTranscriptionWithLLM(text, sessionHistory) {
    try {
      // Validate input text
      if (!text || typeof text !== 'string' || text.trim().length === 0) {
        logger.warn("Skipping LLM processing for empty or invalid transcription", {
          textType: typeof text,
          textLength: text ? text.length : 0
        });
        return;
      }

      const cleanText = text.trim();
      if (cleanText.length < 2) {
        logger.debug("Skipping LLM processing for very short transcription", {
          text: cleanText
        });
        return;
      }

      logger.info("Processing transcription with intelligent LLM response", {
        skill: this.activeSkill,
        textLength: cleanText.length,
        textPreview: cleanText.substring(0, 100) + "..."
      });

      const meetingMemory = meetingMemoryService.getContextForQuestion();
      const memoryWords = meetingMemory.split(/\s+/).filter(Boolean).length;
      const tokenEstimate = Math.ceil(memoryWords * 1.33);
      console.log(`[QUESTION CONTEXT] Injecting meeting memory into LLM call. Total memory: ~${tokenEstimate} tokens`);
      logger.info(`[QUESTION CONTEXT] Injecting meeting memory into LLM call. Total memory: ~${tokenEstimate} tokens`);

      const cleanTextWithMemory = meetingMemory + "\n\n" + cleanText;

      // Check if current skill needs programming language context
      const skillsRequiringProgrammingLanguage = ['meeting-assistant', 'programming', 'dsa', 'devops', 'system-design', 'data-science'];
      const needsProgrammingLanguage = skillsRequiringProgrammingLanguage.includes(this.activeSkill);

      const requestId = ++this.currentRequestId;
      chunkBuffer = '';
      flushScheduled = false;
      windowManager.broadcastToAllWindows('ai-response-start', { type: 'transcription', text: cleanText });

      const llmResult = await llmService.processTranscriptionWithIntelligentResponse(
        cleanTextWithMemory,
        this.activeSkill,
        sessionHistory.recent,
        needsProgrammingLanguage ? this.codingLanguage : null,
        (chunk) => {
          if (requestId !== this.currentRequestId) return;
          chunkBuffer += chunk;
          scheduleFlush();
        }
      );

      if (requestId === this.currentRequestId) {
        if (chunkBuffer) {
          windowManager.broadcastToAllWindows('ai-chunk', chunkBuffer);
          chunkBuffer = '';
        }
        windowManager.broadcastToAllWindows('ai-response-end');

        // Add LLM response to session memory
        sessionManager.addModelResponse(llmResult.response, {
          skill: this.activeSkill,
          processingTime: llmResult.metadata.processingTime,
          usedFallback: llmResult.metadata.usedFallback,
          isTranscriptionResponse: true
        });

        // Send response to chat windows
        this.broadcastTranscriptionLLMResponse(llmResult);

        logger.info("Transcription LLM response completed", {
          responseLength: llmResult.response.length,
          skill: this.activeSkill,
          programmingLanguage: needsProgrammingLanguage ? this.codingLanguage : 'not applicable',
          processingTime: llmResult.metadata.processingTime
        });
      }

    } catch (error) {
      logger.error("Transcription LLM processing failed", {
        error: error.message,
        errorStack: error.stack,
        skill: this.activeSkill,
        text: text ? text.substring(0, 100) : 'undefined'
      });

      if (this.currentRequestId === this.currentRequestId) {
        windowManager.broadcastToAllWindows('ai-response-error', error.message);
        windowManager.broadcastToAllWindows('ai-response-end');
      }

      // Try to provide a fallback response
      try {
        const fallbackResult = llmService.generateIntelligentFallbackResponse(text, this.activeSkill);

        sessionManager.addModelResponse(fallbackResult.response, {
          skill: this.activeSkill,
          processingTime: fallbackResult.metadata.processingTime,
          usedFallback: true,
          isTranscriptionResponse: true,
          fallbackReason: error.message
        });

        this.broadcastTranscriptionLLMResponse(fallbackResult);

        logger.info("Used fallback response for transcription", {
          skill: this.activeSkill,
          fallbackResponse: fallbackResult.response
        });

      } catch (fallbackError) {
        logger.error("Fallback response also failed", {
          fallbackError: fallbackError.message
        });

        sessionManager.addConversationEvent({
          role: 'system',
          content: `Transcription LLM processing failed: ${error.message}`,
          action: 'transcription_llm_error',
          metadata: {
            error: error.message,
            skill: this.activeSkill
          }
        });
      }
    }
  }

  broadcastOCRSuccess(ocrResult) {
    windowManager.broadcastToAllWindows("ocr-completed", {
      text: ocrResult.text,
      metadata: ocrResult.metadata,
    });
  }

  broadcastOCRError(errorMessage) {
    windowManager.broadcastToAllWindows("ocr-error", {
      error: errorMessage,
      timestamp: new Date().toISOString(),
    });
  }

  broadcastLLMSuccess(llmResult) {
    const broadcastData = {
      response: llmResult.response,
      metadata: llmResult.metadata,
      skill: this.activeSkill, // Add the current active skill to the top level
    };

    logger.info("Broadcasting LLM success to all windows", {
      responseLength: llmResult.response.length,
      skill: this.activeSkill,
      dataKeys: Object.keys(broadcastData),
      responsePreview: llmResult.response.substring(0, 100) + "...",
    });

    windowManager.broadcastToAllWindows("llm-response", broadcastData);
  }

  broadcastLLMError(errorMessage) {
    windowManager.broadcastToAllWindows("llm-error", {
      error: errorMessage,
      timestamp: new Date().toISOString(),
    });
  }

  broadcastTranscriptionLLMResponse(llmResult) {
    const broadcastData = {
      response: llmResult.response,
      metadata: llmResult.metadata,
      skill: this.activeSkill,
      isTranscriptionResponse: true
    };

    logger.info("Broadcasting transcription LLM response to all windows", {
      responseLength: llmResult.response.length,
      skill: this.activeSkill,
      responsePreview: llmResult.response.substring(0, 100) + "..."
    });

    windowManager.broadcastToAllWindows("transcription-llm-response", broadcastData);
  }

  onWindowAllClosed() {
    if (process.platform !== "darwin") {
      app.quit();
    }
  }

  onActivate() {
    if (!this.isReady) {
      this.onAppReady();
    } else {
      // When app is activated, ensure windows appear on current desktop
      const mainWindow = windowManager.getWindow("main");
      if (mainWindow && mainWindow.isVisible()) {
        windowManager.showOnCurrentDesktop(mainWindow);
      }

      // Also handle other visible windows
      windowManager.windows.forEach((window, type) => {
        if (window.isVisible()) {
          windowManager.showOnCurrentDesktop(window);
        }
      });

      logger.debug("App activated - ensured windows appear on current desktop");
    }
  }

  onWillQuit() {
    globalShortcut.unregisterAll();
    windowManager.destroyAllWindows();

    // Terminate local Whisper server
    try {
      whisperService.stopServer();
    } catch (err) {
      logger.error("Error stopping Whisper server on quit:", err);
    }

    const sessionStats = sessionManager.getMemoryUsage();
    logger.info("Application shutting down", {
      sessionEvents: sessionStats.eventCount,
      sessionSize: sessionStats.approximateSize,
    });
  }

  getSettings() {
    return {
      codingLanguage: this.codingLanguage || "javascript",
      activeSkill: this.activeSkill || "meeting-assistant",
      appIcon: this.appIcon || "terminal",
      selectedIcon: this.appIcon || "terminal",
      fontSize: this.fontSize !== undefined ? this.fontSize : 13,
      bgOpacity: this.bgOpacity !== undefined ? this.bgOpacity : 0.85,
      windowGap: this.windowGap !== undefined ? this.windowGap : 20,
      displaySelection: this.displaySelection || "opened",
      includeMicrophone: this.includeMicrophone !== undefined ? this.includeMicrophone : true,
      includeSystemAudio: this.includeSystemAudio !== undefined ? this.includeSystemAudio : true,
    };
  }

  saveSettings(settings) {
    try {
      if (settings.codingLanguage) {
        this.codingLanguage = settings.codingLanguage;
      }
      if (settings.activeSkill) {
        this.activeSkill = settings.activeSkill;
        windowManager.broadcastToAllWindows("skill-updated", {
          skill: settings.activeSkill,
        });
      }
      if (settings.appIcon) {
        this.appIcon = settings.appIcon;
      }
      if (settings.selectedIcon) {
        this.appIcon = settings.selectedIcon;
        this.updateAppIcon(settings.selectedIcon);
      }
      if (settings.fontSize !== undefined) {
        this.fontSize = settings.fontSize;
      }
      if (settings.bgOpacity !== undefined) {
        this.bgOpacity = settings.bgOpacity;
      }
      if (settings.windowGap !== undefined) {
        this.windowGap = settings.windowGap;
        windowManager.windowGap = parseInt(settings.windowGap, 10) || 20;
      }
      if (settings.displaySelection !== undefined) {
        this.displaySelection = settings.displaySelection;
        windowManager.setDisplaySelection(settings.displaySelection);
      }
      if (settings.includeMicrophone !== undefined) {
        this.includeMicrophone = settings.includeMicrophone;
      }
      if (settings.includeSystemAudio !== undefined) {
        this.includeSystemAudio = settings.includeSystemAudio;
      }

      windowManager.broadcastToAllWindows("settings-updated", this.getSettings());

      // Persist settings to file or config
      this.persistSettings(settings);

      logger.info("Settings saved successfully", settings);
      return { success: true };
    } catch (error) {
      logger.error("Failed to save settings", { error: error.message });
      return { success: false, error: error.message };
    }
  }

  persistSettings(settings) {
    const fs = require('fs');
    const path = require('path');
    const settingsPath = path.join(app.getPath('userData'), 'settings.json');
    try {
      fs.writeFileSync(settingsPath, JSON.stringify(this.getSettings(), null, 2), 'utf8');
      logger.info('Settings successfully persisted to settings.json');
    } catch (e) {
      logger.error('Failed to write settings.json', e.message);
    }

    if (settings.geminiKey) {
      try {
        const envPath = path.join(app.getAppPath(), '.env');
        if (fs.existsSync(envPath)) {
          let envContent = fs.readFileSync(envPath, 'utf8');
          if (envContent.includes('GEMINI_API_KEY=')) {
            envContent = envContent.replace(/^GEMINI_API_KEY=.*$/m, `GEMINI_API_KEY=${settings.geminiKey}`);
          } else {
            envContent += `\nGEMINI_API_KEY=${settings.geminiKey}`;
          }
          fs.writeFileSync(envPath, envContent, 'utf8');
          logger.info('Successfully updated GEMINI_API_KEY in .env file');
        } else {
          fs.writeFileSync(envPath, `GEMINI_API_KEY=${settings.geminiKey}\n`, 'utf8');
          logger.info('Created new .env file with GEMINI_API_KEY');
        }
        process.env.GEMINI_API_KEY = settings.geminiKey;
      } catch (err) {
        logger.error('Failed to write to .env file', err.message);
      }
    }
  }

  updateAppIcon(iconKey) {
    try {
      const { app } = require("electron");
      const path = require("path");
      const fs = require("fs");

      // Icon mapping for available icons in assests/icons folder
      const iconPaths = {
        terminal: "assests/icons/terminal.png",
        activity: "assests/icons/activity.png",
        settings: "assests/icons/settings.png",
      };

      // App name mapping for stealth mode
      const appNames = {
        terminal: "Terminal ",
        activity: "Activity Monitor ",
        settings: "System Settings ",
      };

      const iconPath = iconPaths[iconKey];
      const appName = appNames[iconKey];

      if (!iconPath) {
        logger.error("Invalid icon key", { iconKey });
        return { success: false, error: "Invalid icon key" };
      }

      const fullIconPath = path.resolve(iconPath);

      if (!fs.existsSync(fullIconPath)) {
        logger.error("Icon file not found", {
          iconKey,
          iconPath: fullIconPath,
        });
        return { success: false, error: "Icon file not found" };
      }

      // Set app icon for dock/taskbar
      if (process.platform === "darwin") {
        // macOS - update dock icon
        app.dock.setIcon(fullIconPath);

        // Force dock refresh with multiple attempts
        setTimeout(() => {
          app.dock.setIcon(fullIconPath);
        }, 100);

        setTimeout(() => {
          app.dock.setIcon(fullIconPath);
        }, 500);
      } else {
        // Windows/Linux - update window icons
        windowManager.windows.forEach((window, type) => {
          if (window && !window.isDestroyed()) {
            window.setIcon(fullIconPath);
          }
        });
      }

      // Update app name for stealth mode
      this.updateAppName(appName, iconKey);

      logger.info("App icon and name updated successfully", {
        iconKey,
        appName,
        iconPath: fullIconPath,
        platform: process.platform,
        fileExists: fs.existsSync(fullIconPath),
      });

      this.appIcon = iconKey;
      return { success: true };
    } catch (error) {
      logger.error("Failed to update app icon", {
        error: error.message,
        stack: error.stack,
      });
      return { success: false, error: error.message };
    }
  }

  updateAppName(appName, iconKey) {
    try {
      const { app } = require("electron");

      // Force update process title for Activity Monitor stealth - CRITICAL
      process.title = appName;

      // Set app name in dock (macOS) - this affects the dock and Activity Monitor
      if (process.platform === "darwin") {
        // Multiple attempts to ensure the name sticks
        app.setName(appName);

        // Force update the bundle name for macOS stealth
        const { execSync } = require("child_process");
        try {
          // Update the app's Info.plist CFBundleName in memory
          if (process.mainModule && process.mainModule.filename) {
            const appPath = process.mainModule.filename;
            // Force set the bundle name directly
            process.env.CFBundleName = appName.trim();
          }
        } catch (e) {
          // Silently fail if we can't modify bundle info
        }

        // Clear dock badge and reset
        if (app.dock) {
          app.dock.setBadge("");
          // Force dock refresh
          setTimeout(() => {
            app.dock.setIcon(
              require("path").resolve(`assests/icons/${iconKey}.png`)
            );
          }, 50);
        }
      }

      // Set app user model ID for Windows taskbar grouping
      app.setAppUserModelId(`${appName.trim()}-${iconKey}`);

      // Update all window titles to match the new app name
      const windows = windowManager.windows;
      windows.forEach((window, type) => {
        if (window && !window.isDestroyed()) {
          // Use stealth name for all windows
          const stealthTitle = appName.trim();
          window.setTitle(stealthTitle);
        }
      });

      // Multiple force refreshes with increasing delays
      const refreshTimes = [50, 100, 200, 500];
      refreshTimes.forEach((delay) => {
        setTimeout(() => {
          process.title = appName;
          if (process.platform === "darwin") {
            app.setName(appName);
            // Force update bundle display name
            if (app.getName() !== appName) {
              app.setName(appName);
            }
          }
        }, delay);
      });

      logger.info("App name updated for stealth mode", {
        appName,
        processTitle: process.title,
        appGetName: app.getName(),
        iconKey,
        platform: process.platform,
      });
    } catch (error) {
      logger.error("Failed to update app name", { error: error.message });
    }
  }
}

new ApplicationController();
