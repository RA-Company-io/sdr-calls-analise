const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json());

// Mapeamento userId → nome do SDR
const SDR_MAP = {
  'USgCXC5yNi': 'Victor Hugo',
  'USeF2q4DqR': 'João Muniz',
};
const SDR_IDS = Object.keys(SDR_MAP);

// Voicemail keywords — português e inglês
const VOICEMAIL_KEYWORDS = [
  'forwarded to', 'leave a message', 'voicemail', 'not available',
  'please leave', 'after the tone', 'call has been forwarded',
  'deixe sua mensagem', 'não disponível', 'caixa postal',
  'deixe uma mensagem', 'após o sinal', 'fora da área',
  'não foi possível completar', 'tente novamente mais tarde'
];

function isVoicemail(dialogue) {
  if (!dialogue || dialogue.length === 0) return true;
  const text = dialogue.map(d => d.content || '').join(' ').toLowerCase();
  return VOICEMAIL_KEYWORDS.some(kw => text.includes(kw));
}

function isRealConversation(dialogue) {
  if (!dialogue || dialogue.length < 2) return false;
  if (isVoicemail(dialogue)) return false;
  const identifiers = new Set(dialogue.map(d => d.identifier));
  return identifiers.size >= 2;
}

let calls = [];
let callIdCounter = 1;

// Fila de transcrições que chegaram antes da call ser registrada
let pendingTranscripts = [];

// ─── WEBHOOK DO OPENPHONE ───────────────────────────────────────────────────
app.post('/webhook/openphone', async (req, res) => {
  try {
    const event = req.body;
    console.log('WEBHOOK TYPE:', event.type);

    // ── call.completed — registra a call ──
    if (event.type === 'call.completed') {
      const call = event.data?.object;
      if (!call) return res.json({ ok: true, skipped: true });

      const userId = call.userId || '';
      const direction = call.direction || 'outgoing';
      const to = call.to || '';
      const answeredAt = call.answeredAt;
      const callId = call.id || '';

      console.log('call.completed - userId:', userId, 'answeredAt:', answeredAt, 'to:', to);

      if (!SDR_IDS.includes(userId)) {
        console.log('SDR não monitorado:', userId);
        return res.json({ ok: true, skipped: true });
      }

      const sdrName = SDR_MAP[userId];
      const atendeu = !!answeredAt;

      const newCall = {
        id: callIdCounter++,
        openPhoneId: callId,
        lead: to,
        meta: direction === 'outgoing' ? 'Outbound' : 'Inbound',
        sdr: sdrName,
        status: atendeu ? 'atendida' : 'nao_atendeu',
        result: atendeu ? 'nao_agendou' : 'nao_atendeu',
        duration: '—',
        score: 0,
        transcript: '',
        issues: atendeu ? [] : ['Lead não atendeu a ligação'],
        suggestion: atendeu ? '' : 'Tentar novamente entre 8h–10h ou 16h–18h.',
        scores_detalhados: {},
        resumo: '',
        createdAt: new Date().toISOString(),
      };

      calls.unshift(newCall);

      // Verifica se já tinha transcrição pendente para essa call
      const pending = pendingTranscripts.find(p => p.callId === callId);
      if (pending) {
        console.log('Processando transcrição pendente para:', callId);
        pendingTranscripts = pendingTranscripts.filter(p => p.callId !== callId);
        await processTranscript(newCall, pending.dialogue);
      }

      return res.json({ ok: true, callId: newCall.id });
    }

    // ── call.transcript.completed — analisa com Claude ──
    if (event.type === 'call.transcript.completed') {
      const obj = event.data?.object;
      if (!obj) return res.json({ ok: true, skipped: true });

      const callId = obj.callId || '';
      const dialogue = obj.dialogue || [];

      console.log('transcript.completed - callId:', callId, 'linhas:', dialogue.length);

      const existing = calls.find(c => c.openPhoneId === callId);

      if (!existing) {
        // Guarda na fila — call.completed ainda não chegou
        console.log('Call não encontrada ainda — guardando na fila:', callId);
        pendingTranscripts.push({ callId, dialogue, receivedAt: Date.now() });
        // Limpa pendentes com mais de 5 minutos
        pendingTranscripts = pendingTranscripts.filter(p => Date.now() - p.receivedAt < 300000);
        return res.json({ ok: true, queued: true });
      }

      await processTranscript(existing, dialogue);
      return res.json({ ok: true, updated: true });
    }

    return res.json({ ok: true, skipped: true });

  } catch (err) {
    console.error('Webhook error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── PROCESSA TRANSCRIÇÃO ────────────────────────────────────────────────────
async function processTranscript(callObj, dialogue) {
  if (isVoicemail(dialogue)) {
    console.log('Voicemail detectado — removendo:', callObj.openPhoneId);
    calls = calls.filter(c => c.openPhoneId !== callObj.openPhoneId);
    return;
  }

  if (!isRealConversation(dialogue)) {
    console.log('Conversa muito curta — removendo:', callObj.openPhoneId);
    calls = calls.filter(c => c.openPhoneId !== callObj.openPhoneId);
    return;
  }

  // Monta transcrição
  const transcript = dialogue.map(d => `${d.identifier || 'Speaker'}: ${d.content}`).join('\n');
  callObj.transcript = transcript;
  callObj.status = 'atendida';

  // Calcula duração pelo dialogue
  if (dialogue.length > 0) {
    const lastLine = dialogue[dialogue.length - 1];
    const totalSecs = Math.round(lastLine.end || 0);
    const mins = Math.floor(totalSecs / 60);
    const secs = totalSecs % 60;
    callObj.duration = `${mins}:${secs.toString().padStart(2, '0')}`;
  }

  // Analisa com Claude
  try {
    const analysis = await analyzeWithClaude(transcript, callObj.sdr);
    callObj.score = analysis?.score || 0;
    callObj.issues = (analysis?.pontos_positivos || []).concat((analysis?.erros || []).map(e => '⚠️ ' + e));
    callObj.erros = analysis?.erros || [];
    callObj.suggestion = analysis?.sugestao || '';
    callObj.scores_detalhados = analysis?.scores_detalhados || {};
    callObj.resumo = analysis?.resumo || '';
    callObj.result = analysis?.agendou ? 'agendou' : 'nao_agendou';
    console.log('Análise concluída - score:', callObj.score);
  } catch (e) {
    console.error('Erro Claude:', e.message);
  }
}

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
      erros: analysis?.erros || [],
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

// ─── STATS ───────────────────────────────────────────────────────────────────
app.get('/api/stats', (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  const todayCalls = calls.filter(c => c.createdAt.startsWith(today));

  const total = todayCalls.length;
  const atendidas = todayCalls.filter(c => c.status === 'atendida').length;
  const agendamentos = todayCalls.filter(c => c.result === 'agendou').length;
  const naoAtendeu = todayCalls.filter(c => c.status === 'nao_atendeu').length;
  const scoreTotal = todayCalls.filter(c => c.score > 0).reduce((a, c) => a + c.score, 0);
  const scoreMedio = atendidas > 0 ? Math.round(scoreTotal / atendidas) : 0;

  // Corrigido — usa c.erros (array separado)
  const objecoes = {};
  todayCalls.forEach(c => {
    (c.erros || []).forEach(e => {
      objecoes[e] = (objecoes[e] || 0) + 1;
    });
  });

  res.json({ total, atendidas, agendamentos, naoAtendeu, scoreMedio, objecoes });
});

// ─── CLAUDE ──────────────────────────────────────────────────────────────────
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
