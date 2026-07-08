const fs = require('fs');
const path = require('path');
const whisperService = require('../src/services/whisper.service');

async function runTest() {
  console.log("Starting Real-Speech Whisper streaming validation test...");
  
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
  whisperService.on('interim', (data) => {
    const text = data && typeof data === 'object' ? data.text : data;
    if (text) {
      console.log(`[UI INTERIM]: "${text}"`);
    }
  });

  whisperService.on('final', (result) => {
    console.log(`\n========================================`);
    console.log(`>>> [UI FINALIZED SEGMENT]: "${result.text}" (Inference: ${result.durationMs}ms)`);
    if (result.metadata) {
      const now = Date.now();
      const cap_to_sent = result.metadata.sent_to_worker - result.metadata.audio_captured;
      const pipe_delay = result.metadata.worker_received - result.metadata.sent_to_worker;
      const queue_wait = result.metadata.inference_starts - result.metadata.worker_received;
      const inference = result.metadata.inference_finishes - result.metadata.inference_starts;
      const worker_to_main = now - result.metadata.inference_finishes;
      const total = now - result.metadata.audio_captured;
      
      console.log(`  - Capture to Sent:     ${cap_to_sent}ms`);
      console.log(`  - Pipe Write:          ${pipe_delay}ms`);
      console.log(`  - Worker Queue Wait:   ${queue_wait}ms`);
      console.log(`  - GPU Inference Time:  ${inference}ms`);
      console.log(`  - Worker to Main Read: ${worker_to_main}ms`);
      console.log(`  ========================================`);
      console.log(`  TOTAL TEST LATENCY:   ${total}ms`);
    }
    console.log(`========================================\n`);
  });

  // Read jfk.wav
  const wavPath = path.join(__dirname, '../models/jfk.wav');
  if (!fs.existsSync(wavPath)) {
    console.error(`WAV file not found at: ${wavPath}`);
    process.exit(1);
  }

  console.log(`Reading WAV file: ${wavPath}`);
  const fileBuffer = fs.readFileSync(wavPath);
  
  // Extract details from header
  const sampleRate = fileBuffer.readUInt32LE(24);
  const bitsPerSample = fileBuffer.readUInt16LE(34);
  const numChannels = fileBuffer.readUInt16LE(22);
  console.log(`WAV Info: Sample Rate = ${sampleRate}Hz, Bits per sample = ${bitsPerSample}, Channels = ${numChannels}`);

  // Parse PCM_S16 data (starts at byte 44)
  const pcmDataBuffer = fileBuffer.subarray(44);
  const totalSamples = pcmDataBuffer.length / 2;
  const float32Samples = new Float32Array(totalSamples);
  
  for (let i = 0; i < totalSamples; i++) {
    const intSample = pcmDataBuffer.readInt16LE(i * 2);
    float32Samples[i] = intSample / 32768.0;
  }
  
  console.log(`Decoded ${totalSamples} samples (~${(totalSamples / 16000).toFixed(2)} seconds of audio).`);

  const chunkSec = 0.5; // 500ms chunk sizes
  const chunkSize = 16000 * chunkSec;
  let offset = 0;

  console.log("Beginning audio stream feed...");

  while (offset < totalSamples) {
    const end = Math.min(offset + chunkSize, totalSamples);
    const chunk = float32Samples.subarray(offset, end);
    offset = end;

    const id = `chunk_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const audioCreationTimestamp = Date.now();

    whisperService.feedAudioStream(chunk, { id, audioCreationTimestamp });
    
    // Sleep 500ms to simulate real-time input
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  console.log("Finished streaming audio. Sending 6 seconds of silence to trigger VAD finalization...");
  for (let i = 0; i < 12; i++) {
    const silentChunk = new Float32Array(chunkSize);
    const id = `silent_chunk_${Date.now()}_${i}`;
    const audioCreationTimestamp = Date.now();
    whisperService.feedAudioStream(silentChunk, { id, audioCreationTimestamp });
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

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
