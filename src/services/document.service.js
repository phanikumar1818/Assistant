const fs = require('fs');
const path = require('path');

// Polyfill DOMMatrix for pdf-parse compatibility in Electron main process
if (typeof global.DOMMatrix === 'undefined') {
  global.DOMMatrix = class DOMMatrix { };
}
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const logger = require('../core/logger').createServiceLogger('DOCUMENT');

class DocumentService {
  constructor() {
    this.activeDocuments = []; // Documents for the active session
    this.activeSessionId = null;
    this.activeSessionDocsPath = null;
  }

  // Set session context
  setSession(sessionId, sessionFilePath) {
    this.activeSessionId = sessionId;
    if (sessionFilePath) {
      this.activeSessionDocsPath = sessionFilePath.replace(/\.md$/, '.docs.json');
      this.loadDocumentsFromDisk();
    } else {
      this.activeSessionDocsPath = null;
      this.activeDocuments = [];
    }
    logger.info(`Session bound to DocumentService: ID=${sessionId}, Path=${this.activeSessionDocsPath}`);
  }

  // Load documents metadata and index from disk
  loadDocumentsFromDisk() {
    if (!this.activeSessionDocsPath) return;
    try {
      if (fs.existsSync(this.activeSessionDocsPath)) {
        const data = fs.readFileSync(this.activeSessionDocsPath, 'utf8');
        this.activeDocuments = JSON.parse(data);
        logger.info(`Loaded ${this.activeDocuments.length} documents from disk for session ${this.activeSessionId}`);
      } else {
        this.activeDocuments = [];
      }
    } catch (error) {
      logger.error('Failed to load documents from disk:', error);
      this.activeDocuments = [];
    }
  }

  // Save documents metadata and index to disk
  saveDocumentsToDisk() {
    if (!this.activeSessionDocsPath) return;
    try {
      fs.writeFileSync(this.activeSessionDocsPath, JSON.stringify(this.activeDocuments, null, 2), 'utf8');
      logger.info(`Saved ${this.activeDocuments.length} documents to disk for session ${this.activeSessionId}`);
    } catch (error) {
      logger.error('Failed to save documents to disk:', error);
    }
  }

  // Rename docs file when session file is renamed
  renameSessionDocs(oldPath, newPath) {
    try {
      const oldDocsPath = oldPath.replace(/\.md$/, '.docs.json');
      const newDocsPath = newPath.replace(/\.md$/, '.docs.json');
      if (fs.existsSync(oldDocsPath)) {
        fs.renameSync(oldDocsPath, newDocsPath);
        logger.info(`Renamed session docs file from ${oldDocsPath} to ${newDocsPath}`);
      }
      if (this.activeSessionDocsPath === oldDocsPath) {
        this.activeSessionDocsPath = newDocsPath;
      }
    } catch (error) {
      logger.error('Failed to rename session docs file:', error);
    }
  }

  // Delete docs file when session is deleted
  deleteSessionDocs(sessionFilePath) {
    try {
      const docsPath = sessionFilePath.replace(/\.md$/, '.docs.json');
      if (fs.existsSync(docsPath)) {
        fs.unlinkSync(docsPath);
        logger.info(`Deleted session docs file: ${docsPath}`);
      }
    } catch (error) {
      logger.error('Failed to delete session docs file:', error);
    }
  }

  // Get list of active documents for UI display
  getDocumentsList() {
    return this.activeDocuments.map(doc => ({
      id: doc.id,
      filename: doc.filename,
      status: doc.status,
      error: doc.error,
      summary: doc.summary
    }));
  }

