class AudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = [];
    this.bufferSize = 4096; // Post in chunks of 4096 samples (~85ms at 48kHz) to minimize IPC overhead
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    if (input && input.length > 0) {
      const channelData = input[0]; // mono channel
      
      // Copy sample data into our buffer
      for (let i = 0; i < channelData.length; i++) {
        this.buffer.push(channelData[i]);
      }

      if (this.buffer.length >= this.bufferSize) {
        const chunk = new Float32Array(this.buffer);
        this.port.postMessage(chunk);
        this.buffer = [];
      }
    }
    return true;
  }
}

registerProcessor('audio-processor', AudioProcessor);
