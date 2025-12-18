import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import OpenAI from 'openai';

const app = express();
const port = process.env.PORT || 3000;

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// 헬스 체크
app.get('/health', (req, res) => {
  res.json({ ok: true });
});

// 챗봇 엔드포인트
app.post('/api/chat', async (req, res) => {
  try {
    const { messages, hasImage } = req.body || {};

    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages 배열이 필요합니다.' });
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
      return res.status(500).json({ error: '모델 응답이 비어 있습니다.' });
    }

    res.json({
      model,
      message: reply,
    });
  } catch (error) {
    console.error('OpenAI 호출 오류:', error);
    res.status(500).json({
      error: '서버 오류가 발생했습니다.',
      detail: error.message,
    });
  }
});

app.listen(port, () => {
  console.log(`DuoML 챗봇 서버가 http://localhost:${port} 에서 실행 중입니다.`);
});










