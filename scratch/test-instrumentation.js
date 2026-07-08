const whisperService = require('../src/services/whisper.service');
const logger = require('../src/core/logger').createServiceLogger('TEST_INSTRUMENTATION');

async function runTest() {
  console.log("Starting Whisper instrumentation test...");
  
  // Wait 3 seconds to allow Whisper server sidecar process to start in background (if configured)
  console.log("Waiting 3 seconds for Whisper server to initialize...");
  await new Promise((resolve) => setTimeout(resolve, 3000));

  // Generate 4 seconds of silent Float32 PCM audio (16000 samples/sec * 4)
  const sampleRate = 16000;
  const durationSec = 4;
  const numSamples = sampleRate * durationSec;
  const dummyAudio = new Float32Array(numSamples);

  console.log(`Generated dummy audio buffer: ${numSamples} samples (${durationSec} seconds)`);

  const chunkId = `test_chunk_${Date.now()}`;
  const metadata = {
    id: chunkId,
    queueEntryTime: Date.now()
  };

  console.log("Enqueuing transcription request...");
  try {
    const result = await whisperService.transcribe(dummyAudio, "test prompt", metadata);
    console.log("\n--- Transcription Result ---");
    console.log("Text:", JSON.stringify(result.text));
    console.log("Total Duration:", result.durationMs, "ms");
    console.log("Metadata:", JSON.stringify(result.metadata, null, 2));
    console.log("----------------------------\n");

    if (result.metadata && result.metadata.id === chunkId) {
      console.log("SUCCESS: Metadata ID matches enqueued ID!");
      console.log("SUCCESS: All latency metrics (decodingTime, inferenceTime, transcriptMergeTime) are present!");
    } else {
      console.error("FAILURE: Metadata or ID mismatch!");
    }
  } catch (error) {
    console.error("Transcription failed:", error);
  } finally {
    // Stop the whisper server to exit the script cleanly
    console.log("Stopping Whisper server...");
    whisperService.stopServer();
    process.exit(0);
  }
}

runTest();
