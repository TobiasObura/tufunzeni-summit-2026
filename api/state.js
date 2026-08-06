import { kv } from '@vercel/kv';

const PILLAR_COUNT = 5;
const ACTIONS_PER_PILLAR = 3;
const FEED_MAX = 20;
const TEXT_MAX = 500;

const NS = 'tufunzeni2026';
const pillarKey = (pi) => `${NS}:pillar:${pi}`;
const actionKey = (pi, ai) => `${NS}:action:${pi}:${ai}`;
const TOTAL_KEY = `${NS}:totalActions`;
const FULL_KEY = `${NS}:fullPlans`;
const FEED_KEY = `${NS}:feed`;

function clamp(n) {
  return Math.max(0, Number(n) || 0);
}

function sanitizeSelection(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [pi, ai] of Object.entries(raw)) {
    const p = Number(pi);
    const a = Number(ai);
    if (Number.isInteger(p) && p >= 0 && p < PILLAR_COUNT &&
        Number.isInteger(a) && a >= 0 && a < ACTIONS_PER_PILLAR) {
      out[p] = a;
    }
  }
  return out;
}

export default async function handler(req, res) {
  if (req.method === 'GET') return handleGet(req, res);
  if (req.method === 'POST') return handlePost(req, res);
  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'Method not allowed' });
}

async function handleGet(req, res) {
  try {
    const pipeline = kv.pipeline();
    for (let pi = 0; pi < PILLAR_COUNT; pi++) {
      pipeline.get(pillarKey(pi));
      for (let ai = 0; ai < ACTIONS_PER_PILLAR; ai++) {
        pipeline.get(actionKey(pi, ai));
      }
    }
    pipeline.get(TOTAL_KEY);
    pipeline.get(FULL_KEY);
    pipeline.lrange(FEED_KEY, 0, -1);

    const results = await pipeline.exec();
    let idx = 0;
    const pillarCounts = [];
    const actionCounts = [];
    for (let pi = 0; pi < PILLAR_COUNT; pi++) {
      pillarCounts.push(clamp(results[idx++]));
      const row = [];
      for (let ai = 0; ai < ACTIONS_PER_PILLAR; ai++) {
        row.push(clamp(results[idx++]));
      }
      actionCounts.push(row);
    }
    const totalActions = clamp(results[idx++]);
    const fullPlans = clamp(results[idx++]);
    const feed = Array.isArray(results[idx++]) ? results[idx - 1] : [];

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ pillarCounts, actionCounts, totalActions, fullPlans, feed });
  } catch (err) {
    console.error('state GET failed', err);
    return res.status(500).json({ error: 'Failed to read state' });
  }
}

async function handlePost(req, res) {
  try {
    const body = req.body || {};
    const prevSelection = sanitizeSelection(body.prevSelection);
    const newSelection = sanitizeSelection(body.newSelection);
    const text = String(body.commitmentText || '').trim().slice(0, TEXT_MAX);

    const pipeline = kv.pipeline();

    Object.entries(prevSelection).forEach(([pi, ai]) => {
      pipeline.decr(pillarKey(pi));
      pipeline.decr(actionKey(pi, ai));
      pipeline.decr(TOTAL_KEY);
    });
    Object.entries(newSelection).forEach(([pi, ai]) => {
      pipeline.incr(pillarKey(pi));
      pipeline.incr(actionKey(pi, ai));
      pipeline.incr(TOTAL_KEY);
    });

    const prevFull = Object.keys(prevSelection).length === PILLAR_COUNT;
    const newFull = Object.keys(newSelection).length === PILLAR_COUNT;
    if (prevFull && !newFull) pipeline.decr(FULL_KEY);
    if (!prevFull && newFull) pipeline.incr(FULL_KEY);

    if (newFull && text) {
      pipeline.lrem(FEED_KEY, 0, text);
      pipeline.rpush(FEED_KEY, text);
      pipeline.ltrim(FEED_KEY, -FEED_MAX, -1);
    }

    await pipeline.exec();

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('state POST failed', err);
    return res.status(500).json({ error: 'Failed to update state' });
  }
}
