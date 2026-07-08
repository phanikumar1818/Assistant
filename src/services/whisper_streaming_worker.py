import sys
import os

# On Windows, explicitly add CUDA/cuBLAS DLL directories to the DLL search path
if sys.platform == 'win32':
    import site
    site_dirs = site.getsitepackages() + [site.getusersitepackages()]
    for site_dir in site_dirs:
        nvidia_dir = os.path.join(site_dir, 'nvidia')
        if os.path.isdir(nvidia_dir):
            for root, dirs, files in os.walk(nvidia_dir):
                if 'bin' in dirs:
                    bin_path = os.path.join(root, 'bin')
                    try:
                        os.add_dll_directory(bin_path)
                        os.environ['PATH'] = bin_path + os.path.pathsep + os.environ['PATH']
                    except Exception:
                        pass

import argparse
import json
import numpy as np
import time
import struct
import threading
import queue

# Helper to read exact bytes from stdin
def read_exact(n):
    data = b''
    while len(data) < n:
        packet = sys.stdin.buffer.read(n - len(data))
        if not packet:
            return None
        data += packet
    return data

# Thread-safe queue to pass chunks from background reader to main thread
input_queue = queue.Queue()

def stdin_reader():
    while True:
        try:
            # 1. Read JSON metadata length (4 bytes)
            meta_len_bytes = read_exact(4)
            if not meta_len_bytes:
                break
            meta_len = struct.unpack('<I', meta_len_bytes)[0]
            
            # 2. Read JSON metadata string
            meta_bytes = read_exact(meta_len)
            if not meta_bytes:
                break
            meta = json.loads(meta_bytes.decode('utf-8'))
            
            # 3. Read PCM length (4 bytes)
            pcm_len_bytes = read_exact(4)
            if not pcm_len_bytes:
                break
            pcm_len = struct.unpack('<I', pcm_len_bytes)[0]
            
            # 4. Read PCM binary data
            pcm_bytes = read_exact(pcm_len * 4)
            if not pcm_bytes:
                break
                
            # Record receipt time by the worker
            meta['worker_received'] = int(time.time() * 1000)
            
            # Put metadata and pcm data in the queue
            input_queue.put((meta, pcm_bytes))
        except Exception as e:
            # Output error to stderr and stop reader
            sys.stderr.write(f"Stdin reader error: {str(e)}\n")
            sys.stderr.flush()
            break

try:
    from faster_whisper import WhisperModel
except ImportError:
    print(json.dumps({"status": "error", "message": "faster-whisper not installed"}), flush=True)
    sys.exit(1)

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--model', type=str, default='base.en')
    parser.add_argument('--device', type=str, default='cuda')
    args = parser.parse_args()

    device = args.device
    if device == 'cuda':
        import torch
        if not torch.cuda.is_available():
            device = 'cpu'
    
    compute_type = 'float16' if device == 'cuda' else 'int8'

    print(json.dumps({"status": "info", "message": f"Loading model '{args.model}' on {device} ({compute_type})..."}), flush=True)
    
    try:
        model = WhisperModel(args.model, device=device, compute_type=compute_type)
        print(json.dumps({"status": "ready", "message": f"faster-whisper worker ready (device: {device})"}), flush=True)
    except Exception as e:
        print(json.dumps({"status": "error", "message": f"Failed to load model: {str(e)}"}), flush=True)
        sys.exit(1)

    # Start the background stdin reader thread
    reader_thread = threading.Thread(target=stdin_reader, daemon=True)
    reader_thread.start()

    sample_rate = 16000
    audio_buffer = np.zeros(0, dtype=np.float32)
    
    while True:
        # Block until at least one chunk is available
        try:
            item = input_queue.get(timeout=0.1)
        except queue.Empty:
            continue
            
        # Coalesce all currently pending chunks in the queue
        chunks = [item]
        while not input_queue.empty():
            try:
                chunks.append(input_queue.get_nowait())
            except queue.Empty:
                break
                
        # The latest chunk's metadata is used for tracking latency deltas
        latest_meta = chunks[-1][0]
        
        # Concatenate all new PCM samples
        new_samples_list = [np.frombuffer(pcm_bytes, dtype=np.float32) for _, pcm_bytes in chunks]
        new_samples = np.concatenate(new_samples_list)
        audio_buffer = np.concatenate((audio_buffer, new_samples))
        
        buffer_duration = len(audio_buffer) / sample_rate
        
        try:
            t0 = time.time()
            inference_start = int(t0 * 1000)
            
            # Transcribe current audio buffer
            # We use Silero VAD to detect segments
            segments, info = model.transcribe(
                audio_buffer,
                beam_size=5,
                temperature=0.0,
                vad_filter=True,
                vad_parameters=dict(min_silence_duration_ms=800),
                condition_on_previous_text=False
            )
            
            segments_list = list(segments)
            t1 = time.time()
            inference_finish = int(t1 * 1000)
            inference_duration_ms = int((t1 - t0) * 1000)
            
            # Attach inference timestamps to metadata
            latest_meta['inference_starts'] = inference_start
            latest_meta['inference_finishes'] = inference_finish
            
            # Determine which segments are final
            final_segments = []
            interim_segments = []
            
            for seg in segments_list:
                # Forced finalization: if buffer is > 15s, finalize everything ending before the last 4s
                is_forced_final = buffer_duration > 15.0 and seg.end < (buffer_duration - 4.0)
                # Silence gap finalization: standard pause gap
                is_silence_final = (buffer_duration - seg.end) > 1.2
                
                if is_forced_final or is_silence_final:
                    final_segments.append(seg)
                else:
                    interim_segments.append(seg)
            
            # Finalized text
            if final_segments:
                final_text = " ".join([s.text for s in final_segments]).strip()
                last_final_end_sec = final_segments[-1].end
                
                if final_text:
                    print(json.dumps({
                        "type": "final",
                        "text": final_text,
                        "duration_ms": inference_duration_ms,
                        "metadata": latest_meta
                    }), flush=True)
                
                # Trim the finalized audio from the buffer
                samples_to_discard = int(last_final_end_sec * sample_rate)
                audio_buffer = audio_buffer[samples_to_discard:]
            
            # Yield interim text for the remaining active window
            interim_text = " ".join([s.text for s in interim_segments]).strip()
            print(json.dumps({
                "type": "interim",
                "text": interim_text,
                "metadata": latest_meta
            }), flush=True)
            
        except Exception as e:
            print(json.dumps({
                "type": "error",
                "message": str(e)
            }), flush=True)

if __name__ == "__main__":
    main()
