# 🎤 Vysper Meeting Audio Architecture & Flow

This document provides a detailed, end-to-end breakdown of how Vysper captures meeting/microphone audio, transcribes it, and utilizes it to generate intelligent LLM responses.

---

## 📌 Architectural Overview

Vysper utilizes a hybrid, high-fidelity capture and transcription model designed to operate stealthily on Windows environments. The system combines:
1. **Web Audio API mixing** of system loopback (meeting) audio and local microphone input.
2. **Browser-native Web Speech API** as the primary, real-time, zero-latency transcription engine.
3. **Google Gemini Generative AI** as a fallback transcription engine to analyze raw audio buffers when local speech recognition lacks context or is silent.
4. **Context-Aware LLM Processing** leveraging active user skills and conversation history to format optimal interview answers.

```mermaid
graph TD
    %% Audio Capture Phase
    subgraph Audio Capture & Mixing (Renderer)
        A1[System Display Stream <br> getDisplayMedia] -->|Audio Track| AMix[Web Audio API <br> AudioContext Mix]
        A2[Microphone Stream <br> getUserMedia] -->|Audio Track| AMix
        AMix -->|Mixed MediaStream| MR[MediaRecorder <br> WebM / OGG]
        MR -->|2s Chunks| MC[mixedChunks Buffer]
    end

    %% Transcription Phase
    subgraph Real-Time Transcription
        A2 -->|Local Mic| WS[WebSpeech API <br> SpeechRecognition]
        WS -->|Utterance Event| TB[MeetingTranscriptBuffer]
    end

    %% User Interaction Phase
    subgraph Answer Trigger & Processing
        UI[User Presses Enter / Send] -->|Triggers| AP[prepareAnswerPayload]
        TB -->|Has Transcript?| AP
        
        %% Fallback Path
        AP -->|No Web Speech Text| SNAP[_snapshotAudioForTranscription]
        MC -->|Compile Blobs| SNAP
        SNAP -->|base64Audio| IPC1[IPC: transcribe-audio]
        IPC1 -->|Gemini API| G1[Gemini Audio Transcription]
        G1 -->|Transcribed Text| TB
        
        %% Payload Assembly
        AP -->|Assemble Payload| PAY[Payload: Manual Text + Transcript]
        PAY -->|IPC: send-chat-message| IPC2[IPC: send-chat-message]
    end

    %% LLM Response Phase
    subgraph LLM Intelligence (Main Process)
        IPC2 -->|Add to History| SM[SessionManager]
        IPC2 -->|Process| LLM[LLM Service]
        SM -->|Context + History| LLM
        LLM -->|System Instruction + History| G2[Gemini API]
        G2 -->|Broadcast Response| BC[Renderer Response Window]
    end
    
    style Real-Time Transcription fill:#e1f5fe,stroke:#03a9f4,stroke-width:2px;
    style Audio Capture & Mixing (Renderer) fill:#efebe9,stroke:#8d6e63,stroke-width:2px;
    style Answer Trigger & Processing fill:#e8f5e9,stroke:#4caf50,stroke-width:2px;
    style LLM Intelligence (Main Process) fill:#f3e5f5,stroke:#9c27b0,stroke-width:2px;
```

---

## 🛠️ Step-by-Step Flow

