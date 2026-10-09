import fs from 'node:fs/promises';
import path from 'node:path';

const dir = path.dirname(new URL(import.meta.url).pathname);
const text = await fs.readFile(path.join(dir, 'narration.txt'), 'utf8');
const parts = text.trim().split(/\n\s*\n/);
const key = process.env.SARVAM_API_KEY;
if (!key) throw new Error('SARVAM_API_KEY is required');

for (let i = 0; i < parts.length; i++) {
  const response = await fetch('https://api.sarvam.ai/text-to-speech', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'api-subscription-key': key },
    body: JSON.stringify({ text: parts[i], language_code: 'en-IN', model: 'bulbul:v3', speaker: 'shubh', pace: 1, output_audio_codec: 'wav' }),
  });
  if (!response.ok) throw new Error(`Sarvam TTS paragraph ${i + 1}: HTTP ${response.status} ${await response.text()}`);
  const body = await response.json();
  if (!Array.isArray(body.audios) || !body.audios[0]) throw new Error(`Sarvam TTS paragraph ${i + 1}: no audio`);
  await fs.writeFile(path.join(dir, `voice-${String(i + 1).padStart(2, '0')}.wav`), Buffer.from(body.audios.join(''), 'base64'));
  console.log(`Generated paragraph ${i + 1}/${parts.length}`);
}
