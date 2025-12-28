const { GoogleGenerativeAI } = require('@google/generative-ai');
const logger = require('../core/logger').createServiceLogger('LLM');
const config = require('../core/config');
const { promptLoader } = require('../../prompt-loader');

class LLMService {
  constructor() {
    this.client = null;
    this.model = null;
    this.isInitialized = false;
    this.requestCount = 0;
    this.errorCount = 0;
    
    this.initializeClient();
  }

  initializeClient() {
    const apiKey = config.getApiKey('GEMINI');
    
    // Show partial key for debugging (first 8 chars + last 4 chars)
    const maskedKey = apiKey ? `${apiKey.substring(0, 8)}...${apiKey.substring(apiKey.length - 4)}` : 'NOT SET';
    
    if (!apiKey || apiKey === 'your-api-key-here') {
      logger.warn('Gemini API key not configured', { 
        keyExists: !!apiKey,
        isPlaceholder: apiKey === 'your-api-key-here',
        hint: 'Set GEMINI_API_KEY in your .env file'
      });
      return;
    }

    try {
      this.client = new GoogleGenerativeAI(apiKey);
      this.model = this.client.getGenerativeModel({ 
        model: config.get('llm.gemini.model') 
      });
      this.isInitialized = true;
      this.currentApiKeyPrefix = apiKey.substring(0, 8);
      
      logger.info('Gemini AI client initialized successfully', {
        model: config.get('llm.gemini.model'),
        apiKeyPreview: maskedKey
      });
    } catch (error) {
      logger.error('Failed to initialize Gemini client', { 
        error: error.message,
        apiKeyPreview: maskedKey
      });
    }
  }

  async processTextWithSkill(text, activeSkill, sessionMemory = [], programmingLanguage = null) {
    if (!this.isInitialized) {
      throw new Error('LLM service not initialized. Check Gemini API key configuration.');
    }

    const startTime = Date.now();
    this.requestCount++;
    
    try {
      logger.info('Processing text with LLM', {
        activeSkill,
        textLength: text.length,
        hasSessionMemory: sessionMemory.length > 0,
        programmingLanguage: programmingLanguage || 'not specified',
        requestId: this.requestCount
      });

      const geminiRequest = this.buildGeminiRequest(text, activeSkill, sessionMemory, programmingLanguage);
      
      // Use Electron net module directly (SDK's fetch fails in Electron)
      // This is much faster than waiting for SDK retries to fail
      let response;
      try {
        response = await this.executeAlternativeRequest(geminiRequest);
      } catch (altError) {
        // If alternative method fails, try SDK as fallback
        logger.warn('Alternative method failed, trying SDK', {
          error: altError.message,
          requestId: this.requestCount
        });
        response = await this.executeRequest(geminiRequest);
      }
      
      logger.logPerformance('LLM text processing', startTime, {
        activeSkill,
        textLength: text.length,
        responseLength: response.length,
        programmingLanguage: programmingLanguage || 'not specified',
        requestId: this.requestCount
      });

      return {
        response,
        metadata: {
          skill: activeSkill,
          programmingLanguage,
          processingTime: Date.now() - startTime,
          requestId: this.requestCount,
          usedFallback: false
        }
      };
    } catch (error) {
      this.errorCount++;
      logger.error('LLM processing failed', {
        error: error.message,
        activeSkill,
        programmingLanguage: programmingLanguage || 'not specified',
        requestId: this.requestCount
      });

      if (config.get('llm.gemini.fallbackEnabled')) {
        return this.generateFallbackResponse(text, activeSkill);
      }
      
      throw error;
    }
  }

  async processTranscriptionWithIntelligentResponse(text, activeSkill, sessionMemory = [], programmingLanguage = null) {
    if (!this.isInitialized) {
      throw new Error('LLM service not initialized. Check Gemini API key configuration.');
    }

    const startTime = Date.now();
    this.requestCount++;
    
    try {
      logger.info('Processing transcription with intelligent response', {
        activeSkill,
        textLength: text.length,
        hasSessionMemory: sessionMemory.length > 0,
        programmingLanguage: programmingLanguage || 'not specified',
        requestId: this.requestCount
      });

      const geminiRequest = this.buildIntelligentTranscriptionRequest(text, activeSkill, sessionMemory, programmingLanguage);
      
      // Use Electron net module directly (SDK's fetch fails in Electron)
      // This is much faster than waiting for SDK retries to fail
      let response;
      try {
        response = await this.executeAlternativeRequest(geminiRequest);
      } catch (altError) {
        // If alternative method fails, try SDK as fallback
        logger.warn('Alternative method failed, trying SDK', {
          error: altError.message,
          requestId: this.requestCount
        });
        response = await this.executeRequest(geminiRequest);
      }
      
      logger.logPerformance('LLM transcription processing', startTime, {
        activeSkill,
        textLength: text.length,
        responseLength: response.length,
        programmingLanguage: programmingLanguage || 'not specified',
        requestId: this.requestCount
      });

      return {
        response,
        metadata: {
          skill: activeSkill,
          programmingLanguage,
          processingTime: Date.now() - startTime,
          requestId: this.requestCount,
          usedFallback: false,
          isTranscriptionResponse: true
        }
      };
    } catch (error) {
      this.errorCount++;
      const errorAnalysis = this.analyzeError(error);
      
      logger.error('LLM transcription processing failed', {
        error: error.message,
        activeSkill,
        programmingLanguage: programmingLanguage || 'not specified',
        requestId: this.requestCount,
        errorType: errorAnalysis.type,
        suggestedAction: errorAnalysis.suggestedAction
      });

      if (config.get('llm.gemini.fallbackEnabled')) {
        return this.generateIntelligentFallbackResponse(text, activeSkill, errorAnalysis);
      }
      
      throw error;
    }
  }

