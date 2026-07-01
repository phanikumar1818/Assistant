const fs = require('fs');
const path = require('path');
const assert = require('assert');

// Mock electron app getPath
const electronMock = {
  app: {
    getPath: (name) => {
      if (name === 'userData') {
        return path.join(__dirname, 'mock_user_data');
      }
      return __dirname;
    }
  }
};

// Require our PersistentSessionManager class
// We override app require by mocking/requiring with a fake electron module if necessary,
// or we can mock require if we run it directly.
// Let's intercept electron require by modifying the module cache!
require.cache[require.resolve('electron')] = {
  exports: electronMock
};

const PersistentSessionManager = require('../src/services/persistent-session.manager');

async function runTests() {
  console.log('=== STARTING PERSISTENT SESSION MANAGER TESTS ===\n');

  const manager = new PersistentSessionManager();
  
  // 1. Initialize
  console.log('Testing initialize()...');
  await manager.initialize();
  assert.ok(fs.existsSync(manager.sessionsDir), 'Sessions directory should be created');
  console.log('✓ initialize() passed\n');

  // Clear mock directory if anything was left over
  const files = fs.readdirSync(manager.sessionsDir);
  for (const f of files) {
    fs.unlinkSync(path.join(manager.sessionsDir, f));
  }

  // 2. startSession()
  console.log('Testing startSession()...');
  assert.strictEqual(manager.isIdle, true, 'Manager should be idle initially');
  
  const startRes = await manager.startSession();
  assert.ok(startRes, 'Start session result should not be null');
  assert.strictEqual(manager.isIdle, false, 'Manager should not be idle after start');
  assert.ok(manager.activeSession, 'Active session should be set');
  assert.strictEqual(manager.activeSession.title, 'Untitled Meeting', 'Default title should be Untitled Meeting');
  assert.ok(fs.existsSync(manager.activeSession.filePath), 'Initial markdown skeleton file should exist');
  
  const initialContent = fs.readFileSync(manager.activeSession.filePath, 'utf8');
  assert.ok(initialContent.includes('# Untitled Meeting'), 'Markdown should contain title');
  assert.ok(initialContent.includes(manager.activeSession.id), 'Markdown should contain session ID');
  console.log('✓ startSession() passed\n');

  // 3. appendTranscriptLine()
  console.log('Testing appendTranscriptLine()...');
  manager.appendTranscriptLine('Hello everyone, welcome to the design sync.', '12:00:00 PM');
  manager.appendTranscriptLine('Today we will talk about meeting sessions.', '12:00:05 PM');
  
  // Wait a moment for debounced write or force it (we can test immediate by running write with force=true)
  manager._writeFileToDisk(true);
  
  const contentWithTranscript = fs.readFileSync(manager.activeSession.filePath, 'utf8');
  assert.ok(contentWithTranscript.includes('[12:00:00 PM] Hello everyone, welcome to the design sync.'), 'Transcript line 1 should be written');
  assert.ok(contentWithTranscript.includes('[12:00:05 PM] Today we will talk about meeting sessions.'), 'Transcript line 2 should be written');
  console.log('✓ appendTranscriptLine() passed\n');

  // 4. updateSummary()
  console.log('Testing updateSummary()...');
  const mockNarrative = "This is a detailed summary narrative of the sync.";
  const mockFacts = {
    decisions: [
      { text: "Adopt Markdown for session storage", owner: "Engineering", timestamp: "12:02:00 PM" }
    ],
    action_items: [
      { text: "Implement persistent session manager", owner: "Agent", due: "End of day" }
    ],
    constraints: [
      { text: "Additive feature only, do not break existing code", raised_by: "Product Team" }
    ],
    key_facts: [
      { text: "The app stores state in service classes", timestamp: "12:01:00 PM" }
    ]
  };
  
  manager.updateSummary(mockNarrative, mockFacts);
  manager._writeFileToDisk(true);
  
  const contentWithSummary = fs.readFileSync(manager.activeSession.filePath, 'utf8');
  assert.ok(contentWithSummary.includes(mockNarrative), 'Narrative summary should be written');
  assert.ok(contentWithSummary.includes('- Adopt Markdown for session storage (Owner: Engineering, At: 12:02:00 PM)'), 'Decision fact should be written');
  assert.ok(contentWithSummary.includes('- Implement persistent session manager (Owner: Agent, Due: End of day)'), 'Action item should be written');
  assert.ok(contentWithSummary.includes('- Additive feature only, do not break existing code (Raised by: Product Team)'), 'Constraint should be written');
  assert.ok(contentWithSummary.includes('- The app stores state in service classes (At: 12:01:00 PM)'), 'Key fact should be written');
  console.log('✓ updateSummary() passed\n');

  // 5. generateAndSetTitle()
  console.log('Testing generateAndSetTitle()...');
  // Need at least 20 transcript lines
  for (let i = 0; i < 20; i++) {
    manager.appendTranscriptLine(`Line item ${i}`, `12:10:${i.toString().padStart(2, '0')}`);
  }
  
  const mockLlmService = {
    callGeminiRaw: async (prompt, logLabel) => {
      assert.strictEqual(logLabel, 'TITLE GENERATION', 'Log label should be TITLE GENERATION');
      assert.ok(prompt.includes(mockNarrative), 'Prompt should include narrative');
      return '"Design Sync Session"'; // return with quotes to test stripping
    }
  };
  
  const newTitle = await manager.generateAndSetTitle(mockLlmService);
  assert.strictEqual(newTitle, 'Design Sync Session', 'Title should be parsed and cleaned');
  assert.strictEqual(manager.activeSession.title, 'Design Sync Session', 'Active session title should be updated');
  assert.ok(manager.activeSession.filePath.includes('design-sync-session.md'), 'Filename should be slugified and updated');
  assert.ok(fs.existsSync(manager.activeSession.filePath), 'Renamed file should exist');
  console.log('✓ generateAndSetTitle() passed\n');

  // 6. stopSession()
  console.log('Testing stopSession() and resetting dependencies...');
  const mockMemoryService = {
    layer1: { decisions: ['d1'], action_items: ['a1'], constraints: ['c1'], key_facts: ['kf1'] },
    layer2: "old narrative",
    layer3: "old transcript",
    unprocessedBuffer: "old buffer",
    llmService: mockLlmService
  };
  
  const mockSessionManager = {
    sessionMemory: [{ role: 'system', content: 'prompt' }],
    clearHistory: function() {
      this.sessionMemory = [];
    }
  };
  
  const mockTranscriptBuffer = [{ text: 'segment1' }];
  
  const oldActiveSessionId = manager.activeSession.id;
  const stopRes = await manager.stopSession({
    meetingMemoryService: mockMemoryService,
    sessionManager: mockSessionManager,
    transcriptBuffer: mockTranscriptBuffer
  });
  
  assert.ok(stopRes, 'Stop session result should not be null');
  assert.strictEqual(stopRes.id, oldActiveSessionId, 'ID should match');
  assert.strictEqual(stopRes.title, 'Design Sync Session', 'Title should match');
  assert.strictEqual(manager.isIdle, true, 'Manager should be idle after stop');
  assert.strictEqual(manager.activeSession, null, 'Active session should be null');
  
  // Verify resets
  assert.deepStrictEqual(mockMemoryService.layer1, { decisions: [], action_items: [], constraints: [], key_facts: [] }, 'Layer 1 should be cleared');
  assert.strictEqual(mockMemoryService.layer2, '', 'Layer 2 should be empty');
  assert.strictEqual(mockMemoryService.layer3, '', 'Layer 3 should be empty');
  assert.strictEqual(mockMemoryService.unprocessedBuffer, '', 'Unprocessed buffer should be empty');
  assert.deepStrictEqual(mockSessionManager.sessionMemory, [], 'SessionManager memory should be cleared');
  assert.deepStrictEqual(mockTranscriptBuffer, [], 'TranscriptBuffer should be cleared');
  console.log('✓ stopSession() passed\n');

  // 7. listSessions()
  console.log('Testing listSessions()...');
  const sessions = await manager.listSessions();
  assert.strictEqual(sessions.length, 1, 'Should list exactly one session');
  const s = sessions[0];
  assert.strictEqual(s.title, 'Design Sync Session', 'Listed title should match');
  assert.strictEqual(s.duration, '0 min', 'Listed duration should match');
  console.log('✓ listSessions() passed\n');

  // 8. renameSession()
  console.log('Testing renameSession()...');
  const renameSuccess = await manager.renameSession(s.id, 'New Restructured Sync');
  assert.strictEqual(renameSuccess, true, 'Rename should succeed');
  
  const renamedSessions = await manager.listSessions();
  assert.strictEqual(renamedSessions[0].title, 'New Restructured Sync', 'Renamed title should reflect in list');
  assert.ok(renamedSessions[0].filePath.includes('new-restructured-sync.md'), 'File should be renamed on disk');
  assert.ok(fs.existsSync(renamedSessions[0].filePath), 'Renamed file should exist on disk');
  console.log('✓ renameSession() passed\n');

  // 9. getSessionContent()
  console.log('Testing getSessionContent()...');
  const fileContent = await manager.getSessionContent(s.id);
  assert.ok(fileContent, 'File content should not be null');
  assert.ok(fileContent.includes('# New Restructured Sync'), 'File content should have new title');
  console.log('✓ getSessionContent() passed\n');

  // 10. deleteSession()
  console.log('Testing deleteSession()...');
  const deleteSuccess = await manager.deleteSession(s.id);
  assert.strictEqual(deleteSuccess, true, 'Delete should succeed');
  
  const postDeleteSessions = await manager.listSessions();
  assert.strictEqual(postDeleteSessions.length, 0, 'No sessions should exist after delete');
  assert.strictEqual(fs.existsSync(renamedSessions[0].filePath), false, 'File should be deleted from disk');
  console.log('✓ deleteSession() passed\n');

  console.log('==================================================');
  console.log('🎉 ALL PERSISTENT SESSION MANAGER TESTS PASSED! 🎉');
  console.log('==================================================');
}

// Ensure clean environment for mock files
try {
  const mockDir = path.join(__dirname, 'mock_user_data');
  const mockSessionsDir = path.join(mockDir, 'sessions');
  if (fs.existsSync(mockSessionsDir)) {
    const files = fs.readdirSync(mockSessionsDir);
    for (const f of files) {
      fs.unlinkSync(path.join(mockSessionsDir, f));
    }
    fs.rmdirSync(mockSessionsDir);
  }
  if (fs.existsSync(mockDir)) {
    fs.rmdirSync(mockDir);
  }
} catch (e) {}

runTests().catch(err => {
  console.error('\n❌ TEST RUN FAILED:', err);
  process.exit(1);
});
