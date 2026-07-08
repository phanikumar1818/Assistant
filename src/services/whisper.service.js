const path = require('path');
const { spawn } = require('child_process');
const EventEmitter = require('events');
const logger = require('../core/logger').createServiceLogger('WHISPER_SERVICE');

class WhisperService extends EventEmitter {
  constructor() {
    super();
    this.modelName = 'base.en';
    this.device = 'cuda';
    
    this.workerProcess = null;
    this.stdoutBuffer = '';
    this.isReady = false;
    
    this.startWorker();
  }

  startWorker() {
    if (this.workerProcess) return;

    const workerScript = path.join(__dirname, 'whisper_streaming_worker.py');
    logger.info(`Spawning Whisper streaming worker: python "${workerScript}" --model ${this.modelName} --device ${this.device}`);

    try {
      this.workerProcess = spawn('python', [
        workerScript,
        '--model', this.modelName,
        '--device', this.device
      ], {
        cwd: __dirname,
        detached: false
      });

      this.workerProcess.stdout.on('data', (data) => {
        this.stdoutBuffer += data.toString();
        let newlineIndex;
        while ((newlineIndex = this.stdoutBuffer.indexOf('\n')) !== -1) {
          const line = this.stdoutBuffer.substring(0, newlineIndex).trim();
          this.stdoutBuffer = this.stdoutBuffer.substring(newlineIndex + 1);
          if (line) {
            this._handleWorkerMessage(line);
          }
        }
      });

      this.workerProcess.stderr.on('data', (data) => {
        logger.info(`[Whisper Worker stderr] ${data.toString().trim()}`);
      });

      this.workerProcess.on('exit', (code, signal) => {
        logger.warn(`Whisper worker process exited with code ${code} and signal ${signal}`);
        this.workerProcess = null;
        this.isReady = false;
        
        // Auto-restart if exited unexpectedly
        if (code !== 0 && signal !== 'SIGTERM') {
          logger.info("Restarting Whisper worker in 2 seconds...");
          setTimeout(() => this.startWorker(), 2000);
        }
      });

      this.workerProcess.on('error', (err) => {
        logger.error("Failed to start Whisper worker process:", err);
      });
    } catch (err) {
      logger.error("Error spawning Whisper worker process:", err);
    }
  }

  stopWorker() {
    if (this.workerProcess) {
      logger.info("Stopping Whisper streaming worker...");
      this.workerProcess.kill('SIGTERM');
      this.workerProcess = null;
      this.isReady = false;
    }
  }

  stopServer() {
    this.stopWorker();
  }

  _handleWorkerMessage(line) {
    try {
      const msg = JSON.parse(line);
      
      if (msg.status) {
        if (msg.status === 'ready') {
          this.isReady = true;
          this.emit('ready');
          logger.info(`Whisper worker is ready: ${msg.message}`);
        } else if (msg.status === 'error') {
          logger.error(`Whisper worker error: ${msg.message}`);
        } else {
          logger.info(`Whisper worker: ${msg.message}`);
        }
        return;
      }

      if (msg.type === 'interim') {
        this.emit('interim', {
          text: msg.text,
          metadata: msg.metadata
        });
      } else if (msg.type === 'final') {
        this.emit('final', {
          text: msg.text,
          durationMs: msg.duration_ms,
          metadata: msg.metadata
        });
      } else if (msg.type === 'error') {
        logger.error(`Whisper worker processing error: ${msg.message}`);
      }
    } catch (err) {
      logger.error("Failed to parse Whisper worker message:", err, { line });
    }
  }

  feedAudioStream(pcmFloat32Array, metadata = {}) {
    if (!this.workerProcess || !this.workerProcess.stdin) {
      logger.warn("Whisper streaming worker not active");
      return;
    }

    const sampleCount = pcmFloat32Array.length;
    if (sampleCount === 0) return;

    // 1. Pack metadata JSON with captured and sent timestamps
    const metaPayload = {
      id: metadata.id || `chunk_${Date.now()}`,
      audio_captured: metadata.audioCreationTimestamp || Date.now(),
      sent_to_worker: Date.now()
    };

    const metaStr = JSON.stringify(metaPayload);
    const metaBytes = Buffer.from(metaStr, 'utf8');

    // Headers
    const metaHeader = Buffer.alloc(4);
    metaHeader.writeUInt32LE(metaBytes.length, 0);

    const pcmHeader = Buffer.alloc(4);
    pcmHeader.writeUInt32LE(sampleCount, 0);

    const pcmBuffer = Buffer.from(pcmFloat32Array.buffer, pcmFloat32Array.byteOffset, pcmFloat32Array.byteLength);

    try {
      this.workerProcess.stdin.write(metaHeader);
      this.workerProcess.stdin.write(metaBytes);
      this.workerProcess.stdin.write(pcmHeader);
      this.workerProcess.stdin.write(pcmBuffer);
    } catch (err) {
      logger.error("Failed to write to Whisper worker stdin:", err);
    }
  }

  transcribe(pcmFloat32Array, promptText = '', metadata = {}) {
    this.feedAudioStream(pcmFloat32Array, metadata);
    return Promise.resolve({ text: '', durationMs: 0 });
  }
}

module.exports = new WhisperService();
