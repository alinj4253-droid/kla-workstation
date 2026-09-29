create table if not exists permissions (
  id text primary key,
  resource text not null,
  action text not null,
  scope text not null,
  unique (resource, action, scope)
);

create table if not exists role_permissions (
  role_id text not null references organization_roles(id),
  permission_id text not null references permissions(id),
  effect text not null default 'allow',
  primary key (role_id, permission_id)
);

create table if not exists member_roles (
  member_id text not null references organization_members(id),
  role_id text not null references organization_roles(id),
  assigned_by text references user_accounts(id),
  assigned_at timestamptz not null default now(),
  primary key (member_id, role_id)
);

create table if not exists organization_entitlements (
  organization_id text primary key references organizations(id),
  plan_code text not null,
  token_quota bigint not null default 0,
  token_used bigint not null default 0,
  storage_quota bigint not null default 0,
  member_limit integer not null default 1,
  project_limit integer not null default 1,
  agent_limit integer not null default 1,
  concurrency_limit integer not null default 1,
  model_scope_json jsonb not null default '[]'::jsonb,
  expires_at timestamptz,
  status text not null default 'active'
);