### 1. Audio Stream Acquisition & Mixing
The continuous listening session is managed in the renderer process by the `ContinuousListeningManager` within [`src/ui/meeting-listening.js`](file:///d:/Phani/Tools/Playground/Vysper/Assistant/src/ui/meeting-listening.js).

*   **System Loopback (Meeting) Capture:**
    The application requests display media using:
    ```javascript
    this.displayStream = await navigator.mediaDevices.getDisplayMedia({
      video: { width: 640, height: 360, frameRate: 5 },
      audio: true
    });
    ```
    > [!IMPORTANT]
    > **Windows Stealth Constraint:** Under Windows, stopping the video track of a display stream immediately terminates the associated loopback audio capture. To circumvent this, the system disables the video track (`track.enabled = false`) rather than calling `track.stop()`. This keeps the loopback audio channel alive while hiding visual capture.
    
*   **Microphone Capture:**
    Local voice input is requested simultaneously:
    ```javascript
    this.micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: true, sampleRate: 48000 }
    });
    ```
*   **Stream Mixing (Web Audio API):**
    To capture both system audio (what is said in the meeting) and microphone input (what the user says), the two streams are mixed via `AudioContext`:
    ```javascript
    const audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const destination = audioContext.createMediaStreamDestination();
    
    const systemSource = audioContext.createMediaStreamSource(this.systemStream);
    systemSource.connect(destination);
    
    const micSource = audioContext.createMediaStreamSource(this.micStream);
    micSource.connect(destination);
    
    this.mixedStream = destination.stream;
    ```
*   **Media Recording Buffer:**
    The mixed stream is continuously written to a temporary buffer of raw audio chunks (`mixedChunks`) every `2000ms` using `MediaRecorder` configured with supported codecs (`audio/webm;codecs=opus`, `audio/webm`, or `audio/ogg;codecs=opus`).

---

### 2. Primary Transcription Engine: Browser Web Speech API
While the raw audio is recorded into memory, the **native Web Speech API** acts as the primary transcriber.
The `WebSpeechTranscriptionService` in [`src/ui/web-speech_service.js`](file:///d:/Phani/Tools/Playground/Vysper/Assistant/src/ui/web-speech_service.js) initializes the browser speech recognition engine:

```javascript
this.recognition = new (window.SpeechRecognition || window.webkitSpeechRecognition)();
this.recognition.continuous = true;
this.recognition.interimResults = true;
```

*   **Transcription Delivery:**
    *   **Interim (Live Preview):** Fired in real-time as words are spoken. Handled via `onInterim` to display live feedback in the chat window.
    *   **Final (Utterance):** Fired when a speaker finishes a sentence. Appended to the `MeetingTranscriptBuffer` as a segment with `source: 'web-speech'` and synchronized with the main process.
*   **Resiliency & Auto-Restart:**
    The service runs a keep-alive loop. If the connection drops or speech recognition stops (e.g. on silence timeout), the `onend` callback auto-restarts the recognizer within 300ms as long as `shouldBeListening` is active.

---

### 3. Fallback Transcription: Gemini Audio Model
If the Web Speech transcript is empty when the user triggers an answer (e.g., due to API rate limits, language configurations, or OS permission constraints), the system automatically triggers a **Gemini Audio Transcription Fallback**:

1.  **Audio Snapshotting:**
    `ContinuousListeningManager._snapshotAudioForTranscription()` stops the active recording and compiles all collected chunks in `mixedChunks` into a single audio `Blob`.
2.  **IPC Request:**
    The Blob is converted to Base64 and sent to the main process via IPC:
    `whysperAPI.sendAudioForTranscription(base64Audio, options)` which triggers the `"transcribe-audio"` handler in [`main.js`](file:///d:/Phani/Tools/Playground/Vysper/Assistant/main.js).
3.  **Gemini Direct Audio Processing:**
    `LLMService.transcribeAudio()` inside [`src/services/llm.service.js`](file:///d:/Phani/Tools/Playground/Vysper/Assistant/src/services/llm.service.js) makes a direct HTTPS request to Google's Gemini endpoint utilizing the raw base64 data:
    ```json
    {
      "contents": [{
        "role": "user",
        "parts": [
          { "inlineData": { "mimeType": "audio/webm", "data": "base64..." } },
          { "text": "This is system audio captured from a live video call... Transcribe ALL audible speech..." }
        ]
      }]
    }
    ```
4.  **Integration:** The transcribed text returned by Gemini is sent back to the renderer and appended to the `MeetingTranscriptBuffer` as a segment of type `fallback-transcription`.

---

### 4. LLM Prompt Assembly & Execution
When the user submits a query (presses `Enter` or clicks Send), the full payload is processed:

1.  **Payload Generation:**
    `ContinuousListeningManager.prepareAnswerPayload(manualText)` builds the request text by combining what the user typed in the chat input (`manualText`) and the newly accumulated transcript text since the last response:
    ```javascript
    const parts = [manualText, newSinceLastAnswer].filter(Boolean);
    const payload = parts.join('\n\n').trim();
    ```
2.  **IPC Dispatch:**
    The assembled text is sent to the main process via IPC: `whysperAPI.sendChatMessage(textToSend)`.
3.  **Session & Context Assembly:**
    In `main.js`, the chat message is recorded in session history. Then, `processTranscriptionWithLLM()` is invoked. It checks the active skill (e.g., `dsa`, `system-design`, `programming`) and retrieves context:
    *   **Skill Instructions:** Loaded from [`prompt-loader.js`](file:///d:/Phani/Tools/Playground/Vysper/Assistant/prompt-loader.js) containing specific parameters for that skill.
    *   **Coding Language:** Injects the preferred language (e.g. `Java`, `Python`, `JavaScript`) if the active skill is code-related.
    *   **Conversation History:** Retrieves the last 8-10 conversation exchanges from `SessionManager` to maintain chat flow.
4.  **Intelligent Transcription Response:**
    `LLMService.processTranscriptionWithIntelligentResponse()` generates the final Gemini prompt. It wraps the context in an intelligent filter system instruction (`getIntelligentTranscriptionPrompt()`):
    *   **Concept / Topic Matches:** Generates an in-depth, structured explanation complete with code syntax, complexities, and potential follow-up questions.
    *   **Greetings / Non-Related Speech:** Returns a brief, polite greeting offering skill assistance to minimize clutter.
5.  **Execution & Delivery:**
    The final payload is executed via Electron's native `net` module POST request to Gemini's `generateContent` endpoint. The resulting response is:
    *   Stored in session memory.
    *   Broadcast back to the renderer windows (`transcription-llm-response`).
    *   Parsed into formatted Markdown and rendered in the AI Response Window.

---

## 🗄️ Legacy Component Note
*   **Azure Speech Integration (`src/services/speech.service.js`):**
     V1 of the project implemented continuous listening and transcription on the Node/Main process side utilizing the **Azure Speech SDK**.
     Although `speechService` is still required at the top of `main.js` for backwards compatibility, **it is entirely bypassed in the active version of Vysper**. All continuous transcription operations are now split between the frontend **Web Speech API** and the backend **Gemini Audio API**.

---

## 📊 Summary of IPC Events Involved

| IPC Channel | Source | Purpose |
|---|---|---|
| `toggle-continuous-listening` | Main $\rightarrow$ Renderer | Triggered by the global shortcut `Alt + R` to start/stop the capture. |
| `sync-meeting-transcript` | Renderer $\rightarrow$ Main | Periodically syncs the `MeetingTranscriptBuffer` to the main process. |
| `get-meeting-transcript` | Renderer $\rightarrow$ Main | Pulls the active transcript buffer data for verification. |
| `transcribe-audio` | Renderer $\rightarrow$ Main | Processes raw audio chunks through Gemini when Web Speech has no text. |
| `send-chat-message` | Renderer $\rightarrow$ Main | Sends the assembled manual + transcribed payload for LLM analysis. |
| `transcription-llm-response` | Main $\rightarrow$ Renderer | Delivers the generated response markdown back to the chat view. |
