-- Apply through Supabase apply_migration to an isolated branch first.
-- No changes to cms_store, reports, or historical purchases.
create table public.kitchen_invoices (
 id uuid primary key,
 client_id text not null,
 version integer not null check(version>0),
 duplicate_key text,
 source_hash text,
 payload jsonb not null,
 updated_at timestamptz not null default now()
);
create unique index kitchen_invoice_identity on public.kitchen_invoices(client_id,duplicate_key) where duplicate_key is not null;
create unique index kitchen_invoice_source on public.kitchen_invoices(client_id,source_hash) where source_hash is not null;
create table public.kitchen_catalogs(client_id text primary key,payload jsonb not null);
alter table public.kitchen_invoices enable row level security;
alter table public.kitchen_catalogs enable row level security;
revoke all on public.kitchen_invoices,public.kitchen_catalogs from anon,authenticated;
grant all on public.kitchen_invoices,public.kitchen_catalogs to service_role;
create function public.save_kitchen_invoice(record jsonb,expected_version integer) returns void
language plpgsql security invoker set search_path=public as $$
begin
 if (record->>'version')::integer <> expected_version+1 then raise exception 'Invalid version' using errcode='40001'; end if;
 if expected_version=0 then
  insert into kitchen_invoices(id,client_id,version,duplicate_key,source_hash,payload)
  values((record->>'id')::uuid,record->>'clientId',1,record->>'duplicateKey',coalesce(record#>>'{source,identity}',record#>>'{source,hash}'),record);
 else
  update kitchen_invoices set version=expected_version+1,duplicate_key=record->>'duplicateKey',source_hash=coalesce(record#>>'{source,identity}',record#>>'{source,hash}'),payload=record,updated_at=now()
   where id=(record->>'id')::uuid and client_id=record->>'clientId' and version=expected_version;
  if not found then raise exception 'Concurrent edit' using errcode='40001'; end if;
 end if;
end $$;
revoke all on function public.save_kitchen_invoice(jsonb,integer) from public,anon,authenticated;
grant execute on function public.save_kitchen_invoice(jsonb,integer) to service_role;
