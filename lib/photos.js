const { getClient } = require('./db');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');

const BUCKET = 'media';

function fromRow(row) {
  return {
    id: row.id,
    uploadedAt: row.uploaded_at,
    filename: row.filename,
    originalName: row.original_name,
    storagePath: row.storage_path,
    url: row.url,
    thumbnailUrl: row.thumbnail_url,
    isVideo: row.is_video,
    duration: row.duration,
    size: row.size,
    notes: row.notes || '',
    usedInPosts: row.used_in_posts || [],
    source: row.source || 'upload',
  };
}

// Upload a file buffer to Supabase Storage, return public URL
async function uploadToStorage(buffer, filename, mimeType) {
  const db = getClient();
  const storagePath = `uploads/${filename}`;
  const { error } = await db.storage.from(BUCKET).upload(storagePath, buffer, {
    contentType: mimeType,
    upsert: true,
  });
  if (error) throw new Error('Storage upload failed: ' + error.message);
  const { data } = db.storage.from(BUCKET).getPublicUrl(storagePath);
  return { storagePath, url: data.publicUrl };
}

// Upload a local file to Supabase Storage
async function uploadLocalFile(filePath, originalName) {
  const ext = path.extname(originalName || filePath).toLowerCase();
  const filename = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`;
  const buffer = fs.readFileSync(filePath);
  const mimeMap = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
    '.gif': 'image/gif', '.webp': 'image/webp', '.heic': 'image/jpeg',
    '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.avi': 'video/x-msvideo' };
  const mimeType = mimeMap[ext] || 'application/octet-stream';
  return { filename, ...(await uploadToStorage(buffer, filename, mimeType)) };
}

// Save photo metadata to Supabase
async function savePhoto({ filename, originalName, storagePath, url, thumbnailUrl, isVideo, duration, size, notes, source }) {
  const db = getClient();
  const { data, error } = await db.from('photos').insert({
    filename,
    original_name: originalName,
    storage_path: storagePath,
    url,
    thumbnail_url: thumbnailUrl || null,
    is_video: isVideo || false,
    duration: duration || null,
    size: size || null,
    notes: notes || '',
    used_in_posts: [],
    source: source || 'upload',
  }).select().single();
  if (error) throw new Error(error.message);
  return fromRow(data);
}

async function getAllPhotos() {
  const db = getClient();
  const { data, error } = await db.from('photos').select('*').order('uploaded_at', { ascending: false });
  if (error) throw new Error(error.message);
  return (data || []).map(fromRow);
}

async function getPhotoById(id) {
  const db = getClient();
  const { data, error } = await db.from('photos').select('*').eq('id', id).single();
  if (error) return null;
  return fromRow(data);
}

async function getPhotosByIds(ids) {
  const db = getClient();
  const { data, error } = await db.from('photos').select('*').in('id', ids);
  if (error) throw new Error(error.message);
  return (data || []).map(fromRow);
}

async function updatePhotoNotes(id, notes) {
  const db = getClient();
  const { data, error } = await db.from('photos').update({ notes }).eq('id', id).select().single();
  if (error) throw new Error(error.message);
  return fromRow(data);
}

async function markPhotoUsed(id) {
  const photo = await getPhotoById(id);
  if (!photo) return;
  const db = getClient();
  const used = [...(photo.usedInPosts || []), new Date().toISOString()];
  await db.from('photos').update({ used_in_posts: used }).eq('id', id);
}

async function deletePhoto(id) {
  const photo = await getPhotoById(id);
  if (!photo) throw new Error('Photo not found');
  const db = getClient();
  // Delete from storage
  if (photo.storagePath) {
    await db.storage.from(BUCKET).remove([photo.storagePath]);
  }
  if (photo.thumbnailUrl) {
    const thumbPath = photo.thumbnailUrl.split('/').slice(-2).join('/');
    await db.storage.from(BUCKET).remove([`uploads/${thumbPath.split('/').pop()}`]).catch(() => {});
  }
  const { error } = await db.from('photos').delete().eq('id', id);
  if (error) throw new Error(error.message);
}

// Download a file from Supabase storage for Claude to analyze
async function downloadForClaude(storagePath) {
  const db = getClient();
  const { data, error } = await db.storage.from(BUCKET).download(storagePath);
  if (error) throw new Error(error.message);
  const buffer = Buffer.from(await data.arrayBuffer());
  return buffer;
}

module.exports = { uploadLocalFile, uploadToStorage, savePhoto, getAllPhotos, getPhotoById, getPhotosByIds, updatePhotoNotes, markPhotoUsed, deletePhoto, downloadForClaude, BUCKET };
