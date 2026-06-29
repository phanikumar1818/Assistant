const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');

// Configuration
const WHISPER_ZIP_URL = 'https://github.com/ggml-org/whisper.cpp/releases/download/v1.9.1/whisper-blas-bin-x64.zip';
const WHISPER_MODEL_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin';
const TESSERACT_DATA_URL = 'https://github.com/tesseract-ocr/tessdata/raw/main/eng.traineddata';

const ROOT_DIR = path.resolve(__dirname, '..');
const BIN_DIR = path.join(ROOT_DIR, 'bin', 'Release');
const MODELS_DIR = path.join(ROOT_DIR, 'models');

// Colors for terminal output
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  bold: '\x1b[1m'
};

console.log(`${colors.bold}${colors.cyan}===================================================${colors.reset}`);
console.log(`${colors.bold}${colors.cyan}             Vysper Project Setup Helper            ${colors.reset}`);
console.log(`${colors.bold}${colors.cyan}===================================================${colors.reset}\n`);

// Helper: Download file with redirect support and progress tracking
function downloadFile(urlStr, destPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    
    function get(url) {
      https.get(url, (response) => {
        if (response.statusCode === 301 || response.statusCode === 302) {
          // Follow redirect
          const redirectUrl = response.headers.location;
          get(redirectUrl);
          return;
        }
        
        if (response.statusCode !== 200) {
          file.close();
          fs.unlink(destPath, () => {});
          reject(new Error(`Failed to download: Status Code ${response.statusCode} for ${url}`));
          return;
        }
        
        const totalSize = parseInt(response.headers['content-length'], 10);
        let downloaded = 0;
        let lastReported = 0;
        
        response.on('data', (chunk) => {
          downloaded += chunk.length;
          const percent = totalSize ? Math.round((downloaded / totalSize) * 100) : 0;
          if (percent - lastReported >= 5 || percent === 100) {
            process.stdout.write(`\rDownloading ${path.basename(destPath)}... ${percent}% (${(downloaded / 1024 / 1024).toFixed(1)} MB)`);
            lastReported = percent;
          }
        });
        
        response.pipe(file);
        
        file.on('finish', () => {
          file.close(() => {
            console.log(`\n${colors.green}✓ Finished downloading ${path.basename(destPath)}${colors.reset}`);
            resolve();
          });
        });
      }).on('error', (err) => {
        file.close();
        fs.unlink(destPath, () => {});
        reject(err);
      });
    }
    
    get(urlStr);
  });
}

// 1. Setup Environment Configuration (.env)
function setupEnvironment() {
  const envPath = path.join(ROOT_DIR, '.env');
  const envExamplePath = path.join(ROOT_DIR, 'env.example');
  
  console.log(`${colors.bold}🔐 Step 1: Configuring Environment Variables...${colors.reset}`);
  if (!fs.existsSync(envPath)) {
    if (fs.existsSync(envExamplePath)) {
      fs.copyFileSync(envExamplePath, envPath);
      console.log(`  ${colors.green}✓ Created .env file from env.example${colors.reset}`);
      console.log(`  ${colors.yellow}⚠️ Please edit the newly created .env file and add your GEMINI_API_KEY!${colors.reset}`);
    } else {
      console.log(`  ${colors.red}✗ env.example template not found. Please create a .env file manually.${colors.reset}`);
    }
  } else {
    console.log(`  ${colors.green}✓ .env file already exists.${colors.reset}`);
  }
  console.log();
}

// 2. Download and Setup OCR Data
async function setupOcrData() {
  const destPath = path.join(ROOT_DIR, 'eng.traineddata');
  console.log(`${colors.bold}📁 Step 2: Checking OCR Language Data...${colors.reset}`);
  
  if (fs.existsSync(destPath)) {
    console.log(`  ${colors.green}✓ eng.traineddata already exists.${colors.reset}`);
  } else {
    console.log(`  ${colors.blue}ℹ eng.traineddata is missing. Downloading (approx. 5 MB)...${colors.reset}`);
    try {
      await downloadFile(TESSERACT_DATA_URL, destPath);
    } catch (err) {
      console.error(`  ${colors.red}✗ Failed to download OCR language data: ${err.message}${colors.reset}`);
      throw err;
    }
  }
  console.log();
}

