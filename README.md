<p align="center">
  <img src="https://github.com/user-attachments/assets/186d5458-7e8b-406a-9adc-ce755256298c" 
       alt="Group 14" 
       width="300" 
       style="padding: 10px; border-radius: 8px;"/>
</p>

# Vysper

**Professional Interview Assistant with Invisible Screen Overlay**

An AI-powered desktop tool that helps you excel in technical and professional interviews by providing intelligent, real-time assistance while remaining completely invisible to screen sharing and recording software.

### Demo
https://github.com/user-attachments/assets/c5616482-3652-4686-b87b-e04d06572d2f

---

## ⚡ Super Quick Start (3 Commands!)

```bash
# 1. Install packages
npm install

# 2. Copy and edit config (add your Gemini API key)
# Windows: copy env.example .env
# Mac/Linux: cp env.example .env

# 3. Run!
npm start
```

**Get your free Gemini API key:** https://aistudio.google.com/app/apikey

📖 **[Full Setup Guide →](SETUP.md)** | 🔍 **Run `npm run setup:check` to verify your setup**

---

## Perfect for Interviews
**Completely Stealth** - Invisible to Zoom, Teams, Meet, and all screen sharing tools
**Real-time AI Assistance** - Instant help with coding problems, system design, and interview questions
**Professional Skills** - Specialized modes for different interview types

### Supported Interview Skills
- **DSA (Data Structures & Algorithms)** - Complete solutions with complexity analysis
- **System Design** - Architecture patterns and scalability approaches  
- **Programming** - Multi-language coding assistance and best practices
- **Behavioral** - STAR method responses and professional scenarios
- **Sales** - Frameworks, objection handling, and closing techniques
- **Negotiation** - Strategic approaches and persuasion tactics
- **Presentation** - Structure, delivery tips, and visual design
- **DevOps** - Infrastructure, CI/CD, and deployment strategies
- **Data Science** - Analytics, ML approaches, and statistical methods

## 🚀 Installation

### Prerequisites
- **Node.js 18+** - [Download here](https://nodejs.org/)
- **Git** - [Download here](https://git-scm.com/)

### Quick Install
```bash
git clone <repository-url>
cd Vysper
npm install
npm start
```

### 🔑 Configuration

Copy `env.example` to `.env` and add your API key:

```bash
# Required - Get from https://aistudio.google.com/app/apikey
GEMINI_API_KEY=your_gemini_api_key

# Optional - For voice input (Azure Speech)
AZURE_SPEECH_KEY=your_azure_speech_key
AZURE_SPEECH_REGION=eastus
```

📢 **🎓 Students:** Get $100 free Azure credits + 5 hours free speech-to-text!

### 🏗️ Building Distributable Apps

```bash
npm run build          # Current platform
npm run build:win      # Windows (.exe)
npm run build:mac      # macOS (.dmg)
npm run build:linux    # Linux (.AppImage, .deb)
npm run build:all      # All platforms
```

**Built apps appear in `dist/` folder**

## ⌨️ Essential Shortcuts

### Core Functions
| Shortcut | Action |
|----------|--------|
| `Cmd + Shift + S` | Screenshot + AI Analysis |
| `Alt/Option + R` | Voice Recording Toggle |
| `Cmd + Shift + \` | Show/Hide All Windows |
| `Alt + A` | Toggle Interactive Mode |

### Navigation
| Shortcut | Action |
|----------|--------|
| `Cmd + Shift + C` | Chat Window |
| `Cmd + Arrow Up/Down` | Skills Selection (only if Interactive mode is on) |
| `Cmd + ,` | Settings |

### Session Management
| Shortcut | Action |
|----------|--------|
| `Cmd+Shift+\` | Clear Session Memory |

### Important Interaction Usage Tip 
* Enable **Interaction Mode** to scroll, click, or select inside windows.
* Use `Cmd+Up/Down` (in Interaction Mode) to switch skills quickly.
* Click thorugh screen works only when interaction mode is disabled
* In **Stealth Mode**, windows are invisible to screen share & mouse.

## 🔧 Key Features

### Stealth Technology
- **Invisible to Screen Sharing** - Completely hidden from Zoom, Teams, Meet
- **Process Disguise** - Appears as "Vysper" in system monitors
- **Click-through Mode** - Windows become transparent to mouse clicks
- **No Screen Recording Detection** - Undetectable by recording software

### AI-Powered Analysis
- **Screenshot OCR** - Extract and analyze text from any screen content
- **Voice Commands** - Speak questions and get instant AI responses
- **Context-Aware** - Remembers conversation history for better responses
- **Multi-Format Output** - Clean text and code blocks with syntax highlighting

### Interview-Specific Intelligence
- **Problem Recognition** - Automatically detects interview question types
- **Step-by-Step Solutions** - Detailed explanations with best practices
- **Code Examples** - Multi-language implementations with optimizations

## 💡 Pro Tips

### During Technical Interviews
1. **Position Windows**: Place Vysper windows in screen corners before sharing
2. **Use Voice Mode**: Whisper questions during "thinking time"
3. **Screenshot Problems**: Capture coding challenges for instant solutions
4. **Check Solutions**: Verify your approach with AI before implementing

### For System Design
1. **Capture Requirements**: Screenshot or voice record the problem statement
2. **Get Frameworks**: Ask for architectural patterns and trade-offs
3. **Verify Scalability**: Double-check your design decisions

### Behavioral Questions
1. **STAR Method**: Get structured response frameworks
2. **Industry Examples**: Request relevant scenarios for your field
3. **Follow-up Prep**: Prepare for common follow-up questions

## 📋 Requirements

| Component | Required? | Notes |
|-----------|-----------|-------|
| Node.js 18+ | ✅ Yes | [Download](https://nodejs.org/) |
| Gemini API Key | ✅ Yes | [Free API Key](https://aistudio.google.com/app/apikey) |
| SoX Audio | ⭕ Optional | For voice recording - `brew install sox` (Mac) |
| Azure Speech | ⭕ Optional | For voice input - [Azure Portal](https://portal.azure.com/)

**Note:** Tesseract OCR is bundled (no separate installation needed!)

## 🚀 Advanced Usage

### Session Memory
The app remembers your interview context across multiple questions:

## 🤝 Contributing

**Contribute to make Vysper the ultimate interview companion, not a cheating tool!**

### Priority Areas
- **New Interview Skills** - Add specialized domains (Finance, Marketing, etc.)
- **Language Support** - Expand beyond English for global users
- **Platform Extensions** - Windows and Linux compatibility
- **LLM Improvements** - Multiple LLM Model selections for the response
- **UI/UX Improvements** - Enhanced interface and user experience

### How to Contribute
1. **Fork the repository**
2. **Star the project** if you find it useful
3. **Report issues** for bugs or feature requests
4. **Submit pull requests** for improvements
5. **Improve documentation** and add examples
6. **Share your success stories**

⭐ **Star this repo** if Vysper helped you ace your interviews or you vibed with it!
