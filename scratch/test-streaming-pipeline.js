const whisperService = require('../src/services/whisper.service');

async function runTest() {
  console.log("Starting Whisper streaming pipeline validation test...");
  
  // Wait for the worker to initialize and be ready
  console.log("Waiting for Whisper worker to initialize...");
  await new Promise((resolve) => {
    if (whisperService.isReady) {
      resolve();
    } else {
      whisperService.once('ready', resolve);
    }
  });
  console.log("Whisper worker is ready!");

  // Listen to interim and final events
  whisperService.on('interim', (text) => {
    console.log(`\n>>> [UI INTERIM UPDATE]: "${text}"`);
  });

  whisperService.on('final', (result) => {
    console.log(`\n========================================`);
    console.log(`>>> [UI SEGMENT FINALIZED]: "${result.text}" (Inference: ${result.durationMs}ms)`);
    console.log(`========================================\n`);
  });

  const sampleRate = 16000;
  const chunkSec = 0.5; // 500ms chunks
  const chunkSize = sampleRate * chunkSec;

  // We will feed 12 chunks (6 seconds of audio total)
  // First 4 chunks: silence
  // Next 4 chunks: dummy audio containing simulated low-frequency voice wave
  // Last 4 chunks: silence (to allow VAD to detect silence gap and finalize)
  console.log("Beginning continuous 500ms audio stream simulation...");

  for (let i = 0; i < 12; i++) {
    const chunk = new Float32Array(chunkSize);
    
    // Simulate vocal energy in chunks 4, 5, 6, 7 (2.0s to 4.0s)
    if (i >= 4 && i <= 7) {
      for (let j = 0; j < chunkSize; j++) {
        // Simple human voice frequency simulation around 150Hz
        chunk[j] = Math.sin(2 * Math.PI * 150 * (j / sampleRate)) * 0.1;
      }
      console.log(`[Stream Feed] Sending chunk ${i + 1}/12 (Simulated Voice)`);
    } else {
      console.log(`[Stream Feed] Sending chunk ${i + 1}/12 (Silence)`);
    }

    whisperService.feedAudioStream(chunk);
    
    // Wait 500ms before sending the next chunk to simulate real-time capture
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  console.log("Audio streaming complete. Waiting 2 seconds for final transcripts...");
  await new Promise((resolve) => setTimeout(resolve, 2000));

  console.log("Stopping Whisper worker...");
  whisperService.stopWorker();
  console.log("Test finished!");
  process.exit(0);
}

runTest().catch((err) => {
  console.error("Test failed with error:", err);
  whisperService.stopWorker();
  process.exit(1);
});
