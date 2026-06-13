// Netlify Function — proxy ไปยัง Claude API อย่างปลอดภัย
// API key เก็บใน Environment Variable (ANTHROPIC_API_KEY)

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders(), body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: corsHeaders(), body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { statusCode: 500, headers: corsHeaders(), body: JSON.stringify({ error: 'ยังไม่ได้ตั้งค่า ANTHROPIC_API_KEY ใน Netlify' }) };
  }

  try {
    const { messages, system } = JSON.parse(event.body || '{}');
    if (!messages || !Array.isArray(messages)) {
      return { statusCode: 400, headers: corsHeaders(), body: JSON.stringify({ error: 'ต้องส่ง messages มาด้วย' }) };
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 8000,
        system: system || '',
        messages: messages
      })
    });

    const data = await response.json();
    if (!response.ok) {
      return { statusCode: response.status, headers: corsHeaders(), body: JSON.stringify({ error: data.error?.message || 'Claude API error' }) };
    }

    const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
    return { statusCode: 200, headers: corsHeaders(), body: JSON.stringify({ reply: text }) };

  } catch (err) {
    return { statusCode: 500, headers: corsHeaders(), body: JSON.stringify({ error: err.message }) };
  }
};

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };
}