// 3. Download and Setup Whisper Model
async function setupWhisperModel() {
  const modelPath = path.join(MODELS_DIR, 'ggml-base.en.bin');
  console.log(`${colors.bold}🎙️ Step 3: Checking Whisper.cpp Model File...${colors.reset}`);
  
  if (!fs.existsSync(MODELS_DIR)) {
    fs.mkdirSync(MODELS_DIR, { recursive: true });
  }
  
  if (fs.existsSync(modelPath)) {
    console.log(`  ${colors.green}✓ ggml-base.en.bin model file already exists.${colors.reset}`);
  } else {
    console.log(`  ${colors.blue}ℹ Whisper model (ggml-base.en.bin) is missing. Downloading (approx. 141 MB)...${colors.reset}`);
    try {
      await downloadFile(WHISPER_MODEL_URL, modelPath);
    } catch (err) {
      console.error(`  ${colors.red}✗ Failed to download Whisper model: ${err.message}${colors.reset}`);
      throw err;
    }
  }
  console.log();
}

// 4. Download and Extract Whisper Binaries
async function setupWhisperBinaries() {
  const cliExePath = path.join(BIN_DIR, 'whisper-cli.exe');
  const serverExePath = path.join(BIN_DIR, 'whisper-server.exe');
  const tempZipPath = path.join(ROOT_DIR, 'whisper-binaries-temp.zip');
  
  console.log(`${colors.bold}🔧 Step 4: Checking Whisper.cpp Native Binaries...${colors.reset}`);
  
  if (!fs.existsSync(BIN_DIR)) {
    fs.mkdirSync(BIN_DIR, { recursive: true });
  }
  
  if (fs.existsSync(cliExePath) && fs.existsSync(serverExePath)) {
    console.log(`  ${colors.green}✓ Whisper.cpp binaries already exist in bin/Release/ (${process.platform})${colors.reset}`);
  } else {
    if (process.platform !== 'win32') {
      console.log(`  ${colors.yellow}⚠️ Non-Windows platform detected (${process.platform}).${colors.reset}`);
      console.log(`  Precompiled binaries are provided for Windows.`);
      console.log(`  For macOS or Linux, please install whisper.cpp manually and ensure`);
      console.log(`  whisper-cli and whisper-server are available or modify config paths.`);
      console.log();
      return;
    }
    
    console.log(`  ${colors.blue}ℹ Whisper.cpp Windows binaries are missing. Downloading precompiled package (approx. 7 MB)...${colors.reset}`);
    try {
      await downloadFile(WHISPER_ZIP_URL, tempZipPath);
      
      console.log(`  Extracting binaries to bin/Release/...`);
      const absoluteZip = path.resolve(tempZipPath);
      const absoluteDest = path.resolve(BIN_DIR);
      
      execSync(`powershell -Command "Expand-Archive -Path '${absoluteZip}' -DestinationPath '${absoluteDest}' -Force"`, { stdio: 'inherit' });
      
      // Cleanup zip
      if (fs.existsSync(tempZipPath)) {
        fs.unlinkSync(tempZipPath);
      }
      console.log(`  ${colors.green}✓ Successfully downloaded and extracted Whisper.cpp binaries.${colors.reset}`);
    } catch (err) {
      console.error(`  ${colors.red}✗ Failed to download/extract Whisper binaries: ${err.message}${colors.reset}`);
      if (fs.existsSync(tempZipPath)) {
        try { fs.unlinkSync(tempZipPath); } catch (_) {}
      }
      throw err;
    }
  }
  console.log();
}

async function main() {
  try {
    setupEnvironment();
    await setupOcrData();
    await setupWhisperModel();
    await setupWhisperBinaries();
    
    console.log(`${colors.bold}${colors.green}===================================================${colors.reset}`);
    console.log(`${colors.bold}${colors.green}          Vysper Setup Completed Successfully!      ${colors.reset}`);
    console.log(`${colors.bold}${colors.green}===================================================${colors.reset}`);
    console.log(`\nNext Steps:`);
    console.log(`1. Add your Gemini API Key in the \`.env\` file.`);
    console.log(`2. Run \`npm start\` or \`npm run dev\` to launch Vysper.`);
    console.log(`3. Optional: Verify setup by running \`npm run setup:check\`\n`);
  } catch (err) {
    console.error(`\n${colors.bold}${colors.red}❌ Setup failed: ${err.message}${colors.reset}\n`);
    process.exit(1);
  }
}

main();
