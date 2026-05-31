require('dotenv').config({ override: true });
const express = require('express');
const path = require('path');
const cron = require('node-cron');
const multer = require('multer');
const crypto = require('crypto');
const fs = require('fs');

// Use memory storage — files go straight to Supabase Storage
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 500 * 1024 * 1024 } });

const { isVideo, ffmpegAvailable, extractThumbnail, getVideoDuration } = require('./lib/video');
const { uploadToStorage, savePhoto, getAllPhotos, getPhotoById, getPhotosByIds, updatePhotoNotes, markPhotoUsed, deletePhoto: deletePhotoFromStorage } = require('./lib/photos');

const { handleInbound } = require('./lib/sms');
const { generatePosts, generateReviewPost, PILLAR_HINTS } = require('./lib/generate');
const { addPost, getAll, getPending, getById, approvePost, rejectPost, markPushed, deletePost } = require('./lib/queue');
const { createPost } = require('./lib/ghl');
const { getWeeklyPlan, pillarLabel, loadConfig, saveConfig, getAllPillars, getNextScheduledTime } = require('./lib/rotation');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─── Password protection ───────────────────────────────────────────────────────
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD;

app.use((req, res, next) => {
  // Skip auth for webhooks and API calls with valid session
  if (req.path.startsWith('/webhook/')) return next();
  if (req.path === '/login') return next();

  // Check session cookie
  const cookie = req.headers.cookie || '';
  const authed = cookie.includes(`auth=${Buffer.from(DASHBOARD_PASSWORD).toString('base64')}`);
  if (authed) return next();

  // API calls return 401
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Unauthorized' });

  // Serve login page for browser requests
  res.send(`<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Modern Roof Social</title>
<style>
  body{font-family:-apple-system,sans-serif;background:#f4f6f9;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
  .box{background:white;border-radius:16px;padding:40px;width:340px;box-shadow:0 4px 20px rgba(0,0,0,0.08)}
  h2{margin:0 0 8px;font-size:22px}p{color:#6b7280;font-size:14px;margin:0 0 24px}
  input{width:100%;padding:12px;border:1px solid #dde1ea;border-radius:8px;font-size:15px;box-sizing:border-box;margin-bottom:12px}
  button{width:100%;padding:13px;background:#2558e8;color:white;border:none;border-radius:8px;font-size:15px;font-weight:600;cursor:pointer}
  .err{color:#dc2626;font-size:13px;margin-top:8px;display:none}
</style></head>
<body><div class="box">
  <h2>Modern Roof Social</h2>
  <p>Enter your password to continue</p>
  <form method="POST" action="/login">
    <input type="password" name="password" placeholder="Password" autofocus>
    <button type="submit">Sign in</button>
  </form>
</div></body></html>`);
});

app.post('/login', (req, res) => {
  const { password } = req.body;
  if (password === DASHBOARD_PASSWORD) {
    const token = Buffer.from(DASHBOARD_PASSWORD).toString('base64');
    res.setHeader('Set-Cookie', `auth=${token}; Path=/; HttpOnly; Max-Age=2592000`);
    res.redirect('/');
  } else {
    res.redirect('/');
  }
});

app.use(express.static(path.join(__dirname, 'public')));

// ─── Slack events ─────────────────────────────────────────────────────────────
const { handleMessage: slackHandleMessage, handleAction: slackHandleAction } = require('./lib/slack');

// Slack sends a URL verification challenge when you first connect
app.post('/webhook/slack', async (req, res) => {
  const body = req.body;

  // URL verification handshake
  if (body.type === 'url_verification') {
    return res.json({ challenge: body.challenge });
  }

  // Respond immediately — Slack requires < 3s response
  res.sendStatus(200);

  try {
    const event = body.event;
    if (!event) return;

    // Ignore messages from bots (including ourselves)
    if (event.bot_id || event.subtype === 'bot_message') return;

    // Message with text or files in a channel
    if (event.type === 'message' && (event.text || event.files)) {
      await slackHandleMessage({
        text: event.text,
        files: event.files,
        channel: event.channel,
        ts: event.ts,
        userId: event.user,
      });
    }
  } catch (err) {
    console.error('Slack event error:', err);
  }
});

