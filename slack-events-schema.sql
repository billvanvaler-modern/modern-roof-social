create table if not exists slack_events (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz default now(),
  processed boolean default false,
  processed_at timestamptz,
  channel text,
  ts text,
  user_id text,
  text text,
  files jsonb default '[]',
  error text
);

create index if not exists slack_events_processed_idx on slack_events(processed, created_at);
