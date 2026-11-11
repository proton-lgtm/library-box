create table public.waitlist_signups (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  consented_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint waitlist_signups_email_normalized check (
    email = lower(btrim(email))
    and octet_length(email) between 3 and 254
    and email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
  ),
  constraint waitlist_signups_email_unique unique (email)
);

alter table public.waitlist_signups enable row level security;

revoke all privileges on table public.waitlist_signups from public, anon, authenticated, service_role;
grant insert (email, consented_at) on table public.waitlist_signups to service_role;
