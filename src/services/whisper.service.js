const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');
const logger = require('../core/logger').createServiceLogger('WHISPER_SERVICE');

class WhisperService {
  constructor() {
    this.exePath = this._resolveExePath();
    this.modelPath = this._resolveModelPath();
    this.queue = [];
    this.isProcessing = false;
    
    this._eagerLoadModel();
  }

  _resolveExePath() {
    // Packaged path: extraResources copies bin/Release into bin
    const packagedPath = process.resourcesPath ? path.join(process.resourcesPath, 'bin', 'whisper-cli.exe') : '';
    // Dev path
    const devPath = path.join(__dirname, '../../bin/Release/whisper-cli.exe');

    if (packagedPath && fs.existsSync(packagedPath)) {
      logger.info(`Using packaged whisper-cli executable: ${packagedPath}`);
      return packagedPath;
    }
    logger.info(`Using dev whisper-cli executable: ${devPath}`);
    return devPath;
  }

  _resolveModelPath() {
    // Packaged path
    const packagedPath = process.resourcesPath ? path.join(process.resourcesPath, 'models', 'ggml-base.en.bin') : '';
    // Dev path
    const devPath = path.join(__dirname, '../../models/ggml-base.en.bin');

    if (packagedPath && fs.existsSync(packagedPath)) {
      logger.info(`Using packaged model: ${packagedPath}`);
      return packagedPath;
    }
    logger.info(`Using dev model: ${devPath}`);
    return devPath;
  }

  _eagerLoadModel() {
    logger.info('Eager loading Whisper model checks completed.');
    if (!fs.existsSync(this.exePath)) {
      logger.error(`whisper-cli executable not found at: ${this.exePath}`);
    }
    if (!fs.existsSync(this.modelPath)) {
      logger.error(`Model file not found at: ${this.modelPath}`);
    }
  }

  transcribe(pcmFloat32Array) {
    let samples = pcmFloat32Array;
    if (!(samples instanceof Float32Array)) {
      if (Buffer.isBuffer(samples) || samples instanceof Uint8Array) {
        samples = new Float32Array(
          samples.buffer,
          samples.byteOffset,
          samples.byteLength / Float32Array.BYTES_PER_ELEMENT
        );
      } else if (samples && typeof samples === 'object') {
        samples = Float32Array.from(Object.values(samples));
      } else {
        samples = new Float32Array(0);
      }
    }
    return new Promise((resolve, reject) => {
      this.queue.push({ pcmFloat32Array: samples, resolve, reject });
      this._processQueue();
    });
  }

  async _processQueue() {
    if (this.isProcessing || this.queue.length === 0) return;
    this.isProcessing = true;

    const { pcmFloat32Array, resolve, reject } = this.queue.shift();

    try {
      const startTime = Date.now();
      const text = await this._transcribeAudio(pcmFloat32Array);
      const durationMs = Date.now() - startTime;
      resolve({ text, durationMs });
    } catch (err) {
      logger.error('Error during transcription queue processing:', err);
      reject(err);
    } finally {
      this.isProcessing = false;
      // Process the next chunk immediately
      setImmediate(() => this._processQueue());
    }
  }

  async _transcribeAudio(pcmFloat32Array) {
    // Generate a unique temporary WAV file path
    const tempDir = path.join(os.tmpdir(), 'vysper_whisper');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
    const tempWavPath = path.join(tempDir, `chunk_${Date.now()}_${Math.random().toString(36).substr(2, 9)}.wav`);

    try {
      // Write PCM Float32Array to 16kHz mono WAV file
      const wavBuffer = this._createWavBuffer(pcmFloat32Array, 16000);
      fs.writeFileSync(tempWavPath, wavBuffer);

      const result = await new Promise((resolve, reject) => {
        execFile(this.exePath, [
          '-m', this.modelPath,
          '-f', tempWavPath,
          '-nt' // no timestamps flag
        ], {
          cwd: path.dirname(this.exePath)
        }, (error, stdout, stderr) => {
          if (error) {
            reject(error);
            return;
          }
          resolve(stdout.trim());
        });
      });
      return result;
    } finally {
      // Clean up the temporary file
      try {
        if (fs.existsSync(tempWavPath)) {
          fs.unlinkSync(tempWavPath);
        }
      } catch (err) {
        logger.warn('Failed to delete temp WAV file:', err.message);
      }
    }
  }

  _createWavBuffer(float32Array, sampleRate) {
    const bitsPerSample = 16;
    const numChannels = 1;
    const pcmData = this._floatTo16BitPCM(float32Array);
    const buffer = new ArrayBuffer(44 + pcmData.length);
    const view = new DataView(buffer);

    this._writeWavHeader(view, 0, sampleRate, numChannels, bitsPerSample, pcmData.length);

    // Copy PCM data
    const uint8View = new Uint8Array(buffer);
    uint8View.set(pcmData, 44);

    return Buffer.from(buffer);
  }

  _floatTo16BitPCM(float32Array) {
    const buffer = new ArrayBuffer(float32Array.length * 2);
    const view = new DataView(buffer);
    let offset = 0;
    for (let i = 0; i < float32Array.length; i++, offset += 2) {
      let s = Math.max(-1, Math.min(1, float32Array[i]));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    }
    return new Uint8Array(buffer);
  }

  _writeWavHeader(view, offset, sampleRate, numChannels, bitsPerSample, byteLength) {
    const writeString = (view, offset, string) => {
      for (let i = 0; i < string.length; i++) {
        view.setUint8(offset + i, string.charCodeAt(i));
      }
    };
    writeString(view, offset, 'RIFF');
    view.setUint32(offset + 4, 36 + byteLength, true);
    writeString(view, offset + 8, 'WAVE');
    writeString(view, offset + 12, 'fmt ');
    view.setUint32(offset + 16, 16, true);
    view.setUint16(offset + 20, 1, true);
    view.setUint16(offset + 22, numChannels, true);
    view.setUint32(offset + 24, sampleRate, true);
    view.setUint32(offset + 28, sampleRate * numChannels * (bitsPerSample / 8), true);
    view.setUint16(offset + 32, numChannels * (bitsPerSample / 8), true);
    view.setUint16(offset + 34, bitsPerSample, true);
    writeString(view, offset + 36, 'data');
    view.setUint32(offset + 40, byteLength, true);
  }
}

module.exports = new WhisperService();
