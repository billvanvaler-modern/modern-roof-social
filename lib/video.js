const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs');

const VIDEO_EXTENSIONS = ['.mp4', '.mov', '.avi', '.m4v', '.hevc', '.mkv', '.webm'];

function isVideo(filename) {
  const ext = path.extname(filename).toLowerCase();
  return VIDEO_EXTENSIONS.includes(ext);
}

function ffmpegAvailable() {
  try {
    require('child_process').execSync('which ffmpeg', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// Extract a frame from a video at the 2-second mark
// Returns the path to the saved thumbnail
function extractThumbnail(videoPath, outputDir) {
  return new Promise((resolve, reject) => {
    const thumbName = path.basename(videoPath, path.extname(videoPath)) + '-thumb.jpg';
    const thumbPath = path.join(outputDir, thumbName);

    ffmpeg(videoPath)
      .screenshots({
        timestamps: ['00:00:02'], // grab frame at 2 seconds
        filename: thumbName,
        folder: outputDir,
        size: '1000x?', // max 1000px wide, maintain aspect ratio
      })
      .on('end', () => resolve(thumbPath))
      .on('error', reject);
  });
}

// Get video duration in seconds
function getVideoDuration(videoPath) {
  return new Promise((resolve) => {
    ffmpeg.ffprobe(videoPath, (err, metadata) => {
      if (err) return resolve(null);
      resolve(metadata?.format?.duration || null);
    });
  });
}

module.exports = { isVideo, ffmpegAvailable, extractThumbnail, getVideoDuration, VIDEO_EXTENSIONS };
