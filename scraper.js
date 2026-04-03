// ============================================================
// scraper.js — TikTok Tracker pour les Parents
// Pipeline : Seeds IA → Scraping hashtags → Filtre IA → Google
// Trends → Vidéo exemple → Export trends.json
// ============================================================
require('dotenv').config();
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const googleTrends = require('google-trends-api');
const fs = require('fs');

chromium.use(stealth);

// ─── CONFIG ──────────────────────────────────────────────────
const MAX_FINAL_TRENDS = 20;   // Trends max dans le JSON final
const MAX_POOL_FOR_AI = 50;   // Candidats max envoyés à l'IA
const GT_BATCH_SIZE = 4;    // Requêtes Google Trends en //
const GT_BATCH_DELAY = 900;  // ms entre chaque batch GT

// ─── SEEDS DE SECOURS (si Gemini est KO) ─────────────────────
const FALLBACK_SEEDS = [
  'skibidi', 'sigma', 'rizz', 'npc', 'aura', 'mewing', 'pookie',
  'fortnite', 'roblox', 'freefire', 'brawlstars', 'minecraft',
  'phonk', 'drift', 'pov', 'ohio', 'brainrot', 'looksmax',
  'gyatt', 'genshin', 'valorant', 'delulu',
];

// ─── UTILITAIRES ─────────────────────────────────────────────

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Parse les chaînes de vues TikTok : "20.5 Trillion", "2B", "500K", etc.
 */
function parseCount(str) {
  if (!str) return 0;
  const s = str.trim().replace(/,/g, '');
  const num = parseFloat(s);
  if (isNaN(num)) return 0;
  const low = s.toLowerCase();
  if (low.includes('trillion')) return Math.round(num * 1e12);
  if (low.includes('billion') || low.endsWith('b')) return Math.round(num * 1e9);
  if (low.includes('million') || low.endsWith('m')) return Math.round(num * 1e6);
  if (low.includes('thousand') || low.endsWith('k')) return Math.round(num * 1e3);
  return Math.round(num);
}

/**
 * Formate un nombre pour l'affichage (ex : 1 200 000 → "1.2 M")
 */
function fmtNumber(n) {
  if (!n || n === 0) return null;
  if (n >= 1e12) return (n / 1e12).toFixed(1) + ' T';
  if (n >= 1e9) return (n / 1e9).toFixed(1) + ' Md';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + ' M';
  if (n >= 1e3) return (n / 1e3).toFixed(0) + ' K';
  return String(n);
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

// ─── MISTRAL : appel générique avec retry ─────────────────────

async function callMistral(prompt, temperature = 0.3) {
  let apiKey = process.env.MISTRAL_API_KEY;
  if (apiKey) apiKey = apiKey.replace(/^["']|["']$/g, '').trim();
  if (!apiKey) throw new Error('MISTRAL_API_KEY manquante');

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(
        'https://api.mistral.ai/v1/chat/completions',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
          },
          body: JSON.stringify({
            model: 'mistral-large-latest',
            messages: [{ role: 'user', content: prompt }],
            temperature: temperature
          }),
        }
      );

      if (!res.ok) {
        const errText = await res.text();
        let errMsg = `HTTP ${res.status}`;
        try {
          const errJson = JSON.parse(errText);
          if (errJson.message) errMsg += ` - ${errJson.message}`;
        } catch (_) {
          errMsg += ` - ${errText.slice(0, 100)}`;
        }
        throw new Error(errMsg);
      }

      const data = await res.json();

      const text = data?.choices?.[0]?.message?.content ?? '';
      if (!text) throw new Error('Réponse Mistral vide');

      // Nettoie les éventuels blocs markdown ```json … ```
      return text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

    } catch (e) {
      console.warn(`   ⚠️  Mistral tentative ${attempt}/3 : ${e.message}`);
      if (attempt < 3) await sleep(1500 * attempt);
    }
  }
  throw new Error('Mistral indisponible après 3 tentatives');
}

// ─── ÉTAPE 1 : Génération des tendances par Mistral (JSON) ────

