const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json());

// Mapeamento email → nome do SDR
const SDR_MAP = {
  'jpboubeemuniz@gmail.com': 'João Muniz',
  'victorcontato.ra@gmail.com': 'Victor Hugo',
};
const SDR_EMAILS = Object.keys(SDR_MAP);

let calls = [];
let callIdCounter = 1;

// ─── WEBHOOK DO OPENPHONE ───────────────────────────────────────────────────
app.post('/webhook/openphone', async (req, res) => {
  try {
    const event = req.body;

    if (event.type !== 'call.transcript.completed') {
      return res.json({ ok: true, skipped: true });
    }

    const call = event.data?.object;
    if (!call) return res.json({ ok: true, skipped: true });

    const transcript = call.transcript || '';
    const duration = call.duration || 0;
    const direction = call.direction || 'inbound';
    const to = call.to || '';
    const userEmail = call.user?.email || '';
    const answeredAt = call.answeredAt;

    // Filtra — só processa calls do João Muniz e Victor Hugo
    if (userEmail && !SDR_EMAILS.includes(userEmail)) {
      return res.json({ ok: true, skipped: true, reason: 'SDR não monitorado' });
    }

    // Resolve nome pelo email
    const sdrName = SDR_MAP[userEmail] || userEmail || 'SDR';

    // Se não atendeu, registra sem análise
    if (!answeredAt || duration < 10) {
      const newCall = {
        id: callIdCounter++,
        lead: to,
        meta: direction === 'outbound' ? 'Outbound' : 'Inbound',
        sdr: sdrName,
        status: 'nao_atendeu',
        result: 'nao_atendeu',
        duration: '—',
        score: 0,
        transcript: '',
        issues: ['Lead não atendeu a ligação'],
        suggestion: 'Tentar novamente entre 8h–10h ou 16h–18h. Enviar WhatsApp antes.',
        createdAt: new Date().toISOString(),
      };
      calls.unshift(newCall);
      return res.json({ ok: true, callId: newCall.id });
    }

    const mins = Math.floor(duration / 60);
    const secs = duration % 60;
    const durationStr = `${mins}:${secs.toString().padStart(2, '0')}`;

    let analysis = null;
    if (transcript && transcript.length > 50) {
      analysis = await analyzeWithClaude(transcript, sdrName);
    }

    const newCall = {
      id: callIdCounter++,
      lead: to,
      meta: direction === 'outbound' ? 'Outbound' : 'Inbound',
      sdr: sdrName,
      status: 'atendida',
      result: analysis?.agendou ? 'agendou' : 'nao_agendou',
      duration: durationStr,
      score: analysis?.score || 0,
      transcript: transcript,
      issues: (analysis?.pontos_positivos || []).concat((analysis?.erros || []).map(e => '⚠️ ' + e)),
      suggestion: analysis?.sugestao || '',
      scores_detalhados: analysis?.scores_detalhados || {},
      resumo: analysis?.resumo || '',
      createdAt: new Date().toISOString(),
    };

    calls.unshift(newCall);
    res.json({ ok: true, callId: newCall.id });

  } catch (err) {
    console.error('Webhook error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/analyze', async (req, res) => {
  try {
    const { transcript, sdr, lead, result } = req.body;
    if (!transcript) return res.status(400).json({ error: 'Transcrição obrigatória' });

    const analysis = await analyzeWithClaude(transcript, sdr, lead);

    const newCall = {
      id: callIdCounter++,
      lead: lead || 'Lead',
      meta: 'Manual',
      sdr: sdr || 'SDR',
      status: 'atendida',
      result: result || (analysis?.agendou ? 'agendou' : 'nao_agendou'),
      duration: '—',
      score: analysis?.score || 0,
      transcript,
      issues: (analysis?.pontos_positivos || []).concat((analysis?.erros || []).map(e => '⚠️ ' + e)),
      suggestion: analysis?.sugestao || '',
      scores_detalhados: analysis?.scores_detalhados || {},
      resumo: analysis?.resumo || '',
      createdAt: new Date().toISOString(),
    };

    calls.unshift(newCall);
    res.json({ ok: true, call: newCall });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/calls', (req, res) => {
  const { filter, date } = req.query;
  let data = [...calls];

  if (date) data = data.filter(c => c.createdAt.startsWith(date));
  if (filter === 'atendida') data = data.filter(c => c.status === 'atendida');
  else if (filter === 'nao_atendeu') data = data.filter(c => c.status === 'nao_atendeu');
  else if (filter === 'agendou') data = data.filter(c => c.result === 'agendou');
  else if (filter === 'nao_agendou') data = data.filter(c => c.result === 'nao_agendou' && c.status === 'atendida');
  else if (filter === 'erro') data = data.filter(c => c.score < 45 && c.score > 0);

  res.json({ calls: data, total: data.length });
});

app.get('/api/stats', (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  const todayCalls = calls.filter(c => c.createdAt.startsWith(today));

  const total = todayCalls.length;
  const atendidas = todayCalls.filter(c => c.status === 'atendida').length;
  const agendamentos = todayCalls.filter(c => c.result === 'agendou').length;
  const naoAtendeu = todayCalls.filter(c => c.status === 'nao_atendeu').length;
  const scoreTotal = todayCalls.filter(c => c.score > 0).reduce((a, c) => a + c.score, 0);
  const scoreMedio = atendidas > 0 ? Math.round(scoreTotal / atendidas) : 0;

  const objecoes = {};
  todayCalls.forEach(c => {
    (c.erros || []).forEach(e => { objecoes[e] = (objecoes[e] || 0) + 1; });
  });

  res.json({ total, atendidas, agendamentos, naoAtendeu, scoreMedio, objecoes });
});

async function analyzeWithClaude(transcript, sdr = 'SDR', lead = 'Lead') {
  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY não configurada');

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1000,
      system: `Você é especialista em vendas B2B para contractors brasileiros nos EUA (construção civil). Analise calls de SDR do RA Accelerator (produto de $20k-$36k para estruturação comercial de contractors). Retorne APENAS JSON válido, sem texto fora do JSON.

Formato exato:
{
  "score": número 0-100,
  "scores_detalhados": {"abertura": número, "timing": número, "objecoes": número, "fechamento": número},
  "pontos_positivos": ["máximo 3 itens"],
  "erros": ["máximo 3 erros com contexto de quando aconteceu"],
  "sugestao": "recomendação prática e específica para o SDR",
  "resumo": "uma frase resumindo a call",
  "agendou": true ou false
}`,
      messages: [{
        role: 'user',
        content: `SDR: ${sdr}\nLead: ${lead}\n\nTranscrição:\n${transcript}`
      }]
    })
  });

  const data = await response.json();
  const text = data.content?.map(i => i.text || '').join('') || '';
  const clean = text.replace(/```json|```/g, '').trim();
  return JSON.parse(clean);
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`RA SDR Server rodando na porta ${PORT}`));
