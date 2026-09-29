-- Placeholder migration. It documents the server-side ownership boundary;
-- production migrations will be applied after the PostgreSQL adapter is wired.

create table if not exists user_accounts (
  id text primary key,
  email text,
  phone text,
  password_hash text,
  nickname text not null,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists organizations (
  id text primary key,
  name text not null,
  business_license_no text not null,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists identities (
  id text primary key,
  user_id text not null references user_accounts(id),
  identity_type text not null,
  display_name text not null,
  organization_id text references organizations(id),
  status text not null default 'active',
  is_default boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists organization_members (
  id text primary key,
  organization_id text not null references organizations(id),
  user_id text not null references user_accounts(id),
  identity_id text not null references identities(id),
  status text not null default 'active',
  joined_at timestamptz not null default now(),
  unique (organization_id, user_id)
);

create table if not exists organization_roles (
  id text primary key,
  organization_id text not null references organizations(id),
  name text not null,
  is_system boolean not null default false
);
