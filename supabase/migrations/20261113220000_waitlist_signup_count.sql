-- Expose only the aggregate; keep signup records inaccessible to API roles.
create function public.waitlist_signup_count()
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select count(*) from public.waitlist_signups;
$$;

revoke all on function public.waitlist_signup_count() from public, anon, authenticated;
grant execute on function public.waitlist_signup_count() to service_role;
