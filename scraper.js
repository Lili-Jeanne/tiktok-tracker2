// ============================================================
// scraper.js — TikTok Tracker pour les Parents
// Pipeline : Tavily Sourcing → Groq Filtering → TikTok Vidéo → Export
// ============================================================
require('dotenv').config();
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const fs = require('fs');

chromium.use(stealth);

// ─── CONFIG ──────────────────────────────────────────────────
const MAX_FINAL_TRENDS = 20;   // Trends max dans le JSON final
const TAVILY_MAX_RESULTS = 5;  // Résultats par requête Tavily

// ─── REQUÊTES DE SOURCING ────────────────────────────────────
// Construites dynamiquement avec le mois/année courants pour forcer la récence

function buildQueries() {
  const now = new Date();
  const monthEN = now.toLocaleDateString('en-US', { month: 'long' }); // ex: "April"
  const monthFR = now.toLocaleDateString('fr-FR', { month: 'long' }); // ex: "avril"
  const year = now.getFullYear();

  return [
    // ─ Tendances TikTok générales (datées)
    `new tiktok trends teenagers ${monthEN} ${year} just went viral`,
    `viral tiktok hashtags Gen Z rising ${monthEN} ${year}`,

    // ─ Argot / slang émergent
    `new gen z slang words ${monthEN} ${year} meaning teenagers`,
    `nouveau argot ados collégiens france ${monthFR} ${year} tiktok`,

    // ─ Sources spécialisées trend-tracking
    `site:knowyourmeme.com new trending memes ${year}`,
    `reddit "what does" new slang teenagers tiktok ${year}`,

    // ─ Contenu viral spécifique
    `trending tiktok sounds ${monthEN} ${year} new viral audio`,
    `new tiktok dance challenge emote ${monthEN} ${year}`,

    // ─ Gaming / jeux en vogue
    `most popular games teenagers tiktok ${monthEN} ${year}`,

    // ─ Culture française spécifique
    `tendances tiktok france ados ${monthFR} ${year} nouveau viral`,
  ];
}

// ─── UTILITAIRES ─────────────────────────────────────────────

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Détermine la catégorie d'un hashtag pour l'affichage parent
 */
function getCategory(tag) {
  const t = tag.toLowerCase();
  const has = (...kw) => kw.some(k => t.includes(k));
  if (has('skibidi', 'sigma', 'rizz', 'gyatt', 'npc', 'fanum', 'delulu', 'aura', 'alpha',
    'mewing', 'looksmax', 'mogging', 'glazing', 'sus', 'cap', 'nocap', 'bussin',
    'goat', 'based', 'cringe', 'pookie', 'brainrot', 'slay', 'periodt'))
    return 'Argot internet / Brainrot';
  if (has('fortnite', 'roblox', 'minecraft', 'freefire', 'brawl', 'clash', 'valorant',
    'cod', 'genshin', 'pubg', 'apex', 'overwatch', 'pokemon', 'mario', 'gaming',
    'gamer', 'streamer', 'twitch', 'league'))
    return 'Gaming';
  if (has('emote', 'dance', 'choreo', 'shuffle', 'griddy', 'phonk', 'drift', 'twerk'))
    return 'Danse / Emote';
  if (has('college', 'collège', 'lycee', 'prof', 'cours', 'brevet', 'bac', 'cantine',
    'recre', 'rentree', 'interro', 'devoir'))
    return 'Vie scolaire';
  if (has('pov', 'challenge', 'duet', 'grwm', 'aesthetic', 'outfit', 'drip', 'sneaker',
    'vlog', 'viral', 'ohio', 'trend', 'fyp', 'foryou'))
    return 'Contenu viral';
  if (has('rap', 'drill', 'trap', 'afro', 'rnb', 'taylorswift', 'sabrina', 'olivia',
    'ariana', 'doja', 'centralcee', 'jul', 'niska', 'sch', 'musique', 'music'))
    return 'Musique';
  if (has('anime', 'manga', 'otaku', 'naruto', 'demon', 'jjk', 'aot', 'onepiece'))
    return 'Anime / Manga';
  return 'Tendance ados';
}

