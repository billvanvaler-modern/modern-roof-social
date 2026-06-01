const { WebClient } = require('@slack/web-api');
const { generatePosts, generateReviewPost } = require('./generate');
const { addPost, getAll, approvePost, rejectPost, deletePost, getById } = require('./queue');
const { nextPillarInCycle, pillarLabel, loadConfig, getNextScheduledTime } = require('./rotation');
const { createPost } = require('./ghl');
const path = require('path');
const fs = require('fs');
const axios = require('axios');

const UPLOADS_DIR = path.join(__dirname, '../uploads');
const crypto = require('crypto');

let web;

function getClient() {
  if (!web) web = new WebClient(process.env.SLACK_BOT_TOKEN);
  return web;
}

// ─── Send a message to a channel ─────────────────────────────────────────────
async function sendMessage(channel, text, blocks) {
  const client = getClient();
  return client.chat.postMessage({ channel, text, blocks });
}

// ─── React to a message ───────────────────────────────────────────────────────
async function addReaction(channel, timestamp, emoji) {
  try {
    const client = getClient();
    await client.reactions.add({ channel, timestamp, name: emoji });
  } catch {}
}

// ─── Download a file from Slack ───────────────────────────────────────────────
async function downloadSlackFile(file) {
  const ext = path.extname(file.name || '.jpg') || '.jpg';
  const filename = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`;
  const filePath = path.join(UPLOADS_DIR, filename);

  const res = await axios.get(file.url_private, {
    headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
    responseType: 'arraybuffer',
    timeout: 60000,
  });

  fs.writeFileSync(filePath, Buffer.from(res.data));
  return { filename, url: `/uploads/${filename}`, originalName: file.name, size: file.size };
}

// ─── Detect post type hint from message text ─────────────────────────────────
function detectPillar(text) {
  const t = (text || '').toLowerCase();
  if (t.includes('build day') || t.includes('buildday') || t.includes('build-day')) return 'build_day';
  if (t.includes('review')) return 'testimonial';
  if (t.includes('before') || t.includes('after') || t.includes('finished') || t.includes('complete')) return 'before_after';
  if (t.includes('storm') || t.includes('hail') || t.includes('damage')) return 'storm_response';
  if (t.includes('tip') || t.includes('did you know') || t.includes('homeowner')) return 'education';
  if (t.includes('meet') || t.includes('crew') || t.includes('team')) return 'crew_culture';
  if (t.includes('monday') || t.includes('manufacturer') || t.includes('gaf') || t.includes('owens')) return 'manufacturer_monday';
  return null; // fall back to rotation cycle
}

// ─── Handle an incoming Slack message ────────────────────────────────────────
async function handleMessage({ text, files, channel, ts, userId }) {
  const client = getClient();

  // Acknowledge receipt
  await addReaction(channel, ts, 'eyes');

  // Check if this is a review submission
  const isReview = (text || '').toLowerCase().startsWith('review');
  const reviewText = isReview ? text.replace(/^review[: ]*/i, '').trim() : null;

  let posts, pillar, mediaUrls = [], mediaEntries = [];

  try {
    // Download any attached files
    if (files && files.length) {
      await sendMessage(channel, `Got ${files.length} file${files.length > 1 ? 's' : ''}! Generating posts... give me 20 seconds.`);
      for (const file of files.slice(0, 5)) {
        try {
          const entry = await downloadSlackFile(file);
          mediaEntries.push(entry);
          mediaUrls.push(entry.url);
        } catch (err) {
          console.warn('Failed to download Slack file:', err.message);
        }
      }
    } else {
      await sendMessage(channel, `Got it! Generating posts... give me 15 seconds.`);
    }

    if (isReview) {
      pillar = 'testimonial';
      posts = await generateReviewPost({ reviewerName: 'A customer', rating: 5, comment: reviewText });
    } else {
      pillar = detectPillar(text) || nextPillarInCycle();
      posts = await generatePosts({
        input: text || 'Job site content from Modern Roof',
        pillar,
        mediaUrls,
        platforms: ['facebook', 'instagram', 'tiktok', 'google', 'linkedin'],
      });
    }

    // Save to queue
    const entry = addPost({
      input: text || `Submitted via Slack`,
      pillar,
      posts,
      mediaUrls,
      source: 'slack',
      slackChannel: channel,
      slackTs: ts,
    });

    // Save photo metadata
    if (mediaEntries.length) {
      const PHOTO_META_FILE = path.join(__dirname, '../data/photos.json');
      let photos = [];
      try { photos = JSON.parse(fs.readFileSync(PHOTO_META_FILE, 'utf8')); } catch {}
      for (const m of mediaEntries) {
        photos.unshift({ id: crypto.randomUUID(), ...m, uploadedAt: new Date().toISOString(), notes: text || '', usedInPosts: [], source: 'slack' });
      }
      fs.writeFileSync(PHOTO_META_FILE, JSON.stringify(photos, null, 2));
    }

    // Post the draft to the queue channel with approve/reject buttons
    const queueChannel = process.env.SLACK_CHANNEL_QUEUE || channel;
    const preview = posts.instagram || posts.facebook || Object.values(posts)[0] || '';

    const label = pillarLabel(pillar);
    await client.chat.postMessage({
      channel: queueChannel,
      text: `New *${label}* post drafted`,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*New post drafted: ${label}*\n\n*Instagram preview:*\n${preview.slice(0, 300)}${preview.length > 300 ? '...' : ''}`,
          },
        },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              text: { type: 'plain_text', text: '✅ Approve & Schedule' },
              style: 'primary',
              action_id: 'approve_post',
              value: entry.id,
            },
            {
              type: 'button',
              text: { type: 'plain_text', text: '❌ Delete' },
              style: 'danger',
              action_id: 'delete_post',
              value: entry.id,
            },
            {
              type: 'button',
              text: { type: 'plain_text', text: '🖥 View in dashboard' },
              action_id: 'view_dashboard',
              value: entry.id,
              url: `http://localhost:${process.env.PORT || 3000}`,
            },
          ],
        },
      ],
    });

    // Confirm back in the submission channel
    await addReaction(channel, ts, 'white_check_mark');

  } catch (err) {
    console.error('Slack handler error:', err);
    await addReaction(channel, ts, 'x');
    await sendMessage(channel, `Sorry, something went wrong generating that post: ${err.message}`);
  }
}

