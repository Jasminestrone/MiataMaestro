const axios = require('axios');

async function evaluateListing(listingData, provider, config) {
  if (!listingData) {
    throw new Error('Listing data is required');
  }

  const prompt = `You are an expert Mazda Miata evaluator. Analyze this NA Miata listing and provide ONLY the following format:

LISTING DATA:
- Title: ${listingData.title || 'Unknown'}
- Year: ${listingData.year || 'Unknown'}
- Price: ${listingData.price?.toLocaleString() || 'Unknown'}
- Mileage: ${listingData.mileage?.toLocaleString() || 'Unknown'} miles
- Transmission: ${listingData.transmission || 'Unknown'}
- Description: ${listingData.description || 'No description provided'}

Respond in exactly this format using HTML not markdown IF I SEE ONE ASTERISK SO HELP ME GOD ILL UNPLUG YOUR SERVERS USE HTML NOT MARKDOWN FORMATTING PLEASEEEE. this is also a marketplace listning so some stuff like adress wont be specific:

<strong>Pros:</strong>
• [List positive aspects]

<strong>Concerns:</strong>
• [List potential issues or red flags]

<strong>Accurate Price:</strong>> $[your estimated fair market value]

<strong>Lowball:</strong> $[reasonable lowball offer amount]

Keep each section brief and factual.`;

  try {
    if (provider === 'ollama') {
      const ollamaUrl = `http://localhost:${config.ollamaPort || 11434}/api/generate`;
      console.log(`Making request to Ollama at: ${ollamaUrl}`);
      
      const response = await axios.post(ollamaUrl, {
        model: 'llama3.1:8b',
        prompt: prompt,
        stream: false,
        options: {
          temperature: 0.7,
          top_p: 0.9,
          num_predict: 200
        }
      }, { 
        timeout: 45000,
        headers: {
          'Content-Type': 'application/json'
        }
      });
      
      if (response.data && response.data.response) {
        return response.data.response.trim();
      } else {
        throw new Error('Invalid response format from Ollama');
      }
    } else if (provider === 'llama3.1:8b') {
      const response = await axios.post(config.gptossUrl || 'http://localhost:8000/v1/complete', {
        prompt: prompt,
        max_tokens: 200,
        temperature: 0.7
      }, { timeout: 30000 });
      
      if (response.data && response.data.choices && response.data.choices[0]) {
        return response.data.choices[0].text.trim();
      } else {
        throw new Error('Invalid response format from llama3.1:8b');
      }
    } else {
      return 'LLM provider not configured properly.';
    }
  } catch (error) {
    console.error('LLM evaluation error:', error.message);
    if (error.code === 'ECONNREFUSED') {
      return `AI evaluation failed: Cannot connect to ${provider} service. Make sure Ollama is running on port ${config.ollamaPort || 11434}.`;
    } else if (error.response) {
      return `AI evaluation failed: ${provider} returned error ${error.response.status}. ${error.response.data?.error || 'Unknown error'}`;
    } else {
      return `AI evaluation failed: ${error.message}. Check if your ${provider} service is running.`;
    }
  }
}

async function generateLowballMessage(listingData, provider, config) {
  if (!listingData) {
    throw new Error('Listing data is required');
  }

  const prompt = `You are a casual car buyer on Facebook Marketplace. Write a super casual, natural message like you're texting a friend.

LISTING DATA:
- Title: ${listingData.title || 'Unknown'}
- Year: ${listingData.year || 'Unknown'}
- Price: ${listingData.price?.toLocaleString() || 'Unknown'}
- Mileage: ${listingData.mileage?.toLocaleString() || 'Unknown'} miles
- Transmission: ${listingData.transmission || 'Unknown'}
- Description: ${listingData.description || 'No description provided'}
- Suggested Lowball Price: $${listingData.lowballPrice?.toLocaleString() || 'Not available'}

Write a casual message (like 2-3 sentences max) that:
- Sounds like a real person, not AI
- Mentions a few specific issues with the car
- Offers $${listingData.lowballPrice?.toLocaleString() || 'a lower price'}
- Uses casual language, emojis, abbreviations
- No fancy formatting, just natural text

Make it sound like you're actually texting someone on Facebook. Keep it super casual and real. dont say something like  "hey seller" just say hey`;

  try {
    if (provider === 'ollama') {
      const ollamaUrl = `http://localhost:${config.ollamaPort || 11434}/api/generate`;
      console.log(`Making lowball request to Ollama at: ${ollamaUrl}`);
      
      const response = await axios.post(ollamaUrl, {
        model: 'llama3.1:8b',
        prompt: prompt,
        stream: false,
        options: {
          temperature: 0.8,
          top_p: 0.9,
          num_predict: 300
        }
      }, { 
        timeout: 45000,
        headers: {
          'Content-Type': 'application/json'
        }
      });
      
      if (response.data && response.data.response) {
        return response.data.response.trim();
      } else {
        throw new Error('Invalid response format from Ollama');
      }
    } else if (provider === 'llama3.1:8b') {
      const response = await axios.post(config.gptossUrl || 'http://localhost:8000/v1/complete', {
        prompt: prompt,
        max_tokens: 300,
        temperature: 0.8
      }, { timeout: 30000 });
      
      if (response.data && response.data.choices && response.data.choices[0]) {
        return response.data.choices[0].text.trim();
      } else {
        throw new Error('Invalid response format from llama3.1:8b');
      }
    } else {
      return 'LLM provider not configured properly.';
    }
  } catch (error) {
    console.error('LLM lowball message error:', error.message);
    if (error.code === 'ECONNREFUSED') {
      return `Lowball message generation failed: Cannot connect to ${provider} service. Make sure Ollama is running on port ${config.ollamaPort || 11434}.`;
    } else if (error.response) {
      return `Lowball message generation failed: ${provider} returned error ${error.response.status}. ${error.response.data?.error || 'Unknown error'}`;
    } else {
      return `Lowball message generation failed: ${error.message}. Check if your ${provider} service is running.`;
    }
  }
}

module.exports = {
  evaluateListing,
  generateLowballMessage
};