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
const MAX_POOL_FOR_AI  = 50;   // Candidats max envoyés à l'IA
const GT_BATCH_SIZE    = 4;    // Requêtes Google Trends en //
const GT_BATCH_DELAY   = 900;  // ms entre chaque batch GT

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
  if (low.includes('trillion'))                  return Math.round(num * 1e12);
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
  if (n >= 1e9)  return (n / 1e9).toFixed(1)  + ' Md';
  if (n >= 1e6)  return (n / 1e6).toFixed(1)  + ' M';
  if (n >= 1e3)  return (n / 1e3).toFixed(0)  + ' K';
  return String(n);
}

/**
 * Détermine la catégorie d'un hashtag pour l'affichage parent
 */
function getCategory(tag) {
  const t = tag.toLowerCase();
  const has = (...kw) => kw.some(k => t.includes(k));
  if (has('skibidi','sigma','rizz','gyatt','npc','fanum','delulu','aura','alpha',
          'mewing','looksmax','mogging','glazing','sus','cap','nocap','bussin',
          'goat','based','cringe','pookie','brainrot','slay','periodt'))
    return 'Argot internet / Brainrot';
  if (has('fortnite','roblox','minecraft','freefire','brawl','clash','valorant',
          'cod','genshin','pubg','apex','overwatch','pokemon','mario','gaming',
          'gamer','streamer','twitch','league'))
    return 'Gaming';
  if (has('emote','dance','choreo','shuffle','griddy','phonk','drift','twerk'))
    return 'Danse / Emote';
  if (has('college','collège','lycee','prof','cours','brevet','bac','cantine',
          'recre','rentree','interro','devoir'))
    return 'Vie scolaire';
  if (has('pov','challenge','duet','grwm','aesthetic','outfit','drip','sneaker',
          'vlog','viral','ohio','trend','fyp','foryou'))
    return 'Contenu viral';
  if (has('rap','drill','trap','afro','rnb','taylorswift','sabrina','olivia',
          'ariana','doja','centralcee','jul','niska','sch','musique','music'))
    return 'Musique';
  if (has('anime','manga','otaku','naruto','demon','jjk','aot','onepiece'))
    return 'Anime / Manga';
  return 'Tendance ados';
}

// ─── GEMINI : appel générique avec retry ─────────────────────

async function callGemini(prompt, temperature = 0.3) {
  let apiKey = process.env.GEMINI_API_KEY;
  if (apiKey) apiKey = apiKey.replace(/^["']|["']$/g, '').trim();
  if (!apiKey) throw new Error('GEMINI_API_KEY manquante');

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature },
          }),
        }
      );

      if (!res.ok) {
        const errText = await res.text();
        let errMsg = `HTTP ${res.status}`;
        try {
          const errJson = JSON.parse(errText);
          if (errJson.error && errJson.error.message) errMsg += ` - ${errJson.error.message}`;
        } catch (_) {
          errMsg += ` - ${errText.slice(0, 100)}`;
        }
        throw new Error(errMsg);
      }

      const data = await res.json();
      if (data.error) throw new Error(data.error.message);

      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
      if (!text) throw new Error('Réponse Gemini vide');

      // Nettoie les éventuels blocs markdown ```json … ```
      return text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

    } catch (e) {
      console.warn(`   ⚠️  Gemini tentative ${attempt}/3 : ${e.message}`);
      if (attempt < 3) await sleep(1500 * attempt);
    }
  }
  throw new Error('Gemini indisponible après 3 tentatives');
}

// ─── ÉTAPE 0 : Génération des seeds par Gemini ───────────────

