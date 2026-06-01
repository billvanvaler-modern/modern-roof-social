const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { getBrandContext } = require('./brandVoice');
const { loadConfig } = require('./rotation');
const { getClient } = require('./db');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const UPLOADS_DIR = path.join(__dirname, '../uploads');
const BUCKET = 'media';

const PLATFORMS = {
  facebook: {
    name: 'Facebook',
    maxChars: 500,
    hashtagCount: '2-4',
    notes: 'Conversational, slightly longer story. End with a question or CTA. 2-4 hashtags max.',
  },
  instagram: {
    name: 'Instagram',
    maxChars: 300,
    hashtagCount: '8-15',
    notes: 'Punchy opener (first line is everything — it shows before "more"). Line breaks for readability. 8-15 local + niche hashtags at the end.',
  },
  tiktok: {
    name: 'TikTok',
    maxChars: 150,
    hashtagCount: '3-6',
    notes: 'Hook in first 3 words. Short, urgent, conversational. Write like you\'re talking, not typing. 3-6 trending hashtags.',
  },
  google: {
    name: 'Google Business Profile',
    maxChars: 300,
    hashtagCount: '0',
    notes: 'No hashtags. Professional but warm. Focus on the service delivered and location. Include a CTA with phone or booking link.',
  },
  linkedin: {
    name: 'LinkedIn',
    maxChars: 600,
    hashtagCount: '3-5',
    notes: 'More professional tone but still human. Can go longer — tell the story. Good for "here\'s what I learned" angle. 3-5 industry hashtags.',
  },
};

// Fallback hints if a post type has no aiInstructions in config
const PILLAR_HINTS = {
  before_after: 'Before/after transformation post. Lead with the problem, reveal the solution, show the result.',
  crew_culture: 'Crew/culture post. Make it human. Name crew members by first name. Build trust.',
  education: 'Homeowner education post. Teach one useful thing. 3 bullet points. Low-pressure CTA.',
  storm_response: 'Storm response post. Timely, urgent, practical. Warn about storm-chasers. Offer free inspection.',
  testimonial: 'Review/social proof post. Let the customer\'s words do the work. Name the neighborhood.',
  materials: 'Materials/manufacturer education. Plain English. Honest comparison. Expert advice, not a sales pitch.',
  team_spotlight: 'Team spotlight. Feature one person. Real details. Quotes work great.',
  community: 'Community/local connection. Name specific towns. Build local trust.',
  faq: 'FAQ/myth-busting. Answer one question directly and honestly.',
  process: 'How it works. Demystify hiring a roofer. Remove friction from calling.',
};

// ─── Image helpers ────────────────────────────────────────────────────────────

