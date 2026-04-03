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

// ─── ÉTAPE 0 : Génération des seeds par Gemini ───────────────

async function generateSeedKeywords() {
  const today = new Date().toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });

  const prompt = `Tu es un expert en culture internet, micro-tendances TikTok et comportements numériques des collégiens français (11-15 ans). Nous sommes le ${today}.

⚙️ PROTOCOLE DE DOUBLE VÉRIFICATION (obligatoire)
Avant d'inclure une tendance, tu dois :
1. Identifier la tendance depuis une première source (TikTok FR, Twitter/X, YouTube Shorts).
2. La confirmer via une seconde source indépendante (autre compte, autre format, autre plateforme).
3. Si tu ne peux pas confirmer la tendance, tu NE l'inclus PAS dans la liste.

🎯 MISSION
Génère une liste de 15 micro-tendances actives chez les collégiens français, datant de moins de 6 semaines, qui sont :
- Virales sur TikTok FR ou Reels Instagram FR
- Reconnaissables instantanément par un élève de 6e à 3e

🧠 RAISONNEMENT REQUIS (chain-of-thought)
Pour CHAQUE tendance, avant de la présenter, raisonne en interne :
→ "Est-ce que cette trend est encore active aujourd'hui ou est-elle déjà passée ?, Si oui la garder si non ou doute la rejeter et ne pas en parler"
→ "A-t-elle bien pénétré le contexte francophone ? Si oui on la garde si non ou doute on la supprime"
Si la réponse à l'une de ces questions est non ou incertaine, tu exclus la tendance.

📋 FORMAT DE SORTIE (strictement respecté pour chaque tendance)
Numéro. Mot-clé / hashtag / phrase virale
- Explication courte (1 ligne max)
- Origine : [plateforme principale] — [type de contenu : son / format / meme / phrase]
- Vues estimées : [ordre de grandeur sur les contenus liés]
- Usage collège : [comment elle est utilisée IRL : blague / imitation / running gag / expression / défi]
- Durée de vie estimée : [en semaines restantes approximatives]
- Score fiabilité : [X/5] — [justification en 5 mots max]

⚠️ CONTRAINTES STRICTES (non négociables)
✗ Exclure tout hashtag générique (#fyp, #viral, #pourtoi, #trending)
✗ Exclure les tendances de plus de 6 semaines
✗ Exclure les trends majoritairement adultes (18 ans et plus)
✗ Exclure les tendances non confirmées par toi même deux fois
✗ Exclure les tendances restées confinées à la sphère anglophone et à l'étranger
✓ Cibler uniquement : collégiens francophones (France métropolitaine principalement)
Il faut viser absolument les contenus pouvant être vus en France

📊 SYNTHÈSE FINALE
Après la liste, fournis :
- Top 3 des tendances les plus "sûres" à utiliser dans une appli parents
- 2 tendances à surveiller (montantes mais pas encore mainstream)
- 1 tendance à éviter car trop risquée ou ambiguë pour un public parental

OBLIGATONS :
Vérifies toi même ce que tu dis deux fois
Vérifies que ce sont des trends françaises et à la mode en France



`;

  try {
    const raw = await callMistral(prompt, 0.45);

    const trends = [];
    const blocks = raw.split(/\n(?=\d+\.\s+)/);
    
    for (const block of blocks) {
      const lines = block.split('\n').filter(l => l.trim().length > 0);
      if (lines.length === 0) continue;

      let titleLine = lines[0].replace(/^\d+\.\s*/, '').trim();
      titleLine = titleLine.replace(/\*\*/g, ''); // enlever le gras

      let tagRaw = titleLine;
      let explanation = "";
      
      const parts = titleLine.match(/^(.*?)\s*(?:[-:—])\s*(.*)$/);
      if (parts) {
         tagRaw = parts[1];
         explanation = parts[2].trim();
      }

      // Si le mot clé est entre guillemets, on prend le contenu
      const quoteMatch = tagRaw.match(/['"«](.*?)['"»]/);
      let tagStr = quoteMatch ? quoteMatch[1] : tagRaw;
      
      // Nettoyage des préfixes inutiles
      tagStr = tagStr.replace(/^(le|la|les|un|une|des|hashtag|phrase|son|défi|trend)\s+/i, '').trim();
      
      // Transformation en format hashtag (minuscules, sans accents, sans espaces)
      const tag = tagStr.toLowerCase()
        .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9]/g, '');

      if (!tag || tag.length < 2) continue;
      
      const viewsMatch = block.match(/- Vues estimées\s*:\s*(.*)/i);
      const viewsRaw = viewsMatch ? viewsMatch[1].replace(/\*\*/g, '').trim() : '';
      
      const originMatch = block.match(/- Origine\s*:\s*(.*)/i);
      const origin = originMatch ? originMatch[1].trim() : '';

      const usageMatch = block.match(/- Usage collège\s*:\s*(.*)/i);
      const usage = usageMatch ? usageMatch[1].trim() : '';

      const confMatch = block.match(/- Score fiabilité\s*:\s*(\d)\/5/i);
      const confidence = confMatch ? parseInt(confMatch[1]) * 20 : 80;

      trends.push({
        tag: tag,
        views: parseCount(viewsRaw) || null,
        posts: null,
        viewsFmt: viewsRaw || 'N/A',
        postsFmt: 'N/A',
        trendScore: confidence, 
        isRising: true,
        aiConfidence: confidence,
        category: getCategory(tag),
        explanation: `${explanation}${usage ? ' Usage : ' + usage : ''}`,
      });
    }

    console.log(`   🤖 Mistral a généré et analysé ${trends.length} tendances.`);
    return trends;

  } catch (e) {
    console.error(`   ❌ Échec génération IA : ${e.message}`);
    return [];
  }
}

// Étapes 1 à 3 supprimées, le nouveau prompt Mistral s'occupe de tout le filtrage.

// ─── ÉTAPE 4 : Vidéo exemple sur TikTok ─────────────────────

async function getExampleVideo(page, hashtag) {
  try {
    await page.goto(
      `https://www.tiktok.com/tag/${encodeURIComponent(hashtag)}`,
      { waitUntil: 'domcontentloaded', timeout: 28000 }
    );
    await sleep(3000);

    const videoData = await page.evaluate(() => {
      // Cherche tous les liens vidéo de la page
      const links = Array.from(document.querySelectorAll('a[href*="/video/"]'));
      for (const link of links) {
        const match = (link.href || '').match(/\/@([^/]+)\/video\/(\d+)/);
        if (!match) continue;

        const author = '@' + match[1];
        const videoId = match[2];
        const videoUrl = `https://www.tiktok.com/@${match[1]}/video/${match[2]}`;

        // Cherche une description dans les éléments voisins
        const container = link.closest('[class*="DivWrapper"], [class*="item"], article, li');
        let description = null;
        if (container) {
          const descEl = container.querySelector(
            '[class*="SpanText"], [class*="desc"], [class*="caption"], p'
          );
          description = descEl?.textContent?.trim()?.slice(0, 150) ?? null;
          // Ignore si la description est juste le nom d'utilisateur
          if (description && description === match[1]) description = null;
        }

        return { author, videoId, videoUrl, description };
      }
      return null;
    });

    if (!videoData) return null;

    return {
      ...videoData,
      embedUrl: `https://www.tiktok.com/embed/v2/${videoData.videoId}`,
    };

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

    // ── 1. GÉNÉRATION DES TENDANCES PAR L'IA ──────────────────
    console.log('\n🤖 ÉTAPE 1 — Génération et Analyse par Mistral AI...');
    let finalTrends = await generateSeedKeywords();
    
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
