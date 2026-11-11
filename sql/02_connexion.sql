-- =====================================================================
-- Transferts CT — version 4.1 : connexion par code unique
-- À exécuter une fois, APRÈS transferts_ct_v4_installation.sql.
-- Supabase > SQL Editor > New query > coller > Run
-- ---------------------------------------------------------------------
-- L'écran de connexion ne montre plus la liste des rôles : l'utilisateur
-- saisit son nom et son code, et le serveur détermine le module à ouvrir.
-- Chaque code doit donc être propre à un accès (rôle ou société).
-- =====================================================================

-- Journal des essais de code erronés (freine les essais en série)
create table if not exists public.tct_login_fails (ts timestamptz not null default now());
alter table public.tct_login_fails enable row level security;
revoke all on public.tct_login_fails from anon, authenticated;

-- Connexion par code seul
create or replace function public.tct_connect(p_code text, p_operateur text)
returns json
language plpgsql security definer set search_path = public, extensions as $$
declare r record; f_role text; f_entity text; n int; tok uuid;
begin
  if coalesce(trim(p_operateur),'') = '' then raise exception 'nom_requis'; end if;
  select count(*) into n from public.tct_login_fails where ts > now() - interval '10 minutes';
  if n >= 30 then raise exception 'trop_de_tentatives'; end if;
  for r in select role, entity, code_hash from public.tct_codes loop
    if extensions.crypt(coalesce(p_code,''), r.code_hash) = r.code_hash then
      f_role := r.role; f_entity := r.entity; exit;
    end if;
  end loop;
  if f_role is null then
    insert into public.tct_login_fails default values;
    delete from public.tct_login_fails where ts < now() - interval '1 day';
    perform pg_sleep(1);
    raise exception 'code_incorrect';
  end if;
  delete from public.tct_sessions where expires_at < now();
  insert into public.tct_sessions (role, entity, operateur)
  values (f_role, nullif(f_entity,''), left(trim(p_operateur), 60))
  returning token into tok;
  return json_build_object('token', tok, 'role', f_role, 'entity', nullif(f_entity,''), 'site', null, 'operateur', trim(p_operateur));
end $$;

-- Précision du site ou du mode après connexion (sans élargir les droits)
create or replace function public.tct_session_set(p_token uuid, p_role text, p_entity text, p_site text)
returns json
language plpgsql security definer set search_path = public, extensions as $$
declare s public.tct_sessions;
begin
  s := public.tct_get_session(p_token);
  if s.role = 'agent' and p_role = 'agent' and p_entity in ('CT','PSK') then
    update public.tct_sessions set entity = p_entity where token = p_token;
  elsif s.role = 'site' and p_role = 'site' and p_entity in ('PSK','BU','KI') then
    update public.tct_sessions set entity = p_entity where token = p_token;
  elsif s.role = 'presta' and p_role = 'presta' and p_entity = s.entity then
    null;
  elsif s.role = 'presta' and p_role = 'pointeur' and p_entity = s.entity and coalesce(p_site,'') <> '' then
    update public.tct_sessions set role = 'pointeur', site = left(p_site, 60) where token = p_token;
  else
    raise exception 'non_autorise';
  end if;
  select * into s from public.tct_sessions where token = p_token;
  return json_build_object('token', s.token, 'role', s.role, 'entity', s.entity, 'site', s.site, 'operateur', s.operateur);
end $$;

-- Changement de code : refus si le code est déjà attribué à un autre accès
create or replace function public.tct_set_code(p_token uuid, p_role text, p_entity text, p_code text)
returns void
language plpgsql security definer set search_path = public, extensions as $$
declare s public.tct_sessions; k_entity text; r record;
begin
  s := public.tct_get_session(p_token);
  if s.role <> 'ct' then raise exception 'non_autorise'; end if;
  if p_code !~ '^[0-9]{4,8}$' then raise exception 'code_format'; end if;
  if p_role not in ('ct','agent','hse','site','presta') then raise exception 'role_inconnu'; end if;
  k_entity := case when p_role = 'presta' then coalesce(p_entity,'') else '' end;
  for r in select role, entity, code_hash from public.tct_codes where not (role = p_role and entity = k_entity) loop
    if extensions.crypt(p_code, r.code_hash) = r.code_hash then raise exception 'code_deja_utilise'; end if;
  end loop;
  insert into public.tct_codes (role, entity, code_hash)
  values (p_role, k_entity, extensions.crypt(p_code, extensions.gen_salt('bf')))
  on conflict (role, entity) do update set code_hash = excluded.code_hash;
end $$;

-- L'ancienne connexion par choix du rôle n'est plus utilisable depuis l'application
revoke execute on function public.tct_login(text,text,text,text,text) from anon, authenticated, public;
grant execute on function public.tct_connect(text,text)                  to anon;
grant execute on function public.tct_session_set(uuid,text,text,text)    to anon;
grant execute on function public.tct_set_code(uuid,text,text,text)       to anon;

notify pgrst, 'reload schema';

-- Vérification : doit afficher les deux nouvelles fonctions
select proname from pg_proc where proname in ('tct_connect','tct_session_set') order by proname;
