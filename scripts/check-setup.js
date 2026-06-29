#!/usr/bin/env node
/**
 * Vysper Setup Checker
 * Validates that all required dependencies and configurations are in place
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  bold: '\x1b[1m'
};

const CHECK = colors.green + '✓' + colors.reset;
const CROSS = colors.red + '✗' + colors.reset;
const WARN = colors.yellow + '⚠' + colors.reset;
const INFO = colors.blue + 'ℹ' + colors.reset;

console.log(colors.bold + colors.cyan + '\n╔══════════════════════════════════════╗' + colors.reset);
console.log(colors.bold + colors.cyan + '║     Vysper Setup Checker v1.0        ║' + colors.reset);
console.log(colors.bold + colors.cyan + '╚══════════════════════════════════════╝\n' + colors.reset);

let errors = 0;
let warnings = 0;

// Check Node.js version
function checkNodeVersion() {
  console.log(colors.bold + '📦 Node.js Environment' + colors.reset);
  const nodeVersion = process.version;
  const majorVersion = parseInt(nodeVersion.slice(1).split('.')[0]);
  
  if (majorVersion >= 18) {
    console.log(`  ${CHECK} Node.js ${nodeVersion} (required: >=18.0.0)`);
  } else {
    console.log(`  ${CROSS} Node.js ${nodeVersion} - Please upgrade to Node.js 18 or higher`);
    errors++;
  }
  console.log();
}

// Check npm modules
function checkNpmModules() {
  console.log(colors.bold + '📚 NPM Dependencies' + colors.reset);
  const nodeModulesPath = path.join(__dirname, '..', 'node_modules');
  
  if (fs.existsSync(nodeModulesPath)) {
    console.log(`  ${CHECK} node_modules directory exists`);
    
    const requiredModules = [
      '@google/generative-ai',
      'electron',
      'dotenv',
      'tesseract.js',
      'microsoft-cognitiveservices-speech-sdk',
      'winston'
    ];
    
    for (const mod of requiredModules) {
      const modPath = path.join(nodeModulesPath, mod);
      if (fs.existsSync(modPath)) {
        console.log(`  ${CHECK} ${mod}`);
      } else {
        console.log(`  ${CROSS} ${mod} - run 'npm install'`);
        errors++;
      }
    }
  } else {
    console.log(`  ${CROSS} node_modules not found - run 'npm install'`);
    errors++;
  }
  console.log();
}

// Check environment configuration
function checkEnvConfig() {
  console.log(colors.bold + '🔐 Environment Configuration' + colors.reset);
  const envPath = path.join(__dirname, '..', '.env');
  const envExamplePath = path.join(__dirname, '..', 'env.example');
  
  if (fs.existsSync(envPath)) {
    console.log(`  ${CHECK} .env file exists`);
    
    // Check for required variables
    require('dotenv').config({ path: envPath });
    
    if (process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== 'your_gemini_api_key_here') {
      console.log(`  ${CHECK} GEMINI_API_KEY is configured`);
    } else {
      console.log(`  ${CROSS} GEMINI_API_KEY not set - Required for AI features`);
      errors++;
    }
    
    if (process.env.AZURE_SPEECH_KEY && process.env.AZURE_SPEECH_KEY !== 'your_azure_speech_key_here') {
      console.log(`  ${CHECK} AZURE_SPEECH_KEY is configured`);
    } else {
      console.log(`  ${WARN} AZURE_SPEECH_KEY not set - Voice input disabled`);
      warnings++;
    }
    
    if (process.env.AZURE_SPEECH_REGION) {
      console.log(`  ${CHECK} AZURE_SPEECH_REGION: ${process.env.AZURE_SPEECH_REGION}`);
    } else if (process.env.AZURE_SPEECH_KEY) {
      console.log(`  ${WARN} AZURE_SPEECH_REGION not set - Required for Azure Speech`);
      warnings++;
    }
  } else {
    console.log(`  ${CROSS} .env file not found`);
    console.log(`  ${INFO} Copy env.example to .env and configure your API keys`);
    errors++;
  }
  console.log();
}

// Check external tools
function checkExternalTools() {
  console.log(colors.bold + '🔧 External Tools (Optional)' + colors.reset);
  
  // Check for SoX (audio recording)
  try {
    if (process.platform === 'win32') {
      execSync('where sox', { stdio: 'pipe' });
    } else {
      execSync('which sox', { stdio: 'pipe' });
    }
    console.log(`  ${CHECK} SoX audio tool is installed`);
  } catch {
    console.log(`  ${WARN} SoX not found - Voice recording may not work`);
    console.log(`      Install: ${getSoxInstallCommand()}`);
    warnings++;
  }
  
  // Note: Tesseract.js doesn't require external installation
  console.log(`  ${CHECK} Tesseract.js (bundled - no external installation needed)`);
  console.log();
}

function getSoxInstallCommand() {
  switch (process.platform) {
    case 'darwin':
      return 'brew install sox';
    case 'linux':
      return 'sudo apt-get install sox';
    case 'win32':
      return 'Download from https://sourceforge.net/projects/sox/ or use: choco install sox';
    default:
      return 'See https://sox.sourceforge.net/';
  }
}

// Check project files
function checkProjectFiles() {
  console.log(colors.bold + '📁 Project Files' + colors.reset);
  
  const requiredFiles = [
    'main.js',
    'preload.js',
    'index.html',
    'chat.html',
    'settings.html',
    'llm-response.html',
    'package.json'
  ];
  
  const requiredDirs = [
    'src',
    'prompts',
    'assests'
  ];
  
  const projectRoot = path.join(__dirname, '..');
  
  for (const file of requiredFiles) {
    if (fs.existsSync(path.join(projectRoot, file))) {
      console.log(`  ${CHECK} ${file}`);
    } else {
      console.log(`  ${CROSS} ${file} not found`);
      errors++;
    }
  }
  
  for (const dir of requiredDirs) {
    if (fs.existsSync(path.join(projectRoot, dir))) {
      console.log(`  ${CHECK} ${dir}/`);
    } else {
      console.log(`  ${CROSS} ${dir}/ not found`);
      errors++;
    }
  }
  console.log();
}

// Check external models and binaries
function checkExternalAssets() {
  console.log(colors.bold + '🎙️ Whisper and OCR Assets (Local models & binaries)' + colors.reset);
  const projectRoot = path.join(__dirname, '..');
  
  const assets = [
    { path: 'eng.traineddata', type: 'file', desc: 'OCR language data' },
    { path: 'models/ggml-base.en.bin', type: 'file', desc: 'Whisper GGML model' },
    { path: 'bin/Release/whisper-cli.exe', type: 'file', desc: 'Whisper CLI executable', winOnly: true },
    { path: 'bin/Release/whisper-server.exe', type: 'file', desc: 'Whisper Server sidecar', winOnly: true }
  ];
  
  for (const asset of assets) {
    if (asset.winOnly && process.platform !== 'win32') {
      continue; // Skip Windows executables checks on macOS/Linux
    }
    
    const assetPath = path.join(projectRoot, asset.path);
    if (fs.existsSync(assetPath)) {
      console.log(`  ${CHECK} ${asset.path} (${asset.desc})`);
    } else {
      console.log(`  ${CROSS} ${asset.path} - ${asset.desc} is missing!`);
      console.log(`      ${colors.blue}ℹ${colors.reset} Run 'npm run setup:binaries' to automatically download and configure this.`);
      errors++;
    }
  }
  console.log();
}

// Run all checks
checkNodeVersion();
checkNpmModules();
checkEnvConfig();
checkExternalTools();
checkExternalAssets();
checkProjectFiles();

// Summary
console.log(colors.bold + '═══════════════════════════════════════' + colors.reset);
if (errors === 0 && warnings === 0) {
  console.log(colors.green + colors.bold + '\n🎉 All checks passed! You\'re ready to go.' + colors.reset);
  console.log('   Run: npm start\n');
} else if (errors === 0) {
  console.log(colors.yellow + colors.bold + `\n⚠️  Setup complete with ${warnings} warning(s)` + colors.reset);
  console.log('   The app will work, but some features may be limited.');
  console.log('   Run: npm start\n');
} else {
  console.log(colors.red + colors.bold + `\n❌ Setup incomplete: ${errors} error(s), ${warnings} warning(s)` + colors.reset);
  console.log('   Please fix the errors above before running the app.\n');
}

process.exit(errors > 0 ? 1 : 0);