// Resize + compress an image for Claude — max 1000px, JPEG 80%
// Claude only needs enough to understand the scene, not full resolution
async function resizeForClaude(filePath) {
  try {
    const buffer = await sharp(filePath)
      .resize({ width: 1000, height: 1000, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toBuffer();
    return buffer.toString('base64');
  } catch {
    // Fallback: send as-is if sharp can't handle the format
    return fs.readFileSync(filePath).toString('base64');
  }
}

// Convert a file to a base64 image block for Claude
// Supports both local files (/uploads/...) and Supabase Storage paths
async function fileToImageBlock(urlOrPath) {
  let buffer;
  try {
    if (urlOrPath.startsWith('http')) {
      // Public Supabase URL — download it
      const axios = require('axios');
      const res = await axios.get(urlOrPath, { responseType: 'arraybuffer', timeout: 30000 });
      buffer = Buffer.from(res.data);
    } else {
      // Local file path
      const localPath = urlOrPath.startsWith('/uploads/')
        ? path.join(UPLOADS_DIR, urlOrPath.replace('/uploads/', ''))
        : urlOrPath;
      if (!fs.existsSync(localPath)) return null;
      buffer = fs.readFileSync(localPath);
    }
    // Resize for Claude
    const resized = await sharp(buffer)
      .resize({ width: 1000, height: 1000, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toBuffer();
    return {
      type: 'image',
      source: { type: 'base64', media_type: 'image/jpeg', data: resized.toString('base64') },
    };
  } catch (err) {
    console.warn('fileToImageBlock failed for', urlOrPath, err.message);
    return null;
  }
}

// Build image blocks from an array of URLs or paths
async function buildImageBlocks(mediaUrls = []) {
  const blocks = [];
  for (const url of mediaUrls.slice(0, 5)) {
    const block = await fileToImageBlock(url);
    if (block) blocks.push(block);
  }
  return blocks;
}

// ─── Main generator ───────────────────────────────────────────────────────────

async function generatePosts({ input, pillar, mediaUrls, platforms }) {
  const { voice, pillars } = getBrandContext();
  const platformList = platforms || Object.keys(PLATFORMS);
  const config = loadConfig();
  const pillarHint = config.postTypes?.[pillar]?.aiInstructions || PILLAR_HINTS[pillar] || '';
  const imageBlocks = await buildImageBlocks(mediaUrls || []);
  const hasImages = imageBlocks.length > 0;

  const platformInstructions = platformList
    .map((p) => {
      const cfg = PLATFORMS[p];
      return `### ${cfg.name}\n- Max chars: ${cfg.maxChars}\n- Hashtags: ${cfg.hashtagCount}\n- Notes: ${cfg.notes}`;
    })
    .join('\n\n');

  const systemPrompt = `You are the social media content writer for Modern Roof, a roofing company.

BRAND VOICE & GUIDELINES:
${voice}

CONTENT PILLARS:
${pillars}

Your job: write ready-to-post social media content for each requested platform.${hasImages ? ' You are being shown the actual job photos — use specific visual details you can see (roof type, material, house style, condition, crew, equipment, before/after state) to make the posts concrete and real.' : ''} Do not invent facts not visible in the photos or mentioned in the input. Use the brand voice consistently.

IMPORTANT: Do NOT sign posts with a name or signoff (no "— Bill", no "— Modern Roof", no "— The Team"). Posts are published by the Modern Roof account — no signature needed. End posts with a CTA or hashtags, never a name.

Return ONLY a valid JSON object with platform keys. No markdown fences, no explanation, just raw JSON.`;

  // Build the user message — images first, then text
  const userContent = [];

  if (hasImages) {
    userContent.push({
      type: 'text',
      text: `Here ${imageBlocks.length === 1 ? 'is' : 'are'} ${imageBlocks.length} photo${imageBlocks.length > 1 ? 's' : ''} from the job:`,
    });
    userContent.push(...imageBlocks);
  }

  let textPrompt = '';
  if (input) textPrompt += `INPUT/NOTES FROM BILL:\n${input}\n\n`;
  if (pillarHint) textPrompt += `POST TYPE: ${pillarHint}\n\n`;
  textPrompt += `Write platform-specific posts for:\n\n${platformInstructions}\n\nReturn JSON:\n{\n${platformList.map(p => `  "${p}": "..."`).join(',\n')}\n}`;

  userContent.push({ type: 'text', text: textPrompt });

  const response = await client.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 2000,
    system: systemPrompt,
    messages: [{ role: 'user', content: userContent }],
  });

  const text = response.content[0].text.trim();
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error('Claude returned non-JSON response: ' + text.slice(0, 200));
  }
}

// ─── Review post generator ────────────────────────────────────────────────────

async function generateReviewPost(review) {
  const { voice } = getBrandContext();

  const systemPrompt = `You are the social media content writer for Modern Roof.

BRAND VOICE:
${voice}

Write a social post celebrating a new 5-star Google review. Grateful and genuine — not over-the-top. Let the review speak. Include a soft CTA. No name signoffs — posts are published by the Modern Roof account. Return JSON with keys: facebook, instagram, google. No markdown, just raw JSON.`;

  const userPrompt = `NEW GOOGLE REVIEW:
Reviewer: ${review.reviewerName || 'A customer'}
Rating: ${review.rating} stars
Review: "${review.comment}"

Write celebration posts for Facebook, Instagram, and Google Business Profile.`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 1000,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const text = response.content[0].text.trim();
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error('Failed to parse review post JSON');
  }
}

module.exports = { generatePosts, generateReviewPost, PLATFORMS, PILLAR_HINTS };
