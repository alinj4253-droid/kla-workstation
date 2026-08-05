import Database from 'better-sqlite3';
import { join } from 'node:path';
import { getDatabase } from './connection';

export function runMigrations(dbPath: string): void {
  const db = getDatabase(dbPath);

  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  const rows = db.prepare('SELECT name FROM _migrations').all() as Array<{ name: string }>;
  const applied = new Set(rows.map((r) => r.name));

  for (const migration of migrations) {
    if (applied.has(migration.name)) continue;
    db.exec(migration.sql);
    db.prepare('INSERT INTO _migrations (name) VALUES (?)').run(migration.name);
  }
}

const migrations: Array<{ name: string; sql: string }> = [
  {
    name: '001_initial',
    sql: `
      CREATE TABLE workspace_registry (
        workspace_id TEXT PRIMARY KEY,
        root_path_hash TEXT NOT NULL,
        schema_version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        last_opened_at TEXT NOT NULL
      );

      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','reviewing','archived')),
        summary TEXT,
        leader_instance_id TEXT,
        workspace_rel_path TEXT,
        shared_knowledge_enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_active_at TEXT NOT NULL,
        archived_at TEXT
      );
      CREATE INDEX idx_projects_last_active ON projects(last_active_at);

      CREATE TABLE project_view_state (
        project_id TEXT PRIMARY KEY REFERENCES projects(id),
        scroll_anchor TEXT,
        draft_json TEXT,
        active_file_id TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        sender_type TEXT NOT NULL CHECK(sender_type IN ('user','agent','system')),
        sender_id TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'text' CHECK(kind IN ('text','artifact','system')),
        content_json TEXT NOT NULL,
        routing_json TEXT,
        status TEXT NOT NULL DEFAULT 'sent' CHECK(status IN ('sending','sent','failed')),
        reply_to_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_messages_project ON messages(project_id, created_at, id);

      CREATE TABLE message_attachments (
        message_id TEXT NOT NULL REFERENCES messages(id),
        file_id TEXT NOT NULL,
        version_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        PRIMARY KEY (message_id, file_id, version_id)
      );

      CREATE TABLE agent_definitions (
        id TEXT NOT NULL,
        version TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('built-in','custom')),
        manifest_rel_path TEXT NOT NULL,
        checksum TEXT NOT NULL,
        framework_entry TEXT,
        max_permissions_json TEXT,
        model_requirements_json TEXT,
        is_builtin INTEGER NOT NULL,
        installed_at TEXT NOT NULL,
        PRIMARY KEY (id, version)
      );

      CREATE TABLE agent_profiles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        definition_id TEXT NOT NULL,
        definition_version TEXT NOT NULL,
        runtime_mode TEXT NOT NULL CHECK(runtime_mode IN ('native-model','external-cli')),
        model_profile_id TEXT,
        cli_connection_id TEXT,
        overrides_json TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        delegatable INTEGER NOT NULL DEFAULT 1,
        is_system_default INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE cli_connections (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        adapter_type TEXT NOT NULL,
        executable_path TEXT NOT NULL,
        args_json TEXT,
        strategy_id TEXT,
        detected_version TEXT,
        auth_mode TEXT,
        secret_refs_json TEXT,
        trust_tier TEXT NOT NULL DEFAULT 'restricted' CHECK(trust_tier IN ('full','restricted','experimental')),
        status TEXT NOT NULL DEFAULT 'unknown' CHECK(status IN ('unknown','compatible','incompatible','experimental')),
        capabilities_json TEXT,
        last_checked_at TEXT
      );
      CREATE INDEX idx_cli_connections_exec ON cli_connections(executable_path, strategy_id);

      CREATE TABLE project_agent_instances (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        agent_profile_id TEXT NOT NULL,
        definition_id TEXT,
        definition_version TEXT,
        role TEXT NOT NULL CHECK(role IN ('leader','teammate')),
        runtime_mode TEXT NOT NULL CHECK(runtime_mode IN ('native-model','external-cli')),
        model_profile_id TEXT,
        cli_connection_id TEXT,
        identity_rel_path TEXT,
        memory_rel_path TEXT,
        effective_permissions_json TEXT,
        ordinal INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_project_agent_instances_ordinal ON project_agent_instances(project_id, ordinal);

      CREATE TABLE external_agent_sessions (
        id TEXT PRIMARY KEY,
        agent_instance_id TEXT NOT NULL,
        cli_connection_id TEXT NOT NULL,
        external_session_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','idle','closed','error')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE agent_runs (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        trigger_message_id TEXT,
        parent_run_id TEXT,
        agent_instance_id TEXT NOT NULL,
        requested_by_type TEXT NOT NULL CHECK(requested_by_type IN ('user','agent','system')),
        requested_by_id TEXT NOT NULL,
        instruction TEXT,
        status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','starting','running','completed','failed','cancelling','cancelled','interrupted')),
        attempt INTEGER NOT NULL DEFAULT 1,
        model_profile_snapshot_json TEXT,
        started_at TEXT,
        finished_at TEXT,
        result_message_id TEXT,
        error_code TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_agent_runs_instance ON agent_runs(agent_instance_id, status);
      CREATE INDEX idx_agent_runs_created ON agent_runs(created_at);

      CREATE TABLE agent_run_events (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        type TEXT NOT NULL,
        payload_json TEXT,
        created_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX unq_agent_run_events_seq ON agent_run_events(run_id, seq);

      CREATE TABLE model_providers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        base_url TEXT,
        auth_type TEXT NOT NULL DEFAULT 'api-key' CHECK(auth_type IN ('api-key','oauth','none')),
        secret_ref TEXT,
        config_json TEXT,
        status TEXT NOT NULL DEFAULT 'unknown' CHECK(status IN ('unknown','available','unavailable','error')),
        last_checked_at TEXT
      );
      CREATE UNIQUE INDEX idx_model_providers_name ON model_providers(name);

      CREATE TABLE model_profiles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        provider_id TEXT NOT NULL REFERENCES model_providers(id),
        model_id TEXT NOT NULL,
        model_slot TEXT CHECK(model_slot IN ('reasoning','fast','embedding')),
        parameters_json TEXT,
        declared_capabilities_json TEXT,
        verified_capabilities_json TEXT,
        capability_tested_at TEXT,
        enabled INTEGER NOT NULL DEFAULT 1
      );
      CREATE UNIQUE INDEX idx_model_profiles_name ON model_profiles(name);
      CREATE UNIQUE INDEX idx_model_profiles_provider_model ON model_profiles(provider_id, model_id);

      CREATE TABLE model_slot_bindings (
        slot TEXT PRIMARY KEY CHECK(slot IN ('reasoning','fast','embedding')),
        model_profile_id TEXT NOT NULL REFERENCES model_profiles(id),
        updated_at TEXT NOT NULL
      );

      CREATE TABLE files (
        id TEXT PRIMARY KEY,
        scope_type TEXT NOT NULL CHECK(scope_type IN ('project','shared')),
        scope_id TEXT NOT NULL,
        parent_id TEXT,
        type TEXT NOT NULL CHECK(type IN ('file','directory')),
        name TEXT NOT NULL,
        normalized_path TEXT NOT NULL,
        mime_type TEXT,
        current_version_id TEXT,
        origin TEXT NOT NULL DEFAULT 'upload' CHECK(origin IN ('upload','artifact','imported')),
        status TEXT NOT NULL DEFAULT 'ready' CHECK(status IN ('staging','ready','deleted','error')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      );
      CREATE UNIQUE INDEX idx_files_scope_path ON files(scope_type, scope_id, normalized_path);

      CREATE TABLE file_versions (
        id TEXT PRIMARY KEY,
        file_id TEXT NOT NULL REFERENCES files(id),
        version_no INTEGER NOT NULL,
        storage_rel_path TEXT NOT NULL,
        size INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        created_by_type TEXT NOT NULL CHECK(created_by_type IN ('user','agent','system')),
        created_by_id TEXT NOT NULL,
        run_id TEXT,
        change_note TEXT,
        created_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX unq_file_versions_file_version ON file_versions(file_id, version_no);
      CREATE INDEX idx_file_versions_sha ON file_versions(sha256);

      CREATE TABLE memory_records (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        agent_instance_id TEXT NOT NULL,
        scope TEXT NOT NULL CHECK(scope IN ('short-term','long-term')),
        type TEXT NOT NULL,
        content TEXT NOT NULL,
        confidence INTEGER NOT NULL DEFAULT 1,
        source_refs_json TEXT,
        status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','expired','deleted')),
        expires_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_memory_records_lookup ON memory_records(agent_instance_id, scope, status);

      CREATE TABLE knowledge_sources (
        id TEXT PRIMARY KEY,
        scope_type TEXT NOT NULL CHECK(scope_type IN ('project','shared')),
        scope_id TEXT NOT NULL,
        file_id TEXT NOT NULL,
        version_id TEXT,
        sha256 TEXT,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','ingesting','ready','error')),
        ingested_at TEXT
      );

      CREATE TABLE knowledge_ingestion_jobs (
        id TEXT PRIMARY KEY,
        scope_type TEXT NOT NULL CHECK(scope_type IN ('project','shared')),
        scope_id TEXT NOT NULL,
        source_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','completed','failed')),
        stage TEXT,
        progress INTEGER,
        error_code TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_knowledge_jobs_scope ON knowledge_ingestion_jobs(scope_type, scope_id, status);

      CREATE TABLE knowledge_chunks (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        text TEXT NOT NULL,
        location_json TEXT,
        content_hash TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX unq_knowledge_chunks_source_ordinal ON knowledge_chunks(source_id, ordinal);

      CREATE TABLE knowledge_nodes (
        id TEXT PRIMARY KEY,
        scope_type TEXT NOT NULL CHECK(scope_type IN ('project','shared')),
        scope_id TEXT NOT NULL,
        node_type TEXT NOT NULL,
        canonical_name TEXT NOT NULL,
        summary TEXT,
        properties_json TEXT,
        confidence INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_knowledge_nodes_lookup ON knowledge_nodes(scope_type, scope_id, node_type, canonical_name);

      CREATE TABLE knowledge_edges (
        id TEXT PRIMARY KEY,
        scope_type TEXT NOT NULL CHECK(scope_type IN ('project','shared')),
        scope_id TEXT NOT NULL,
        source_node_id TEXT NOT NULL,
        target_node_id TEXT NOT NULL,
        edge_type TEXT NOT NULL,
        properties_json TEXT,
        confidence INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_knowledge_edges_lookup ON knowledge_edges(scope_type, scope_id, source_node_id, target_node_id, edge_type);

      CREATE TABLE knowledge_provenance (
        id TEXT PRIMARY KEY,
        target_type TEXT NOT NULL CHECK(target_type IN ('node','edge','wiki')),
        target_id TEXT NOT NULL,
        source_id TEXT,
        chunk_id TEXT,
        location_json TEXT,
        quote_hash TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_knowledge_provenance_target ON knowledge_provenance(target_type, target_id);
      CREATE INDEX idx_knowledge_provenance_source ON knowledge_provenance(source_id);

      CREATE TABLE wiki_pages (
        id TEXT PRIMARY KEY,
        scope_type TEXT NOT NULL CHECK(scope_type IN ('project','shared')),
        scope_id TEXT NOT NULL,
        slug TEXT NOT NULL,
        title TEXT NOT NULL,
        body_md TEXT,
        source_refs_json TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX unq_wiki_pages_scope_slug ON wiki_pages(scope_type, scope_id, slug);

      CREATE TABLE channels (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL CHECK(type IN ('telegram','lark','dingtalk','wecom-webhook')),
        name TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'disconnected' CHECK(status IN ('disconnected','connecting','connected','error')),
        config_json TEXT,
        secret_ref TEXT,
        last_connected_at TEXT,
        last_error TEXT
      );
      CREATE UNIQUE INDEX idx_channels_type_name ON channels(type, name);

      CREATE TABLE channel_bindings (
        channel_id TEXT NOT NULL REFERENCES channels(id),
        external_conversation_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE channel_events (
        channel_id TEXT NOT NULL REFERENCES channels(id),
        external_event_id TEXT NOT NULL,
        direction TEXT NOT NULL CHECK(direction IN ('inbound','outbound')),
        payload_json TEXT,
        status TEXT NOT NULL DEFAULT 'received' CHECK(status IN ('received','processed','failed')),
        created_at TEXT NOT NULL
      );

      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE secrets (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        ciphertext TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE notifications (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT,
        project_id TEXT,
        read_at TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_notifications_read ON notifications(read_at, created_at);

      CREATE TABLE audit_logs (
        id TEXT PRIMARY KEY,
        actor_type TEXT NOT NULL CHECK(actor_type IN ('user','agent','system')),
        actor_id TEXT NOT NULL,
        action TEXT NOT NULL,
        target_type TEXT,
        target_id TEXT,
        metadata_json TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_audit_logs_created ON audit_logs(created_at);
      CREATE INDEX idx_audit_logs_target ON audit_logs(target_type, target_id);

      CREATE TABLE idempotency_requests (
        key TEXT PRIMARY KEY,
        operation TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        result_json TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE drafts (
        scope TEXT NOT NULL,
        scope_id TEXT NOT NULL,
        content_json TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (scope, scope_id)
      );

      -- FTS5 virtual tables
      CREATE VIRTUAL TABLE IF NOT EXISTS project_fts USING fts5(
        id, name, summary, content='projects', content_rowid='rowid'
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS message_fts USING fts5(
        message_id UNINDEXED, project_id UNINDEXED, content, content='messages', content_rowid='rowid'
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS file_fts USING fts5(
        version_id UNINDEXED, file_id UNINDEXED, scope_type UNINDEXED, scope_id UNINDEXED, name, extracted_text,
        content='file_versions', content_rowid='rowid'
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_chunk_fts USING fts5(
        chunk_id UNINDEXED, scope_type UNINDEXED, scope_id UNINDEXED, text,
        content='knowledge_chunks', content_rowid='rowid'
      );
    `,
  },
  {
    name: '002_fts_triggers',
    sql: `
      -- project_fts sync triggers
      CREATE TRIGGER IF NOT EXISTS trg_project_fts_insert AFTER INSERT ON projects BEGIN
        INSERT INTO project_fts(rowid, id, name, summary) VALUES (new.rowid, new.id, new.name, new.summary);
      END;
      CREATE TRIGGER IF NOT EXISTS trg_project_fts_delete AFTER DELETE ON projects BEGIN
        INSERT INTO project_fts(project_fts, rowid, id, name, summary) VALUES('delete', old.rowid, old.id, old.name, old.summary);
      END;
      CREATE TRIGGER IF NOT EXISTS trg_project_fts_update AFTER UPDATE ON projects BEGIN
        INSERT INTO project_fts(project_fts, rowid, id, name, summary) VALUES('delete', old.rowid, old.id, old.name, old.summary);
        INSERT INTO project_fts(rowid, id, name, summary) VALUES (new.rowid, new.id, new.name, new.summary);
      END;

      -- message_fts sync triggers (only index final text content_json)
      CREATE TRIGGER IF NOT EXISTS trg_message_fts_insert AFTER INSERT ON messages BEGIN
        INSERT INTO message_fts(rowid, message_id, project_id, content) VALUES (new.rowid, new.id, new.project_id, new.content_json);
      END;
      CREATE TRIGGER IF NOT EXISTS trg_message_fts_delete AFTER DELETE ON messages BEGIN
        INSERT INTO message_fts(message_fts, rowid, message_id, project_id, content) VALUES('delete', old.rowid, old.id, old.project_id, old.content_json);
      END;
      CREATE TRIGGER IF NOT EXISTS trg_message_fts_update AFTER UPDATE ON messages BEGIN
        INSERT INTO message_fts(message_fts, rowid, message_id, project_id, content) VALUES('delete', old.rowid, old.id, old.project_id, old.content_json);
        INSERT INTO message_fts(rowid, message_id, project_id, content) VALUES (new.rowid, new.id, new.project_id, new.content_json);
      END;

      -- knowledge_chunk_fts sync triggers
      CREATE TRIGGER IF NOT EXISTS trg_chunk_fts_insert AFTER INSERT ON knowledge_chunks BEGIN
        INSERT INTO knowledge_chunk_fts(rowid, chunk_id, text) VALUES (new.rowid, new.id, new.text);
      END;
      CREATE TRIGGER IF NOT EXISTS trg_chunk_fts_delete AFTER DELETE ON knowledge_chunks BEGIN
        INSERT INTO knowledge_chunk_fts(knowledge_chunk_fts, rowid, chunk_id, text) VALUES('delete', old.rowid, old.id, old.text);
      END;
      CREATE TRIGGER IF NOT EXISTS trg_chunk_fts_update AFTER UPDATE ON knowledge_chunks BEGIN
        INSERT INTO knowledge_chunk_fts(knowledge_chunk_fts, rowid, chunk_id, text) VALUES('delete', old.rowid, old.id, old.text);
        INSERT INTO knowledge_chunk_fts(rowid, chunk_id, text) VALUES (new.rowid, new.id, new.text);
      END;

      -- FTS rebuilds skipped — column name mismatches fixed in 007 (message_fts) and 008 (knowledge_chunk_fts)
    `,
  },
  {
    name: '003_fix_project_fts_column',
    sql: `
      -- Fix project_fts FTS5 table: column name 'project_id' changed to 'id' to match projects.id
      DROP TRIGGER IF EXISTS trg_project_fts_insert;
      DROP TRIGGER IF EXISTS trg_project_fts_delete;
      DROP TRIGGER IF EXISTS trg_project_fts_update;
      DROP TABLE IF EXISTS project_fts;

      CREATE VIRTUAL TABLE IF NOT EXISTS project_fts USING fts5(
        id, name, summary, content='projects', content_rowid='rowid'
      );

      CREATE TRIGGER IF NOT EXISTS trg_project_fts_insert AFTER INSERT ON projects BEGIN
        INSERT INTO project_fts(rowid, id, name, summary) VALUES (new.rowid, new.id, new.name, new.summary);
      END;
      CREATE TRIGGER IF NOT EXISTS trg_project_fts_delete AFTER DELETE ON projects BEGIN
        INSERT INTO project_fts(project_fts, rowid, id, name, summary) VALUES('delete', old.rowid, old.id, old.name, old.summary);
      END;
      CREATE TRIGGER IF NOT EXISTS trg_project_fts_update AFTER UPDATE ON projects BEGIN
        INSERT INTO project_fts(project_fts, rowid, id, name, summary) VALUES('delete', old.rowid, old.id, old.name, old.summary);
        INSERT INTO project_fts(rowid, id, name, summary) VALUES (new.rowid, new.id, new.name, new.summary);
      END;

      INSERT INTO project_fts(project_fts) VALUES('rebuild');
    `,
  },
  {
    name: '006_channel_test_and_dedup',
    sql: `
      ALTER TABLE channels ADD COLUMN last_test_result TEXT;
      ALTER TABLE channels ADD COLUMN last_tested_at TEXT;
      ALTER TABLE channels ADD COLUMN updated_at TEXT;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_channel_events_dedup ON channel_events(channel_id, external_event_id);
    `,
  },
  {
    name: '007_fix_message_fts_column',
    sql: `
      DROP TRIGGER IF EXISTS trg_message_fts_insert;
      DROP TRIGGER IF EXISTS trg_message_fts_delete;
      DROP TRIGGER IF EXISTS trg_message_fts_update;
      DROP TABLE IF EXISTS message_fts;

      CREATE VIRTUAL TABLE IF NOT EXISTS message_fts USING fts5(
        id UNINDEXED, project_id UNINDEXED, content_json, content='messages', content_rowid='rowid'
      );

      CREATE TRIGGER IF NOT EXISTS trg_message_fts_insert AFTER INSERT ON messages BEGIN
        INSERT INTO message_fts(rowid, id, project_id, content_json) VALUES (new.rowid, new.id, new.project_id, new.content_json);
      END;
      CREATE TRIGGER IF NOT EXISTS trg_message_fts_delete AFTER DELETE ON messages BEGIN
        INSERT INTO message_fts(message_fts, rowid, id, project_id, content_json) VALUES('delete', old.rowid, old.id, old.project_id, old.content_json);
      END;
      CREATE TRIGGER IF NOT EXISTS trg_message_fts_update AFTER UPDATE ON messages BEGIN
        INSERT INTO message_fts(message_fts, rowid, id, project_id, content_json) VALUES('delete', old.rowid, old.id, old.project_id, old.content_json);
        INSERT INTO message_fts(rowid, id, project_id, content_json) VALUES (new.rowid, new.id, new.project_id, new.content_json);
      END;

      INSERT INTO message_fts(message_fts) VALUES('rebuild');
    `,
  },
  {
    name: '008_fix_knowledge_chunk_fts_column',
    sql: `
      DROP TRIGGER IF EXISTS trg_chunk_fts_insert;
      DROP TRIGGER IF EXISTS trg_chunk_fts_delete;
      DROP TRIGGER IF EXISTS trg_chunk_fts_update;
      DROP TABLE IF EXISTS knowledge_chunk_fts;

      CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_chunk_fts USING fts5(
        id UNINDEXED, text, content='knowledge_chunks', content_rowid='rowid'
      );

      CREATE TRIGGER IF NOT EXISTS trg_chunk_fts_insert AFTER INSERT ON knowledge_chunks BEGIN
        INSERT INTO knowledge_chunk_fts(rowid, id, text) VALUES (new.rowid, new.id, new.text);
      END;
      CREATE TRIGGER IF NOT EXISTS trg_chunk_fts_delete AFTER DELETE ON knowledge_chunks BEGIN
        INSERT INTO knowledge_chunk_fts(knowledge_chunk_fts, rowid, id, text) VALUES('delete', old.rowid, old.id, old.text);
      END;
      CREATE TRIGGER IF NOT EXISTS trg_chunk_fts_update AFTER UPDATE ON knowledge_chunks BEGIN
        INSERT INTO knowledge_chunk_fts(knowledge_chunk_fts, rowid, id, text) VALUES('delete', old.rowid, old.id, old.text);
        INSERT INTO knowledge_chunk_fts(rowid, id, text) VALUES (new.rowid, new.id, new.text);
      END;

      INSERT INTO knowledge_chunk_fts(knowledge_chunk_fts) VALUES('rebuild');
    `,
  },
  {
    name: '009_create_skills_tables',
    sql: `
      CREATE TABLE IF NOT EXISTS skills (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        prompt_md TEXT,
        required_capabilities_json TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        is_builtin INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_skills_name ON skills(name);

      CREATE TABLE IF NOT EXISTS agent_skills (
        agent_definition_id TEXT NOT NULL,
        agent_definition_version TEXT NOT NULL,
        skill_id TEXT NOT NULL REFERENCES skills(id),
        ordinal INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_skills ON agent_skills(agent_definition_id, agent_definition_version, skill_id);
    `,
  },
  {
    name: '010_add_channels_created_at',
    sql: `
      ALTER TABLE channels ADD COLUMN created_at TEXT;
    `,
  },
  {
    name: '011_add_cli_connections_timestamps',
    sql: `
      ALTER TABLE cli_connections ADD COLUMN created_at TEXT;
      ALTER TABLE cli_connections ADD COLUMN updated_at TEXT;
    `,
  },
  {
    name: '012_fix_cli_connections_trust_tier_check',
    sql: `
      CREATE TABLE cli_connections_new (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        adapter_type TEXT NOT NULL,
        executable_path TEXT NOT NULL,
        args_json TEXT,
        strategy_id TEXT,
        detected_version TEXT,
        auth_mode TEXT,
        secret_refs_json TEXT,
        trust_tier TEXT NOT NULL DEFAULT 'trusted' CHECK(trust_tier IN ('trusted','sandboxed','restricted')),
        status TEXT NOT NULL DEFAULT 'unknown' CHECK(status IN ('unknown','compatible','incompatible','experimental')),
        capabilities_json TEXT,
        last_checked_at TEXT,
        created_at TEXT,
        updated_at TEXT
      );
      INSERT INTO cli_connections_new SELECT * FROM cli_connections;
      DROP TABLE cli_connections;
      ALTER TABLE cli_connections_new RENAME TO cli_connections;
      CREATE INDEX IF NOT EXISTS idx_cli_connections_exec ON cli_connections(executable_path, strategy_id);
    `,
  },
  {
    name: '013_create_profiles_for_existing_cli',
    sql: `
      INSERT INTO agent_profiles (id, name, definition_id, definition_version, runtime_mode, cli_connection_id, enabled, delegatable, is_system_default, created_at, updated_at)
      SELECT cc.id || '-profile', cc.name, 'custom.' || cc.adapter_type, '1.0.0', 'external-cli', cc.id, 1, 1, 0, COALESCE(cc.created_at, datetime('now')), COALESCE(cc.updated_at, datetime('now'))
      FROM cli_connections cc
      LEFT JOIN agent_profiles ap ON ap.cli_connection_id = cc.id
      WHERE ap.id IS NULL;
    `,
  },
  {
    name: '014_fix_cli_agent_delegatable',
    sql: `
      UPDATE agent_profiles SET delegatable = 1 WHERE runtime_mode = 'external-cli' AND delegatable = 0;
    `,
  },
  {
    name: '015_add_cli_agents_to_existing_projects',
    sql: `
      INSERT INTO project_agent_instances (id, project_id, agent_profile_id, definition_id, definition_version, role, runtime_mode, cli_connection_id, ordinal, created_at)
      SELECT
        p.id || '-cli-' || substr(ap.id, 1, 8),
        p.id,
        ap.id,
        ap.definition_id,
        ap.definition_version,
        'teammate',
        'external-cli',
        ap.cli_connection_id,
        (SELECT COALESCE(MAX(ordinal), 0) + 1 FROM project_agent_instances WHERE project_id = p.id),
        datetime('now')
      FROM projects p
      CROSS JOIN agent_profiles ap
      WHERE ap.runtime_mode = 'external-cli' AND ap.enabled = 1
      AND NOT EXISTS (
        SELECT 1 FROM project_agent_instances pai
        WHERE pai.project_id = p.id AND pai.agent_profile_id = ap.id
      );
    `,
  },
  {
    name: '016_memory_lifecycle_and_tombstones',
    sql: `
      CREATE TABLE memory_records_v2 (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        agent_instance_id TEXT NOT NULL,
        scope TEXT NOT NULL CHECK(scope IN ('short-term','long-term')),
        type TEXT NOT NULL,
        content TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 0.5,
        importance REAL NOT NULL DEFAULT 0.5,
        pinned INTEGER NOT NULL DEFAULT 0,
        topic_key TEXT,
        source_refs_json TEXT,
        metadata_json TEXT,
        status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','expired','deleted','consolidated','superseded')),
        expires_at TEXT,
        last_reinforced_at TEXT NOT NULL,
        last_accessed_at TEXT,
        access_count INTEGER NOT NULL DEFAULT 0,
        consolidated_into_id TEXT,
        supersedes_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO memory_records_v2 (
        id, project_id, agent_instance_id, scope, type, content, confidence, importance, pinned,
        topic_key, source_refs_json, metadata_json, status, expires_at, last_reinforced_at,
        last_accessed_at, access_count, consolidated_into_id, supersedes_id, created_at, updated_at
      )
      SELECT id, project_id, agent_instance_id, scope, type, content, confidence, 0.5,
        CASE WHEN type = 'project-constraint' THEN 1 ELSE 0 END,
        NULL, source_refs_json, NULL, status, expires_at, updated_at,
        NULL, 0, NULL, NULL, created_at, updated_at
      FROM memory_records;
      DROP TABLE memory_records;
      ALTER TABLE memory_records_v2 RENAME TO memory_records;
      CREATE INDEX idx_memory_records_lookup ON memory_records(agent_instance_id, scope, status);
      CREATE INDEX idx_memory_records_topic ON memory_records(project_id, agent_instance_id, topic_key, status);

      CREATE TABLE memory_tombstones (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        agent_instance_id TEXT NOT NULL,
        normalized_key TEXT NOT NULL,
        source_message_id TEXT,
        reason TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_memory_tombstones_lookup ON memory_tombstones(project_id, agent_instance_id, normalized_key);
    `,
  },
  {
    name: '017_versioned_skills_and_workflows',
    sql: `
      CREATE TABLE skill_packages (
        id TEXT NOT NULL, version TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL,
        package_rel_path TEXT NOT NULL, entry_rel_path TEXT NOT NULL DEFAULT 'SKILL.md',
        manifest_json TEXT NOT NULL, checksum TEXT NOT NULL,
        source TEXT NOT NULL CHECK(source IN ('built-in','custom','legacy')),
        enabled INTEGER NOT NULL DEFAULT 1, installed_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY (id, version)
      );
      CREATE INDEX idx_skill_packages_enabled ON skill_packages(enabled, name);

      CREATE TABLE agent_definition_skills (
        agent_definition_id TEXT NOT NULL, agent_definition_version TEXT NOT NULL,
        skill_id TEXT NOT NULL, skill_version TEXT NOT NULL, ordinal INTEGER NOT NULL, config_json TEXT,
        PRIMARY KEY (agent_definition_id, agent_definition_version, skill_id, skill_version),
        FOREIGN KEY (skill_id, skill_version) REFERENCES skill_packages(id, version)
      );
      CREATE INDEX idx_agent_definition_skills_lookup ON agent_definition_skills(agent_definition_id, agent_definition_version, ordinal);

      CREATE TABLE agent_run_skills (
        run_id TEXT NOT NULL, skill_id TEXT NOT NULL, skill_version TEXT NOT NULL,
        checksum TEXT NOT NULL, package_rel_path TEXT NOT NULL, snapshot_json TEXT NOT NULL, created_at TEXT NOT NULL,
        PRIMARY KEY (run_id, skill_id, skill_version)
      );

      CREATE TABLE workflow_packages (
        id TEXT NOT NULL, version TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL,
        spec_md TEXT NOT NULL, manifest_json TEXT NOT NULL, checksum TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY (id, version)
      );

      CREATE TABLE agent_definition_workflows (
        agent_definition_id TEXT NOT NULL, agent_definition_version TEXT NOT NULL,
        workflow_id TEXT NOT NULL, workflow_version TEXT NOT NULL, ordinal INTEGER NOT NULL,
        PRIMARY KEY (agent_definition_id, agent_definition_version, workflow_id, workflow_version),
        FOREIGN KEY (workflow_id, workflow_version) REFERENCES workflow_packages(id, version)
      );

      CREATE TABLE agent_run_workflows (
        run_id TEXT NOT NULL, workflow_id TEXT NOT NULL, workflow_version TEXT NOT NULL,
        checksum TEXT NOT NULL, snapshot_json TEXT NOT NULL, created_at TEXT NOT NULL,
        PRIMARY KEY (run_id, workflow_id, workflow_version)
      );
    `,
  },
  {
    name: '018_local_knowledge_index',
    sql: `
      ALTER TABLE knowledge_sources ADD COLUMN content_md5 TEXT;
      ALTER TABLE knowledge_sources ADD COLUMN parser_id TEXT;
      ALTER TABLE knowledge_sources ADD COLUMN metadata_json TEXT;
      CREATE INDEX idx_knowledge_sources_md5 ON knowledge_sources(scope_type, scope_id, content_md5);

      CREATE TABLE knowledge_document_profiles (
        source_id TEXT PRIMARY KEY,
        summary TEXT NOT NULL,
        keywords_json TEXT NOT NULL,
        tags_json TEXT NOT NULL,
        language TEXT NOT NULL,
        metadata_json TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE knowledge_chunk_embeddings (
        chunk_id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL,
        model_id TEXT NOT NULL,
        dimensions INTEGER NOT NULL,
        vector_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_knowledge_embeddings_source ON knowledge_chunk_embeddings(source_id);
    `,
  },
];
