/**
 * Continuous meeting listening with separate system loopback + microphone capture.
 * Audio is streamed locally to the main process via AudioWorklet and IPC.
 */
// Import and instantiate MeetingMemoryService as a singleton. Pass the same LLMService instance already used in the file.
let meetingMemoryService;
try {
  if (typeof require !== 'undefined') {
    const llmService = require('../services/llm.service');
    const MeetingMemoryServiceClass = require('../services/meeting-memory.service');
    meetingMemoryService = new MeetingMemoryServiceClass(llmService);
  } else {
    // Fallback to Electron IPC when running in the browser renderer process
    meetingMemoryService = {
      appendTranscript: (text, timestamp) => {
        if (window.electronAPI && typeof window.electronAPI.appendTranscript === 'function') {
          window.electronAPI.appendTranscript(text, timestamp);
        }
      }
    };
  }
} catch (e) {
  console.warn('[MEMORY] Direct require failed, using IPC bridge for MeetingMemoryService:', e.message);
  meetingMemoryService = {
    appendTranscript: (text, timestamp) => {
      if (window.electronAPI && typeof window.electronAPI.appendTranscript === 'function') {
        window.electronAPI.appendTranscript(text, timestamp);
      }
    }
  };
}

(function (global) {
  'use strict';

  class MeetingTranscriptBuffer {
    constructor() {
      this.segments = [];
      this.lastAnswerAt = 0;
    }

    appendSegment(text, source = 'transcription') {
      const trimmed = (text || '').trim();
      if (!trimmed) return null;

      const now = Date.now();
      if (this.segments.length > 0) {
        const lastSegment = this.segments[this.segments.length - 1];
        const timeDiff = now - lastSegment.timestamp;
        
        // Count words in the last segment
        const words = lastSegment.text.split(/\s+/).filter(Boolean);

        // Append to the last segment only if it is within 5 seconds and the segment has less than 25 words
        if (timeDiff < 5000 && words.length < 25) {
          lastSegment.text += ' ' + trimmed;
          lastSegment.timestamp = now;

          // After existing transcript append logic:
          const finalTranscript = trimmed;
          const timestamp = new Date().toLocaleTimeString();
          meetingMemoryService.appendTranscript(finalTranscript, timestamp);

          return lastSegment;
        }
      }

      const segment = { text: trimmed, timestamp: now, source };
      this.segments.push(segment);

      // After existing transcript append logic:
      const finalTranscript = trimmed;
      const timestamp = new Date().toLocaleTimeString();
      meetingMemoryService.appendTranscript(finalTranscript, timestamp);

      return segment;
    }

    getFullTranscript() {
      return this.segments.map((s) => s.text).join(' ').trim();
    }

    getNewSinceLastAnswer() {
      return this.segments
        .filter((s) => s.timestamp >= this.lastAnswerAt)
        .map((s) => s.text)
        .join(' ')
        .trim();
    }

    markAnswerSent() {
      this.lastAnswerAt = Date.now();
    }

    getStats() {
      return {
        segmentCount: this.segments.length,
        fullLength: this.getFullTranscript().length,
        newSinceLastAnswerLength: this.getNewSinceLastAnswer().length,
        lastAnswerAt: this.lastAnswerAt
      };
    }

    toJSON() {
      return { segments: [...this.segments], lastAnswerAt: this.lastAnswerAt };
    }

    loadFromJSON(data) {
      if (!data) return;
      this.segments = Array.isArray(data.segments) ? [...data.segments] : [];
      this.lastAnswerAt = data.lastAnswerAt || 0;
    }
  }

  class ContinuousListeningManager {
    constructor(options = {}) {
      this.onStatus = options.onStatus || (() => {});
      this.onError = options.onError || (() => {});
      this.onListeningChange = options.onListeningChange || (() => {});
      this.onLevelUpdate = options.onLevelUpdate || (() => {});

      this.transcriptBuffer = new MeetingTranscriptBuffer();
      this.displayStream = null;
      this.systemStream = null;
      this.micStream = null;
      this.mixedStream = null;
      
      this.audioContext = null;
      this.mixedSourceNode = null;
      this.workletNode = null;

      // Fixed-interval transcription settings
      this.audioChunksBuffer = [];
      this.totalBufferedSamples = 0;
      this.chunkIntervalId = null;

      this.levelContext = null;
      this.levelAnalyser = null;
      this.levelMonitorId = null;
      this.isListening = false;
      this.includeMicrophone = options.includeMicrophone !== false;
    }

    get isActive() {
      return this.isListening;
    }

    async start() {
      if (this.isListening) {
        return { success: true, alreadyListening: true };
      }

      try {
        this.onStatus('Starting meeting capture — select Entire Screen and enable Share system audio.');
        await this._acquireStreams();
        await this._startWorklet();
        this._setListening(true);

        this.onStatus('Listening: system audio + microphone. Press Enter when you want an answer.');
        return { success: true };
      } catch (err) {
        this._cleanupStreams();
        this._setListening(false);
        const message = this._formatCaptureError(err);
        this.onError(message);
        return { success: false, error: message };
      }
    }

    stop() {
      this._sendAudioWindow();
      this._cleanupStreams();
      this._setListening(false);
      this.onStatus('Meeting listening stopped.');
      return { success: true };
    }

    async toggle() {
      return this.isListening ? this.stop() : this.start();
    }

    markAnswerSent() {
      this.transcriptBuffer.markAnswerSent();
    }

    getFullTranscript() {
      return this.transcriptBuffer.getFullTranscript();
    }

    getNewSinceLastAnswer() {
      return this.transcriptBuffer.getNewSinceLastAnswer();
    }

    getStats() {
      return {
        isListening: this.isListening,
        hasSystemStream: !!this.systemStream,
        hasMicStream: !!this.micStream,
        ...this.transcriptBuffer.getStats()
      };
    }

    async _acquireStreams() {
      if (!navigator.mediaDevices?.getDisplayMedia) {
        throw new Error('System audio capture is not supported in this environment.');
      }

      this.displayStream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          width: { ideal: 640, max: 1280 },
          height: { ideal: 360, max: 720 },
          frameRate: { ideal: 5, max: 15 }
        },
        audio: true
      });

      // CRITICAL: Do NOT stop the video track on Windows — that kills loopback audio.
      // Disable video instead to keep the capture session alive.
      this.displayStream.getVideoTracks().forEach((track) => {
        track.enabled = false;
      });

      const systemTracks = this.displayStream.getAudioTracks();
      if (!systemTracks.length) {
        throw new Error(
          'No system audio received. Share "Entire screen" and check "Also share system audio" in the picker.'
        );
      }

      systemTracks.forEach((track) => {
        track.addEventListener('ended', () => this._handleStreamEnded('system'));
      });

      this.systemStream = new MediaStream(systemTracks);

      if (this.includeMicrophone) {
        try {
          this.micStream = await navigator.mediaDevices.getUserMedia({
            audio: {
              echoCancellation: false,
              noiseSuppression: false,
              autoGainControl: true,
              sampleRate: 48000
            }
          });
          this.micStream.getAudioTracks().forEach((track) => {
            track.addEventListener('ended', () => this._handleStreamEnded('microphone'));
          });
        } catch (micErr) {
          console.warn('Microphone unavailable:', micErr.message);
          this.onStatus('System audio only — microphone access denied or unavailable.');
        }
      }

      // Mix the system stream and microphone stream using Web Audio API
      if (this.micStream) {
        try {
          const audioContext = new (window.AudioContext || window.webkitAudioContext)();
          const destination = audioContext.createMediaStreamDestination();

          const systemSource = audioContext.createMediaStreamSource(this.systemStream);
          systemSource.connect(destination);

          const micSource = audioContext.createMediaStreamSource(this.micStream);
          micSource.connect(destination);

          this.mixedStream = destination.stream;
          this.audioContext = audioContext;
          console.info('Successfully mixed system loopback audio and microphone streams.');
        } catch (mixErr) {
          console.warn('Failed to mix audio streams, falling back to separate/system stream:', mixErr.message);
          this.mixedStream = this.systemStream;
        }
      } else {
        this.mixedStream = this.systemStream;
      }
    }

    async _startWorklet() {
      if (!this.audioContext) {
        this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
      }

      if (this.audioContext.state === 'suspended') {
        await this.audioContext.resume();
      }

      // Load AudioWorklet module
      await this.audioContext.audioWorklet.addModule('src/ui/audio-processor.js');

      this.mixedSourceNode = this.audioContext.createMediaStreamSource(this.mixedStream);
      this.workletNode = new AudioWorkletNode(this.audioContext, 'audio-processor');

      this.audioChunksBuffer = [];
      this.totalBufferedSamples = 0;

      this.workletNode.port.onmessage = (event) => {
        const chunk = event.data; // Float32Array
        this._handleAudioChunk(chunk);
      };

      this.mixedSourceNode.connect(this.workletNode);
      this.workletNode.connect(this.audioContext.destination);

      this._startLevelMonitor();
      this._startChunkTimer();
    }

    _handleAudioChunk(chunk) {
      if (!this.isListening) return;
      this.audioChunksBuffer.push(chunk);
      this.totalBufferedSamples += chunk.length;
    }

    _startChunkTimer() {
      this._stopChunkTimer();
      // Slice and transcribe a 4-second chunk every 4 seconds
      this.chunkIntervalId = setInterval(() => {
        this._sendAudioWindow();
      }, 4000);
    }

    _stopChunkTimer() {
      if (this.chunkIntervalId) {
        clearInterval(this.chunkIntervalId);
        this.chunkIntervalId = null;
      }
    }

    _calculateRMS(array) {
      if (array.length === 0) return 0;
      let sum = 0;
      for (let i = 0; i < array.length; i++) {
        sum += array[i] * array[i];
      }
      return Math.sqrt(sum / array.length);
    }

    _sendAudioWindow() {
      if (this.totalBufferedSamples === 0) return;

      const sampleRate = this.audioContext.sampleRate;
      const fullBuffer = new Float32Array(this.totalBufferedSamples);
      let offset = 0;
      for (const chunk of this.audioChunksBuffer) {
        fullBuffer.set(chunk, offset);
        offset += chunk.length;
      }

      // Clear buffers
      this.audioChunksBuffer = [];
      this.totalBufferedSamples = 0;

      // Skip silent chunks
      const rms = this._calculateRMS(fullBuffer);
      if (rms < 0.0005) {
        return;
      }

      // Resample to 16kHz
      const resampled = this._resampleTo16k(fullBuffer, sampleRate);

      // Send to main process via IPC
      if (window.electronAPI && typeof window.electronAPI.sendAudioChunk === 'function') {
        window.electronAPI.sendAudioChunk(resampled);
      }
    }

    _resampleTo16k(inputBuffer, fromSampleRate) {
      const targetSampleRate = 16000;
      if (fromSampleRate === targetSampleRate) {
        return inputBuffer;
      }

      const ratio = fromSampleRate / targetSampleRate;
      const newLength = Math.round(inputBuffer.length / ratio);
      const result = new Float32Array(newLength);

      for (let i = 0; i < newLength; i++) {
        const pos = i * ratio;
        const index1 = Math.floor(pos);
        const index2 = Math.min(index1 + 1, inputBuffer.length - 1);
        const weight = pos - index1;
        result[i] = inputBuffer[index1] * (1 - weight) + inputBuffer[index2] * weight;
      }
      return result;
    }

    _startLevelMonitor() {
      this._stopLevelMonitor();
      if (!this.systemStream) return;

      try {
        this.levelContext = new AudioContext();
        this.levelAnalyser = this.levelContext.createAnalyser();
        this.levelAnalyser.fftSize = 256;
        const source = this.levelContext.createMediaStreamSource(this.systemStream);
        source.connect(this.levelAnalyser);

        const data = new Uint8Array(this.levelAnalyser.frequencyBinCount);
        this.levelMonitorId = setInterval(() => {
          if (!this.levelAnalyser) return;
          this.levelAnalyser.getByteFrequencyData(data);
          const avg = data.reduce((sum, v) => sum + v, 0) / data.length;
          const micActive = this.micStream?.getAudioTracks().some((t) => t.enabled && t.readyState === 'live');
          this.onLevelUpdate({
            systemLevel: Math.round(avg),
            micActive: !!micActive,
            capturing: avg > 2
          });
        }, 500);

        if (this.levelContext.state === 'suspended') {
          this.levelContext.resume().catch(() => {});
        }
      } catch (err) {
        console.warn('Audio level monitor unavailable:', err.message);
      }
    }

    _stopLevelMonitor() {
      if (this.levelMonitorId) {
        clearInterval(this.levelMonitorId);
        this.levelMonitorId = null;
      }
      if (this.levelContext) {
        this.levelContext.close().catch(() => {});
        this.levelContext = null;
      }
      this.levelAnalyser = null;
    }

    _handleStreamEnded(source) {
      if (!this.isListening) return;
      this.onError(`${source} capture ended. Toggle listening to reconnect.`);
      this.stop();
    }

    _cleanupStreams() {
      this._stopChunkTimer();
      this._stopLevelMonitor();

      if (this.workletNode) {
        try {
          this.workletNode.disconnect();
        } catch (e) {}
        this.workletNode = null;
      }
      if (this.mixedSourceNode) {
        try {
          this.mixedSourceNode.disconnect();
        } catch (e) {}
        this.mixedSourceNode = null;
      }

      [this.systemStream, this.micStream, this.displayStream, this.mixedStream].forEach((stream) => {
        if (!stream) return;
        stream.getTracks().forEach((track) => {
          try {
            track.stop();
          } catch (err) {
            console.warn('Failed to stop track:', err);
          }
        });
      });
      this.systemStream = null;
      this.micStream = null;
      this.displayStream = null;
      this.mixedStream = null;

      if (this.audioContext) {
        try {
          this.audioContext.close();
        } catch (err) {}
        this.audioContext = null;
      }

      this.audioChunksBuffer = [];
      this.totalBufferedSamples = 0;
    }

    _setListening(listening) {
      this.isListening = listening;
      this.onListeningChange(listening);
    }

    _formatCaptureError(err) {
      if (err.name === 'NotAllowedError') {
        return 'Capture denied. Share Entire Screen and enable "Also share system audio".';
      }
      if (err.name === 'NotFoundError') {
        return 'No capture source found.';
      }
      if (err.name === 'NotReadableError') {
        return 'Audio device is busy. Close other apps using the microphone or screen capture.';
      }
      return err.message || 'Failed to start meeting audio capture.';
    }
  }

  global.MeetingListening = {
    MeetingTranscriptBuffer,
    ContinuousListeningManager
  };
})(typeof window !== 'undefined' ? window : global);
