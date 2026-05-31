const twilio = require('twilio');
const axios = require('axios');
const { generatePosts } = require('./generate');
const { addPost } = require('./queue');
const { nextPillarInCycle, pillarLabel } = require('./rotation');

const BILL_PHONE = process.env.BILL_PHONE_NUMBER;
const TWILIO_PHONE = process.env.TWILIO_PHONE_NUMBER;

function getTwilioClient() {
  return twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
}

async function sendSMS(to, body) {
  const client = getTwilioClient();
  return client.messages.create({ from: TWILIO_PHONE, to, body });
}

async function downloadMedia(mediaUrl) {
  // Twilio media URLs require auth
  const res = await axios.get(mediaUrl, {
    auth: {
      username: process.env.TWILIO_ACCOUNT_SID,
      password: process.env.TWILIO_AUTH_TOKEN,
    },
    responseType: 'arraybuffer',
    timeout: 30000,
  });
  return {
    buffer: Buffer.from(res.data),
    contentType: res.headers['content-type'],
  };
}

async function handleInbound(body) {
  const from = body.From;
  const text = (body.Body || '').trim();
  const numMedia = parseInt(body.NumMedia || '0', 10);

  // Security: only accept from Bill's phone
  if (from !== BILL_PHONE) {
    console.log(`Ignored SMS from unknown number: ${from}`);
    return null;
  }

  // Handle commands
  const lower = text.toLowerCase();
  if (lower === 'help' || lower === '?') {
    await sendSMS(BILL_PHONE,
      'Modern Roof Content Engine\n\n' +
      'Just text me:\n' +
      '• A description of a job + location\n' +
      '• A photo (MMS) + any description\n' +
      '• A topic idea ("tips for storm damage")\n' +
      '• "REVIEW [paste review]" to make a review post\n\n' +
      'I\'ll draft all 5 platforms and add to your queue.'
    );
    return null;
  }

  // Handle review posts
  if (lower.startsWith('review ') || lower.startsWith('review:')) {
    const reviewText = text.replace(/^review[: ]*/i, '').trim();
    await sendSMS(BILL_PHONE, '📝 Got the review. Generating review post...');
    try {
      const { generateReviewPost } = require('./generate');
      const posts = await generateReviewPost({
        reviewerName: 'A customer',
        rating: 5,
        comment: reviewText,
      });
      const entry = addPost({
        input: reviewText,
        pillar: 'testimonial',
        posts,
        mediaUrls: [],
        source: 'sms',
      });
      await sendSMS(BILL_PHONE,
        `✅ Review post drafted!\n\nFacebook preview:\n"${posts.facebook.slice(0, 120)}..."\n\nApprove it at your dashboard.`
      );
      return entry;
    } catch (err) {
      await sendSMS(BILL_PHONE, `❌ Error generating review post: ${err.message}`);
      return null;
    }
  }

  // Regular post — text + optional photo
  const mediaUrls = [];
  for (let i = 0; i < numMedia; i++) {
    mediaUrls.push(body[`MediaUrl${i}`]);
  }

  if (!text && !numMedia) {
    await sendSMS(BILL_PHONE, 'Got your message but it was empty. Send a job description or photo!');
    return null;
  }

  const pillar = nextPillarInCycle();
  const inputText = text || `Photo from job site (no description provided)`;
  const imageDesc = numMedia > 0 ? `${numMedia} photo(s) attached from the job site.` : '';

  await sendSMS(BILL_PHONE,
    `📸 Got it${numMedia ? ` (${numMedia} photo)` : ''}!\n` +
    `Post type: ${pillarLabel(pillar)}\n` +
    `Generating for all 5 platforms... give me 20 seconds.`
  );

  try {
    const posts = await generatePosts({
      input: inputText,
      pillar,
      imageDescription: imageDesc,
      platforms: ['facebook', 'instagram', 'tiktok', 'google', 'linkedin'],
    });

    const entry = addPost({
      input: inputText,
      pillar,
      posts,
      mediaUrls: mediaUrls, // Twilio media URLs — dashboard shows them
      source: 'sms',
    });

    await sendSMS(BILL_PHONE,
      `✅ ${pillarLabel(pillar)} post drafted for all 5 platforms!\n\n` +
      `Instagram preview:\n"${(posts.instagram || '').slice(0, 120)}..."\n\n` +
      `Open your dashboard to approve & push to GHL.`
    );

    return entry;
  } catch (err) {
    console.error('Error generating posts:', err);
    await sendSMS(BILL_PHONE, `❌ Error generating posts: ${err.message}\n\nTry again or describe the job differently.`);
    return null;
  }
}

module.exports = { handleInbound, sendSMS };
