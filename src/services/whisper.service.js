const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile, spawn } = require('child_process');
const logger = require('../core/logger').createServiceLogger('WHISPER_SERVICE');

class WhisperService {
  constructor() {
    this.exePath = this._resolveExePath();
    this.modelPath = this._resolveModelPath();
    this.queue = [];
    this.isProcessing = false;
    
    this.serverProcess = null;
    this.serverPort = null;
    this.serverExePath = this._resolveServerExePath();

    this._eagerLoadModel();
    // Start Whisper server in the background
    this.startServer();
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

  _resolveServerExePath() {
    const packagedPath = process.resourcesPath ? path.join(process.resourcesPath, 'bin', 'whisper-server.exe') : '';
    const devPath = path.join(__dirname, '../../bin/Release/whisper-server.exe');

    if (packagedPath && fs.existsSync(packagedPath)) {
      logger.info(`Using packaged whisper-server executable: ${packagedPath}`);
      return packagedPath;
    }
    logger.info(`Using dev whisper-server executable: ${devPath}`);
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
    if (!fs.existsSync(this.serverExePath)) {
      logger.error(`whisper-server executable not found at: ${this.serverExePath}`);
    }
    if (!fs.existsSync(this.modelPath)) {
      logger.error(`Model file not found at: ${this.modelPath}`);
    }
  }

  _getFreePort() {
    const net = require('net');
    return new Promise((resolve, reject) => {
      const server = net.createServer();
      server.unref();
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const port = server.address().port;
        server.close(() => resolve(port));
      });
    });
  }

  async startServer() {
    if (this.serverProcess) return;

    logger.info('Starting local Whisper server sidecar...');
    try {
      this.serverPort = await this._getFreePort();
      
      if (!fs.existsSync(this.serverExePath)) {
        throw new Error(`whisper-server.exe not found at: ${this.serverExePath}`);
      }
      if (!fs.existsSync(this.modelPath)) {
        throw new Error(`Model file not found at: ${this.modelPath}`);
      }

      logger.info(`Spawning Whisper server on port ${this.serverPort}...`);
      this.serverProcess = spawn(this.serverExePath, [
        '-m', this.modelPath,
        '--port', this.serverPort.toString(),
        '--host', '127.0.0.1',
        '-t', Math.min(4, Math.max(2, os.cpus().length - 2)).toString(),
        '--suppress-nst',
        '--no-timestamps'
      ], {
        cwd: path.dirname(this.serverExePath),
        detached: false
      });

      this.serverProcess.stderr.on('data', (data) => {
        logger.info(`[Whisper Server stderr] ${data.toString().trim()}`);
      });
      this.serverProcess.stdout.on('data', (data) => {
        logger.info(`[Whisper Server stdout] ${data.toString().trim()}`);
      });

      this.serverProcess.on('exit', (code, signal) => {
        logger.warn(`Whisper server process exited with code ${code} and signal ${signal}`);
        this.serverProcess = null;
        this.serverPort = null;
      });

      await this._waitForServer(this.serverPort);
      logger.info(`Whisper server is active on port ${this.serverPort}`);
    } catch (err) {
      logger.error('Failed to start local Whisper server, will fall back to CLI transcription:', err);
      this.serverProcess = null;
      this.serverPort = null;
    }
  }

  async _waitForServer(port, timeoutMs = 60000) {
    const net = require('net');
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const isAlive = await new Promise((resolve) => {
        const socket = new net.Socket();
        socket.setTimeout(1000);
        socket.on('connect', () => {
          socket.destroy();
          resolve(true);
        });
        socket.on('error', () => {
          socket.destroy();
          resolve(false);
        });
        socket.on('timeout', () => {
          socket.destroy();
          resolve(false);
        });
        socket.connect(port, '127.0.0.1');
      });

      if (isAlive) {
        return true;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error('Whisper server startup timeout');
  }

  stopServer() {
    if (this.serverProcess) {
      logger.info('Stopping local Whisper server...');
      this.serverProcess.kill();
      this.serverProcess = null;
      this.serverPort = null;
    }
  }

  transcribe(pcmFloat32Array, promptText = '') {
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
      this.queue.push({ pcmFloat32Array: samples, promptText, resolve, reject });
      this._processQueue();
    });
  }

  async _processQueue() {
    if (this.isProcessing || this.queue.length === 0) return;
    this.isProcessing = true;

    const { pcmFloat32Array, promptText, resolve, reject } = this.queue.shift();

    try {
      const startTime = Date.now();
      const text = await this._transcribeAudio(pcmFloat32Array, promptText);
      const durationMs = Date.now() - startTime;
      resolve({ text, durationMs });
    } catch (err) {
      logger.error('Error during transcription queue processing:', err);
      reject(err);
    } finally {
      this.isProcessing = false;
      setImmediate(() => this._processQueue());
    }
  }

  _cleanText(text, promptText = '') {
    if (!text) return '';
    let cleaned = text.trim();
    
    // Remove common bracketed whisper hallucinations/sounds
    cleaned = cleaned.replace(/\[[^\]]*\]/g, ''); 
    cleaned = cleaned.replace(/\([^)]*\)/g, ''); 
    
    // Clean up specific words often hallucinated in quiet or background noise
    cleaned = cleaned.replace(/^(music|silence|sigh|laughter|cough|clicks|throat-clearing|coughing|chuckle|snicker)\.?$/i, '');
    cleaned = cleaned.replace(/^(um|uh|ah|er|oh)\.?$/i, ''); 
    
    // Trim extra spaces
    cleaned = cleaned.replace(/\s+/g, ' ').trim();
    
    // If the text contains only punctuation/symbols, return empty
    if (/^[.,\/#!$%\^&\*;:{}=\-_`~()?\s]+$/.test(cleaned)) {
      return '';
    }

    // Repetition check: If Whisper returns exactly the prompt (or a subset of it), it's a hallucination
    if (promptText) {
      const cleanPrompt = promptText.trim().toLowerCase().replace(/[.,\/#!$%\^&\*;:{}=\-_`~()?]/g,"");
      const cleanCleaned = cleaned.toLowerCase().replace(/[.,\/#!$%\^&\*;:{}=\-_`~()?]/g,"");
      if (cleanPrompt.includes(cleanCleaned)) {
        return '';
      }
    }
    
    return cleaned;
  }

  async _transcribeAudio(pcmFloat32Array, promptText = '') {
    if (this.serverPort) {
      try {
        const wavBuffer = this._createWavBuffer(pcmFloat32Array, 16000);
        const formData = new FormData();
        const blob = new Blob([wavBuffer], { type: 'audio/wav' });
        formData.append('file', blob, 'audio.wav');
        formData.append('temperature', '0.0');
        formData.append('response_format', 'json');
        if (promptText) {
          formData.append('prompt', promptText);
        }

        const response = await fetch(`http://127.0.0.1:${this.serverPort}/inference`, {
          method: 'POST',
          body: formData
        });

        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }

        const result = await response.json();
        const text = result.text ? result.text.trim() : '';
        return this._cleanText(text, promptText);
      } catch (err) {
        logger.error('Error during server transcription, falling back to CLI execution:', err);
      }
    }
    return this._transcribeAudioCLI(pcmFloat32Array, promptText);
  }

  async _transcribeAudioCLI(pcmFloat32Array, promptText = '') {
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

      const args = [
        '-m', this.modelPath,
        '-f', tempWavPath,
        '-nt' // no timestamps flag
      ];

      if (promptText) {
        args.push('--prompt', promptText);
      }

      const result = await new Promise((resolve, reject) => {
        execFile(this.exePath, args, {
          cwd: path.dirname(this.exePath)
        }, (error, stdout, stderr) => {
          if (error) {
            reject(error);
            return;
          }
          resolve(stdout.trim());
        });
      });
      return this._cleanText(result, promptText);
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