// ─── PHASE 1 : SOURCING TAVILY ───────────────────────────────

/**
 * Lance une requête sur l'API Tavily et retourne les snippets
 */
async function tavilySearch(query) {
  let apiKey = process.env.TAVILY_API_KEY;
  if (apiKey) apiKey = apiKey.replace(/^["']|["']$/g, '').trim();
  if (!apiKey) throw new Error('TAVILY_API_KEY manquante');

  try {
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: apiKey,
        query,
        search_depth: 'basic',
        max_results: TAVILY_MAX_RESULTS,
        include_answer: false,
        include_raw_content: false,
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`HTTP ${res.status} — ${err.slice(0, 120)}`);
    }

    const data = await res.json();
    return (data.results || []).map(r => ({
      title: r.title || '',
      // Tronqué à 400 chars pour économiser les tokens Groq
      content: (r.content || '').slice(0, 400),
      url: r.url || '',
    }));
  } catch (e) {
    console.warn(`   ⚠️  Tavily erreur pour "${query}" : ${e.message}`);
    return [];
  }
}

/**
 * Lance toutes les requêtes de sourcing et retourne les snippets dédupliqués
 */
async function sourceTrends() {
  const queries = buildQueries();
  console.log(`   📡 ${queries.length} requêtes Tavily (${new Date().toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' })})...\n`);
  const allSnippets = [];

  for (const query of queries) {
    process.stdout.write(`   🔍 "${query}" → `);
    const results = await tavilySearch(query);
    console.log(`${results.length} résultat(s)`);
    allSnippets.push(...results);
    await sleep(350); // Pause légère pour éviter le rate limiting
  }

  // Déduplication par URL
  const seen = new Set();
  const unique = allSnippets.filter(s => {
    if (!s.url || seen.has(s.url)) return false;
    seen.add(s.url);
    return true;
  });

  console.log(`\n   ✅ ${unique.length} snippets uniques collectés sur ${allSnippets.length} au total.`);
  return unique;
}

// ─── PHASE 2 : FILTRAGE GROQ (désactivé pour test) ─────────────

/*
async function callGroq(prompt, temperature = 0.2) {
  let apiKey = process.env.GROQ_API_KEY;
  if (apiKey) apiKey = apiKey.replace(/^["']|["']$/g, '').trim();
  if (!apiKey) throw new Error('GROQ_API_KEY manquante');

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          messages: [{ role: 'user', content: prompt }],
          temperature,
        }),
      });

      if (!res.ok) {
        const errText = await res.text();
        let errMsg = `HTTP ${res.status}`;
        try {
          const errJson = JSON.parse(errText);
          if (errJson.error?.message) errMsg += ` - ${errJson.error.message}`;
          else if (errJson.message) errMsg += ` - ${errJson.message}`;
        } catch (_) {
          errMsg += ` - ${errText.slice(0, 100)}`;
        }
        throw new Error(errMsg);
      }

      const data = await res.json();
      const text = data?.choices?.[0]?.message?.content ?? '';
      if (!text) throw new Error('Réponse Groq vide');

      return text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

    } catch (e) {
      console.warn(`   ⚠️  Groq tentative ${attempt}/3 : ${e.message}`);
      if (attempt < 3) await sleep(1500 * attempt);
    }
  }
  throw new Error('Groq indisponible après 3 tentatives');
}
*/

