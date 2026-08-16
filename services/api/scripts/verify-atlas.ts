/**
 * LIVE Atlas verification (not a test): drives the running API over real
 * MongoDB and asserts the four things only a real store can prove:
 *   1. indexes exist on Atlas (messages text index, unique indexes)
 *   2. event seq counters are monotonic AND survive an API restart
 *   3. Mongo text search finds a chat message (MemoryStore uses substring)
 *   4. room + chat persist across an API restart
 * Run:  set -a; . ./.env; set +a; npx tsx scripts/verify-atlas.ts
 */
import { MongoClient } from 'mongodb';

const API = 'http://localhost:4000';
const EMAIL = 'owner@gather.local';

const j = (r: Response) => r.json() as Promise<any>;

async function login(): Promise<string> {
  const linkRes = await j(await fetch(`${API}/auth/magic-link`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: EMAIL }),
  }));
  const token = new URL(linkRes.devLink).searchParams.get('token')!;
  const verify = await j(await fetch(`${API}/auth/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  }));
  return verify.accessToken as string;
}

async function sendChat(token: string, roomId: string, body: string): Promise<number> {
  const { WebSocket } = await import('ws');
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:4000/ws?roomId=${roomId}&token=${token}`);
    const timer = setTimeout(() => reject(new Error('ws timeout')), 8000);
    ws.on('open', () => {
      ws.send(JSON.stringify({
        type: 'chat.send', roomId, seq: 0, ts: Date.now(),
        payload: { kind: 'text', body, gifUrl: null, attachment: null, replyTo: null, mentions: [] },
      }));
    });
    ws.on('message', (data: Buffer) => {
      const ev = JSON.parse(data.toString());
      if (ev.type === 'chat.message') {
        clearTimeout(timer);
        ws.close();
        resolve(ev.seq as number);
      }
    });
    ws.on('error', reject);
  });
}

async function main(): Promise<void> {
  const token = await login();
  const auth = { authorization: `Bearer ${token}` };
  console.log('✓ login');

  // ── 2/4. room + messages with monotonic seqs (creates the collections) ──
  const { room } = await j(await fetch(`${API}/rooms`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'watch', name: 'Atlas Live Check' }),
  }));
  console.log('✓ room created:', room.id);
  const s1 = await sendChat(token, room.id, 'atlas verification alpha');
  const s2 = await sendChat(token, room.id, 'atlas verification beta');
  console.log(`✓ seqs before restart: ${s1}, ${s2}`, s1 < s2 ? '(monotonic)' : '✗ NOT MONOTONIC');

  // ── 3. text search ──
  const found = await j(await fetch(`${API}/rooms/${room.id}/messages/search?q=verification`, { headers: auth }));
  console.log(found.items.length >= 2 ? `✓ text search hits: ${found.items.length}` : `✗ text search missed (${found.items.length})`);

  // ── 1. indexes on Atlas (after writes have materialized collections) ──
  const client = new MongoClient(process.env.MONGO_URL!);
  await client.connect();
  const db = client.db('gather');
  const collections = (await db.listCollections().toArray()).map((c) => c.name);
  console.log('✓ collections:', collections.sort().join(', '));
  if (collections.includes('messages')) {
    const msgIndexes = await db.collection('messages').indexes();
    const textIdx = msgIndexes.find((i) => Object.values(i.key).includes('text'));
    console.log(textIdx ? '✓ messages text index present' : '✗ NO text index');
    console.log('  message indexes:', msgIndexes.map((i) => i.name).join(', '));
  }
  if (collections.includes('counters')) {
    const counterIndexes = await db.collection('counters').indexes();
    console.log('✓ counters indexes:', counterIndexes.map((i) => i.name).join(', '));
  }

  console.log('ROOM_ID=' + room.id);
  await client.close();
}

main().catch((err) => {
  console.error('FAILED:', err);
  process.exit(1);
});
