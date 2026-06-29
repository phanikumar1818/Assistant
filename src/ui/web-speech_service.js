(function (global) {
  'use strict';

  class WebSpeechTranscriptionService {
    constructor(options = {}) {
      this.lang = options.lang || 'en-US';
      this.onUtterance = options.onUtterance || null;   // callback(text: string) fired on each final result
      this.onInterim = options.onInterim || null;        // callback(text: string) fired on interim results
      this.onError = options.onError || null;            // callback(error: string)
      this.onStatusChange = options.onStatusChange || null;  // callback(status: 'listening'|'stopped'|'error')
      this.recognition = null;
      this.isListening = false;
      this.shouldBeListening = false;   // ← This flag drives the auto-restart loop
      this.restartDelay = 300;          // ms to wait before restarting after onend
      this._restartTimer = null;
      this.consecutiveNetworkErrors = 0;
    }

    start() {
      this.shouldBeListening = true;
      this._createAndStart();
    }

    _createAndStart() {
      if (!window.webkitSpeechRecognition && !window.SpeechRecognition) {
        if (this.onError) {
          this.onError('Web Speech API not supported in this browser');
        }
        return;
      }

      // Cleanup existing recognition if any
      if (this.recognition) {
        try {
          this.recognition.onstart = null;
          this.recognition.onresult = null;
          this.recognition.onerror = null;
          this.recognition.onend = null;
          this.recognition.stop();
        } catch (e) {
          // ignore
        }
      }

      this.recognition = new (window.SpeechRecognition || window.webkitSpeechRecognition)();

      this.recognition.continuous = true;
      this.recognition.interimResults = true;
      this.recognition.lang = this.lang;
      this.recognition.maxAlternatives = 1;

      this.recognition.onstart = () => {
        this.isListening = true;
        if (this.onStatusChange) {
          this.onStatusChange('listening');
        }
      };

      this.recognition.onresult = (event) => {
        this.consecutiveNetworkErrors = 0;
        let interimTranscript = '';
        for (let i = event.resultIndex; i < event.results.length; ++i) {
          const result = event.results[i];
          const text = result[0].transcript.trim();
          if (result.isFinal) {
            if (this.onUtterance && text) {
              this.onUtterance(text);
            }
          } else {
            interimTranscript += result[0].transcript;
          }
        }
        if (interimTranscript && this.onInterim) {
          this.onInterim(interimTranscript.trim());
        }
      };

      this.recognition.onerror = (event) => {
        const errorType = event.error;
        console.warn('[WebSpeech] Error event:', errorType);

        if (errorType === 'no-speech' || errorType === 'aborted') {
          // Normal silence/aborted, let onend handle restart
          return;
        }

        if (errorType === 'audio-capture') {
          if (this.onError) {
            this.onError('Microphone not available');
          }
          this.shouldBeListening = false;
        } else if (errorType === 'not-allowed') {
          if (this.onError) {
            this.onError('Microphone permission denied');
          }
          this.shouldBeListening = false;
        } else if (errorType === 'network') {
          this.consecutiveNetworkErrors = (this.consecutiveNetworkErrors || 0) + 1;
          console.warn(`[WebSpeech] Network error during speech recognition (count: ${this.consecutiveNetworkErrors}).`);
          if (this.consecutiveNetworkErrors >= 3) {
            console.warn('[WebSpeech] Too many consecutive network errors. Disabling WebSpeech auto-restart to prevent infinite loop.');
            this.shouldBeListening = false;
            if (this.onError) {
              this.onError('Speech recognition network error: Service unavailable or requires API key configuration.');
            }
          }
        } else {
          console.warn('[WebSpeech] Speech recognition service error:', errorType);
          if (errorType === 'service-not-allowed') {
            this.shouldBeListening = false;
          }
        }
      };

      this.recognition.onend = () => {
        this.isListening = false;
        if (this.onStatusChange) {
          this.onStatusChange('stopped');
        }

        if (this.shouldBeListening) {
          clearTimeout(this._restartTimer);
          this._restartTimer = setTimeout(() => {
            if (this.shouldBeListening) {
              console.log('[WebSpeech] Auto-restarting speech recognition...');
              this._createAndStart();
            }
          }, this.restartDelay);
        }
      };

      try {
        this.recognition.start();
      } catch (err) {
        console.error('[WebSpeech] Failed to start recognition:', err);
        if (this.onError) {
          this.onError('Failed to start recognition: ' + err.message);
        }
      }
    }

    stop() {
      this.shouldBeListening = false;
      clearTimeout(this._restartTimer);
      if (this.recognition) {
        try {
          this.recognition.stop();
        } catch (err) {
          // ignore
        }
        this.recognition = null;
      }
      this.isListening = false;
      if (this.onStatusChange) {
        this.onStatusChange('stopped');
      }
    }

    setLanguage(lang) {
      this.lang = lang;
      if (this.shouldBeListening) {
        this.stop();
        this.start();
      }
    }

    getStatus() {
      return {
        isListening: this.isListening,
        shouldBeListening: this.shouldBeListening,
        lang: this.lang
      };
    }
  }

  global.WebSpeechTranscriptionService = WebSpeechTranscriptionService;
})(typeof window !== 'undefined' ? window : global);