/*
async function filterTrendsWithGroq(snippets) {
  const today = new Date().toLocaleDateString('fr-FR', {
    day: 'numeric', month: 'long', year: 'numeric'
  });

  const context = snippets
    .map((s, i) => `[${i + 1}] ${s.title}\n${s.content}`)
    .join('\n\n');

  const prompt = `Tu es un analyste culturel expert en tendances TikTok chez les collégiens français (11-15 ans). Nous sommes le ${today}.

Tu reçois ci-dessous ${snippets.length} extraits bruts issus du web (articles, forums, listes de tendances). Ton rôle : identifier les tendances qui ont ÉMERGÉ ou EXPLOSÉ récemment (dans les 1 à 4 derniers mois), et qui n'étaient PAS populaires il y a 4 mois.

=== EXTRAITS WEB ===
${context}
=== FIN DES EXTRAITS ===

CRITÈRES DE SÉLECTION — LIS ATTENTIVEMENT :

✅ INCLURE seulement si la tendance EST NOUVELLE : née ou devenue virale dans les 1 à 4 derniers mois
✅ La tendance doit être mentionnée dans les extraits ci-dessus (ne pas inventer)
✅ La tendance doit être utilisée par des collégiens français (11-15 ans)
✅ Le hashtag = UN SEUL MOT, minuscules, sans espace, sans # et sans accents
✅ L'explication est destinée à des PARENTS : claire, simple, sans jargon
✅ La catégorie doit être exactement l'une de : "Argot internet / Brainrot", "Gaming", "Danse / Emote", "Vie scolaire", "Contenu viral", "Musique", "Anime / Manga", "Tendance ados"
✅ "fiabilite" = score 0-100 selon la récence ET la fréquence de mention
✅ "vues" = si mentionné dans les extraits, sinon "N/A"

❌ EXCLURE les tendances établies depuis plus de 6 mois (même si encore populaires)
❌ EXCLURE : fyp, viral, tiktok, trending, france, pourtoi (trop génériques)
❌ EXCLURE les tendances réservées aux adultes (18+)
❌ EXCLURE ce qui n'est pas mentionné dans les extraits
❌ Le hashtag ne doit pas contenir d'espaces, tirets, apostrophes ou caractères spéciaux

EXEMPLES du type de tendances attendues (à titre illustratif — ne pas copier si non présentes dans les extraits) :
• "skibidi" → argot/animation absurde devenue virale chez les ados
• "forsure" → expression d'approbation exagérée utilisée ironiquement
• "looksmax" → obsession d'améliorer son apparence physique
• "gyatt" → exclamation de surprise devant quelqu'un d'attirant

Réponds UNIQUEMENT avec un tableau JSON valide de 10 à 15 éléments, sans texte avant ni après, sans bloc markdown :
[
  {
    "hashtag": "exemple",
    "explication": "Ce que c'est en clair pour un parent : origine, usage, pourquoi les ados l'utilisent.",
    "categorie": "Argot internet / Brainrot",
    "fiabilite": 85,
    "vues": "50M+"
  }
]`;

  const raw = await callGroq(prompt, 0.2);

  const match = raw.match(/\[[\s\S]*\]/);
  if (!match) throw new Error('Pas de tableau JSON dans la réponse Groq');

  const parsed = JSON.parse(match[0]);
  if (!Array.isArray(parsed) || parsed.length === 0) throw new Error('Tableau Groq vide');

  return parsed
    .filter(item => typeof item.hashtag === 'string' && item.hashtag.trim().length >= 2)
    .map(item => {
      const tag = item.hashtag.toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]/g, '');
      return {
        tag,
        views: null,
        posts: null,
        viewsFmt: item.vues || 'N/A',
        postsFmt: 'N/A',
        trendScore: typeof item.fiabilite === 'number' ? item.fiabilite : 80,
        isRising: true,
        aiConfidence: typeof item.fiabilite === 'number' ? item.fiabilite : 80,
        category: item.categorie || getCategory(tag),
        explanation: item.explication || null,
      };
    })
    .filter(t => t.tag.length >= 2);
}
*/

// ─── PHASE 3 : VIDÉO EXEMPLE TIKTOK ─────────────────────────

