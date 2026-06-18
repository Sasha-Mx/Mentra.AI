const axios = require('axios');
const fs = require('fs');

/**
 * Robust JSON extractor to handle extra text, markdown, or <think> tags
 */
function extractJSON(text) {
  // Remove <think>...</think> blocks (some models emit these)
  let cleaned = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  // Remove markdown code fences
  cleaned = cleaned.replace(/```json/gi, '').replace(/```/g, '').trim();
  
  // Find first { and last }
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  
  if (start === -1 || end === -1) {
    // Try array
    const arrStart = cleaned.indexOf('[');
    const arrEnd = cleaned.lastIndexOf(']');
    if (arrStart !== -1 && arrEnd !== -1) {
      return JSON.parse(cleaned.slice(arrStart, arrEnd + 1));
    }
    throw new Error('No JSON found in response');
  }
  
  return JSON.parse(cleaned.slice(start, end + 1));
}

/**
 * Reusable AI utility function to generate responses via OpenRouter
 * Includes retry logic for resilience against DNS/Network transient failures.
 * @param {string} prompt - The prompt to send to the AI
 * @returns {Promise<any>} - The parsed JSON response
 */
const generateAIResponse = async (prompt) => {
  const MAX_RETRIES = 3;
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const geminiKey = process.env.GEMINI_API_KEY?.trim();
      const openRouterKey = process.env.OPENROUTER_API_KEY?.trim();

      if (!geminiKey && !openRouterKey) {
        throw new Error("API Key is missing. Please configure GEMINI_API_KEY or OPENROUTER_API_KEY in your .env file.");
      }

      const logMsg = attempt > 1 
        ? `[AI] Sending request (Attempt ${attempt}/${MAX_RETRIES})...\n`
        : `[AI] Sending request...\n`;
      fs.appendFileSync('debug.log', logMsg);

      let response;
      let rawContent;

      if (geminiKey) {
        // Direct Google AI Studio API call
        response = await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiKey}`, {
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            responseMimeType: "application/json",
            maxOutputTokens: 8000
          }
        }, {
          headers: {
            "Content-Type": "application/json"
          },
          timeout: 45000
        });

        if (response.data?.candidates?.[0]?.content?.parts?.[0]?.text) {
          rawContent = response.data.candidates[0].content.parts[0].text;
        } else {
          throw new Error("Invalid response format from Google Gemini API");
        }
      } else {
        // OpenRouter API call
        response = await axios.post("https://openrouter.ai/api/v1/chat/completions", {
          model: "google/gemini-2.5-flash",
          max_tokens: 3000,
          messages: [{ role: "user", content: prompt }]
        }, {
          headers: {
            "Authorization": `Bearer ${openRouterKey}`,
            "Content-Type": "application/json",
            "HTTP-Referer": "https://mentra.ai",
            "X-Title": "Mentra AI Career Coach"
          },
          timeout: 45000
        });

        rawContent = response.data.choices[0].message.content;
      }

      fs.appendFileSync('debug.log', `[AI] Raw response length: ${rawContent.length}\n`);
      
      try {
        const parsed = extractJSON(rawContent);
        fs.appendFileSync('debug.log', `[AI] JSON parsed successfully\n`);
        return parsed;
      } catch (e) {
        fs.appendFileSync('debug.log', `[AI] JSON PARSE FAILED: ${e.message}\nRAW: ${rawContent}\n`);
        throw new Error("Failed to parse AI JSON response.");
      }
    } catch (error) {
      lastError = error;
      const statusCode = error.response?.status;
      const errorData = error.response?.data;
      const errMsg = statusCode ? `${statusCode}: ${JSON.stringify(errorData)}` : error.message;
      
      fs.appendFileSync('debug.log', `[AI] ATTEMPT ${attempt} FAILED: ${errMsg}\n`);

      // Stop retrying on auth errors (401/403)
      if (statusCode === 401 || statusCode === 403) {
        fs.appendFileSync('debug.log', `[AI] AUTH ERROR - Stopping retries. Check API key.\n`);
        throw new Error("AI Authentication failed. Please verify your API Key configuration.");
      }

      // Don't retry on other client errors (4xx) except 429
      if (statusCode && statusCode >= 400 && statusCode < 500 && statusCode !== 429) {
        throw error;
      }

      // Wait before retrying (exponential backoff)
      if (attempt < MAX_RETRIES) {
        const delay = Math.pow(2, attempt) * 1000;
        fs.appendFileSync('debug.log', `[AI] Waiting ${delay}ms before next attempt...\n`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError;
};


const MODELS = {
  RESUME_ANALYZE:  'google/gemini-2.5-flash',
  RESUME_REWRITE:  'google/gemini-2.5-flash',
  RESUME_KEYWORDS: 'google/gemini-2.5-flash',
  DEFAULT: 'google/gemini-2.5-flash'
};

const MAX_TOKENS = {
  RESUME_ANALYZE:  2000,
  RESUME_REWRITE:  1500,
  RESUME_KEYWORDS: 800,
  DEFAULT: 3000
};

/**
 * Specialized AI call for specific feature tasks
 */
const callAI = async (taskType, prompt) => {
  const model = MODELS[taskType] || MODELS.DEFAULT;
  const tokens = MAX_TOKENS[taskType] || MAX_TOKENS.DEFAULT;

  // We reuse our resilient generateAIResponse logic but with specific model/tokens if needed
  // For now, generateAIResponse is hardcoded to gemini-2.0-flash-001. 
  // We will pass the specific prompt to it.
  return await generateAIResponse(prompt);
};

module.exports = { generateAIResponse, callAI };
