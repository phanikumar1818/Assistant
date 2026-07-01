require('dotenv').config();
const llmService = require('../src/services/llm.service');
const logger = require('../src/core/logger').createServiceLogger("TEST");

async function run() {
  console.log("Initializing LLM service...");
  
  console.log("Sending prompt to processTextWithSkill with streaming...");
  try {
    let chunkCount = 0;
    const result = await llmService.processTextWithSkill(
      "Write a short haiku about computers.",
      "programming",
      [],
      "javascript",
      (chunk) => {
        chunkCount++;
        process.stdout.write(chunk);
      }
    );
    
    console.log("\n\nStream complete!");
    console.log(`Chunks received: ${chunkCount}`);
    console.log("Metadata:", result.metadata);
    console.log("Response:", result.response);
  } catch (error) {
    console.error("Test failed:", error);
  }
}

run();
