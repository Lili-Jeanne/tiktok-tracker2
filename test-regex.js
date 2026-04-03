const raw = `1. #SkibidiToilet - Explication
- Origine : TikTok — meme
- Vues estimées : 150M+
- Usage collège : blagues
- Durée de vie estimée : 2 semaines
- Score fiabilité : 4/5 — très drôle

2. Le son 'Oh non, oh non, oh non non non' (remix)
- Origine : Autre — son
- Vues estimées : 120M+ (combiné son + vidéos)
- Usage collège : Running gag en cours, blagues entre amis
- Durée de vie estimée : 3 semaines
- Score fiabilité : 5/5 — Universel, drôle, sans risque.

3. la phrase 'C’est pas moi, c’est mon cerveau'
- Origine : TikTok — phrase
- Vues estimées : 30M+
- Usage collège : Expression courante en classe
- Durée de vie estimée : 4 semaines
- Score fiabilité : 3/5 — drôle`;

const fs = require('fs');
let out = [];
const blocks = raw.split(/\n(?=\d+\.\s+)/);
for (const block of blocks) {
  const lines = block.split('\n').filter(l => l.trim().length > 0);
  if (lines.length === 0) continue;

  let titleLine = lines[0].replace(/^\d+\.\s*/, '').replace(/\*\*/g, '').trim();

  let tagRaw = titleLine;
  let expInline = "";
  
  const parts = titleLine.match(/^(.*?)\s*(?:[-:—])\s*(.*)$/);
  if (parts) {
     tagRaw = parts[1];
     expInline = parts[2].trim();
  }

  const quoteMatch = tagRaw.match(/['"«](.*?)['"»]/);
  let tagStr = quoteMatch ? quoteMatch[1] : tagRaw;
  tagStr = tagStr.replace(/^(le|la|les|un|une|des|hashtag|phrase|son|défi|trend)\s+/i, '').trim();
  
  const tag = tagStr.toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]/g, '');

  if (!tag || tag.length < 2) continue;

  let explanation = expInline;
  let viewsRaw = '';
  let usage = '';
  let confidence = 80;

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].replace(/\*\*/g, '').trim();
    if (/^-?\s*Origine\s*:/i.test(line)) continue;
    else if (/^-?\s*Durée/i.test(line)) continue;
    else if (/^-?\s*Vues/i.test(line)) {
       viewsRaw = line.replace(/^-?\s*Vues[^:]*:\s*/i, '').trim();
    }
    else if (/^-?\s*Usage/i.test(line)) {
       usage = line.replace(/^-?\s*Usage[^:]*:\s*/i, '').trim();
    }
    else if (/^-?\s*Score/i.test(line)) {
       const match = line.match(/(\d)\s*\/\s*5/);
       if (match) confidence = parseInt(match[1]) * 20;
    }
    else if (line.startsWith('-')) {
       // Only capture as explanation if we don't already have one, or if it says "Explication"
       if (!explanation || /^-?\s*Explication/i.test(line)) {
           explanation = line.replace(/^-?\s*(Explication[^:]*:)?\s*/i, '').trim();
       }
    }
  }

  out.push({
    tagStr,
    tag,
    explanation: `${explanation}${usage ? ' (Usage : ' + usage + ')' : ''}`,
    viewsRaw,
    confidence
  });
}
fs.writeFileSync('out.json', JSON.stringify(out, null, 2));