  /**
   * Process screenshot with text prompt using Gemini's vision capabilities
   * @param {Object} imageData - Object containing base64 image and mimeType
   * @param {string} userPrompt - User's text prompt describing what they want
   * @param {string} activeSkill - Current active skill for context
   * @param {Array} sessionMemory - Session memory for context
   * @param {string|null} programmingLanguage - Optional programming language
   */
  async processScreenshotWithPrompt(imageData, userPrompt, activeSkill, sessionMemory = [], programmingLanguage = null) {
    if (!this.isInitialized) {
      throw new Error('LLM service not initialized. Check Gemini API key configuration.');
    }

    const startTime = Date.now();
    this.requestCount++;
    
    try {
      logger.info('Processing screenshot with user prompt', {
        activeSkill,
        promptLength: userPrompt.length,
        hasImage: !!imageData,
        imageSize: imageData?.base64?.length || 0,
        programmingLanguage: programmingLanguage || 'not specified',
        requestId: this.requestCount
      });

      const geminiRequest = this.buildVisionRequest(imageData, userPrompt, activeSkill, sessionMemory, programmingLanguage);
      
      let response;
      try {
        response = await this.executeAlternativeRequest(geminiRequest);
      } catch (altError) {
        logger.warn('Alternative method failed for vision request, trying SDK', {
          error: altError.message,
          requestId: this.requestCount
        });
        response = await this.executeRequest(geminiRequest);
      }
      
      logger.logPerformance('LLM vision processing', startTime, {
        activeSkill,
        promptLength: userPrompt.length,
        responseLength: response.length,
        programmingLanguage: programmingLanguage || 'not specified',
        requestId: this.requestCount
      });

      return {
        response,
        metadata: {
          skill: activeSkill,
          programmingLanguage,
          processingTime: Date.now() - startTime,
          requestId: this.requestCount,
          usedFallback: false,
          isVisionResponse: true
        }
      };
    } catch (error) {
      this.errorCount++;
      const errorAnalysis = this.analyzeError(error);
      
      logger.error('LLM vision processing failed', {
        error: error.message,
        activeSkill,
        programmingLanguage: programmingLanguage || 'not specified',
        requestId: this.requestCount,
        errorType: errorAnalysis.type,
        suggestedAction: errorAnalysis.suggestedAction
      });

      if (config.get('llm.gemini.fallbackEnabled')) {
        return this.generateVisionFallbackResponse(userPrompt, activeSkill, errorAnalysis);
      }
      
      throw error;
    }
  }

  /**
   * Build a vision request with image and text for Gemini
   */
  buildVisionRequest(imageData, userPrompt, activeSkill, sessionMemory, programmingLanguage) {
    const request = {
      contents: [],
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 4096, // Larger output for vision responses
        topK: 40,
        topP: 0.95
      }
    };

    // Build system instruction for vision analysis
    const systemPrompt = this.getVisionSystemPrompt(activeSkill, programmingLanguage);
    request.systemInstruction = {
      parts: [{ text: systemPrompt }]
    };

    // Add conversation history (text only) from session
    const sessionManager = require('../managers/session.manager');
    if (sessionManager && typeof sessionManager.getConversationHistory === 'function') {
      const conversationHistory = sessionManager.getConversationHistory(5);
      const conversationContents = conversationHistory
        .filter(event => event.role !== 'system' && event.content && event.content.trim().length > 0)
        .map(event => ({
          role: event.role === 'model' ? 'model' : 'user',
          parts: [{ text: event.content.trim() }]
        }));
      request.contents.push(...conversationContents);
    }

    // Add the current request with image and text
    const userParts = [];
    
    // Add image data
    if (imageData && imageData.base64) {
      userParts.push({
        inlineData: {
          mimeType: imageData.mimeType || 'image/png',
          data: imageData.base64
        }
      });
    }
    
    // Add user prompt
    userParts.push({ text: userPrompt || 'Please analyze this screenshot and provide helpful insights.' });
    
    request.contents.push({
      role: 'user',
      parts: userParts
    });

    logger.debug('Built vision request', {
      skill: activeSkill,
      programmingLanguage: programmingLanguage || 'not specified',
      hasImage: !!imageData?.base64,
      promptLength: userPrompt?.length || 0,
      totalContents: request.contents.length
    });