  // Handle uploading documents
  async handleUpload(filePaths, llmService, onStatusUpdate) {
    if (!this.activeSessionId) {
      throw new Error('No active session. Please start a session first.');
    }

    const results = [];
    for (const filePath of filePaths) {
      const filename = path.basename(filePath);

      // Check for duplicate upload
      const isDuplicate = this.activeDocuments.some(doc => doc.filename === filename);
      if (isDuplicate) {
        logger.warn(`Duplicate upload skipped: ${filename}`);
        continue;
      }

      const docId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      const docState = {
        id: docId,
        filename,
        path: filePath,
        status: 'processing',
        error: null,
        chunks: [],
        summary: null
      };

      this.activeDocuments.push(docState);
      this.saveDocumentsToDisk();
      onStatusUpdate();

      // Run the processing in background asynchronously
      this.processDocument(docState, llmService, onStatusUpdate).catch(err => {
        logger.error(`Error processing doc ${filename}:`, err);
      });

      results.push({ id: docId, filename });
    }
    return results;
  }

  // Background processing of a document
  async processDocument(doc, llmService, onStatusUpdate) {
    const filename = doc.filename;
    const filePath = doc.path;

    try {
      logger.info(`Processing document: ${filename} from path: ${filePath}`);
      // 1. Check if file is empty
      const stats = fs.statSync(filePath);
      if (stats.size === 0) {
        throw new Error('Document is empty (0 bytes)');
      }

      // 2. Extract Text based on type
      let text = '';
      const ext = path.extname(filename).toLowerCase();

      if (ext === '.pdf') {
        text = await this.extractPdfText(filePath);
      } else if (ext === '.docx') {
        text = await this.extractDocxText(filePath);
      } else if (this.isTextOrCodeExtension(ext)) {
        text = fs.readFileSync(filePath, 'utf8');
      } else {
        throw new Error(`Unsupported file format: ${ext}`);
      }

      if (!text || !text.trim()) {
        throw new Error('Extracted text is empty or only whitespace');
      }

      // 3. Chunk text semantically
      doc.chunks = this.chunkText(text, filename);

      // 4. Generate search index (precompute normalized token representations for each chunk)
      this.indexChunks(doc);

      // 5. Generate Optional AI Summary (up to first 8,000 chars)
      try {
        doc.summary = await this.generateDocumentSummary(text, llmService);
      } catch (sumErr) {
        logger.warn(`Failed to generate optional AI summary for ${filename}:`, sumErr.message);
        // Do not fail the whole process if summary fails
      }

      doc.status = 'ready';
      doc.error = null;
      logger.info(`Document successfully processed: ${filename}. Chunks count: ${doc.chunks.length}`);

    } catch (error) {
      doc.status = 'failed';
      doc.error = error.message;
      logger.error(`Document processing failed for ${filename}:`, error);
    } finally {
      this.saveDocumentsToDisk();
      onStatusUpdate();
    }
  }

  isTextOrCodeExtension(ext) {
    const textAndCodeExts = [
      '.txt', '.md', '.markdown', '.js', '.jsx', '.ts', '.tsx', '.py',
      '.java', '.c', '.cpp', '.h', '.hpp', '.cs', '.go', '.rs', '.rb',
      '.php', '.html', '.css', '.json', '.xml', '.yaml', '.yml', '.ini',
      '.sql', '.sh', '.bat', '.ps1'
    ];
    return textAndCodeExts.includes(ext);
  }

  async extractPdfText(filePath) {
    const dataBuffer = fs.readFileSync(filePath);
    try {
      const data = await pdfParse(dataBuffer);
      return data.text;
    } catch (err) {
      if (err.message && err.message.includes('encrypted')) {
        throw new Error('Password-protected/encrypted PDF');
      }
      throw new Error('Corrupted or unreadable PDF: ' + err.message);
    }
  }

  async extractDocxText(filePath) {
    try {
      const result = await mammoth.extractRawText({ path: filePath });
      return result.value;
    } catch (err) {
      throw new Error('Corrupted or unreadable DOCX: ' + err.message);
    }
  }