async function generateSeedKeywords() {
  const today = new Date().toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });

  const prompt = `Tu es un expert de la culture internet et des tendances TikTok des collégiens français (11-15 ans), en ${today}.

Génère une liste de 22 hashtags TikTok actuellement très utilisés par les collégiens français.
Inclus : argot brainrot, gaming, mèmes viraux, danses, termes musicaux ados, culture web fr.
Règles : 1 mot ou expression sans espace, minuscules, sans #, sans accent si possible.
Préfère des termes spécifiques aux ados (pas des hashtags génériques comme "music" ou "tiktok").

Réponds UNIQUEMENT avec un tableau JSON valide de chaînes, sans texte avant ni après, sans markdown :
["terme1","terme2",...]`;

  try {
    const raw = await callGemini(prompt, 0.45);

    // Extraction robuste : cherche le premier [ ... ] dans la réponse
    const match = raw.match(/\[[\s\S]*?\]/);
    if (!match) throw new Error('Aucun tableau JSON trouvé dans la réponse');

    const keywords = JSON.parse(match[0]);
    if (!Array.isArray(keywords) || keywords.length === 0) throw new Error('Tableau vide');

    const cleaned = keywords
      .map(k => String(k).toLowerCase().replace(/^#/, '').trim())
      .filter(k => k.length > 1 && k.length < 40 && /^[a-z0-9_àâéèêëîïôùûüç-]+$/i.test(k));

    console.log(`   🤖 Gemini → ${cleaned.length} seeds : ${cleaned.slice(0, 8).join(', ')}…`);
    return cleaned;

  } catch (e) {
    console.warn(`   ⚠️  Échec génération seeds (${e.message}) → seeds de secours`);
    return FALLBACK_SEEDS;
  }
}

// ─── ÉTAPE 1 : Scraping tiktokhashtags.com ───────────────────

async function scrapeHashtagPage(page, keyword) {
  try {
    await page.goto(
      `https://tiktokhashtags.com/hashtag/${encodeURIComponent(keyword)}/`,
      { waitUntil: 'domcontentloaded', timeout: 28000 }
    );
    await sleep(1500);

    return await page.evaluate((kw) => {
      // Stats du hashtag principal
      function getStat(label) {
        const blocks = Array.from(document.querySelectorAll('.g-line-height-1'));
        const b = blocks.find(el => {
          const h = el.querySelector('h4, .h5, h5');
          return h && h.innerText.toUpperCase().includes(label.toUpperCase());
        });
        return b?.querySelector('.g-font-size-26, [class*="font-size-2"]')?.innerText?.trim() ?? null;
      }

      const viewsRaw = getStat('Overall Views') || getStat('Views');
      const postsRaw = getStat('Overall Posts') || getStat('Posts');

      // Hashtags connexes dans le tableau
      const related = [];
      document.querySelectorAll('table tbody tr').forEach(row => {
        const cells = row.querySelectorAll('td');
        if (cells.length < 2) return;
        const name = (cells[1]?.querySelector('a')?.textContent ?? cells[1]?.textContent ?? '')
          .trim().replace(/^#/, '').toLowerCase();
        const v = cells[3]?.textContent?.trim() ?? null;
        const p = cells[2]?.textContent?.trim() ?? null;
        if (name && name.length > 1 && name !== kw) {
          related.push({ tag: name, viewsRaw: v, postsRaw: p });
        }
      });

      return { self: { tag: kw, viewsRaw, postsRaw }, related };
    }, keyword);

  } catch (e) {
    console.warn(`   ⚠️  Échec scrape #${keyword} : ${e.message}`);
    return { self: { tag: keyword, viewsRaw: null, postsRaw: null }, related: [] };
  }
}

// ─── ÉTAPE 2 : Classification + Explications Gemini ──────────

async function classifyWithAI(candidates) {
  // Fallback si pas de clé
  if (!process.env.GEMINI_API_KEY) {
    console.warn('   ⚠️  Pas de clé Gemini → classification ignorée');
    return Object.fromEntries(
      candidates.map(c => [c.tag, { isCollegeTrend: true, confidence: 50, explanation: null }])
    );
  }

  const tagList = candidates.map(c => `"${c.tag}"`).join(', ');

  const prompt = `Tu es un expert des tendances TikTok chez les adolescents français de 11 à 15 ans (collégiens), en ${new Date().getFullYear()}.

Voici une liste de hashtags TikTok. Pour chacun, réponds avec :
- "isCollegeTrend": true si ce hashtag est réellement utilisé/apprécié par les collégiens français 11-15 ans en ce moment, false sinon. Exclure les hashtags trop génériques (ex: "tiktok", "music", "usa", "car") ou hors sujet.
- "confidence": entier de 0 à 100 indiquant ta certitude que c'est une vraie trend collégienne active.
- "explanation": si isCollegeTrend est true, une phrase de 1-2 phrases en français vulgarisée pour des parents. Commence par "Ce hashtag", "Tendance où" ou "Mème où". Si false, mets null.

Réponds UNIQUEMENT avec un tableau JSON valide, sans markdown, sans texte autour :
[{"tag":"nom","isCollegeTrend":true,"confidence":85,"explanation":"..."},...]

Hashtags à analyser : [${tagList}]`;

  try {
    const raw = await callGemini(prompt, 0.2);

    // Extraction robuste du tableau JSON
    const match = raw.match(/\[[\s\S]*\]/);
    if (!match) throw new Error('Pas de tableau JSON dans la réponse');

    const parsed = JSON.parse(match[0]);
    if (!Array.isArray(parsed)) throw new Error('Résultat non-array');

    const map = {};
    for (const item of parsed) {
      if (!item.tag) continue;
      map[item.tag.toLowerCase()] = {
        isCollegeTrend: item.isCollegeTrend === true,
        confidence:     typeof item.confidence === 'number' ? item.confidence : 50,
        explanation:    item.explanation ?? null,
      };
    }

    console.log(`   ✅ Gemini a classifié ${Object.keys(map).length} hashtags`);
    return map;

  } catch (e) {
    console.warn(`   ⚠️  Gemini classification échouée (${e.message}) → tous gardés`);
    return Object.fromEntries(
      candidates.map(c => [c.tag, { isCollegeTrend: true, confidence: 50, explanation: null }])
    );
  }
}

// ─── ÉTAPE 3 : Google Trends ─────────────────────────────────

async function getTrendScore(keyword) {
  try {
    const raw = await googleTrends.interestOverTime({
      keyword,
      geo: 'FR',
      startTime: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000),
      hl: 'fr',
    });
    const data = JSON.parse(raw);
    const timeline = data?.default?.timelineData ?? [];
    if (timeline.length === 0) return null;

    const values = timeline.map(d => d.value?.[0] ?? 0);
    const third  = Math.floor(values.length / 3);
    const avg    = arr => arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0;

    const score30d    = avg(values.slice(2 * third));
    const scorePrev60 = avg(values.slice(0, 2 * third));
    const isRising    = score30d >= 10 && (scorePrev60 === 0 || score30d >= scorePrev60 * 1.4);

    return { score: Math.round(score30d), isRising };
  } catch {
    return null;
  }
}

async function fetchGoogleTrendsBatch(items) {
  const results = [];
  for (let i = 0; i < items.length; i += GT_BATCH_SIZE) {
    const batch = items.slice(i, i + GT_BATCH_SIZE);
    const batchResults = await Promise.all(batch.map(item => getTrendScore(item.tag)));
    batchResults.forEach((gt, j) => results.push({ item: batch[j], gt }));
    if (i + GT_BATCH_SIZE < items.length) await sleep(GT_BATCH_DELAY);
  }
  return results;
}

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

        const author  = '@' + match[1];
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

    // ── 0. SEEDS ─────────────────────────────────────────────
    console.log('\n🤖 ÉTAPE 0 — Génération des mots-clés seeds par Gemini...');
    const seedKeywords = await generateSeedKeywords();

    // ── 1. SCRAPING HASHTAGS ──────────────────────────────────
    console.log(`\n🔍 ÉTAPE 1 — Scraping de ${seedKeywords.length} keywords sur tiktokhashtags.com...`);

    const seen = new Set();
    const pool = [];

    for (const kw of seedKeywords) {
      process.stdout.write(`   #${kw} ... `);
      const { self, related } = await scrapeHashtagPage(page, kw);

      if (!seen.has(kw)) {
        seen.add(kw);
        pool.push({ tag: kw, views: parseCount(self.viewsRaw), posts: parseCount(self.postsRaw) });
      }

      let added = 0;
      for (const r of related) {
        if (!seen.has(r.tag)) {
          seen.add(r.tag);
          pool.push({ tag: r.tag, views: parseCount(r.viewsRaw), posts: parseCount(r.postsRaw) });
          added++;
        }
      }
      console.log(`${related.length} connexes (+${added} nouveaux)`);
    }

    console.log(`\n   📦 Pool total : ${pool.length} hashtags candidats`);

    // ── 2. CLASSIFICATION IA ──────────────────────────────────
    // Prend les MAX_POOL_FOR_AI avec le plus de vues
    const poolForAI = pool
      .sort((a, b) => (b.views || 0) - (a.views || 0))
      .slice(0, MAX_POOL_FOR_AI);

    console.log(`\n🤖 ÉTAPE 2 — Classification Gemini (${poolForAI.length} candidats)...`);
    const aiResults = await classifyWithAI(poolForAI);

    // Affichage du résultat de classification
    const aiFiltered = poolForAI.filter(item => {
      const ai = aiResults[item.tag.toLowerCase()];
      const keep = !ai || ai.isCollegeTrend === true;
      const icon = !ai ? '❓' : keep ? '✅' : '⛔';
      const conf = ai?.confidence ?? '?';
      console.log(`   ${icon} #${item.tag} (confiance ${conf}/100)`);
      return keep;
    });

    console.log(`\n   → ${aiFiltered.length} trends collégiens validés`);

    // ── 3. GOOGLE TRENDS ──────────────────────────────────────
    console.log(`\n📈 ÉTAPE 3 — Google Trends FR (batch de ${GT_BATCH_SIZE})...`);
    const gtBatch = await fetchGoogleTrendsBatch(aiFiltered);

    // Assemblage des résultats
    const assembled = aiFiltered.map(item => {
      const gt = gtBatch.find(r => r.item.tag === item.tag)?.gt ?? null;
      const ai = aiResults[item.tag.toLowerCase()];
      console.log(`   📊 #${item.tag} → GT score: ${gt ? gt.score : '—'}/100${gt?.isRising ? ' 📈' : ''}`);
      return {
        tag:         item.tag,
        views:       item.views || null,
        posts:       item.posts || null,
        viewsFmt:    fmtNumber(item.views),
        postsFmt:    fmtNumber(item.posts),
        trendScore:  gt?.score  ?? null,
        isRising:    gt?.isRising ?? null,
        aiConfidence: ai?.confidence ?? null,
        explanation: ai?.explanation ?? null,
        category:    getCategory(item.tag),
      };
    });

    // Tri : confiance IA desc, puis score GT desc
    assembled.sort((a, b) => {
      const ca = a.aiConfidence ?? 50;
      const cb = b.aiConfidence ?? 50;
      if (cb !== ca) return cb - ca;
      return (b.trendScore ?? 0) - (a.trendScore ?? 0);
    });

    const finalTrends = assembled.slice(0, MAX_FINAL_TRENDS);

    // ── 4. VIDÉOS EXEMPLES ────────────────────────────────────
    console.log(`\n🎬 ÉTAPE 4 — Vidéo exemple TikTok pour chaque trend...`);

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
      lastUpdate:         new Date().toISOString(),
      totalCandidates:    pool.length,
      totalAfterAIFilter: aiFiltered.length,
      sources: [
        'tiktokhashtags.com',
        'Gemini 1.5 Flash (filtre + explications)',
        'Google Trends FR 90 jours',
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
