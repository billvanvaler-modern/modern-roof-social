-- Modern Roof Social Content Engine
-- Run this in Supabase SQL Editor

-- Posts queue
create table if not exists posts (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz default now(),
  status text default 'pending', -- pending | approved | rejected | pushed
  source text default 'manual',  -- manual | upload | slack | sms | review | rotation
  pillar text,
  input text,
  media_urls jsonb default '[]',
  posts jsonb default '{}',      -- { facebook: '...', instagram: '...', ... }
  scheduled_date timestamptz,
  pushed_at timestamptz,
  slack_channel text,
  slack_ts text
);

-- Photos library
create table if not exists photos (
  id uuid primary key default gen_random_uuid(),
  uploaded_at timestamptz default now(),
  filename text,
  original_name text,
  storage_path text,             -- Supabase Storage path
  url text,                      -- public URL
  thumbnail_url text,
  is_video boolean default false,
  duration numeric,
  size bigint,
  notes text default '',
  used_in_posts jsonb default '[]',
  source text default 'upload'   -- upload | slack
);

-- Rotation state
create table if not exists rotation_state (
  id integer primary key default 1,
  cycle_index integer default 0,
  updated_at timestamptz default now()
);

insert into rotation_state (id, cycle_index) values (1, 0)
  on conflict (id) do nothing;

-- Indexes for common queries
create index if not exists posts_status_idx on posts(status);
create index if not exists posts_created_at_idx on posts(created_at desc);
create index if not exists photos_uploaded_at_idx on photos(uploaded_at desc);
