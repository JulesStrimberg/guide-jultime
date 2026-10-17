// ══════════════════════════════════════════════════════
//  LUC-IA — proxy Cloudflare Worker vers Groq
//  La clé Groq reste ici (secret GROQ_API_KEY), jamais dans le site.
//  Le Worker n'accepte qu'une recherche courte : il lit lui-même le
//  Google Sheet publié et construit le prompt, donc il ne peut pas servir
//  de proxy LLM générique à quelqu'un qui récupérerait son URL.
// ══════════════════════════════════════════════════════

const SHEET_CSV = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vR5w17--h8WAdc4NritirRSbJdCjGdGnm7oytFYRZFDz-x__jsRWULdOcL_cmt0MJlvm7c17zf75g9n/pub?gid=1622534072&single=true&output=csv';
const GROQ_URL  = 'https://api.groq.com/openai/v1/chat/completions';
// llama-3.3-70b-versatile a été retiré par Groq le 16/08/2026 ; remplaçant recommandé.
// Surchargeable par la variable GROQ_MODEL (Settings du Worker) sans toucher au code.
const DEFAULT_MODEL = 'openai/gpt-oss-120b';
const MAX_QUERY = 200;
// Sites autorisés à appeler Luc-IA (surchargeable par la variable ALLOWED_ORIGINS, séparée par des virgules)
const DEFAULT_ORIGINS = 'https://julesstrimberg.github.io';

export default {
  async fetch(request, env, ctx) {
    const allowed = (env.ALLOWED_ORIGINS || DEFAULT_ORIGINS).split(',').map(s => s.trim());
    const origin = request.headers.get('Origin') || '';
    const cors = {
      'Access-Control-Allow-Origin': allowed.includes(origin) ? origin : allowed[0],
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Vary': 'Origin'
    };
    const reply = (body, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'POST')    return reply({ error: 'Méthode non autorisée' }, 405);
    if (!allowed.includes(origin))    return reply({ error: 'Origine non autorisée' }, 403);
    if (!env.GROQ_API_KEY)            return reply({ error: 'Clé Groq non configurée sur le Worker' }, 500);

    // Limite de débit par IP (optionnelle : binding RATE_LIMITER dans wrangler.toml)
    if (env.RATE_LIMITER) {
      const ip = request.headers.get('CF-Connecting-IP') || 'inconnu';
      const { success } = await env.RATE_LIMITER.limit({ key: ip });
      if (!success) return reply({ error: 'Trop de questions d\'un coup, réessaie dans une minute 🙏' }, 429);
    }

    let query = '';
    try { query = String((await request.json()).query || '').trim(); } catch (e) {}
    if (!query)                   return reply({ error: 'Recherche vide' }, 400);
    if (query.length > MAX_QUERY) return reply({ error: 'Recherche trop longue' }, 400);

    let places;
    try { places = await loadPlaces(); }
    catch (e) { return reply({ error: 'Impossible de lire le guide' }, 502); }

    const res = await fetch(GROQ_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${env.GROQ_API_KEY}` },
      body: JSON.stringify({
        model: env.GROQ_MODEL || DEFAULT_MODEL,
        messages: [{ role: 'user', content: buildPrompt(places, query) }],
        temperature: 0.4,
        // gpt-oss raisonne avant de répondre : effort bas et marge de tokens pour le JSON final
        reasoning_effort: 'low',
        max_tokens: 1024
      })
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      return reply({ error: err?.error?.message || 'Groq HTTP ' + res.status }, 502);
    }
    const data = await res.json();
    const raw = data.choices?.[0]?.message?.content || '';
    const m = raw.match(/\{[\s\S]*\}/);
    let recs = [];
    try { recs = m ? (JSON.parse(m[0]).recs || []) : []; } catch (e) {}
    return reply({ recs });
  }
};

// Sheet publié, mis en cache 5 min par Cloudflare ; lieux « bientot » exclus
async function loadPlaces() {
  const res = await fetch(SHEET_CSV, { cf: { cacheTtl: 300, cacheEverything: true } });
  if (!res.ok) throw new Error('Sheet HTTP ' + res.status);
  const rows = parseCSV(await res.text());
  const hdr = rows[0].map(h => h.trim());
  return rows.slice(1)
    .map(r => Object.fromEntries(hdr.map((h, i) => [h, (r[i] || '').trim()])))
    .filter(p => p.city && p.name && !/bient|soon/i.test(p.badge || ''));
}

// Offre gratuite Groq : 8000 tokens/minute (prompt + max_tokens). On n'envoie donc
// que les adresses les plus pertinentes, en lignes compactes.
const MAX_PLACES = 60;
const fold = s => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const CITY_WORDS = { milan: ['milan', 'milano'], paris: ['paris'], lyon: ['lyon'] };

function selectPlaces(places, query) {
  const q = fold(query);
  const cities = Object.keys(CITY_WORDS).filter(c => CITY_WORDS[c].some(w => q.includes(w)));
  let pool = cities.length ? places.filter(p => cities.includes(p.city)) : places;
  if (pool.length <= MAX_PLACES) return pool;
  const words = q.split(/[^a-z0-9]+/).filter(w => w.length >= 3 && !Object.values(CITY_WORDS).flat().includes(w));
  const score = p => {
    const hay = fold([p.name, p.type, p.tags, p.desc].join(' '));
    return words.reduce((n, w) => n + (hay.includes(w) ? 1 : 0), 0) + (Number(p.rating) || 0) / 10;
  };
  return pool.map(p => [score(p), p]).sort((a, b) => b[0] - a[0]).slice(0, MAX_PLACES).map(x => x[1]);
}

function buildPrompt(places, query) {
  const list = selectPlaces(places, query).map(p =>
    `${p.city}|${p.name}|${p.type}|${p.price}|${p.rating || '?'}★|${(p.tags || '').replace(/\|/g, ',')}|${(p.desc || '').slice(0, 90)}`
  ).join('\n');
  return `Tu es Luc-IA, l'assistante du Guide Jultime — celle qui a toujours toutes les infos sur les meilleures adresses de Milan, Paris et Lyon.
Adresses disponibles (ville|nom|type|prix|note|tags|avis) :
${list}

L'utilisateur cherche : "${query.replace(/"/g, "'")}"

Recommande exactement 2 ou 3 adresses de la liste qui correspondent le mieux à sa recherche.
Réponds UNIQUEMENT en JSON valide, sans texte autour, au format :
{
  "recs": [
    { "name": "Nom exact de l'adresse", "city": "milan|paris|lyon", "why": "Courte explication chaleureuse en français (1-2 phrases max)" },
    ...
  ]
}
Utilise uniquement des noms qui apparaissent exactement dans la liste. Ne modifie pas les noms.`;
}

function parseCSV(text) {
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i+1] === '"') { cell += '"'; i++; }
      else if (c === '"') { q = false; }
      else { cell += c; }
    } else {
      if (c === '"') { q = true; }
      else if (c === ',') { row.push(cell); cell = ''; }
      else if (c === '\n') { row.push(cell); if (row.some(Boolean)) rows.push(row); row = []; cell = ''; }
      else if (c !== '\r') { cell += c; }
    }
  }
  if (row.length) { row.push(cell); if (row.some(Boolean)) rows.push(row); }
  return rows;
}
