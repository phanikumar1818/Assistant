# 🚀 Vysper Setup Guide

This guide will get you up and running with Vysper in **under 5 minutes**.

---

## 📋 Requirements

| Requirement | Version | Notes |
|-------------|---------|-------|
| Node.js | 18.0.0+ | [Download here](https://nodejs.org/) |
| npm | 9.0.0+ | Comes with Node.js |
| Git | Any | [Download here](https://git-scm.com/) |

---

## ⚡ Quick Start (3 Simple Steps)

### Step 1: Clone and Run Automated Setup

This command installs dependencies, creates your `.env` configuration file, and automatically downloads the necessary native Whisper.cpp binaries, Whisper model (`ggml-base.en.bin`), and OCR language data:

```bash
# Clone the repository
git clone <repository-url>
cd Vysper

# Run the automated setup script
npm run setup
```

### Step 2: Configure Your API Key

Open the newly created `.env` file in the root of the project with any text editor and paste your Google Gemini API key:

```env
GEMINI_API_KEY=your_actual_gemini_api_key_here
```

> [!TIP]
> **Get a free Gemini API key:** Sign in with your Google account at [Google AI Studio](https://aistudio.google.com/app/apikey) and click **"Create API Key"**.

### Step 3: Run Vysper

To launch the application:

```bash
npm start
```

For development mode (with DevTools and additional logs):

```bash
npm run dev
```

That's it! 🎉

---

## 🔑 API Keys Setup

### Required: Google Gemini AI

1. Go to [Google AI Studio](https://aistudio.google.com/app/apikey)
2. Sign in with your Google account
3. Click **"Create API Key"**
4. Copy the key and add it to your `.env` file


## 🔧 Platform-Specific Setup

### Windows

```powershell
# 1. Install Node.js (version 18+) from https://nodejs.org/

# 2. Open PowerShell or Command Prompt and navigate to the project folder
cd path\to\Vysper

# 3. Run the automated project setup (installs npm modules and downloads native assets)
npm run setup

# 4. Open and edit the .env file with your API key
notepad .env

# 5. Run the application
npm start
```

**Optional: Install SoX for voice recording**
- Download from: https://sourceforge.net/projects/sox/
- Or use Chocolatey: `choco install sox`

### macOS

```bash
# 1. Install Node.js (if not installed)
brew install node

# 2. Install optional dependencies for voice recording
brew install sox

# 3. Navigate to project
cd path/to/Vysper

# 4. Install packages
npm install

# 5. Create and configure .env
cp env.example .env
nano .env  # or use any editor

# 6. Run
npm start
```

### Linux (Ubuntu/Debian)

```bash
# 1. Install Node.js
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# 2. Install optional dependencies for voice recording
sudo apt-get install sox

# 3. Navigate to project
cd path/to/Vysper

# 4. Install packages
npm install

# 5. Create and configure .env
cp env.example .env
nano .env

# 6. Run
npm start
```

---

## ✅ Verify Your Setup

Run the setup checker to verify everything is configured correctly:

```bash
npm run setup:check
```

This will check:
- ✓ Node.js version
- ✓ All npm packages installed
- ✓ Environment configuration
- ✓ External tools (SoX)
- ✓ Project files

---

## 🏗️ Building the App

Create distributable versions:

```bash
# Build for your current platform
npm run build

# Platform-specific builds
npm run build:win     # Windows (.exe)
npm run build:mac     # macOS (.dmg)
npm run build:linux   # Linux (.AppImage, .deb)

# Build for all platforms
npm run build:all
```

Built files will be in the `dist/` folder.

---

## 🛠️ Development

```bash
# Start in development mode (more logs)
npm run dev

# Start with Chrome DevTools
npm run dev:debug

# Clean build artifacts
npm run clean
```

---

## 📁 Project Structure

```
Vysper/
├── main.js              # Electron main process
├── preload.js           # Secure bridge between main and renderer
├── index.html           # Main window
├── chat.html            # Chat window
├── settings.html        # Settings window
├── llm-response.html    # AI response window
├── .env                 # Your configuration (create this!)
├── env.example          # Configuration template
├── package.json         # Dependencies and scripts
├── prompts/             # AI prompt templates
├── src/
│   ├── core/            # Core utilities (config, logger)
│   ├── services/        # Services (LLM, OCR, Speech)
│   ├── managers/        # Window and session management
│   └── ui/              # UI scripts
└── assests/             # Icons and images
```

---

## ❓ Troubleshooting

### "Gemini API key not configured"
- Make sure you created a `.env` file (not just `env.example`)
- Verify your API key is correct (no extra spaces)
- Restart the app after changing `.env`

### "npm install" fails
- Make sure you have Node.js 18+ installed: `node --version`
- Try clearing npm cache: `npm cache clean --force`
- Delete `node_modules` and `package-lock.json`, then reinstall

### "Voice recording not working"
- Install SoX (see platform-specific instructions above)
- On Windows, make sure SoX is in your PATH
- Check microphone permissions in your OS settings

### App window is invisible
- Press `Cmd+Shift+V` (Mac) or `Ctrl+Shift+V` (Win/Linux) to toggle visibility
- Press `Alt+A` to toggle interaction mode

### "Cannot find module" errors
```bash
# Reinstall all dependencies
rm -rf node_modules package-lock.json
npm install
```

---

## ⌨️ Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl/Cmd + Shift + S` | Screenshot + AI Analysis |
| `Alt + R` | Toggle Voice Recording |
| `Ctrl/Cmd + Shift + V` | Toggle Window Visibility |
| `Alt + A` | Toggle Interaction Mode |
| `Ctrl/Cmd + Shift + C` | Open Chat Window |
| `Ctrl/Cmd + ,` | Open Settings |
| `Ctrl/Cmd + Shift + \` | Clear Session Memory |

---

## 📞 Need Help?

1. Run setup checker: `npm run setup:check`
2. Check the logs: `~/.Vysper/logs/`
3. Create an issue on GitHub

---

Happy interviewing! 🎯