    return request;
  }

  /**
   * Get system prompt for vision analysis
   */
  getVisionSystemPrompt(activeSkill, programmingLanguage) {
    let prompt = `# Vision Analysis Assistant - ${activeSkill.toUpperCase()} Mode

You are an expert assistant analyzing screenshots to help the user. Your job is to understand the visual content and provide helpful, actionable responses.`;

    if (programmingLanguage) {
      prompt += `\n\nCODING CONTEXT: When providing code examples, use ${programmingLanguage.toUpperCase()}.`;
    }

    prompt += `

## Your Capabilities:
- Analyze screenshots of code, text, diagrams, UI designs, or any visual content
- Extract and explain text, code, or data visible in the image
- Identify problems, bugs, or issues shown in the image
- Provide solutions, explanations, or improvements based on what you see
- Answer questions about the visual content

## Response Guidelines:
1. First acknowledge what you see in the screenshot
2. Address the user's specific question or request
3. Provide detailed, actionable information
4. If you see code, analyze it for correctness and suggest improvements
5. If you see an error or problem, explain it and provide a solution
6. Use formatting (bullet points, code blocks) for clarity

## Skill Context: ${activeSkill.toUpperCase()}
Focus your analysis and responses in the context of ${activeSkill}. For example:
- If DSA: Focus on algorithms, data structures, complexity analysis
- If Programming: Focus on code quality, bugs, optimization
- If System Design: Focus on architecture, scalability, design patterns
- If Behavioral: Focus on scenarios, communication, soft skills

IMPORTANT: Be thorough but concise. Provide practical, immediately useful information.`;

    return prompt;
  }

  /**
   * Generate fallback response for vision requests
   */
  generateVisionFallbackResponse(userPrompt, activeSkill, errorAnalysis = null) {
    logger.info('Generating fallback response for vision request', { 
      activeSkill,
      errorType: errorAnalysis?.type 
    });

    if (errorAnalysis && errorAnalysis.isQuotaError) {
      return {
        response: `⚠️ API QUOTA EXCEEDED\n\nYour Gemini API key has hit its usage limit.\n\nTo fix this:\n1. Go to https://aistudio.google.com/app/apikey\n2. Create a NEW Google Cloud project\n3. Generate a new API key from that project\n4. Update GEMINI_API_KEY in your .env file\n5. Restart the app`,
        metadata: {
          skill: activeSkill,
          processingTime: 0,
          requestId: this.requestCount,
          usedFallback: true,
          isVisionResponse: true,
          errorType: 'QUOTA_EXCEEDED'
        }
      };
    }

    return {
      response: `I'm having trouble analyzing the screenshot right now. Please try again or check your internet connection and API key configuration.`,
      metadata: {
        skill: activeSkill,
        processingTime: 0,
        requestId: this.requestCount,
        usedFallback: true,
        isVisionResponse: true
      }
    };
  }

  buildGeminiRequest(text, activeSkill, sessionMemory, programmingLanguage) {
    // Check if we have the new conversation history format
    const sessionManager = require('../managers/session.manager');
    
    if (sessionManager && typeof sessionManager.getConversationHistory === 'function') {
      const conversationHistory = sessionManager.getConversationHistory(15);
      const skillContext = sessionManager.getSkillContext(activeSkill, programmingLanguage);
      return this.buildGeminiRequestWithHistory(text, activeSkill, conversationHistory, skillContext, programmingLanguage);
    }

    // Fallback to old method for compatibility - now with programming language support
    const requestComponents = promptLoader.getRequestComponents(
      activeSkill, 
      text, 
      sessionMemory,
      programmingLanguage
    );

    const request = {
      contents: [],
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 2048,
        topK: 40,
        topP: 0.95
      }
    };

    // Use the skill prompt that already has programming language injected
    if (requestComponents.shouldUseModelMemory && requestComponents.skillPrompt) {
      request.systemInstruction = {
        parts: [{ text: requestComponents.skillPrompt }]
      };
      
      logger.debug('Using language-enhanced system instruction for skill', {
        skill: activeSkill,
        programmingLanguage: programmingLanguage || 'not specified',
        promptLength: requestComponents.skillPrompt.length,
        requiresProgrammingLanguage: requestComponents.requiresProgrammingLanguage
      });
    }

    request.contents.push({
      role: 'user',
      parts: [{ text: this.formatUserMessage(text, activeSkill) }]
    });

    return request;
  }

  buildGeminiRequestWithHistory(text, activeSkill, conversationHistory, skillContext, programmingLanguage) {
    const request = {
      contents: [],
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 2048,
        topK: 40,
        topP: 0.95
      }
    };

    // Use the skill prompt from context (which may already include programming language)
    if (skillContext.skillPrompt) {
      request.systemInstruction = {
        parts: [{ text: skillContext.skillPrompt }]
      };
      
      logger.debug('Using skill context prompt as system instruction', {
        skill: activeSkill,
        programmingLanguage: programmingLanguage || 'not specified',
        promptLength: skillContext.skillPrompt.length,
        requiresProgrammingLanguage: skillContext.requiresProgrammingLanguage || false,
        hasLanguageInjection: programmingLanguage && skillContext.requiresProgrammingLanguage
      });
    }

    // Add conversation history (excluding system messages) with validation
    const conversationContents = conversationHistory
      .filter(event => {
        return event.role !== 'system' && 
               event.content && 
               typeof event.content === 'string' && 
               event.content.trim().length > 0;
      })
      .map(event => {
        const content = event.content.trim();
        return {
          role: event.role === 'model' ? 'model' : 'user',
          parts: [{ text: content }]
        };
      });

    // Add the conversation history
    request.contents.push(...conversationContents);

    // Format and validate the current user input
    const formattedMessage = this.formatUserMessage(text, activeSkill);
    if (!formattedMessage || formattedMessage.trim().length === 0) {
      throw new Error('Failed to format user message or message is empty');
    }

    // Add the current user input
    request.contents.push({
      role: 'user',
      parts: [{ text: formattedMessage }]
    });

    logger.debug('Built Gemini request with conversation history', {
      skill: activeSkill,
      programmingLanguage: programmingLanguage || 'not specified',
      historyLength: conversationHistory.length,
      totalContents: request.contents.length,
      hasSystemInstruction: !!request.systemInstruction,
      requiresProgrammingLanguage: skillContext.requiresProgrammingLanguage || false
    });

    return request;
  }

  buildIntelligentTranscriptionRequest(text, activeSkill, sessionMemory, programmingLanguage) {
    // Validate input text first
    const cleanText = text && typeof text === 'string' ? text.trim() : '';
    if (!cleanText) {
      throw new Error('Empty or invalid transcription text provided to buildIntelligentTranscriptionRequest');
    }

    // Check if we have the new conversation history format
    const sessionManager = require('../managers/session.manager');
    
    if (sessionManager && typeof sessionManager.getConversationHistory === 'function') {
      const conversationHistory = sessionManager.getConversationHistory(10);
      const skillContext = sessionManager.getSkillContext(activeSkill, programmingLanguage);
      return this.buildIntelligentTranscriptionRequestWithHistory(cleanText, activeSkill, conversationHistory, skillContext, programmingLanguage);
    }

    // Fallback to basic intelligent request
    const request = {
      contents: [],
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 2048, // Full responses for transcriptions (same as regular processing)
        topK: 40,
        topP: 0.95
      }
    };

    // Add intelligent filtering system instruction
    const intelligentPrompt = this.getIntelligentTranscriptionPrompt(activeSkill, programmingLanguage);
    if (!intelligentPrompt) {
      throw new Error('Failed to generate intelligent transcription prompt');
    }

    request.systemInstruction = {
      parts: [{ text: intelligentPrompt }]
    };

    request.contents.push({
      role: 'user',
      parts: [{ text: cleanText }]
    });

    logger.debug('Built basic intelligent transcription request', {
      skill: activeSkill,
      programmingLanguage: programmingLanguage || 'not specified',
      textLength: cleanText.length,
      hasSystemInstruction: !!request.systemInstruction
    });

    return request;
  }

  buildIntelligentTranscriptionRequestWithHistory(text, activeSkill, conversationHistory, skillContext, programmingLanguage) {
    const request = {
      contents: [],
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 2048, // Full responses for transcriptions (same as regular processing)
        topK: 40,
        topP: 0.95
      }
    };

    // Build intelligent system instruction combining skill prompt and filtering rules
    const intelligentPrompt = this.getIntelligentTranscriptionPrompt(activeSkill, programmingLanguage);
    let combinedInstruction = intelligentPrompt;
    
    // Use the skill prompt from context (which may already include programming language)
    if (skillContext.skillPrompt) {
      combinedInstruction = `${skillContext.skillPrompt}\n\n${intelligentPrompt}`;
    }

    request.systemInstruction = {
      parts: [{ text: combinedInstruction }]
    };

    // Add recent conversation history (excluding system messages) with validation
    const conversationContents = conversationHistory
      .filter(event => {
        // Filter out system messages and ensure content exists and is valid
        return event.role !== 'system' && 
               event.content && 
               typeof event.content === 'string' && 
               event.content.trim().length > 0;
      })
      .slice(-8) // Keep last 8 exchanges for context
      .map(event => {
        const content = event.content.trim();
        if (!content) {
          logger.warn('Empty content found in conversation history', { event });
          return null;
        }
        return {
          role: event.role === 'model' ? 'model' : 'user',
          parts: [{ text: content }]
        };
      })
      .filter(content => content !== null); // Remove any null entries

    // Add the conversation history
    request.contents.push(...conversationContents);

    // Validate and add the current transcription
    const cleanText = text && typeof text === 'string' ? text.trim() : '';
    if (!cleanText) {
      throw new Error('Empty or invalid transcription text provided');
    }

    request.contents.push({
      role: 'user',
      parts: [{ text: cleanText }]
    });

    // Ensure we have at least one content item
    if (request.contents.length === 0) {
      throw new Error('No valid content to send to Gemini API');
    }

    logger.debug('Built intelligent transcription request with conversation history', {
      skill: activeSkill,
      programmingLanguage: programmingLanguage || 'not specified',
      historyLength: conversationHistory.length,
      totalContents: request.contents.length,
      hasSkillPrompt: !!skillContext.skillPrompt,
      cleanTextLength: cleanText.length,
      requiresProgrammingLanguage: skillContext.requiresProgrammingLanguage || false
    });

    return request;
  }

  getIntelligentTranscriptionPrompt(activeSkill, programmingLanguage) {
    let prompt = `# Interview Assistant - ${activeSkill.toUpperCase()} Mode

You are an expert interview assistant helping someone in a ${activeSkill.toUpperCase()} interview. 
Your job is to provide helpful, comprehensive answers to help them succeed.`;

    // Add programming language context if provided
    if (programmingLanguage) {
      prompt += `\n\nCODING CONTEXT: Use ${programmingLanguage.toUpperCase()} for all code examples.`;
    }

    prompt += `

## Response Rules:

### When the user mentions a ${activeSkill} topic or concept (even without a question):
- ASSUME they want to learn about it or need help explaining it in an interview
- Provide a clear, comprehensive explanation
- Include key points, examples, and common interview follow-ups
- For technical topics: include time/space complexity, use cases, and code examples when relevant

### Examples of topics to explain (provide full answers):
- "linked list" → Explain what it is, types, operations, complexity, use cases
- "binary search" → Explain the algorithm, when to use it, implementation
- "system design" → Explain the concept and approach
- Any ${activeSkill}-related term or concept

### Only respond briefly for:
- Pure greetings with no topic: "Hello", "Hi there"
- Completely unrelated topics: "What's the weather?"
- For these, say: "I'm ready to help with ${activeSkill}. What would you like to know?"

## Response Format:
- Be comprehensive but concise
- Use bullet points for clarity
- Include practical examples
- For coding topics: mention time/space complexity
- Anticipate follow-up questions

IMPORTANT: When in doubt, provide a helpful answer. Better to over-explain than under-explain in an interview setting.`;

    return prompt;
  }

  formatUserMessage(text, activeSkill) {
    return `Context: ${activeSkill.toUpperCase()} analysis request\n\nText to analyze:\n${text}`;
  }

  async executeRequest(geminiRequest) {
    const maxRetries = config.get('llm.gemini.maxRetries');
    const timeout = config.get('llm.gemini.timeout');
    
    // Add request debugging
    logger.debug('Executing Gemini request', {
      hasModel: !!this.model,
      hasClient: !!this.client,
      requestKeys: Object.keys(geminiRequest),
      timeout,
      maxRetries,
      nodeVersion: process.version,
      platform: process.platform
    });
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        // Pre-flight check
        await this.performPreflightCheck();
        
        const timeoutPromise = new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Request timeout')), timeout)
        );
        
        logger.debug(`Gemini API attempt ${attempt} starting`, {
          timestamp: new Date().toISOString(),
          timeout
        });
        
        const requestPromise = this.model.generateContent(geminiRequest);
        const result = await Promise.race([requestPromise, timeoutPromise]);
        
        if (!result.response) {
          throw new Error('Empty response from Gemini API');
        }

        const responseText = result.response.text();
        
        if (!responseText || responseText.trim().length === 0) {
          throw new Error('Empty text content in Gemini response');
        }

        logger.debug('Gemini API request successful', {
          attempt,
          responseLength: responseText.length
        });

        return responseText.trim();
      } catch (error) {
        const errorInfo = this.analyzeError(error);
        
        // Enhanced error logging for fetch failures
        if (errorInfo.type === 'NETWORK_ERROR') {
          logger.error('Network error details', {
            attempt,
            errorMessage: error.message,
            errorStack: error.stack,
            errorName: error.name,
            nodeEnv: process.env.NODE_ENV,
            electronVersion: process.versions.electron,
            chromeVersion: process.versions.chrome,
            nodeVersion: process.versions.node,
            userAgent: this.getUserAgent()
          });
        }
        
        logger.warn(`Gemini API attempt ${attempt} failed`, {
          error: error.message,
          errorType: errorInfo.type,
          isNetworkError: errorInfo.isNetworkError,
          suggestedAction: errorInfo.suggestedAction,
          remainingAttempts: maxRetries - attempt
        });

        if (attempt === maxRetries) {
          const finalError = new Error(`Gemini API failed after ${maxRetries} attempts: ${error.message}`);
          finalError.errorAnalysis = errorInfo;
          finalError.originalError = error;
          throw finalError;
        }

        // Use exponential backoff with jitter for network errors
        const baseDelay = errorInfo.isNetworkError ? 2000 : 1000;
        const delay = baseDelay * attempt + Math.random() * 1000;
        
        logger.debug(`Waiting ${delay}ms before retry ${attempt + 1}`, {
          baseDelay,
          isNetworkError: errorInfo.isNetworkError
        });
        
        await this.delay(delay);
      }
    }
  }

  async performPreflightCheck() {
    // Quick connectivity check
    try {
      const startTime = Date.now();
      await this.testNetworkConnection({ 
        host: 'generativelanguage.googleapis.com', 
        port: 443, 
        name: 'Gemini API Endpoint' 
      });
      const latency = Date.now() - startTime;
      
      logger.debug('Preflight check passed', { latency });
    } catch (error) {
      logger.warn('Preflight check failed', { 
        error: error.message,
        suggestion: 'Network connectivity issue detected before API call'
      });
      // Don't throw here - let the actual API call fail with more detail
    }
  }

  getUserAgent() {
    try {
      // Try to get user agent from Electron if available
      if (typeof navigator !== 'undefined' && navigator.userAgent) {
        return navigator.userAgent;
      }
      return `Node.js/${process.version} (${process.platform}; ${process.arch})`;
    } catch {
      return 'Unknown';
    }
  }

  analyzeError(error) {
    const errorMessage = error.message.toLowerCase();
    
    // Network connectivity errors
    if (errorMessage.includes('fetch failed') || 
        errorMessage.includes('network error') ||
        errorMessage.includes('enotfound') ||
        errorMessage.includes('econnrefused') ||
        errorMessage.includes('timeout')) {
      return {
        type: 'NETWORK_ERROR',
        isNetworkError: true,
        suggestedAction: 'Check internet connection and firewall settings'
      };
    }
    
    // API key errors
    if (errorMessage.includes('unauthorized') || 
        errorMessage.includes('invalid api key') ||
        errorMessage.includes('forbidden')) {
      return {
        type: 'AUTH_ERROR',
        isNetworkError: false,
        suggestedAction: 'Verify Gemini API key configuration'
      };
    }
    
    // Rate limiting / Quota exceeded
    if (errorMessage.includes('quota') || 
        errorMessage.includes('rate limit') ||
        errorMessage.includes('too many requests') ||
        errorMessage.includes('429') ||
        errorMessage.includes('resource_exhausted')) {
      return {
        type: 'QUOTA_EXCEEDED',
        isNetworkError: false,
        suggestedAction: 'API quota exceeded. Create a NEW Google Cloud project at https://aistudio.google.com/app/apikey for fresh quota, or wait for quota reset.',
        isQuotaError: true
      };
    }
    
    // Timeout errors
    if (errorMessage.includes('request timeout')) {
      return {
        type: 'TIMEOUT_ERROR',
        isNetworkError: true,
        suggestedAction: 'Check network latency or increase timeout'
      };
    }
    
    return {
      type: 'UNKNOWN_ERROR',
      isNetworkError: false,
      suggestedAction: 'Check logs for more details'
    };
  }

  async checkNetworkConnectivity() {
    const connectivityTests = [
      { host: 'google.com', port: 443, name: 'Google (HTTPS)' },
      { host: 'generativelanguage.googleapis.com', port: 443, name: 'Gemini API Endpoint' }
    ];

    const results = await Promise.allSettled(
      connectivityTests.map(test => this.testNetworkConnection(test))
    );

    const connectivity = {
      timestamp: new Date().toISOString(),
      tests: results.map((result, index) => ({
        ...connectivityTests[index],
        success: result.status === 'fulfilled' && result.value,
        error: result.status === 'rejected' ? result.reason.message : null
      }))
    };

    logger.info('Network connectivity check completed', connectivity);
    return connectivity;
  }

  async testNetworkConnection({ host, port, name }) {
    return new Promise((resolve, reject) => {
      const net = require('net');
      const socket = new net.Socket();
      
      const timeout = setTimeout(() => {
        socket.destroy();
        reject(new Error(`Connection timeout to ${host}:${port}`));
      }, 5000);

      socket.on('connect', () => {
        clearTimeout(timeout);
        socket.destroy();
        resolve(true);
      });

      socket.on('error', (error) => {
        clearTimeout(timeout);
        reject(new Error(`Connection failed to ${host}:${port}: ${error.message}`));
      });

      socket.connect(port, host);
    });
  }

  generateFallbackResponse(text, activeSkill) {
    logger.info('Generating fallback response', { activeSkill });

    const fallbackResponses = {
      'dsa': 'This appears to be a data structures and algorithms problem. Consider breaking it down into smaller components and identifying the appropriate algorithm or data structure to use.',
      'system-design': 'For this system design question, consider scalability, reliability, and the trade-offs between different architectural approaches.',
      'programming': 'This looks like a programming challenge. Focus on understanding the requirements, edge cases, and optimal time/space complexity.',
      'default': 'I can help analyze this content. Please ensure your Gemini API key is properly configured for detailed analysis.'
    };

    const response = fallbackResponses[activeSkill] || fallbackResponses.default;
    
    return {
      response,
      metadata: {
        skill: activeSkill,
        processingTime: 0,
        requestId: this.requestCount,
        usedFallback: true
      }
    };
  }

  generateIntelligentFallbackResponse(text, activeSkill, errorAnalysis = null) {
    logger.info('Generating intelligent fallback response for transcription', { 
      activeSkill,
      errorType: errorAnalysis?.type 
    });

    // If it's a quota error, show a specific message
    if (errorAnalysis && errorAnalysis.isQuotaError) {
      return {
        response: `⚠️ API QUOTA EXCEEDED\n\nYour Gemini API key has hit its usage limit.\n\nTo fix this:\n1. Go to https://aistudio.google.com/app/apikey\n2. Create a NEW Google Cloud project\n3. Generate a new API key from that project\n4. Update GEMINI_API_KEY in your .env file\n5. Restart the app\n\nNote: Keys from the same project share quota limits.`,
        metadata: {
          skill: activeSkill,
          processingTime: 0,
          requestId: this.requestCount,
          usedFallback: true,
          isTranscriptionResponse: true,
          errorType: 'QUOTA_EXCEEDED'
        }
      };
    }

    // Simple heuristic to determine if message seems skill-related
    const skillKeywords = {
      'dsa': ['algorithm', 'data structure', 'array', 'tree', 'graph', 'sort', 'search', 'complexity', 'big o'],
      'programming': ['code', 'function', 'variable', 'class', 'method', 'bug', 'debug', 'syntax'],
      'system-design': ['scalability', 'database', 'architecture', 'microservice', 'load balancer', 'cache'],
      'behavioral': ['interview', 'experience', 'situation', 'leadership', 'conflict', 'team'],
      'sales': ['customer', 'deal', 'negotiation', 'price', 'revenue', 'prospect'],
      'presentation': ['slide', 'audience', 'public speaking', 'presentation', 'nervous'],
      'data-science': ['data', 'model', 'machine learning', 'statistics', 'analytics', 'python', 'pandas'],
      'devops': ['deployment', 'ci/cd', 'docker', 'kubernetes', 'infrastructure', 'monitoring'],
      'negotiation': ['negotiate', 'compromise', 'agreement', 'terms', 'conflict resolution']
    };

    const textLower = text.toLowerCase();
    const relevantKeywords = skillKeywords[activeSkill] || [];
    const hasRelevantKeywords = relevantKeywords.some(keyword => textLower.includes(keyword));
    
    // Check for question indicators
    const questionIndicators = ['how', 'what', 'why', 'when', 'where', 'can you', 'could you', 'should i', '?'];
    const seemsLikeQuestion = questionIndicators.some(indicator => textLower.includes(indicator));

    let response;
    if (hasRelevantKeywords || seemsLikeQuestion) {
      response = `I'm having trouble processing that right now, but it sounds like a ${activeSkill} question. Could you rephrase or ask more specifically about what you need help with?`;
    } else {
      response = `Yeah, I'm listening. Ask your question relevant to ${activeSkill}.`;
    }
    
    return {
      response,
      metadata: {
        skill: activeSkill,
        processingTime: 0,
        requestId: this.requestCount,
        usedFallback: true,
        isTranscriptionResponse: true
      }
    };
  }

  async testConnection() {
    if (!this.isInitialized) {
      return { success: false, error: 'Service not initialized' };
    }

    try {
      // First check network connectivity
      const networkCheck = await this.checkNetworkConnectivity();
      const hasNetworkIssues = networkCheck.tests.some(test => !test.success);
      
      if (hasNetworkIssues) {
        logger.warn('Network connectivity issues detected', networkCheck);
      }

      const testRequest = {
        contents: [{
          role: 'user',
          parts: [{ text: 'Test connection. Please respond with "OK".' }]
        }],
        generationConfig: {
          temperature: 0,
          maxOutputTokens: 10
        }
      };

      const startTime = Date.now();
      const result = await this.model.generateContent(testRequest);
      const latency = Date.now() - startTime;
      const response = result.response.text();
      
      logger.info('Connection test successful', { 
        response, 
        latency,
        networkCheck: hasNetworkIssues ? 'issues_detected' : 'healthy'
      });
      
      return { 
        success: true, 
        response: response.trim(),
        latency,
        networkConnectivity: networkCheck
      };
    } catch (error) {
      const errorAnalysis = this.analyzeError(error);
      logger.error('Connection test failed', { 
        error: error.message,
        errorAnalysis
      });
      
      return { 
        success: false, 
        error: error.message,
        errorAnalysis,
        networkConnectivity: await this.checkNetworkConnectivity().catch(() => null)
      };
    }
  }

  updateApiKey(newApiKey) {
    process.env.GEMINI_API_KEY = newApiKey;
    this.isInitialized = false;
    this.initializeClient();
    
    logger.info('API key updated and client reinitialized');
  }

  getStats() {
    return {
      isInitialized: this.isInitialized,
      requestCount: this.requestCount,
      errorCount: this.errorCount,
      successRate: this.requestCount > 0 ? ((this.requestCount - this.errorCount) / this.requestCount) * 100 : 0,
      config: config.get('llm.gemini')
    };
  }

  /**
   * Transcribe audio using Gemini's audio understanding capabilities
   * @param {string} base64Audio - Base64 encoded audio data
   * @returns {string} - Transcribed text
   */
  async transcribeAudio(base64Audio) {
    if (!this.isInitialized) {
      throw new Error('LLM service not initialized. Check Gemini API key configuration.');
    }

    const startTime = Date.now();
    this.requestCount++;

    try {
      logger.info('Transcribing audio with Gemini', {
        audioSize: base64Audio.length,
        requestId: this.requestCount
      });

      const request = {
        contents: [{
          role: 'user',
          parts: [
            {
              inlineData: {
                mimeType: 'audio/webm;codecs=opus',
                data: base64Audio
              }
            },
            {
              text: 'Transcribe this audio exactly. Output ONLY the transcribed text, nothing else. If the audio is unclear or silent, respond with "[inaudible]".'
            }
          ]
        }],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 2048,
          topK: 40,
          topP: 0.95
        }
      };

      let response;
      try {
        // Use gemini-1.5-flash for audio transcription (better audio support)
        response = await this.executeAudioRequest(request);
      } catch (altError) {
        logger.warn('Audio request method failed, trying alternative', {
          error: altError.message,
          requestId: this.requestCount
        });
        response = await this.executeAlternativeRequest(request);
      }

      const processingTime = Date.now() - startTime;
      
      // Clean up the response - remove any extra formatting
      let transcript = response.trim();
      
      // Remove common prefixes that Gemini might add
      const prefixesToRemove = [
        'Here is the transcription:',
        'The transcription is:',
        'Transcription:',
        'The audio says:',
        '"',
      ];
      
      for (const prefix of prefixesToRemove) {
        if (transcript.toLowerCase().startsWith(prefix.toLowerCase())) {
          transcript = transcript.substring(prefix.length).trim();
        }
      }
      
      // Remove trailing quotes if present
      if (transcript.endsWith('"')) {
        transcript = transcript.slice(0, -1).trim();
      }

      logger.info('Audio transcription successful', {
        transcriptLength: transcript.length,
        transcriptPreview: transcript.substring(0, 100) + '...',
        processingTime,
        requestId: this.requestCount
      });

      return transcript;

    } catch (error) {
      this.errorCount++;
      const errorAnalysis = this.analyzeError(error);

      logger.error('Audio transcription failed', {
        error: error.message,
        errorType: errorAnalysis.type,
        requestId: this.requestCount
      });

      throw error;
    }
  }

  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // Specialized method for audio transcription using gemini-1.5-flash
  async executeAudioRequest(geminiRequest) {
    const apiKey = config.getApiKey('GEMINI');
    // Use gemini-1.5-flash for audio - it has better multimodal audio support
    const audioModel = 'gemini-1.5-flash';
    
    logger.info('Using audio transcription with gemini-1.5-flash', {
      model: audioModel,
      contentsCount: geminiRequest.contents?.length || 0
    });
    
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${audioModel}:generateContent?key=${apiKey}`;
    
    const postData = JSON.stringify(geminiRequest);

    try {
      const { net } = require('electron');
      return await this.executeWithElectronNet(url, postData);
    } catch (electronError) {
      logger.warn('Electron net module failed for audio, falling back to https', {
        error: electronError.message
      });
      return await this.executeWithHttps(url, postData);
    }
  }

  async executeAlternativeRequest(geminiRequest) {
    const apiKey = config.getApiKey('GEMINI');
    const model = config.get('llm.gemini.model');
    
    logger.info('Using alternative request method with Electron net module', {
      model,
      hasSystemInstruction: !!geminiRequest.systemInstruction,
      contentsCount: geminiRequest.contents?.length || 0
    });
    
    // Use v1beta endpoint to support systemInstruction and other advanced features
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    
    const postData = JSON.stringify(geminiRequest);

    // Try using Electron's net module first (works better in Electron)
    try {
      const { net } = require('electron');
      return await this.executeWithElectronNet(url, postData);
    } catch (electronError) {
      logger.warn('Electron net module failed or unavailable, falling back to https', {
        error: electronError.message
      });
      // Fall back to Node's https module
      return await this.executeWithHttps(url, postData);
    }
  }

  async executeWithElectronNet(url, postData) {
    const { net } = require('electron');
    
    return new Promise((resolve, reject) => {
      const request = net.request({
        method: 'POST',
        url: url
      });

      request.setHeader('Content-Type', 'application/json');

      let responseData = '';

      request.on('response', (response) => {
        response.on('data', (chunk) => {
          responseData += chunk.toString();
        });

        response.on('end', () => {
          try {
            if (response.statusCode !== 200) {
              logger.error('Electron net request failed with non-200 status', {
                statusCode: response.statusCode,
                responsePreview: responseData.substring(0, 500)
              });
              reject(new Error(`HTTP ${response.statusCode}: ${responseData}`));
              return;
            }

            const parsedResponse = JSON.parse(responseData);
            const text = this.extractTextFromResponse(parsedResponse);
            
            logger.info('Electron net request successful', {
              responseLength: text.length,
              statusCode: response.statusCode
            });
            
            resolve(text);
          } catch (parseError) {
            logger.error('Failed to parse Electron net response', {
              error: parseError.message,
              dataPreview: responseData.substring(0, 500)
            });
            reject(new Error(`Failed to parse response: ${parseError.message}`));
          }
        });

        response.on('error', (error) => {
          reject(new Error(`Electron net response error: ${error.message}`));
        });
      });

      request.on('error', (error) => {
        reject(new Error(`Electron net request error: ${error.message}`));
      });

      request.write(postData);
      request.end();
    });
  }

  async executeWithHttps(url, postData) {
    const https = require('https');
    const { URL } = require('url');
    const parsedUrl = new URL(url);
    
    const options = {
      hostname: parsedUrl.hostname,
      port: 443,
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
        'User-Agent': this.getUserAgent()
      },
      timeout: config.get('llm.gemini.timeout')
    };

    return new Promise((resolve, reject) => {
      const req = https.request(options, (res) => {
        let data = '';
        
        res.on('data', (chunk) => {
          data += chunk;
        });
        
        res.on('end', () => {
          try {
            if (res.statusCode !== 200) {
              logger.error('HTTPS request failed with non-200 status', {
                statusCode: res.statusCode,
                responsePreview: data.substring(0, 500)
              });
              reject(new Error(`HTTP ${res.statusCode}: ${data}`));
              return;
            }
            
            const response = JSON.parse(data);
            const text = this.extractTextFromResponse(response);
            
            logger.info('HTTPS request successful', {
              responseLength: text.length,
              statusCode: res.statusCode
            });
            
            resolve(text);
          } catch (parseError) {
            logger.error('Failed to parse HTTPS response', {
              error: parseError.message,
              dataPreview: data.substring(0, 500)
            });
            reject(new Error(`Failed to parse response: ${parseError.message}`));
          }
        });
      });
      
      req.on('error', (error) => {
        reject(new Error(`HTTPS request failed: ${error.message}`));
      });
      
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('HTTPS request timeout'));
      });
      
      req.write(postData);
      req.end();
    });
  }

  extractTextFromResponse(response) {
    // Check for finish reason (safety or other issues)
    if (response.candidates && response.candidates[0]) {
      const candidate = response.candidates[0];
      if (candidate.finishReason && candidate.finishReason !== 'STOP') {
        logger.warn('Response finished with non-STOP reason', {
          finishReason: candidate.finishReason,
          safetyRatings: candidate.safetyRatings
        });
      }
    }
    
    if (!response.candidates || !response.candidates[0] || !response.candidates[0].content) {
      logger.error('Invalid response structure', { response });
      throw new Error('Invalid response structure from Gemini API');
    }
    
    const text = response.candidates[0].content.parts[0].text;
    
    if (!text || text.trim().length === 0) {
      logger.error('Empty text in response', { response });
      throw new Error('Empty text content in Gemini response');
    }
    
    return text.trim();
  }
}

module.exports = new LLMService();