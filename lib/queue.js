const { getClient } = require('./db');

function toRow(post) {
  return {
    id: post.id,
    status: post.status,
    source: post.source,
    pillar: post.pillar,
    input: post.input,
    media_urls: post.mediaUrls || [],
    posts: post.posts || {},
    scheduled_date: post.scheduledDate || null,
    pushed_at: post.pushedAt || null,
    slack_channel: post.slackChannel || null,
    slack_ts: post.slackTs || null,
  };
}

function fromRow(row) {
  return {
    id: row.id,
    createdAt: row.created_at,
    status: row.status,
    source: row.source,
    pillar: row.pillar,
    input: row.input,
    mediaUrls: row.media_urls || [],
    posts: row.posts || {},
    scheduledDate: row.scheduled_date,
    pushedAt: row.pushed_at,
    slackChannel: row.slack_channel,
    slackTs: row.slack_ts,
  };
}

async function addPost({ input, pillar, posts, mediaUrls, source, slackChannel, slackTs }) {
  const db = getClient();
  const { data, error } = await db.from('posts').insert({
    status: 'pending',
    source: source || 'manual',
    pillar,
    input,
    media_urls: mediaUrls || [],
    posts: posts || {},
    slack_channel: slackChannel || null,
    slack_ts: slackTs || null,
  }).select().single();
  if (error) throw new Error(error.message);
  return fromRow(data);
}

async function getAll() {
  const db = getClient();
  const { data, error } = await db.from('posts').select('*').order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  return (data || []).map(fromRow);
}

async function getPending() {
  const db = getClient();
  const { data, error } = await db.from('posts').select('*').eq('status', 'pending').order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  return (data || []).map(fromRow);
}

async function getById(id) {
  const db = getClient();
  const { data, error } = await db.from('posts').select('*').eq('id', id).single();
  if (error) return null;
  return fromRow(data);
}

async function updatePost(id, updates) {
  const db = getClient();
  const dbUpdates = {};
  if (updates.status !== undefined) dbUpdates.status = updates.status;
  if (updates.posts !== undefined) dbUpdates.posts = updates.posts;
  if (updates.scheduledDate !== undefined) dbUpdates.scheduled_date = updates.scheduledDate;
  if (updates.pushedAt !== undefined) dbUpdates.pushed_at = updates.pushedAt;
  const { data, error } = await db.from('posts').update(dbUpdates).eq('id', id).select().single();
  if (error) throw new Error(error.message);
  return fromRow(data);
}

async function approvePost(id, { scheduledDate, edits } = {}) {
  return updatePost(id, {
    status: 'approved',
    scheduledDate: scheduledDate || null,
    posts: edits,
  });
}

async function rejectPost(id) {
  return updatePost(id, { status: 'rejected' });
}

async function markPushed(id) {
  return updatePost(id, { status: 'pushed', pushedAt: new Date().toISOString() });
}

async function deletePost(id) {
  const db = getClient();
  const { error } = await db.from('posts').delete().eq('id', id);
  if (error) throw new Error(error.message);
}

module.exports = { addPost, getAll, getPending, getById, updatePost, approvePost, rejectPost, markPushed, deletePost };
