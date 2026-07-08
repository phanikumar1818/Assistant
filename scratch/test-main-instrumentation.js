// Mock dependencies
const mockLogger = {
  info: (msg) => console.log("[LOG INFO]", msg),
  debug: (msg) => console.log("[LOG DEBUG]", msg),
  error: (msg) => console.error("[LOG ERROR]", msg)
};

// Simulated ApplicationController state
class MockApplicationController {
  constructor() {
    this.activeTranscriptions = new Map();
  }

  // Mimics the main.js audio-chunk IPC handler
  async handleAudioChunk(chunkData, mockWhisperResult) {
    try {
      console.log("main.js: Received audio-chunk event...");

      let id, audioCreationTimestamp, pcmFloat32Array;
      if (chunkData && chunkData.id) {
        id = chunkData.id;
        audioCreationTimestamp = chunkData.audioCreationTimestamp;
        pcmFloat32Array = chunkData.pcmFloat32Array;
      } else {
        id = `legacy_chunk_${Date.now()}`;
        audioCreationTimestamp = Date.now();
        pcmFloat32Array = chunkData;
      }

      const queueEntryTime = Date.now();

      // Simulate whisperService.transcribe
      const result = mockWhisperResult;

      if (result && result.text) {
        console.log(`main.js: Segment transcribed: "${result.text}"`);
        
        // Simulate transcriptStore segment
        const segment = { text: result.text, id };
        
        const segmentSentTime = Date.now();
        if (result.metadata) {
          this.activeTranscriptions.set(id, {
            audioCreationTimestamp,
            queueEntryTime: result.metadata.queueEntryTime,
            queueExitTime: result.metadata.queueExitTime,
            decodingTime: result.metadata.decodingTime,
            inferenceTime: result.metadata.inferenceTime,
            transcriptMergeTime: result.metadata.transcriptMergeTime,
            queueLength: result.metadata.queueLength,
            segmentSentTime
          });
        }

        console.log("main.js: Sent transcript-segment to renderer.");
        return segment;
      } else {
        if (result && result.metadata) {
          const queueWaitTime = result.metadata.queueExitTime - result.metadata.queueEntryTime;
          const ipcTime = result.metadata.queueEntryTime - audioCreationTimestamp;
          mockLogger.info(`[LATENCY_INSTRUMENTATION] Chunk: ${id} (Empty/Silence) | Queue length: ${result.metadata.queueLength} | IPC time: ${ipcTime}ms | Queue wait: ${queueWaitTime}ms | Decoding/Prep: ${result.metadata.decodingTime}ms | Inference: ${result.metadata.inferenceTime}ms | Post-proc/Merge: ${result.metadata.transcriptMergeTime}ms`);
        }
      }
    } catch (error) {
      console.error("main.js: Failed to transcribe:", error);
    }
  }

  // Mimics the main.js transcript-rendered IPC handler
  handleTranscriptRendered(id, renderFinishedTimestamp) {
    console.log(`main.js: Received transcript-rendered event for chunk ${id}...`);
    const meta = this.activeTranscriptions.get(id);
    if (meta) {
      this.activeTranscriptions.delete(id);
      const rendererUpdateDuration = renderFinishedTimestamp - meta.segmentSentTime;
      const totalEndToEndLatency = renderFinishedTimestamp - meta.audioCreationTimestamp;
      const queueWaitTime = meta.queueExitTime - meta.queueEntryTime;
      const ipcTime = meta.queueEntryTime - meta.audioCreationTimestamp;

      mockLogger.info(`[LATENCY_INSTRUMENTATION] Chunk: ${id} | Queue length: ${meta.queueLength} | IPC time: ${ipcTime}ms | Queue wait: ${queueWaitTime}ms | Decoding/Prep: ${meta.decodingTime}ms | Inference: ${meta.inferenceTime}ms | Post-proc/Merge: ${meta.transcriptMergeTime}ms | Render update: ${rendererUpdateDuration}ms | End-to-end: ${totalEndToEndLatency}ms`);
      return true;
    }
    console.error(`main.js: Metadata for chunk ${id} not found!`);
    return false;
  }
}

async function runTest() {
  console.log("Running Mock IPC roundtrip test for main.js...");

  const controller = new MockApplicationController();

  // Test Case 1: Silent chunk (logged immediately, no renderer confirmation needed)
  console.log("\n--- TEST CASE 1: Silent/Empty Chunk ---");
  const silentChunk = {
    id: "chunk_silent_001",
    audioCreationTimestamp: Date.now() - 5, // 5ms IPC delay
    pcmFloat32Array: new Float32Array(0)
  };
  const silentWhisperResult = {
    text: "",
    durationMs: 400,
    metadata: {
      id: "chunk_silent_001",
      queueEntryTime: Date.now(),
      queueExitTime: Date.now() + 10,  // 10ms queue wait
      queueLength: 0,
      decodingTime: 2,
      inferenceTime: 380,
      transcriptMergeTime: 8
    }
  };
  await controller.handleAudioChunk(silentChunk, silentWhisperResult);

  // Test Case 2: Transcribed chunk (logged after renderer confirmation)
  console.log("\n--- TEST CASE 2: Transcribed Chunk ---");
  const transcribedChunk = {
    id: "chunk_speech_002",
    audioCreationTimestamp: Date.now() - 12, // 12ms IPC delay
    pcmFloat32Array: new Float32Array(100)
  };
  const speechWhisperResult = {
    text: "Hello World",
    durationMs: 1200,
    metadata: {
      id: "chunk_speech_002",
      queueEntryTime: Date.now(),
      queueExitTime: Date.now() + 200,  // 200ms queue wait
      queueLength: 1,
      decodingTime: 15,
      inferenceTime: 980,
      transcriptMergeTime: 5
    }
  };

  // Simulate audio-chunk arriving
  const segment = await controller.handleAudioChunk(transcribedChunk, speechWhisperResult);

  // Simulate renderer displaying text and sending confirmation back after 150ms render duration
  await new Promise((resolve) => setTimeout(resolve, 150));
  const renderFinishedTimestamp = Date.now();
  const success = controller.handleTranscriptRendered(segment.id, renderFinishedTimestamp);

  if (success) {
    console.log("\nSUCCESS: Simulated Electron IPC roundtrip test completed successfully!");
  } else {
    console.error("\nFAILURE: Simulated IPC roundtrip test failed!");
  }
}

runTest();
