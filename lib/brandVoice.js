const fs = require('fs');
const path = require('path');

const BRAND_VOICE_PATH = path.join(__dirname, '../../brand-voice.md');
const PILLARS_PATH = path.join(__dirname, '../../content-pillars.md');

function getBrandContext() {
  let voice = '';
  let pillars = '';

  try { voice = fs.readFileSync(BRAND_VOICE_PATH, 'utf8'); } catch {}
  try { pillars = fs.readFileSync(PILLARS_PATH, 'utf8'); } catch {}

  return { voice, pillars };
}

module.exports = { getBrandContext };
