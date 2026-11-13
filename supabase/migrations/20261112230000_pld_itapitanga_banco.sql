-- PLD Itapitanga — banco do sistema (projeto Supabase PLD_Itapitanga, fbmmmpgaitglndlmyimh)
-- Já aplicado no projeto. Guardado aqui só como registro.
-- Árvore de caminhos igual à usada pelas páginas ("legislar/itapitanga/votacao/...").
-- Cada folha (texto, número, verdadeiro/falso) é uma linha; o site só grava pelas funções pld_*.

create table public.pld_nos (caminho text primary key, valor jsonb not null, atualizado timestamptz not null default now());
create index pld_nos_caminho_prefixo on public.pld_nos (caminho text_pattern_ops);
create table public.pld_log (seq bigserial primary key, caminho text not null, em timestamptz not null default now());
create table public.pld_desconectar (cliente text not null, caminho text not null, folhas jsonb, visto_em timestamptz not null default now(), primary key (cliente, caminho));

alter table public.pld_nos enable row level security;
alter table public.pld_log enable row level security;
alter table public.pld_desconectar enable row level security;
create policy "leitura publica" on public.pld_nos for select to anon, authenticated using (true);
create policy "leitura publica" on public.pld_log for select to anon, authenticated using (true);
revoke insert, update, delete, truncate on public.pld_nos, public.pld_log, public.pld_desconectar from anon, authenticated;
revoke select on public.pld_desconectar from anon, authenticated;
alter publication supabase_realtime add table public.pld_log;

create or replace function public._pld_ancestrais(p text) returns text[] language sql immutable set search_path = '' as $$
  select coalesce(array_agg(array_to_string(a[1:i], '/')), '{}')
  from (select string_to_array(p, '/') a) s, generate_series(1, greatest(array_length(a,1)-1,0)) i $$;

create or replace function public._pld_gravar(p text, folhas jsonb) returns void language plpgsql set search_path = '' as $$
declare anc text[] := public._pld_ancestrais(p); topo text := p; x text;
begin
  select a into x from public.pld_nos n, unnest(anc) a where n.caminho = a order by length(a) limit 1;
  if x is not null then delete from public.pld_nos where caminho = any(anc); topo := x; end if;
  delete from public.pld_nos where caminho = p or caminho like replace(replace(replace(p,'\','\\'),'%','\%'),'_','\_') || '/%';
  if folhas is not null and jsonb_typeof(folhas) = 'object' then
    insert into public.pld_nos (caminho, valor)
      select case when k = '' then p else p || '/' || k end, v from jsonb_each(folhas) as e(k, v) where v is not null and jsonb_typeof(v) <> 'null';
  end if;
  insert into public.pld_log (caminho) values (topo);
end $$;

create or replace function public.pld_set(p text, folhas jsonb) returns bigint language plpgsql security definer set search_path = '' as $$
begin perform public._pld_gravar(p, folhas); return (select max(seq) from public.pld_log); end $$;

create or replace function public.pld_update(mudancas jsonb) returns bigint language plpgsql security definer set search_path = '' as $$
declare k text; v jsonb;
begin
  for k, v in select * from jsonb_each(mudancas) loop perform public._pld_gravar(k, case when jsonb_typeof(v) = 'null' then null else v end); end loop;
  return (select max(seq) from public.pld_log);
end $$;

create or replace function public.pld_cas(p text, esperado jsonb, folhas jsonb) returns jsonb language plpgsql security definer set search_path = '' as $$
declare atual jsonb;
begin
  perform pg_advisory_xact_lock(hashtext(p));
  select jsonb_object_agg(case when caminho = p then '' else substr(caminho, length(p) + 2) end, valor) into atual
    from public.pld_nos where caminho = p or caminho like replace(replace(replace(p,'\','\\'),'%','\%'),'_','\_') || '/%';
  if coalesce(atual, '{}'::jsonb) is distinct from coalesce(case when jsonb_typeof(esperado) = 'null' then null else esperado end, '{}'::jsonb) then
    return jsonb_build_object('ok', false, 'atual', atual);
  end if;
  perform public._pld_gravar(p, folhas);
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.pld_agora() returns bigint language sql stable security definer set search_path = '' as $$
  select (extract(epoch from clock_timestamp()) * 1000)::bigint $$;

create or replace function public.pld_ler(p text, desde integer default 0) returns table (caminho text, valor jsonb)
language sql stable security definer set search_path = '' as $$
  select n.caminho, n.valor from public.pld_nos n where p = '' or n.caminho = p or starts_with(n.caminho, p || '/')
  order by n.caminho limit 1000 offset greatest(desde, 0) $$;

create or replace function public.pld_ao_desconectar(cli text, p text, folhas jsonb, cancelar boolean default false) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if cancelar then delete from public.pld_desconectar d where d.cliente = cli and d.caminho = p; return; end if;
  insert into public.pld_desconectar as d (cliente, caminho, folhas, visto_em)
    values (cli, p, case when jsonb_typeof(folhas) = 'null' then null else folhas end, now())
  on conflict (cliente, caminho) do update set folhas = excluded.folhas, visto_em = now();
end $$;

create or replace function public.pld_sinal(cli text, saindo boolean default false) returns void
language plpgsql security definer set search_path = '' as $$
declare r record;
begin
  update public.pld_desconectar d set visto_em = case when saindo then 'epoch'::timestamptz else now() end where d.cliente = cli;
  for r in delete from public.pld_desconectar d where d.visto_em < now() - interval '40 seconds' returning d.caminho, d.folhas loop
    perform public._pld_gravar(r.caminho, r.folhas);
  end loop;
  delete from public.pld_log where em < now() - interval '2 days';
end $$;

revoke all on function public._pld_ancestrais(text), public._pld_gravar(text, jsonb) from public, anon, authenticated;
grant execute on function public.pld_set(text, jsonb), public.pld_update(jsonb), public.pld_cas(text, jsonb, jsonb), public.pld_agora(),
  public.pld_ler(text, integer), public.pld_ao_desconectar(text, text, jsonb, boolean), public.pld_sinal(text, boolean) to anon, authenticated;
