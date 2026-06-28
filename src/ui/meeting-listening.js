/**
 * Continuous meeting listening with separate system loopback + microphone capture.
 * Audio is streamed locally to the main process via AudioWorklet and IPC.
 */
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

      const segment = { text: trimmed, timestamp: Date.now(), source };
      this.segments.push(segment);
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
      
      this.audioChunksBuffer = [];
      this.totalBufferedSamples = 0;
      this.chunkTimeoutId = null;
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

      // Keep only the last 35 seconds of audio to avoid memory leaks
      const sampleRate = this.audioContext.sampleRate;
      const maxSamplesToKeep = 35 * sampleRate;

      while (this.totalBufferedSamples - this.audioChunksBuffer[0].length > maxSamplesToKeep) {
        const removed = this.audioChunksBuffer.shift();
        this.totalBufferedSamples -= removed.length;
      }
    }

    _startChunkTimer() {
      this._stopChunkTimer();

      // Wait 30 seconds for the first chunk, then send every 25 seconds (providing a 5-second overlap)
      this.chunkTimeoutId = setTimeout(() => {
        if (!this.isListening) return;
        this._sendWindowChunk();

        this.chunkIntervalId = setInterval(() => {
          if (!this.isListening) return;
          this._sendWindowChunk();
        }, 25000);
      }, 30000);
    }

    _stopChunkTimer() {
      if (this.chunkTimeoutId) {
        clearTimeout(this.chunkTimeoutId);
        this.chunkTimeoutId = null;
      }
      if (this.chunkIntervalId) {
        clearInterval(this.chunkIntervalId);
        this.chunkIntervalId = null;
      }
    }

    _sendWindowChunk() {
      if (this.totalBufferedSamples === 0) return;

      const sampleRate = this.audioContext.sampleRate;

      // Concatenate the chunks in the buffer
      const fullBuffer = new Float32Array(this.totalBufferedSamples);
      let offset = 0;
      for (const chunk of this.audioChunksBuffer) {
        fullBuffer.set(chunk, offset);
        offset += chunk.length;
      }

      // Slice the last 30 seconds of audio
      const samplesNeeded = 30 * sampleRate;
      let windowBuffer;
      if (fullBuffer.length > samplesNeeded) {
        windowBuffer = fullBuffer.subarray(fullBuffer.length - samplesNeeded);
      } else {
        windowBuffer = fullBuffer;
      }

      // Resample to 16kHz
      const resampled = this._resampleTo16k(windowBuffer, sampleRate);

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
