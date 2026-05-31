const axios = require('axios');
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');

const BASE = 'https://services.leadconnectorhq.com';
const VERSION = '2021-07-28';

function headers(contentType = 'application/json') {
  return {
    Authorization: `Bearer ${process.env.GHL_PRIVATE_TOKEN}`,
    Version: VERSION,
    Accept: 'application/json',
    'Content-Type': contentType,
  };
}

function accountIds(platforms) {
  const map = {
    facebook: process.env.GHL_FB_ACCOUNT_ID,
    instagram: process.env.GHL_IG_ACCOUNT_ID,
    tiktok: process.env.GHL_TIKTOK_ACCOUNT_ID,
    linkedin: process.env.GHL_LINKEDIN_ACCOUNT_ID,
    google: process.env.GHL_GOOGLE_ACCOUNT_ID,
  };
  return platforms
    .map((p) => map[p.toLowerCase()])
    .filter(Boolean)
    .filter((id) => !id.includes('PASTE'));
}

async function uploadMedia(filePath) {
  const form = new FormData();
  form.append('file', fs.createReadStream(filePath));
  form.append('locationId', process.env.GHL_LOCATION_ID);
  form.append('hosted', 'false');

  const res = await axios.post(`${BASE}/medias/upload-file`, form, {
    headers: {
      ...form.getHeaders(),
      Authorization: `Bearer ${process.env.GHL_PRIVATE_TOKEN}`,
      Version: VERSION,
      Accept: 'application/json',
    },
    timeout: 120000,
  });

  return res.data.url || res.data.fileUrl || res.data.file?.url;
}

async function createPost({ caption, platforms, mediaUrls, scheduleDate, status }) {
  const ids = accountIds(platforms);
  if (!ids.length) throw new Error('No GHL account IDs configured for: ' + platforms.join(', '));

  const payload = {
    locationId: process.env.GHL_LOCATION_ID,
    accountIds: ids,
    summary: caption,
    type: 'post',
    status: status || process.env.GHL_POST_STATUS || 'draft',
  };

  if (mediaUrls && mediaUrls.length) payload.mediaUrls = mediaUrls;
  if (scheduleDate) payload.scheduleDate = scheduleDate;

  const res = await axios.post(
    `${BASE}/social-media-posting/${process.env.GHL_LOCATION_ID}/posts`,
    payload,
    { headers: headers(), timeout: 60000 }
  );

  return res.data;
}

async function listSocialAccounts() {
  const res = await axios.get(
    `${BASE}/social-media-posting/${process.env.GHL_LOCATION_ID}/accounts`,
    { headers: headers(), timeout: 30000 }
  );
  return res.data?.results?.accounts || res.data.accounts || [];
}

async function testConnection() {
  const accounts = await listSocialAccounts();
  return { ok: true, accounts };
}

module.exports = { createPost, uploadMedia, listSocialAccounts, testConnection };