  chunkText(text, filename) {
    const targetChunkSize = 1200; // characters (approx 200-300 words)
    const ext = path.extname(filename).toLowerCase();

    let paragraphs = [];
    if (ext === '.md' || ext === '.markdown') {
      paragraphs = text.split(/\n+(?=#|\r?\n)/);
    } else {
      paragraphs = text.split(/\r?\n\r?\n/);
    }

    const chunks = [];
    let currentChunk = '';

    for (let paragraph of paragraphs) {
      paragraph = paragraph.trim();
      if (!paragraph) continue;

      if (paragraph.length > targetChunkSize * 1.5) {
        if (currentChunk) {
          chunks.push(currentChunk);
          currentChunk = '';
        }

        const sentences = paragraph.split(/(?<=[.!?])\s+/);
        let temp = '';
        for (const sentence of sentences) {
          if (temp.length + sentence.length > targetChunkSize) {
            if (temp) chunks.push(temp.trim());
            temp = sentence + ' ';
          } else {
            temp += sentence + ' ';
          }
        }
        if (temp) currentChunk = temp.trim();
      } else {
        if (currentChunk.length + paragraph.length > targetChunkSize) {
          if (currentChunk) {
            chunks.push(currentChunk);
          }
          currentChunk = paragraph;
        } else {
          if (currentChunk) {
            currentChunk += '\n\n' + paragraph;
          } else {
            currentChunk = paragraph;
          }
        }
      }
    }

    if (currentChunk) {
      chunks.push(currentChunk);
    }

    return chunks.map((content, index) => ({
      id: `${filename}_chunk_${index}`,
      text: content,
      index
    }));
  }

  // Pre-tokenize chunks for fast searching
  indexChunks(doc) {
    for (const chunk of doc.chunks) {
      chunk.tokens = this.tokenize(chunk.text);
    }
  }

  tokenize(text) {
    const ignoreList = new Set([
      'a', 'an', 'to', 'in', 'on', 'of', 'at', 'by', 'it', 'is', 'as', 'if', 'or', 
      'he', 'we', 'me', 'us', 'do', 'so', 'no', 'my', 'up', 'the', 'and', 'for', 
      'you', 'that', 'this', 'with', 'from', 'about', 'your', 'are', 'was', 'were', 
      'have', 'has', 'had', 'what', 'how', 'why', 'who', 'where', 'but', 'not'
    ]);
    return text.toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 0 && !ignoreList.has(w));
  }

  areTokensMatching(chunkToken, queryToken) {
    if (chunkToken === queryToken) return true;
    if (queryToken.length > 3 && chunkToken.length > 3) {
      if (chunkToken.startsWith(queryToken) || queryToken.startsWith(chunkToken)) {
        return true;
      }
      if (chunkToken.includes(queryToken) || queryToken.includes(chunkToken)) {
        return true;
      }
    }
    return false;
  }

  async generateDocumentSummary(text, llmService) {
    if (!llmService) return null;
    const cleanText = text.substring(0, 8000); // Capped to avoid token limits
    const prompt = `You are a professional assistant. Provide a brief, high-level summary of the following document contents. Describe its main topic, purpose, and key takeaways in 2-3 paragraphs.
Do not include any conversational opening or closing phrases. Start directly with the summary text.

Document Contents:
${cleanText}`;

    return await llmService.callGeminiRaw(prompt, 'DOCUMENT SUMMARY');
  }

  // Retrieve relevant chunks matching the query
  async retrieveRelevantChunks(queryText, topN = 3) {
    const readyDocs = this.activeDocuments.filter(doc => doc.status === 'ready');
    if (readyDocs.length === 0) return '';

    const queryTokens = this.tokenize(queryText);
    if (queryTokens.length === 0) return '';

    // Collect all active chunks
    const allChunks = [];
    for (const doc of readyDocs) {
      for (const chunk of doc.chunks) {
        allChunks.push({
          docId: doc.id,
          docName: doc.filename,
          docSummary: doc.summary || '',
          text: chunk.text,
          tokens: chunk.tokens || []
        });
      }
    }

    if (allChunks.length === 0) return '';

    // Calculate Document Frequency (DF) for each query token
    const df = {};
    for (const token of queryTokens) {
      df[token] = 0;
      for (const chunk of allChunks) {
        const matchesChunk = chunk.tokens.some(ct => this.areTokensMatching(ct, token));
        if (matchesChunk) {
          df[token]++;
        }
      }
    }

    // Score each chunk
    const scores = [];
    const totalDocs = allChunks.length;

    for (const chunk of allChunks) {
      let score = 0;
      for (const token of queryTokens) {
        const docFreq = df[token] || 0;
        if (docFreq === 0) continue;

        // IDF formula
        const idf = Math.log(1 + (totalDocs - docFreq + 0.5) / (docFreq + 0.5));

        // Term frequency in chunk
        let termFreq = 0;
        for (const ct of chunk.tokens) {
          if (this.areTokensMatching(ct, token)) {
            termFreq++;
          }
        }

        // BM25-like TF scoring
        const tf = termFreq / (termFreq + 1.5);
        score += tf * idf;
      }

      // Boost score if query matches the filename (only applied when query explicitly references files/extensions)
      const isFileReference = queryText.toLowerCase().includes(chunk.docName.toLowerCase()) || 
                              queryTokens.includes('md') || 
                              queryTokens.includes('docx') || 
                              queryTokens.includes('pdf');
      if (isFileReference) {
        const filenameTokens = this.tokenize(chunk.docName);
        let filenameMatchCount = 0;
        for (const token of queryTokens) {
          if (filenameTokens.some(ft => this.areTokensMatching(ft, token))) {
            filenameMatchCount++;
          }
        }
        if (filenameMatchCount > 0) {
          score += (filenameMatchCount / queryTokens.length) * 2.0 * (score > 0 ? 1.0 : 0.25);
        }
      }

      // Boost score if query matches the summary (scaled by content score so low-overlap chunks aren't falsely inflated)
      if (chunk.docSummary && score > 0) {
        const summaryTokens = this.tokenize(chunk.docSummary);
        let summaryMatchCount = 0;
        for (const token of queryTokens) {
          if (summaryTokens.some(st => this.areTokensMatching(st, token))) {
            summaryMatchCount++;
          }
        }
        if (summaryMatchCount > 0) {
          score += (summaryMatchCount / queryTokens.length) * 1.0 * Math.min(1.0, score);
        }
      }

      if (score > 0.01) { // Lower threshold for prefix/partial matches
        scores.push({ chunk, score });
      }
    }

    if (scores.length === 0) return '';

    // Sort by score descending
    scores.sort((a, b) => b.score - a.score);

    // Apply absolute and relative thresholds to filter out noisy matching chunks
    const bestScore = scores[0].score;
    const finalScores = scores.filter(item => {
      // Require absolute minimum of 0.05 AND at least 35% of the highest matched chunk's score
      return item.score >= 0.05 && item.score >= bestScore * 0.35;
    });

    // Get top N chunks
    const selected = finalScores.slice(0, topN).map(item => item.chunk);
    if (selected.length === 0) return '';

    // Format for prompt injection
    let formatted = '--- Relevant Chunks from Attached Documents ---\n';
    formatted += 'Instructions to Assistant: These document chunks are provided for reference. ';
    formatted += 'Prioritize the live meeting discussion (Summary, Facts, and Transcript) over these documents in case of any conflict. ';
    formatted += 'Do not blindly quote this documentation if it contradicts what the meeting participants have discussed or agreed upon.\n\n';

    selected.forEach((chunk, index) => {
      formatted += `[Source: ${chunk.docName} | Chunk #${index + 1}]\n${chunk.text}\n\n`;
    });
    formatted += '--- End of Attached Documents ---';
    return formatted;
  }

  // Remove document
  deleteDocument(docId) {
    const index = this.activeDocuments.findIndex(doc => doc.id === docId);
    if (index !== -1) {
      const doc = this.activeDocuments[index];
      this.activeDocuments.splice(index, 1);
      this.saveDocumentsToDisk();
      logger.info(`Removed document ${doc.filename} (ID: ${docId})`);
      return true;
    }
    return false;
  }

  // Clear all documents
  clear() {
    this.activeDocuments = [];
    this.activeSessionId = null;
    this.activeSessionDocsPath = null;
    logger.info('DocumentService cleared');
  }
}

module.exports = new DocumentService();
