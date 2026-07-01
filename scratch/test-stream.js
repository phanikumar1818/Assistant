require('dotenv').config();
const { GoogleGenerativeAI } = require('@google/generative-ai');

async function test() {
  const apiKey = process.env.GEMINI_API_KEY;
  console.log('API Key:', apiKey ? apiKey.substring(0, 10) + '...' : 'NONE');
  
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
  
  try {
    console.log('Sending streaming request...');
    const result = await model.generateContentStream({
      contents: [{ role: 'user', parts: [{ text: 'Hello, write a short 3 sentence poem.' }] }],
    });
    
    for await (const chunk of result.stream) {
      process.stdout.write(chunk.text());
    }
    console.log('\nStream finished successfully!');
  } catch (error) {
    console.error('Error during streaming:', error);
  }
}

test();
