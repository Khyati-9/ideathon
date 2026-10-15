import { extractMessages, handleMessage, validSignature } from '../../../whatsapp-bot.mjs';

const readBody = request => new Promise((resolve, reject) => {
  const chunks = [];
  request.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
  request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  request.on('error', reject);
});

export default async function handler(request, response) {
  if (request.method === 'GET') {
    const mode = request.query?.['hub.mode'] || request.query?.hub_mode;
    const token = request.query?.['hub.verify_token'] || request.query?.hub_verify_token;
    const challenge = request.query?.['hub.challenge'] || request.query?.hub_challenge;
    if (mode === 'subscribe' && token === (process.env.WHATSAPP_VERIFY_TOKEN || 'change-this-verify-token')) {
      response.status(200).send(challenge || '');
      return;
    }
    response.status(403).send('Forbidden');
    return;
  }
  if (request.method !== 'POST') {
    response.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const raw = await readBody(request);
  if (!validSignature(request, raw)) {
    response.status(401).send('Invalid signature');
    return;
  }
  let payload;
  try { payload = JSON.parse(raw); } catch {
    response.status(200).json({ ok: true });
    return;
  }

  // Acknowledge quickly; production should put the payload in a durable queue first.
  response.status(200).json({ ok: true });
  for (const item of extractMessages(payload)) {
    handleMessage(item.phone, item.message).catch(error => console.error('WhatsApp message error', error));
  }
}