// Slack interactive actions (button clicks)
app.post('/webhook/slack/actions', async (req, res) => {
  res.sendStatus(200);
  try {
    const payload = JSON.parse(req.body.payload);
    for (const action of payload.actions || []) {
      await slackHandleAction({
        action,
        body: payload,
        respond: async (msg) => {
          await require('axios').post(payload.response_url, msg);
        },
      });
    }
  } catch (err) {
    console.error('Slack action error:', err);
  }
});

// ─── Twilio webhook ────────────────────────────────────────────────────────────
app.post('/webhook/sms', async (req, res) => {
  // Respond immediately so Twilio doesn't retry
  res.set('Content-Type', 'text/xml');
  res.send('<Response></Response>');

  try {
    await handleInbound(req.body);
  } catch (err) {
    console.error('SMS handler error:', err);
  }
});

// ─── API: queue ────────────────────────────────────────────────────────────────
app.get('/api/posts', async (req, res) => {
  try {
    const status = req.query.status;
    let posts = await getAll();
    if (status) posts = posts.filter((p) => p.status === status);
    res.json(posts);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/posts/:id', async (req, res) => {
  try {
    const post = await getById(req.params.id);
    if (!post) return res.status(404).json({ error: 'Not found' });
    res.json(post);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Manual post creation from dashboard
app.post('/api/posts/generate', async (req, res) => {
  const { input, pillar, platforms, mediaUrls } = req.body;
  if (!input) return res.status(400).json({ error: 'input required' });

  try {
    const posts = await generatePosts({
      input,
      pillar: pillar || 'before_after',
      mediaUrls: mediaUrls || [],
      platforms: platforms || ['facebook', 'instagram', 'tiktok', 'google', 'linkedin'],
    });
    const entry = addPost({ input, pillar, posts, mediaUrls: mediaUrls || [], source: 'manual' });
    res.json(entry);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Review post from dashboard
app.post('/api/posts/generate-review', async (req, res) => {
  const { reviewerName, rating, comment } = req.body;
  if (!comment) return res.status(400).json({ error: 'comment required' });

  try {
    const posts = await generateReviewPost({ reviewerName, rating, comment });
    const entry = addPost({
      input: comment,
      pillar: 'testimonial',
      posts,
      source: 'review',
    });
    res.json(entry);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Approve + auto-schedule + auto-push to GHL in one step
app.post('/api/posts/:id/approve', async (req, res) => {
  try {
    const { edits, scheduledDate } = req.body;
    const post = getById(req.params.id);
    if (!post) return res.status(404).json({ error: 'Not found' });

    // Auto-calculate schedule time based on post type if not overridden
    const scheduleTime = scheduledDate || getNextScheduledTime(post.pillar);

    // Save as approved with schedule date + any edits
    const approved = approvePost(req.params.id, {
      scheduledDate: scheduleTime,
      edits: edits || post.posts,
    });

    // Push to GHL immediately
    const platforms = Object.keys(approved.posts);
    const ghlResults = {};
    const ghlConfigured = process.env.GHL_PRIVATE_TOKEN && !process.env.GHL_PRIVATE_TOKEN.includes('placeholder');

    if (ghlConfigured) {
      for (const platform of platforms) {
        const caption = approved.posts[platform];
        if (!caption) continue;
        try {
          const result = await createPost({
            caption,
            platforms: [platform],
            mediaUrls: approved.mediaUrls,
            scheduleDate: scheduleTime,
          });
          ghlResults[platform] = { ok: true, id: result.id };
        } catch (err) {
          ghlResults[platform] = { ok: false, error: err.message };
        }
      }
      const anyOk = Object.values(ghlResults).some((r) => r.ok);
      if (anyOk) markPushed(post.id);
    }

    res.json({
      post: approved,
      scheduledDate: scheduleTime,
      ghl: ghlConfigured ? ghlResults : { note: 'GHL not configured yet — post saved locally' },
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/posts/:id/reject', async (req, res) => {
  try {
    const post = await rejectPost(req.params.id);
    res.json(post);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/posts/:id', async (req, res) => {
  try {
    await deletePost(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Manual push (for already-approved posts)
app.post('/api/posts/:id/push', async (req, res) => {
  try {
    const post = getById(req.params.id);
    if (!post) return res.status(404).json({ error: 'Not found' });

    const platforms = Object.keys(post.posts);
    const results = {};

    for (const platform of platforms) {
      const caption = post.posts[platform];
      if (!caption) continue;
      try {
        const result = await createPost({
          caption,
          platforms: [platform],
          mediaUrls: post.mediaUrls,
          scheduleDate: post.scheduledDate,
        });
        results[platform] = { ok: true, id: result.id };
      } catch (err) {
        results[platform] = { ok: false, error: err.message };
      }
    }

    const anyOk = Object.values(results).some((r) => r.ok);
    if (anyOk) markPushed(post.id);

    res.json({ results, postId: post.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── API: calendar / rotation ─────────────────────────────────────────────────
app.get('/api/calendar', (req, res) => {
  res.json(getWeeklyPlan());
});

app.get('/api/pillars', (req, res) => {
  const config = loadConfig();
  const types = config.postTypes || {};
  res.json(
    Object.entries(types).map(([key, def]) => ({
      key,
      label: def.label,
      hint: def.aiInstructions,
      enabled: def.enabled !== false,
    }))
  );
});

// ─── Admin: rotation config ────────────────────────────────────────────────────
app.get('/api/admin/rotation', (req, res) => {
  const config = loadConfig();
  res.json({ config, allPillars: getAllPillars() });
});

app.post('/api/admin/rotation', (req, res) => {
  try {
    const { weeklySchedule, rotationCycle, postTypes, postingTimes } = req.body;
    const current = loadConfig();
    const updated = {
      postingTimes: postingTimes || current.postingTimes,
      weeklySchedule: weeklySchedule || current.weeklySchedule,
      rotationCycle: rotationCycle || current.rotationCycle,
      postTypes: postTypes || current.postTypes,
    };
    saveConfig(updated);
    res.json({ ok: true, config: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Photo library ────────────────────────────────────────────────────────────

// Upload one or more photos or videos
app.post('/api/photos/upload', upload.array('photos', 50), async (req, res) => {
  if (!req.files || !req.files.length) return res.status(400).json({ error: 'No files received' });
  const added = [];

  for (const f of req.files) {
    try {
      const ext = path.extname(f.originalname).toLowerCase() || '.jpg';
      const filename = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`;
      const video = isVideo(filename);
      let thumbnailUrl = null;
      let duration = null;

      // Upload to Supabase Storage
      const mimeType = f.mimetype || 'image/jpeg';
      const { storagePath, url } = await uploadToStorage(f.buffer, filename, mimeType);

      // For videos, extract thumbnail if ffmpeg available
      if (video && ffmpegAvailable()) {
        try {
          const tmpDir = require('os').tmpdir();
          const tmpFile = path.join(tmpDir, filename);
          fs.writeFileSync(tmpFile, f.buffer);
          const thumbPath = await extractThumbnail(tmpFile, tmpDir);
          const thumbBuffer = fs.readFileSync(thumbPath);
          const thumbFilename = path.basename(thumbPath);
          const { url: thumbUrl } = await uploadToStorage(thumbBuffer, thumbFilename, 'image/jpeg');
          thumbnailUrl = thumbUrl;
          duration = await getVideoDuration(tmpFile);
          fs.unlinkSync(tmpFile);
          fs.unlinkSync(thumbPath);
        } catch (err) {
          console.warn('Thumbnail extraction failed:', err.message);
        }
      }

      const entry = await savePhoto({
        filename,
        originalName: f.originalname,
        storagePath,
        url,
        thumbnailUrl,
        isVideo: video,
        duration,
        size: f.size,
        notes: '',
        source: 'upload',
      });
      added.push(entry);
    } catch (err) {
      console.error('Upload error for', f.originalname, err.message);
    }
  }

  res.json({ uploaded: added });
});

// List all photos
app.get('/api/photos', async (req, res) => {
  try {
    res.json(await getAllPhotos());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update notes on a photo
app.patch('/api/photos/:id', async (req, res) => {
  try {
    const photo = await updatePhotoNotes(req.params.id, req.body.notes || '');
    res.json(photo);
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

// Delete a photo
app.delete('/api/photos/:id', async (req, res) => {
  try {
    await deletePhotoFromStorage(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

// Generate posts from uploaded photo IDs
app.post('/api/photos/generate', async (req, res) => {
  const { photoIds, input, pillar } = req.body;
  if (!photoIds || !photoIds.length) return res.status(400).json({ error: 'photoIds required' });

  const selected = await getPhotosByIds(photoIds);
  if (!selected.length) return res.status(400).json({ error: 'No valid photos found' });

  const mediaUrlsForClaude = selected.map(p => p.thumbnailUrl || p.url);
  const mediaUrls = selected.map(p => p.url);
  const videoCount = selected.filter(p => p.isVideo).length;
  const imageDesc = [
    selected.map(p => p.notes).filter(Boolean).join(' '),
    videoCount ? `(${videoCount} video${videoCount > 1 ? 's' : ''} included)` : '',
  ].filter(Boolean).join(' ');

  try {
    const posts = await generatePosts({
      input: input || imageDesc || 'Job site content from Modern Roof',
      pillar: pillar || 'before_after',
      mediaUrls: mediaUrlsForClaude,
      platforms: ['facebook', 'instagram', 'tiktok', 'google', 'linkedin'],
    });

    for (const p of selected) await markPhotoUsed(p.id);

    const entry = await addPost({
      input: input || `Generated from ${selected.length} uploaded photo(s)`,
      pillar: pillar || 'before_after',
      posts,
      mediaUrls,
      source: 'upload',
    });

    res.json(entry);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GHL connection test ───────────────────────────────────────────────────────
app.get('/api/ghl/test', async (req, res) => {
  const { testConnection } = require('./lib/ghl');
  try {
    const result = await testConnection();
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Low content alert ────────────────────────────────────────────────────────
const LOW_CONTENT_THRESHOLD = 3; // alert when fewer than this many posts are pending or approved

async function checkContentLevel() {
  const posts = await getAll();
  const ready = posts.filter(p => p.status === 'pending' || p.status === 'approved').length;
  console.log(`[Content check] ${ready} posts ready in queue`);

  if (ready < LOW_CONTENT_THRESHOLD) {
    const slackToken = process.env.SLACK_BOT_TOKEN;
    if (slackToken && !slackToken.includes('placeholder')) {
      const { sendLowContentAlert } = require('./lib/slack');
      await sendLowContentAlert(ready);
      console.log(`[Content check] Low content Slack alert sent — ${ready} posts remaining`);
    } else {
      console.log('[Content check] Low content but Slack not configured — skipping alert');
    }
  }
}

// Check every morning at 8am
cron.schedule('0 8 * * *', () => {
  checkContentLevel().catch(err => console.error('[Content check error]', err.message));
}, { timezone: process.env.TIMEZONE || 'America/Indiana/Indianapolis' });

// Also expose as an API so the dashboard can trigger it manually
app.get('/api/content-level', async (req, res) => {
  try {
    const posts = await getAll();
    const pending = posts.filter(p => p.status === 'pending').length;
    const approved = posts.filter(p => p.status === 'approved').length;
    const pushed = posts.filter(p => p.status === 'pushed').length;
    res.json({ pending, approved, pushed, total: posts.length, threshold: LOW_CONTENT_THRESHOLD, low: (pending + approved) < LOW_CONTENT_THRESHOLD });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Weekly cron: Friday 4pm — generate next week draft posts ─────────────────
// Uncomment this block once brand-voice.md is filled in and GHL is connected
/*
cron.schedule('0 16 * * 5', async () => {
  console.log('[CRON] Friday 4pm — generating weekly posts...');
  const plan = getWeeklyPlan();
  for (const day of plan) {
    try {
      const posts = await generatePosts({
        input: `Scheduled ${pillarLabel(day.pillar)} post for ${day.date}`,
        pillar: day.pillar,
        platforms: ['facebook', 'instagram', 'tiktok', 'google', 'linkedin'],
      });
      addPost({ input: `Auto-generated for ${day.date}`, pillar: day.pillar, posts, source: 'rotation' });
      console.log(`[CRON] Generated ${day.pillar} post for ${day.date}`);
    } catch (err) {
      console.error(`[CRON] Failed to generate post for ${day.date}:`, err.message);
    }
  }
  console.log('[CRON] Weekly generation done.');
}, { timezone: process.env.TIMEZONE || 'America/Indiana/Indianapolis' });
*/

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🏠 Modern Roof Content Engine running at http://localhost:${PORT}`);
  console.log(`📱 Twilio webhook URL: http://localhost:${PORT}/webhook/sms`);
  console.log(`   (use ngrok or deploy to expose this publicly for Twilio)\n`);
});
