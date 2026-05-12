#!/usr/bin/env node
// Probe what creator_knowledge_topk returns for plausible user questions
// against Vuk's actual corpus. Shows similarity scores + chunk previews.

import { createClient } from '@supabase/supabase-js';
import { GoogleGenAI } from '@google/genai';

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const CREATOR_ID = '74e897d8-6e91-4f00-98ab-190a66c92d9a';

const QUESTIONS = [
  'What is the one-eyed man story?',
  'Tell me about the twins',
  'What does it mean to be a one-eyed man in the land of the blind?',
  'How do we see the world differently?',
  'What is a mental model?',
];

async function embed(text) {
  const r = await ai.models.embedContent({
    model: 'gemini-embedding-001',
    contents: [text],
    config: { outputDimensionality: 768, taskType: 'RETRIEVAL_QUERY' },
  });
  return r.embeddings?.[0]?.values || r.embedding?.values;
}

for (const q of QUESTIONS) {
  console.log(`\n══ "${q}" ══`);
  const vec = await embed(q);
  const { data, error } = await supabase.rpc('creator_knowledge_topk', {
    p_creator_id: CREATOR_ID,
    p_query_vec: '[' + vec.join(',') + ']',
    p_k: 3,
    p_min_similarity: 0.55,
  });
  if (error) { console.log('  ERROR:', error.message); continue; }
  if (!data || data.length === 0) { console.log('  (no passages above 0.55)'); continue; }
  for (const p of data) {
    console.log(`  sim=${Number(p.similarity).toFixed(4)} | ${p.text.slice(0, 180).replace(/\s+/g, ' ')}…`);
  }
}
