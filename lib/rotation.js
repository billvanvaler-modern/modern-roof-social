const fs = require('fs');
const path = require('path');

const STATE_FILE = path.join(__dirname, '../data/rotation.json');
const CONFIG_FILE = path.join(__dirname, '../data/rotation-config.json');

const DEFAULT_CONFIG = {
  weeklySchedule: {
    0: 'community', 1: 'education', 2: 'before_after',
    3: 'team_spotlight', 4: 'materials', 5: 'before_after', 6: 'testimonial',
  },
  rotationCycle: [
    'before_after','education','testimonial','before_after','team_spotlight',
    'materials','before_after','faq','crew_culture','testimonial',
    'before_after','education','storm_response','materials','before_after',
    'community','education','team_spotlight','faq','process',
  ],
  enabledPillars: {
    before_after: true, education: true, testimonial: true, materials: true,
    team_spotlight: true, crew_culture: true, faq: true, community: true,
    storm_response: true, process: true,
  },
};

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    return DEFAULT_CONFIG;
  }
}

function saveConfig(config) {
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

async function loadState() {
  try {
    const { getClient } = require('./db');
    const { data } = await getClient().from('rotation_state').select('cycle_index').eq('id', 1).single();
    return { cycleIndex: data?.cycle_index || 0 };
  } catch {
    return { cycleIndex: 0 };
  }
}

async function saveState(state) {
  try {
    const { getClient } = require('./db');
    await getClient().from('rotation_state').upsert({ id: 1, cycle_index: state.cycleIndex, updated_at: new Date().toISOString() });
  } catch {}
}

function getTodaysPillar() {
  const config = loadConfig();
  const day = new Date().getDay();
  return config.weeklySchedule[day];
}

async function nextPillarInCycle() {
  const config = loadConfig();
  const state = await loadState();
  const cycle = config.rotationCycle.filter(p => config.postTypes?.[p]?.enabled !== false);
  if (!cycle.length) return 'before_after';
  const pillar = cycle[state.cycleIndex % cycle.length];
  state.cycleIndex = (state.cycleIndex + 1) % cycle.length;
  await saveState(state);
  return pillar;
}

function getWeeklyPlan() {
  const config = loadConfig();
  const plan = [];
  const today = new Date();
  for (let i = 0; i < 7; i++) {
    const date = new Date(today);
    date.setDate(today.getDate() + i);
    const day = date.getDay();
    plan.push({
      date: date.toISOString().split('T')[0],
      dayName: ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][day],
      pillar: config.weeklySchedule[day],
    });
  }
  return plan;
}

function pillarLabel(key) {
  const config = loadConfig();
  return config.postTypes?.[key]?.label || key;
}

// Find the next calendar date+time to schedule a given post type.
// Looks up to 14 days ahead for a day that matches the weekly schedule.
// Falls back to the next available weekday at 11am if no match found.
function getNextScheduledTime(pillar) {
  const config = loadConfig();
  const tz = process.env.TIMEZONE || 'America/Indiana/Indianapolis';

  // Find which days of the week this pillar is scheduled on
  const scheduledDays = Object.entries(config.weeklySchedule)
    .filter(([, p]) => p === pillar)
    .map(([day]) => parseInt(day));

  const now = new Date();

  for (let daysAhead = 1; daysAhead <= 14; daysAhead++) {
    const candidate = new Date(now);
    candidate.setDate(now.getDate() + daysAhead);
    const dayOfWeek = candidate.getDay();

    const isScheduledDay = scheduledDays.includes(dayOfWeek);
    if (!isScheduledDay && scheduledDays.length > 0) continue;

    // Get posting time range for this day and pick a random time within it
    const timeStr = config.postingTimes?.[dayOfWeek] || '10:00-12:00';
    const [start, end] = timeStr.includes('-') ? timeStr.split('-') : [timeStr, timeStr];
    const [startH, startM] = start.split(':').map(Number);
    const [endH, endM] = end.split(':').map(Number);
    const startMins = startH * 60 + startM;
    const endMins = endH * 60 + endM;
    const randomMins = startMins + Math.floor(Math.random() * (endMins - startMins + 1));
    const hours = Math.floor(randomMins / 60);
    const minutes = randomMins % 60;

    candidate.setHours(hours, minutes, 0, 0);

    // Format as ISO string
    return candidate.toISOString();
  }

  // Fallback: tomorrow at 11am
  const fallback = new Date(now);
  fallback.setDate(now.getDate() + 1);
  fallback.setHours(11, 0, 0, 0);
  return fallback.toISOString();
}

function getAllPillars() {
  const config = loadConfig();
  return Object.keys(config.postTypes || DEFAULT_CONFIG.postTypes || {});
}

module.exports = { getTodaysPillar, nextPillarInCycle, getWeeklyPlan, getNextScheduledTime, pillarLabel, loadConfig, saveConfig, getAllPillars };
