/**
 * Continuous meeting listening with separate system loopback + microphone capture.
 * Transcription is deferred until the user requests an answer (Enter/Send).
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
      this.transcribeAudio = options.transcribeAudio || null;
      this.syncTranscript = options.syncTranscript || null;

      this.transcriptBuffer = new MeetingTranscriptBuffer();
      this.displayStream = null;
      this.systemStream = null;
      this.micStream = null;
      this.mixedStream = null;
      this.systemRecorder = null;
      this.micRecorder = null;
      this.mixedRecorder = null;
      this.systemChunks = [];
      this.micChunks = [];
      this.mixedChunks = [];
      this.audioContext = null;
      this.levelContext = null;
      this.levelAnalyser = null;
      this.levelMonitorId = null;
      this.isListening = false;
      this.isProcessingAnswer = false;
      this.chunkIntervalMs = options.chunkIntervalMs || 2000;
      this.includeMicrophone = options.includeMicrophone !== false;
      this.maxTranscribeBytes = options.maxTranscribeBytes || 12 * 1024 * 1024;
      this.audioBitsPerSecond = options.audioBitsPerSecond || 128000;
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
        this._startRecorders();
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
      this._stopLevelMonitor();
      this._stopRecorder(this.mixedRecorder);
      this.mixedRecorder = null;
      this.mixedChunks = [];
      this._cleanupStreams();
      this._setListening(false);
      this.onStatus('Meeting listening stopped.');
      return { success: true };
    }

    async toggle() {
      return this.isListening ? this.stop() : this.start();
    }

    async prepareAnswerPayload(manualText = '') {
      if (this.isProcessingAnswer) {
        throw new Error('Already processing an answer request.');
      }

      this.isProcessingAnswer = true;

      try {
        const manual = (manualText || '').trim();
        const { mixedBlob } = await this._snapshotAudioForTranscription();
        const transcriptParts = [];

        if (mixedBlob) {
          this.onStatus(`Transcribing mixed meeting audio (${Math.round(mixedBlob.size / 1024)} KB)...`);
          const text = await this._transcribeBlob(mixedBlob, 'meeting');
          if (text) transcriptParts.push(text);
        }

        const newTranscript = transcriptParts.join(' ').trim();
        if (newTranscript) {
          this.transcriptBuffer.appendSegment(newTranscript, 'transcription');
          await this._notifyTranscriptSync();
        }

        const newSinceLastAnswer = this.transcriptBuffer.getNewSinceLastAnswer();
        const parts = [manual, newSinceLastAnswer].filter(Boolean);
        const payload = parts.join('\n\n').trim();

        return {
          payload,
          newTranscript,
          manualText: manual,
          fullTranscript: this.transcriptBuffer.getFullTranscript(),
          stats: this.transcriptBuffer.getStats(),
          captured: { systemBytes: mixedBlob?.size || 0, micBytes: 0 }
        };
      } finally {
        this.isProcessingAnswer = false;
      }
    }

    markAnswerSent() {
      this.transcriptBuffer.markAnswerSent();
      this._notifyTranscriptSync();
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
        pendingSystemChunks: this.systemChunks.length,
        pendingMicChunks: this.micChunks.length,
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

    _getMimeType() {
      const candidates = [
        'audio/webm;codecs=opus',
        'audio/webm',
        'audio/ogg;codecs=opus'
      ];
      return candidates.find((type) => MediaRecorder.isTypeSupported(type)) || 'audio/webm';
    }

    _createRecorder(stream, onChunk) {
      const mimeType = this._getMimeType();
      const recorder = new MediaRecorder(stream, {
        mimeType,
        audioBitsPerSecond: this.audioBitsPerSecond
      });

      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          onChunk(event.data);
        }
      };

      recorder.onerror = (event) => {
        this.onError(event.error?.message || 'MediaRecorder error');
      };

      return recorder;
    }

    _startRecorders() {
      this.mixedChunks = [];

      this.mixedRecorder = this._createRecorder(this.mixedStream, (chunk) => {
        this.mixedChunks.push(chunk);
      });
      this.mixedRecorder.start(this.chunkIntervalMs);

      this._startLevelMonitor();
    }

    _stopRecorder(recorder) {
      if (!recorder || recorder.state === 'inactive') return;
      try {
        recorder.stop();
      } catch (err) {
        console.warn('Error stopping recorder:', err);
      }
    }

    async _finalizeRecorder(recorder, chunks) {
      if (!recorder || recorder.state === 'inactive') {
        if (!chunks.length) return null;
        const blob = new Blob(chunks, { type: this._getMimeType() });
        chunks.length = 0;
        return blob.size >= 500 ? blob : null;
      }

      return new Promise((resolve) => {
        const finalChunks = [...chunks];
        const mimeType = recorder.mimeType || this._getMimeType();

        const onData = (event) => {
          if (event.data && event.data.size > 0) {
            finalChunks.push(event.data);
          }
        };

        const onStop = () => {
          recorder.removeEventListener('dataavailable', onData);
          chunks.length = 0;
          if (!finalChunks.length) {
            resolve(null);
            return;
          }
          const blob = new Blob(finalChunks, { type: mimeType });
          resolve(blob.size >= 500 ? blob : null);
        };

        recorder.addEventListener('dataavailable', onData);
        recorder.addEventListener('stop', onStop, { once: true });

        try {
          if (recorder.state === 'recording') {
            recorder.requestData();
          }
          recorder.stop();
        } catch (err) {
          recorder.removeEventListener('dataavailable', onData);
          resolve(null);
        }
      });
    }

    async _snapshotAudioForTranscription() {
      const wasListening = this.isListening;
      this._stopLevelMonitor();

      const mixedBlob = await this._finalizeRecorder(this.mixedRecorder, this.mixedChunks);

      this.mixedRecorder = null;

      if (wasListening && this.mixedStream && !this.mixedStream.getAudioTracks().some((t) => t.readyState === 'ended')) {
        this._startRecorders();
      } else if (wasListening) {
        this.onError('System audio track ended. Toggle listening to reconnect.');
        this._setListening(false);
      }

      return { mixedBlob };
    }

    async _transcribeBlob(blob, source) {
      if (!this.transcribeAudio) {
        throw new Error('Transcription service not configured.');
      }

      if (blob.size > this.maxTranscribeBytes) {
        this.onStatus('Audio segment is large — transcribing in parts...');
        return this._transcribeBlobInTimeParts(blob, source);
      }

      const base64 = await this._blobToBase64(blob);
      const result = await this.transcribeAudio(base64, {
        source,
        mimeType: blob.type || this._getMimeType()
      });

      if (result?.success && result.transcript) {
        const text = result.transcript.trim();
        return this._isInaudible(text) ? '' : text;
      }

      throw new Error(result?.error || 'Transcription failed.');
    }

    async _transcribeBlobInTimeParts(blob, source) {
      const partSize = Math.floor(this.maxTranscribeBytes * 0.8);
      const transcripts = [];
      let offset = 0;
      let part = 1;

      while (offset < blob.size) {
        const end = Math.min(offset + partSize, blob.size);
        const slice = blob.slice(offset, end, blob.type);
        if (slice.size >= 500) {
          this.onStatus(`Transcribing ${source} audio part ${part}...`);
          const base64 = await this._blobToBase64(slice);
          const result = await this.transcribeAudio(base64, { source, mimeType: blob.type });
          if (result?.success && result.transcript) {
            const text = result.transcript.trim();
            if (text && !this._isInaudible(text)) {
              transcripts.push(text);
            }
          }
          part += 1;
        }
        offset = end;
      }

      return transcripts.join(' ').trim();
    }

    _isInaudible(text) {
      const normalized = text.toLowerCase().replace(/[\[\]()]/g, '').trim();
      return !normalized || normalized === 'inaudible' || normalized === 'no speech' || normalized === 'silence';
    }

    _blobToBase64(blob) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result.split(',')[1]);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
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
      this._stopLevelMonitor();
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

    async _notifyTranscriptSync() {
      if (this.syncTranscript) {
        try {
          await this.syncTranscript(this.transcriptBuffer.toJSON());
        } catch (err) {
          console.warn('Transcript sync failed:', err);
        }
      }
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
