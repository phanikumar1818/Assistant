/**
 * Continuous meeting listening with system audio loopback + optional mic mix.
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

      const segment = {
        text: trimmed,
        timestamp: Date.now(),
        source
      };
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
      return {
        segments: [...this.segments],
        lastAnswerAt: this.lastAnswerAt
      };
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
      this.transcribeAudio = options.transcribeAudio || null;
      this.syncTranscript = options.syncTranscript || null;

      this.transcriptBuffer = new MeetingTranscriptBuffer();
      this.mediaRecorder = null;
      this.audioChunksSinceLastAnswer = [];
      this.streams = [];
      this.audioContext = null;
      this.isListening = false;
      this.isProcessingAnswer = false;
      this.chunkIntervalMs = options.chunkIntervalMs || 5000;
      this.includeMicrophone = options.includeMicrophone !== false;
      this.maxTranscribeBytes = options.maxTranscribeBytes || 8 * 1024 * 1024;
    }

    get isActive() {
      return this.isListening;
    }

    async start() {
      if (this.isListening) {
        return { success: true, alreadyListening: true };
      }

      try {
        this.onStatus('Starting meeting audio capture (system loopback)...');
        const stream = await this._acquireMeetingAudioStream();
        this._attachStream(stream);

        const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
          ? 'audio/webm;codecs=opus'
          : 'audio/webm';

        this.mediaRecorder = new MediaRecorder(stream, { mimeType });
        this.audioChunksSinceLastAnswer = [];

        this.mediaRecorder.ondataavailable = (event) => {
          if (event.data && event.data.size > 0) {
            this.audioChunksSinceLastAnswer.push(event.data);
          }
        };

        this.mediaRecorder.onerror = (event) => {
          this.onError(event.error?.message || 'MediaRecorder error');
        };

        this.mediaRecorder.onstop = () => {
          if (this.isListening) {
            this.onError('Recording stopped unexpectedly. Toggle listening to restart.');
            this._setListening(false);
          }
        };

        this.mediaRecorder.start(this.chunkIntervalMs);
        this._setListening(true);
        this.onStatus('Listening to meeting audio. Press Enter when you want an answer.');
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
      if (!this.isListening && !this.mediaRecorder) {
        return { success: true };
      }

      try {
        if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
          this.mediaRecorder.stop();
        }
      } catch (err) {
        console.warn('Error stopping MediaRecorder:', err);
      }

      this.mediaRecorder = null;
      this._cleanupStreams();
      this._setListening(false);
      this.onStatus('Meeting listening stopped.');
      return { success: true };
    }

    async toggle() {
      if (this.isListening) {
        return this.stop();
      }
      return this.start();
    }

    /**
     * Transcribe audio captured since the last answer, append to full history,
     * and return the new text (plus any manual user input).
     */
    async prepareAnswerPayload(manualText = '') {
      if (this.isProcessingAnswer) {
        throw new Error('Already processing an answer request.');
      }

      this.isProcessingAnswer = true;

      try {
        const manual = (manualText || '').trim();
        let newTranscript = '';

        const audioBlob = this._getAudioBlobSinceLastAnswer();
        if (audioBlob && audioBlob.size >= 500) {
          this.onStatus('Transcribing new meeting audio...');
          newTranscript = await this._transcribeBlob(audioBlob);
          if (newTranscript) {
            this.transcriptBuffer.appendSegment(newTranscript, 'transcription');
            await this._notifyTranscriptSync();
          }
          this.audioChunksSinceLastAnswer = [];
        }

        const newSinceLastAnswer = this.transcriptBuffer.getNewSinceLastAnswer();
        const parts = [manual, newSinceLastAnswer].filter(Boolean);
        const payload = parts.join('\n\n').trim();

        return {
          payload,
          newTranscript,
          manualText: manual,
          fullTranscript: this.transcriptBuffer.getFullTranscript(),
          stats: this.transcriptBuffer.getStats()
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
        pendingAudioChunks: this.audioChunksSinceLastAnswer.length,
        ...this.transcriptBuffer.getStats()
      };
    }

    async _acquireMeetingAudioStream() {
      if (!navigator.mediaDevices?.getDisplayMedia) {
        throw new Error('System audio capture is not supported in this environment.');
      }

      const displayStream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          width: { ideal: 320, max: 640 },
          height: { ideal: 180, max: 360 },
          frameRate: { ideal: 5, max: 10 }
        },
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          suppressLocalAudioPlayback: false
        },
        preferCurrentTab: false,
        selfBrowserSurface: 'exclude',
        systemAudio: 'include'
      });

      displayStream.getVideoTracks().forEach((track) => {
        track.stop();
      });

      const systemAudioTracks = displayStream.getAudioTracks();
      if (!systemAudioTracks.length) {
        displayStream.getTracks().forEach((track) => track.stop());
        throw new Error(
          'No system audio track received. On Windows, share "Entire screen" and enable "Share system audio".'
        );
      }

      let meetingStream = new MediaStream(systemAudioTracks);

      if (this.includeMicrophone) {
        try {
          const micStream = await navigator.mediaDevices.getUserMedia({
            audio: {
              echoCancellation: true,
              noiseSuppression: true,
              autoGainControl: true
            }
          });
          meetingStream = this._mixAudioStreams(meetingStream, micStream);
          this.streams.push(micStream);
        } catch (micErr) {
          console.warn('Microphone unavailable; using system audio only:', micErr.message);
          this.onStatus('System audio only (microphone unavailable).');
        }
      }

      this.streams.push(displayStream);
      return meetingStream;
    }

    _mixAudioStreams(systemStream, micStream) {
      this.audioContext = new AudioContext();
      const destination = this.audioContext.createMediaStreamDestination();

      const connectStream = (stream) => {
        if (stream.getAudioTracks().length > 0) {
          this.audioContext.createMediaStreamSource(stream).connect(destination);
        }
      };

      connectStream(systemStream);
      connectStream(micStream);

      systemStream.getAudioTracks().forEach((track) => {
        track.addEventListener('ended', () => this._handleStreamEnded());
      });
      micStream.getAudioTracks().forEach((track) => {
        track.addEventListener('ended', () => this._handleStreamEnded());
      });

      return destination.stream;
    }

    _attachStream(stream) {
      stream.getAudioTracks().forEach((track) => {
        track.addEventListener('ended', () => this._handleStreamEnded());
      });
      this.streams.push(stream);
    }

    _handleStreamEnded() {
      if (!this.isListening) return;
      this.onError('Audio capture ended. Toggle listening to reconnect.');
      this.stop();
    }

    _getAudioBlobSinceLastAnswer() {
      if (!this.audioChunksSinceLastAnswer.length) return null;
      const mimeType = this.mediaRecorder?.mimeType || 'audio/webm';
      return new Blob(this.audioChunksSinceLastAnswer, { type: mimeType });
    }

    async _transcribeBlob(blob) {
      if (!this.transcribeAudio) {
        throw new Error('Transcription service not configured.');
      }

      if (blob.size <= this.maxTranscribeBytes) {
        const base64 = await this._blobToBase64(blob);
        const result = await this.transcribeAudio(base64);
        if (result?.success && result.transcript) {
          return result.transcript.trim();
        }
        throw new Error(result?.error || 'Transcription failed.');
      }

      return this._transcribeLargeBlob(blob);
    }

    async _transcribeLargeBlob(blob) {
      const chunkCount = Math.ceil(blob.size / this.maxTranscribeBytes);
      const chunkSize = Math.ceil(blob.size / chunkCount);
      const transcripts = [];

      for (let i = 0; i < chunkCount; i++) {
        const start = i * chunkSize;
        const end = Math.min(start + chunkSize, blob.size);
        const chunkBlob = blob.slice(start, end, blob.type);
        if (chunkBlob.size < 500) continue;

        this.onStatus(`Transcribing audio part ${i + 1} of ${chunkCount}...`);
        const base64 = await this._blobToBase64(chunkBlob);
        const result = await this.transcribeAudio(base64);
        if (result?.success && result.transcript) {
          transcripts.push(result.transcript.trim());
        }
      }

      return transcripts.join(' ').trim();
    }

    _blobToBase64(blob) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => {
          const base64 = reader.result.split(',')[1];
          resolve(base64);
        };
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
    }

    _cleanupStreams() {
      this.streams.forEach((stream) => {
        stream.getTracks().forEach((track) => {
          try {
            track.stop();
          } catch (err) {
            console.warn('Failed to stop track:', err);
          }
        });
      });
      this.streams = [];

      if (this.audioContext) {
        this.audioContext.close().catch(() => {});
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
        return 'Screen/audio capture permission denied. Allow capture and enable "Share system audio".';
      }
      if (err.name === 'NotFoundError') {
        return 'No capture source found. Share your screen with system audio enabled.';
      }
      if (err.name === 'NotReadableError') {
        return 'Audio capture device is busy or unavailable.';
      }
      return err.message || 'Failed to start meeting audio capture.';
    }
  }

  global.MeetingListening = {
    MeetingTranscriptBuffer,
    ContinuousListeningManager
  };
})(typeof window !== 'undefined' ? window : global);