async function getExampleVideo(page, hashtag) {
  try {
    await page.goto(
      `https://www.tiktok.com/tag/${encodeURIComponent(hashtag)}`,
      { waitUntil: 'networkidle', timeout: 30000 }
    );
    await sleep(5000);

    const videoData = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a[href*="/video/"]'));
      const videoLinks = links.filter(l => /\/@[^/]+\/video\/\d{15,}/.test(l.href || ''));
      if (videoLinks.length === 0) return null;

      const idx = Math.floor(Math.random() * Math.min(3, videoLinks.length));
      const link = videoLinks[idx];
      const match = (link.href || '').match(/\/@([^/]+)\/video\/(\d+)/);
      if (!match) return null;

      return {
        author: '@' + match[1],
        videoId: match[2],
        videoUrl: `https://www.tiktok.com/@${match[1]}/video/${match[2]}`,
        embedUrl: `https://www.tiktok.com/embed/v2/${match[2]}`,
      };
    });

    return videoData || null;

  } catch {
    return null;
  }
}

// ─── MAIN ────────────────────────────────────────────────────

async function run() {
  console.log('\n🚀 TikTok Tracker — Démarrage du pipeline\n' + '='.repeat(50));

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();

  await page.setExtraHTTPHeaders({
    'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  });
  await page.setViewportSize({ width: 1280, height: 900 });

  try {

    // ── ÉTAPE 1 : SOURCING TAVILY ──────────────────────────
    console.log('\n📡 ÉTAPE 1 — Sourcing web via Tavily Search API...');
    const snippets = await sourceTrends();

    if (snippets.length === 0) {
      console.error('❌ Aucun snippet collecté depuis Tavily. Vérifier TAVILY_API_KEY.');
      process.exit(1);
    }

    // ── ÉTAPE 2 : FILTRAGE GROQ ────────────────────────────
    console.log(`\n🤖 ÉTAPE 2 — Filtrage IA (Groq / LLaMA 3.3) sur ${snippets.length} snippets...`);
    let finalTrends;
    try {
      finalTrends = await filterTrendsWithGroq(snippets);
      console.log(`   ✅ Groq a extrait ${finalTrends.length} tendances depuis le web.`);
    } catch (e) {
      console.error(`   ❌ Échec filtrage Groq : ${e.message}`);
      process.exit(1);
    }

    if (finalTrends.length === 0) {
      console.error('❌ Aucune tendance extraite. Arrêt.');
      process.exit(1);
    }

    // Limitation au max configuré
    if (finalTrends.length > MAX_FINAL_TRENDS) {
      finalTrends = finalTrends.slice(0, MAX_FINAL_TRENDS);
    }

    // ── ÉTAPE 3 : VIDÉOS EXEMPLES ─────────────────────────
    console.log(`\n🎬 ÉTAPE 3 — Recherche de vidéo exemple TikTok...`);

    for (const trend of finalTrends) {
      process.stdout.write(`   🎥 #${trend.tag} → `);
      const video = await getExampleVideo(page, trend.tag);
      if (video) {
        trend.exampleVideo = video;
        console.log(`✅ ${video.author}`);
      } else {
        trend.exampleVideo = null;
        console.log('⚠️  aucune vidéo trouvée');
      }
    }

    // ── EXPORT ────────────────────────────────────────────
    const output = {
      lastUpdate: new Date().toISOString(),
      totalCandidates: snippets.length,
      totalAfterAIFilter: finalTrends.length,
      sources: [
        'Tavily Search API (sourcing web en temps réel)',
        'Groq AI / LLaMA 3.3 70B (filtrage et structuration)',
        'TikTok (vidéo exemple)',
      ],
      trends: finalTrends,
    };

    fs.writeFileSync('trends.json', JSON.stringify(output, null, 2), 'utf8');
    console.log(`\n✅ trends.json exporté avec ${finalTrends.length} tendances.\n`);

  } catch (err) {
    console.error('\n❌ Erreur fatale :', err.message);
    process.exit(1);
  } finally {
    await browser.close();
  }
}

run();