async function generateTrends() {
  const today = new Date().toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });

  const prompt = `Tu es un expert des tendances TikTok chez les collégiens français (11-15 ans). Nous sommes le ${today}.

Ton rôle : Identifier les 15 meilleurs hashtags TikTok actifs EN CE MOMENT, populaires sur TikTok France, reconnus par les collégiens français.

Règles strictes :
- Chaque élément "hashtag" doit être un seul mot, sans espace, sans #, sans accent, tout en minuscules
- Exemples valides : "skibidi", "sigma", "brainrot", "rizz", "glowtok", "miaw", "fanum"
- Exemples invalides : "le son", "la phrase", "c'est pas moi", "oh non oh non"
- Le champ "explication" est une phrase courte EN FRANÇAIS expliquée pour des PARENTS (pas des ados), qui décrit ce que cette tendance représente dans la culture ado actuelle
- Le champ "categorie" doit être l'une de ces valeurs exactes : "Argot internet / Brainrot", "Gaming", "Danse / Emote", "Vie scolaire", "Contenu viral", "Musique", "Anime / Manga", "Tendance ados"
- Le champ "fiabilite" est un entier de 0 à 100 indiquant à quel point cette tendance est active et populaire maintenant en France
- Le champ "vues" est une estimation formatée comme "50M+" ou "200M+"

Réponds UNIQUEMENT avec un tableau JSON valide, sans texte avant ni après, sans markdown :
[
  {
    "hashtag": "skibidi",
    "explication": "Expression comique issue d'un dessin animé internet très populaire chez les ados, utilisée pour faire des blagues absurdes.",
    "categorie": "Argot internet / Brainrot",
    "fiabilite": 95,
    "vues": "500M+"
  }
]`;

  try {
    const raw = await callMistral(prompt, 0.3);

    const match = raw.match(/\[[\s\S]*\]/);
    if (!match) throw new Error('Pas de tableau JSON dans la réponse');

    const parsed = JSON.parse(match[0]);
    if (!Array.isArray(parsed) || parsed.length === 0) throw new Error('Tableau vide');

    const trends = parsed
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

    console.log(`   ✅ Mistral a généré ${trends.length} tendances.`);
    return trends;

  } catch (e) {
    console.error(`   ❌ Échec génération IA : ${e.message}`);
    return [];
  }
}

// ────────────────────────────────────────────────────────────




// ─── ÉTAPE 4 : Vidéo exemple sur TikTok ─────────────────────

async function getExampleVideo(page, hashtag) {
  try {
    await page.goto(
      `https://www.tiktok.com/tag/${encodeURIComponent(hashtag)}`,
      { waitUntil: 'networkidle', timeout: 30000 }
    );
    // Attente supplémentaire pour laisser le JS charger les vidéos
    await sleep(5000);

    const videoData = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a[href*="/video/"]'));
      // Filtrer les liens avec un vrai ID de vidéo (18-19 chiffres)
      const videoLinks = links.filter(l => /\/@[^/]+\/video\/\d{15,}/.test(l.href || ''));
      if (videoLinks.length === 0) return null;

      // Prendre aléatoirement parmi les 3 premiers pour varier
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

    // ── 1. GÉNÉRATION DES TENDANCES PAR L'IA (JSON) ───────────
    console.log('\n🤖 ÉTAPE 1 — Génération des tendances par Mistral AI...');
    let finalTrends = await generateTrends();
    
    if (finalTrends.length === 0) {
       console.log('⚠️ Aucune tendance n\'a été récupérée. Arrêt.');
       process.exit(1);
    }
    
    // Limitation aux 20 meilleurs
    if (finalTrends.length > MAX_FINAL_TRENDS) {
      finalTrends = finalTrends.slice(0, MAX_FINAL_TRENDS);
    }

    // ── 2. VIDÉOS EXEMPLES ────────────────────────────────────
    console.log(`\n🎬 ÉTAPE 2 — Vidéo exemple TikTok pour chaque trend...`);

    for (const trend of finalTrends) {
      process.stdout.write(`   🎥 #${trend.tag} → `);
      const video = await getExampleVideo(page, trend.tag);
      if (video) {
        trend.exampleVideo = video;
        console.log(`✅ ${video.author}`);
      } else {
        trend.exampleVideo = null;
        console.log('⚠️  aucune vidéo');
      }
    }

    // ── EXPORT ───────────────────────────────────────────────
    const output = {
      lastUpdate: new Date().toISOString(),
      totalCandidates: finalTrends.length,
      totalAfterAIFilter: finalTrends.length,
      sources: [
        'Mistral AI (génération tout-en-un)',
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
