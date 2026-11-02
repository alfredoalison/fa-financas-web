-- ============================================================
-- F&A Finanças - schema.sql
-- Execute no SQL Editor do Supabase.
-- ============================================================
create extension if not exists "pgcrypto";

-- 1. Usuários
create table if not exists usuarios (
  id uuid primary key default gen_random_uuid(),
  nome text not null,
  telefone_whatsapp text not null unique
);

-- 2. Cartões de crédito
-- dia_fechamento = dia do mês em que a fatura fecha.
-- A regra de qual fatura recebe a compra é calculada no app/bot:
--   compra até o dia de fechamento -> fecha neste mês; depois -> fecha no mês seguinte.
--   se dia_vencimento > dia_fechamento -> vence no mesmo mês do fechamento;
--   senão -> vence no mês seguinte ao fechamento.
-- Nubank (fecha 30, vence 7): compra em 15/10 -> fatura 2026-11 (vence 07/11).
-- Mercado Pago (fecha 7, vence 14): compra em 10/10 -> fatura 2026-11 (vence 14/11).
create table if not exists cartoes_credito (
  id uuid primary key default gen_random_uuid(),
  usuario_id uuid references usuarios(id) on delete set null, -- null = cartão compartilhado
  nome_cartao text not null unique,
  dia_fechamento int not null check (dia_fechamento between 1 and 31),
  dia_vencimento int not null check (dia_vencimento between 1 and 31)
);

-- 3. Categorias
create table if not exists categorias (
  id uuid primary key default gen_random_uuid(),
  nome text not null unique
);

-- 4. Transações
create table if not exists transacoes (
  id uuid primary key default gen_random_uuid(),
  usuario_id uuid not null references usuarios(id),
  tipo_pagamento text not null check (tipo_pagamento in ('DÉBITO','CRÉDITO','PIX','RECEITA')),
  categoria_id uuid references categorias(id) on delete set null,
  cartao_id uuid references cartoes_credito(id) on delete set null,
  fatura_mes_ano text check (fatura_mes_ano ~ '^\d{4}-\d{2}$'), -- mês de vencimento da fatura (YYYY-MM)
  valor_total numeric(12,2) not null,
  parcelado boolean not null default false,
  parcela_atual int,
  parcelas_totais int,
  estabelecimento text,
  data_transacao date not null default current_date,
  criado_em timestamptz not null default now()
);
create index if not exists idx_transacoes_data on transacoes (data_transacao);
create index if not exists idx_transacoes_fatura on transacoes (cartao_id, fatura_mes_ano);

-- 5. Itens da transação
create table if not exists itens_transacao (
  id uuid primary key default gen_random_uuid(),
  transacao_id uuid not null references transacoes(id) on delete cascade,
  nome_produto text not null,
  quantidade numeric(12,3) not null default 1,
  valor_unitario numeric(12,2) not null default 0,
  valor_total numeric(12,2) not null default 0
);
create index if not exists idx_itens_transacao on itens_transacao (transacao_id);

-- 6. Metas de poupança
create table if not exists metas_poupanca (
  id uuid primary key default gen_random_uuid(),
  nome_meta text not null,
  valor_alvo numeric(12,2) not null check (valor_alvo > 0),
  valor_atual numeric(12,2) not null default 0,
  data_limite date
);

-- ------------------------------------------------------------
-- Segurança (RLS)
-- O PWA usa a chave anon/publishable, então as tabelas precisam de política
-- para ela. Como é um app privado do casal, as políticas abaixo liberam tudo
-- para anon. Quem tiver a URL do app e a anon key consegue ler/escrever.
-- O ideal é trocar por Supabase Auth (login) e restringir às contas de vocês.
-- O bot usa a service role key e ignora RLS.
-- ------------------------------------------------------------
alter table usuarios enable row level security;
alter table cartoes_credito enable row level security;
alter table categorias enable row level security;
alter table transacoes enable row level security;
alter table itens_transacao enable row level security;
alter table metas_poupanca enable row level security;

do $$
declare t text;
begin
  foreach t in array array['usuarios','cartoes_credito','categorias','transacoes','itens_transacao','metas_poupanca']
  loop
    execute format('drop policy if exists "acesso_app_%1$s" on %1$I', t);
    execute format('create policy "acesso_app_%1$s" on %1$I for all to anon, authenticated using (true) with check (true)', t);
  end loop;
end $$;

-- ------------------------------------------------------------
-- 7. Dados iniciais
-- ------------------------------------------------------------
insert into usuarios (nome, telefone_whatsapp) values
  ('Alfredo Alison', '5584981767874'),
  ('Fernanda Regina', '5584986250294')
on conflict (telefone_whatsapp) do nothing;

insert into cartoes_credito (nome_cartao, dia_fechamento, dia_vencimento) values
  ('Nubank', 30, 7),
  ('Mercado Pago', 7, 14)
on conflict (nome_cartao) do nothing;

insert into categorias (nome) values
  ('Mercado/Alimentação'),
  ('Moradia'),
  ('Transporte'),
  ('Saúde'),
  ('Lazer'),
  ('Assinaturas/Fixos'),
  ('Outros')
on conflict (nome) do nothing;
