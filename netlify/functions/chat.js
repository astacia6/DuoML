const OpenAI = require('openai');

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

exports.handler = async (event, context) => {
  // CORS 헤더 설정
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
  };

  // OPTIONS 요청 처리 (CORS preflight)
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers,
      body: '',
    };
  }

  // POST 요청만 허용
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: 'Method not allowed' }),
    };
  }

  try {
    const { messages, hasImage } = JSON.parse(event.body || '{}');

    if (!Array.isArray(messages) || messages.length === 0) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'messages 배열이 필요합니다.' }),
      };
    }

    // 텍스트-only 기본: gpt-4.1-mini, 이미지 포함/고난도 작업: gpt-4.1
    const modelFromEnv = process.env.OPENAI_MODEL;
    let model;

    if (hasImage) {
      model = modelFromEnv || 'gpt-4.1';
    } else {
      model = modelFromEnv || 'gpt-4.1-mini';
    }

    const completion = await client.chat.completions.create({
      model,
      messages,
    });

    const reply = completion.choices?.[0]?.message;

    if (!reply) {
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: '모델 응답이 비어 있습니다.' }),
      };
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        model,
        message: reply,
      }),
    };
  } catch (error) {
    console.error('OpenAI 호출 오류:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        error: '서버 오류가 발생했습니다.',
        detail: error.message,
      }),
    };
  }
};