// ─── Handle button clicks (approve / delete) ──────────────────────────────────
async function handleAction({ action, body, respond }) {
  const postId = action.value;
  const userId = body.user?.id;
  const client = getClient();

  if (action.action_id === 'approve_post') {
    try {
      const post = getById(postId);
      if (!post) return respond({ text: '⚠️ Post not found — may have already been actioned.' });

      const scheduleTime = getNextScheduledTime(post.pillar);
      approvePost(postId, { scheduledDate: scheduleTime, edits: post.posts });

      // Push to GHL
      const ghlConfigured = process.env.GHL_PRIVATE_TOKEN && !process.env.GHL_PRIVATE_TOKEN.includes('placeholder');
      let ghlNote = '';
      if (ghlConfigured) {
        for (const platform of Object.keys(post.posts)) {
          try {
            await createPost({ caption: post.posts[platform], platforms: [platform], mediaUrls: post.mediaUrls, scheduleDate: scheduleTime });
          } catch (err) {
            console.warn(`GHL push failed for ${platform}:`, err.message);
          }
        }
        ghlNote = ' → pushed to GHL';
      }

      const date = new Date(scheduleTime).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
      await respond({ text: `✅ Approved & scheduled for ${date}${ghlNote}`, replace_original: false });

    } catch (err) {
      await respond({ text: `❌ Error: ${err.message}` });
    }
  }

  if (action.action_id === 'delete_post') {
    try {
      deletePost(postId);
      await respond({ text: '🗑 Post deleted.', replace_original: false });
    } catch (err) {
      await respond({ text: `❌ Error: ${err.message}` });
    }
  }
}

// ─── Low content alert via Slack ──────────────────────────────────────────────
async function sendLowContentAlert(count) {
  const channel = process.env.SLACK_CHANNEL_SUBMISSIONS || process.env.SLACK_CHANNEL_QUEUE;
  if (!channel) return;
  await sendMessage(channel,
    `⚠️ *Content is running low* — only ${count} post${count === 1 ? '' : 's'} left in the queue.\n\nDrop some job photos or a description in this channel to refill it.`
  );
}

module.exports = { handleMessage, handleAction, sendMessage, sendLowContentAlert };
