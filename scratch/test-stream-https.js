require('dotenv').config();
const https = require('https');
const { URL } = require('url');

async function testStream() {
  const apiKey = process.env.GEMINI_API_KEY;
  const model = 'gemini-2.5-flash';
  const urlStr = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?key=${apiKey}&alt=sse`;
  
  const geminiRequest = {
    contents: [
      {
        role: 'user',
        parts: [{ text: 'Write a short 3 sentence poem.' }]
      }
    ],
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 1024
    }
  };
  
  const postData = JSON.stringify(geminiRequest);
  const parsedUrl = new URL(urlStr);
  
  const options = {
    hostname: parsedUrl.hostname,
    port: 443,
    path: parsedUrl.pathname + parsedUrl.search,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(postData)
    }
  };
  
  console.log('Sending https streaming request to', model);
  
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      console.log('Status code:', res.statusCode);
      
      let buffer = '';
      
      res.on('data', (chunk) => {
        buffer += chunk.toString();
        // Process line by line
        let lines = buffer.split('\n');
        // Keep the last partial line in the buffer
        buffer = lines.pop();
        
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.startsWith('data: ')) {
            try {
              const jsonStr = trimmed.substring(6);
              const dataObj = JSON.parse(jsonStr);
              if (dataObj.candidates && dataObj.candidates[0] && dataObj.candidates[0].content) {
                const text = dataObj.candidates[0].content.parts[0].text;
                if (text) {
                  process.stdout.write(text);
                }
              }
            } catch (err) {
              console.error('\nError parsing SSE line:', err.message, 'Line:', trimmed);
            }
          }
        }
      });
      
      res.on('end', () => {
        // Process any remaining buffer
        if (buffer.trim().startsWith('data: ')) {
          try {
            const jsonStr = buffer.trim().substring(6);
            const dataObj = JSON.parse(jsonStr);
            if (dataObj.candidates && dataObj.candidates[0] && dataObj.candidates[0].content) {
              const text = dataObj.candidates[0].content.parts[0].text;
              if (text) {
                process.stdout.write(text);
              }
            }
          } catch (err) {
            // End of stream might have half-lines, ignore
          }
        }
        console.log('\n--- Stream finished ---');
        resolve();
      });
    });
    
    req.on('error', (err) => {
      console.error('Request error:', err);
      reject(err);
    });
    
    req.write(postData);
    req.end();
  });
}

testStream();
