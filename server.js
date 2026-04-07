const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json());

// Mapeamento userId → nome do SDR
// Victor Hugo: USgCXC5yNi
// João Muniz: adicionar após call de teste dele
const SDR_MAP = {
  'USgCXC5yNi': 'Victor Hugo',
  'USeF2q4DqR': 'João Muniz', // substituir após call de teste
};
const SDR_IDS = Object.keys(SDR_MAP);

let calls = [];
let callIdCounter = 1;

// ─── WEBHOOK DO OPENPHONE ───────────────────────────────────────────────────
app.post('/webhook/openphone', async (req, res) => {
  try {
    const event = req.body;
    console.log('WEBHOOK TYPE:', event.type);

    // Processa call.completed (registra a call)
    if (event.type === 'call.completed') {
      const call = event.data?.object;
      if (!call) return res.json({ ok: true, skipped: true });

      const userId = call.userId || '';
      const duration = call.duration || 0;
      const direction = call.direction || 'outgoing';
      const to = call.to || '';
      const answeredAt = call.answeredAt;
      const callId = call.id || '';

      console.log('call.completed - userId:', userId, 'duration:', duration, 'to:', to);

      // Filtra — só processa calls dos SDRs monitorados
      if (!SDR_IDS.includes(userId)) {
        console.log('SDR não monitorado:', userId);
        return res.json({ ok: true, skipped: true, reason: 'SDR não monitorado' });
      }

      const sdrName = SDR_MAP[userId];
      const mins = Math.floor(duration / 60);
      const secs = duration % 60;
      const durationStr = duration > 0 ? `${mins}:${secs.toString().padStart(2, '0')}` : '—';

      const newCall = {
        id: callIdCounter++,
        openPhoneId: callId,
        lead: to,
        meta: direction === 'outgoing' ? 'Outbound' : 'Inbound',
        sdr: sdrName,
        status: !answeredAt || duration < 10 ? 'nao_atendeu' : 'atendida',
        result: !answeredAt || duration < 10 ? 'nao_atendeu' : 'nao_agendou',
        duration: durationStr,
        score: 0,
        transcript: '',
        issues: !answeredAt || duration < 10 ? ['Lead não atendeu a ligação'] : [],
        suggestion: !answeredAt || duration < 10 ? 'Tentar novamente entre 8h–10h ou 16h–18h.' : '',
        scores_detalhados: {},
        resumo: '',
        createdAt: new Date().toISOString(),
      };

      calls.unshift(newCall);
      return res.json({ ok: true, callId: newCall.id });
    }

    // Processa call.transcript.completed (analisa com Claude)
    if (event.type === 'call.transcript.completed') {
      const obj = event.data?.object;
      if (!obj) return res.json({ ok: true, skipped: true });

      const callId = obj.callId || '';
      const dialogue = obj.dialogue || [];

      // Monta transcrição a partir do dialogue
      const transcript = dialogue.map(d => `${d.identifier || 'Speaker'}: ${d.content}`).join('\n');
      console.log('transcript.completed - callId:', callId, 'linhas:', dialogue.length);

      // Encontra a call já registrada
      const existing = calls.find(c => c.openPhoneId === callId);
      if (!existing) {
        console.log('Call não encontrada para transcript:', callId);
        return res.json({ ok: true, skipped: true });
      }

      // Atualiza com transcrição e análise
      existing.transcript = transcript;
      if (transcript && transcript.length > 50) {
        try {
          const analysis = await analyzeWithClaude(transcript, existing.sdr);
          existing.score = analysis?.score || 0;
          existing.issues = (analysis?.pontos_positivos || []).concat((analysis?.erros || []).map(e => '⚠️ ' + e));
          existing.suggestion = analysis?.sugestao || '';
          existing.scores_detalhados = analysis?.scores_detalhados || {};
          existing.resumo = analysis?.resumo || '';
          existing.result = analysis?.agendou ? 'agendou' : 'nao_agendou';
          console.log('Análise concluída - score:', existing.score);
        } catch (e) {
          console.error('Erro na análise Claude:', e.message);
        }
      }

      return res.json({ ok: true, updated: true });
    }

    return res.json({ ok: true, skipped: true });

  } catch (err) {
    console.error('Webhook error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── ANALISAR MANUALMENTE ───────────────────────────────────────────────────
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

// ─── LISTAR CALLS ───────────────────────────────────────────────────────────
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

// ─── STATS DO DIA ───────────────────────────────────────────────────────────
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

// ─── CLAUDE ─────────────────────────────────────────────────────────────────
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
