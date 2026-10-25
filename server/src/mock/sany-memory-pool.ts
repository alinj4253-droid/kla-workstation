import { randomUUID } from 'node:crypto';
import type { MemoryAccountRepository } from './memory-account-repository.js';

type QueryResult = { rows: Array<Record<string, unknown>>; rowCount?: number };

type Row = Record<string, unknown>;

/**
 * Mock 模式的三一规划内存池：按 SQL 模式命中内存数据，
 * 覆盖 sany 路由（项目 / 成员 / 任务 / 派发 / 提交 / 收束 / 事件）的读写。
 * 与 server/migrations/0049_0050 的表结构对齐，用于无 PostgreSQL 环境的联调与测试。
 */
export class SanyMemoryPool {
  private readonly projects = new Map<string, Row>();
  private readonly members = new Map<string, Row>();
  private readonly tasks = new Map<string, Row>();
  private readonly assignments = new Map<string, Row>();
  private readonly submissions = new Map<string, Row>();
  private readonly closures = new Map<string, Row>();
  private readonly events = new Map<string, Row>();
  private readonly documents = new Map<string, Row>();
  private readonly fields = new Map<string, Row>();
  private readonly issues = new Map<string, Row>();
  private readonly outputs = new Map<string, Row>();
  private readonly versions = new Map<string, Row>();
  private readonly feedback = new Map<string, Row>();

  constructor(private readonly accounts: MemoryAccountRepository) {}

  private empty(): QueryResult { return { rows: [], rowCount: 0 }; }
  private result(rows: Row[]): QueryResult { return { rows, rowCount: rows.length }; }
  private now(): string { return new Date().toISOString(); }

  handles(sql: string): boolean {
    return /sany/i.test(sql);
  }

  async query(sql: string, params: readonly unknown[] = []): Promise<QueryResult> {
    const normalized = sql.toLowerCase();
    const asParams = params.map(value => (value === undefined ? null : value));

    if (normalized.startsWith('begin') || normalized.startsWith('commit') || normalized.startsWith('rollback')) return this.empty();

    if (normalized.includes('insert into sany_projects')) {
      const owner = String(asParams[0] ?? '');
      const existing = [...this.projects.values()].find(item => item.owner_identity_id === owner && item.status === 'active');
      if (existing) return this.result([existing]);
      const row: Row & { id: string } = {
        id: randomUUID(), owner_identity_id: owner,
        name: String(asParams[1] ?? ''), org_name: String(asParams[2] ?? ''),
        planning_period: String(asParams[3] ?? ''), plan_year: String(asParams[4] ?? ''),
        deadline: asParams[5] ?? null, intent: String(asParams[6] ?? ''),
        status: 'active', output_generated: false, output_released: false,
        delivery_checks: {}, decisions: {}, conclusion: '',
        organization_id: null, created_at: this.now(), updated_at: this.now(),
      };
      this.projects.set(row.id, row);
      return this.result([row]);
    }

    // INSERT 必须先于 FROM 判断：部分 INSERT 的 VALUES 子查询里含 FROM sany_xxx，
    // 否则会被 SELECT 分支抢先命中，返回错误行。
    if (normalized.includes('insert into sany_')) {
      const table = /insert into (\w+)/i.exec(sql)?.[1] ?? '';
      const columns = /insert into \w+\s*\(([^)]*)\)/i.exec(sql)?.[1]?.split(',').map(item => item.trim()) ?? [];
      const store = this.storeFor(table);
      if (!store || columns.length === 0) return this.empty();
      const conflict = this.conflictCheck(table, columns, asParams);
      if (conflict && [...store.values()].some(row => conflict(row))) return this.empty();
      const valuesClause = this.extractValuesClause(sql);
      const valueParts = valuesClause ? this.splitValues(valuesClause) : [];
      const id = randomUUID();
      const row: Row = { id };
      columns.forEach((column, index) => { row[column] = this.parseValue(valueParts[index], asParams); });
      this.applyDefaults(table, row);
      store.set(id, row);
      return this.result([row]);
    }

    if (normalized.includes('from sany_projects')) {
      if (normalized.includes('where owner_identity_id=$1 and status=')) {
        const row = [...this.projects.values()].find(item => item.owner_identity_id === asParams[0] && item.status === 'active');
        return this.result(row ? [row] : []);
      }
      if (normalized.includes('where id=$1 and owner_identity_id=$2')) {
        const row = this.projects.get(String(asParams[0] ?? ''));
        return this.result(row && row.owner_identity_id === asParams[1] ? [row] : []);
      }
      return this.empty();
    }

    if (normalized.includes('from sany_members')) {
      if (normalized.includes('where project_id=$1 and identity_id=$2 and role=')) {
        return this.result([...this.members.values()].some(item => item.project_id === asParams[0] && item.identity_id === asParams[1] && item.role === 'admin') ? [{ '?column?': 1 }] : []);
      }
      if (normalized.includes('where project_id=$1 and emp_no=$2')) {
        const row = [...this.members.values()].find(item => item.project_id === asParams[0] && item.emp_no === asParams[1]);
        return this.result(row ? [row] : []);
      }
      if (normalized.includes('where project_id=$1 and name=$2 and unit=$3 and role=$4')) {
        const row = [...this.members.values()].find(item => item.project_id === asParams[0] && item.name === asParams[1] && item.unit === asParams[2] && item.role === asParams[3]);
        return this.result(row ? [row] : []);
      }
      if (normalized.includes('where id=$1 and project_id=$2')) {
        const row = this.members.get(String(asParams[0] ?? ''));
        return this.result(row && row.project_id === asParams[1] ? [row] : []);
      }
      if (normalized.includes("where project_id=$1 and role='admin'")) {
        const rows = [...this.members.values()].filter(item => item.project_id === asParams[0] && item.role === 'admin');
        return this.result([{ n: rows.length }]);
      }
      const rows = [...this.members.values()].filter(item => item.project_id === asParams[0]);
      return this.result(rows.sort((a, b) => Number(a.sort_order) - Number(b.sort_order)));
    }

    if (normalized.includes('delete from sany_members')) {
      const row = this.members.get(String(asParams[0] ?? ''));
      if (!row || row.project_id !== asParams[1]) return this.empty();
      this.members.delete(String(asParams[0] ?? ''));
      return this.result([{ id: row.id }]);
    }

    if (normalized.includes('from sany_tasks')) {
      if (normalized.includes('from sany_tasks t where t.project_id=$1')) {
        const projectRows = [...this.tasks.values()].filter(item => item.project_id === asParams[0]);
        const docs = [...this.documents.values()];
        const fields = [...this.fields.values()];
        const submissions = [...this.submissions.values()];
        return this.result(projectRows.sort((a, b) => Number(a.sort_order) - Number(b.sort_order)).map(task => {
          const taskFields = fields.filter(field => field.task_id === task.id && field.scope === 'unit' && !field.removed);
          const taskSubmissions = submissions.filter(submission => submission.task_id === task.id);
          const latest = taskSubmissions[taskSubmissions.length - 1];
          return {
            ...task,
            doc_count: docs.filter(document => document.task_id === task.id).length,
            field_count: taskFields.length,
            verified_count: taskFields.filter(field => ['accepted', 'edited', 'rejected'].includes(String(field.status))).length,
            gap_count: taskFields.filter(field => field.status === 'missing').length,
            submission_count: taskSubmissions.length,
            latest_no: latest ? latest.submission_no : null,
            latest_status: latest ? latest.status : null,
            latest_summary: latest ? latest.summary : null,
            latest_submitted_at: latest ? latest.submitted_at : null,
          };
        }));
      }
      if (normalized.includes('where id=$1 and project_id=$2')) {
        const row = this.tasks.get(String(asParams[0] ?? ''));
        return this.result(row && row.project_id === asParams[1] ? [row] : []);
      }
      if (normalized.includes('where project_id=$1')) {
        return this.result([{ n: [...this.tasks.values()].filter(item => item.project_id === asParams[0]).length }]);
      }
      return this.empty();
    }

    if (normalized.includes('from sany_task_assignments')) {
      if (normalized.includes('where task_id=$1 and project_id=$2 order by assigned_at limit 1')) {
        const rows = [...this.assignments.values()].filter(item => item.task_id === asParams[0] && item.project_id === asParams[1]);
        return this.result(rows.length ? [rows[0]] : []);
      }
      const rows = [...this.assignments.values()].filter(item => item.project_id === asParams[0]);
      return this.result(rows);
    }

    if (normalized.includes('from sany_task_submissions')) {
      if (normalized.includes('coalesce(max(submission_no)')) {
        const rows = [...this.submissions.values()].filter(item => item.task_id === asParams[0]);
        return this.result([{ v: rows.reduce((max, item) => Math.max(max, Number(item.submission_no)), 0) + 1 }]);
      }
      if (normalized.includes('where task_id=$1 and project_id=$2 order by submission_no desc limit 1')) {
        const rows = [...this.submissions.values()].filter(item => item.task_id === asParams[0] && item.project_id === asParams[1]);
        return this.result(rows.length ? [rows[rows.length - 1]] : []);
      }
      const rows = [...this.submissions.values()].filter(item => item.task_id === asParams[0] && item.project_id === asParams[1]);
      return this.result([...rows].sort((a, b) => Number(a.submission_no) - Number(b.submission_no)));
    }

    if (normalized.includes('from sany_task_closures')) {
      if (normalized.includes('join identities')) {
        const rows = [...this.closures.values()].filter(item => item.task_id === asParams[0] && item.project_id === asParams[1]);
        return this.result(rows.map(closure => ({ ...closure, actor_name: this.accounts.getIdentityDisplayName(String(closure.actor_identity_id ?? '')) })));
      }
      if (normalized.includes('order by c.created_at desc limit 1')) {
        const rows = [...this.closures.values()].filter(item => item.task_id === asParams[0] && item.project_id === asParams[1]);
        return this.result(rows.length ? [rows[rows.length - 1]] : []);
      }
      return this.empty();
    }

    if (normalized.includes('from sany_task_events')) {
      const rows = [...this.events.values()].filter(item => item.task_id === asParams[0] && item.project_id === asParams[1]);
      return this.result(rows.map(event => ({ ...event, actor_name: this.accounts.getIdentityDisplayName(String(event.actor_identity_id ?? '')) })));
    }

    if (normalized.includes('from sany_documents')) {
      if (normalized.includes('where task_id=$1 and project_id=$2')) {
        return this.result([...this.documents.values()].filter(item => item.task_id === asParams[0]).length ? [{ id: 'ok' }] : []);
      }
      return this.result([...this.documents.values()].filter(item => item.project_id === asParams[0]));
    }

    if (normalized.includes('delete from sany_documents')) {
      const row = this.documents.get(String(asParams[0] ?? ''));
      if (!row || row.project_id !== asParams[1]) return this.empty();
      this.documents.delete(String(asParams[0] ?? ''));
      return this.result([{ id: row.id }]);
    }

    if (normalized.includes('from sany_fields')) {
      if (normalized.includes("where task_id=$1 and scope='unit' and not removed")) {
        const rows = [...this.fields.values()].filter(item => item.task_id === asParams[0] && item.scope === 'unit' && !item.removed);
        return this.result([{
          total: rows.length,
          accepted: rows.filter(item => ['accepted', 'edited'].includes(String(item.status))).length,
          edited: rows.filter(item => item.status === 'edited').length,
          rejected: rows.filter(item => item.status === 'rejected').length,
          missing: rows.filter(item => item.status === 'missing').length,
          pending: rows.filter(item => item.status === 'pending').length,
        }]);
      }
      return this.result([...this.fields.values()].filter(item => item.project_id === asParams[0]));
    }

    if (normalized.includes('update sany_fields set')) {
      const row = this.fields.get(String(asParams[0] ?? ''));
      if (!row || row.project_id !== asParams[1]) return this.empty();
      if (asParams[2] !== null && asParams[2] !== undefined) row.status = String(asParams[2]);
      if (asParams[3] === true) row.human_content = asParams[4] ?? null;
      if (asParams[5] !== null && asParams[5] !== undefined) row.removed = Boolean(asParams[5]);
      if (asParams[6] === true) row.removed_reason = asParams[7] ?? null;
      row.updated_at = this.now();
      return this.result([row]);
    }

    if (normalized.includes('from sany_issues')) {
      return this.result([...this.issues.values()].filter(item => item.project_id === asParams[0]));
    }

    if (normalized.includes('update sany_issues set')) {
      const row = this.issues.get(String(asParams[0] ?? ''));
      if (!row || row.project_id !== asParams[1]) return this.empty();
      row.status = String(asParams[2] ?? '');
      return this.result([{ id: row.id, code: row.code, status: row.status }]);
    }

    if (normalized.includes('from sany_outputs')) {
      if (normalized.includes('where project_id=$1 and output_key=$2')) {
        const row = [...this.outputs.values()].find(item => item.project_id === asParams[0] && item.output_key === asParams[1]);
        return this.result(row ? [row] : []);
      }
      return this.result([...this.outputs.values()].filter(item => item.project_id === asParams[0]));
    }

    if (normalized.includes('from sany_output_versions')) {
      if (normalized.includes('where output_id=$1')) {
        const rows = [...this.versions.values()].filter(item => item.output_id === asParams[0]);
        return this.result([{ v: rows.reduce((max, item) => Math.max(max, Number(item.version_no)), 0) + 1 }]);
      }
      const projectOutputs = [...this.outputs.values()].filter(item => item.project_id === asParams[0]);
      const outputIds = new Set(projectOutputs.map(item => item.id));
      return this.result([...this.versions.values()].filter(item => outputIds.has(item.output_id)).sort((a, b) => Number(a.version_no) - Number(b.version_no)));
    }

    if (normalized.includes('from sany_feedback')) {
      return this.result([...this.feedback.values()].filter(item => item.project_id === asParams[0]).slice(0, 20));
    }

    if (normalized.includes('update sany_projects set')) {
      const row = this.projects.get(String(asParams[0] ?? ''));
      if (!row) return this.empty();
      if (asParams[1] !== null && asParams[1] !== undefined) row.conclusion = String(asParams[1]);
      if (asParams[2] !== null && asParams[2] !== undefined) row.decisions = JSON.parse(String(asParams[2]));
      if (asParams[3] !== null && asParams[3] !== undefined) row.output_generated = Boolean(asParams[3]);
      if (asParams[4] !== null && asParams[4] !== undefined) row.output_released = Boolean(asParams[4]);
      if (asParams[5] !== null && asParams[5] !== undefined) row.delivery_checks = JSON.parse(String(asParams[5]));
      row.updated_at = this.now();
      return this.result([{
        output_generated: row.output_generated, output_released: row.output_released,
        delivery_checks: row.delivery_checks, decisions: row.decisions, conclusion: row.conclusion,
      }]);
    }

    if (normalized.includes('update sany_tasks set')) {
      const row = this.tasks.get(String(asParams[0] ?? ''));
      if (!row) return this.empty();
      const setClause = this.sliceSetClause(sql);
      for (const part of setClause.split(',').map(item => item.trim()).filter(Boolean)) {
        const eq = part.indexOf('=');
        const column = part.slice(0, eq).trim();
        const raw = part.slice(eq + 1).trim();
        if (raw.startsWith('$')) row[column] = asParams[Number(raw.slice(1)) - 1] ?? null;
        else if (raw === 'null') row[column] = null;
        else if (raw === 'now()') row[column] = this.now();
        else if (raw.startsWith("'")) row[column] = part.slice(eq + 2, part.lastIndexOf("'"));
      }
      row.updated_at = this.now();
      return this.empty();
    }

    if (normalized.includes('update sany_task_assignments set')) {
      const row = this.assignments.get(String(asParams[0] ?? ''));
      if (!row) return this.empty();
      const setClause = this.sliceSetClause(sql);
      for (const part of setClause.split(',').map(item => item.trim()).filter(Boolean)) {
        const eq = part.indexOf('=');
        const column = part.slice(0, eq).trim();
        const raw = part.slice(eq + 1).trim();
        if (raw.startsWith("'")) row[column] = part.slice(eq + 2, part.lastIndexOf("'"));
        else if (raw === 'now()') row[column] = this.now();
      }
      return this.empty();
    }

    if (normalized.includes('update sany_task_submissions set')) {
      const row = this.submissions.get(String(asParams[0] ?? ''));
      if (!row || row.project_id !== asParams[1]) return this.empty();
      const setClause = this.sliceSetClause(sql);
      for (const part of setClause.split(',').map(item => item.trim()).filter(Boolean)) {
        const eq = part.indexOf('=');
        const column = part.slice(0, eq).trim();
        const raw = part.slice(eq + 1).trim();
        if (raw.startsWith("'")) row[column] = part.slice(eq + 2, part.lastIndexOf("'"));
        else if (raw === 'now()') row[column] = this.now();
        else if (raw.startsWith('$')) row[column] = asParams[Number(raw.slice(1)) - 1] ?? null;
      }
      return this.empty();
    }

    return this.empty();
  }

  private extractValuesClause(sql: string): string | null {
    const marker = sql.toLowerCase().indexOf('values');
    if (marker === -1) return null;
    const open = sql.indexOf('(', marker);
    if (open === -1) return null;
    let depth = 0;
    for (let i = open; i < sql.length; i += 1) {
      if (sql[i] === '(') depth += 1;
      if (sql[i] === ')') {
        depth -= 1;
        if (depth === 0) return sql.slice(open + 1, i);
      }
    }
    return null;
  }

  private splitValues(clause: string): string[] {
    const parts: string[] = [];
    let depth = 0;
    let current = '';
    for (const char of clause) {
      if (char === '(') depth += 1;
      if (char === ')') depth -= 1;
      if (char === ',' && depth === 0) { parts.push(current.trim()); current = ''; continue; }
      current += char;
    }
    if (current.trim()) parts.push(current.trim());
    return parts;
  }

  private parseValue(raw: string | undefined, params: unknown[]): unknown {
    if (raw === undefined || raw === '') return null;
    if (raw.startsWith('$')) return params[Number(raw.slice(1)) - 1] ?? null;
    if (raw === 'NULL') return null;
    if (raw === 'now()') return this.now();
    if (raw === 'current_date') return this.now().slice(0, 10);
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    const jsonLiteral = /^'([^']*)'::jsonb$/.exec(raw);
    if (jsonLiteral) { try { return JSON.parse(jsonLiteral[1]); } catch { return jsonLiteral[1]; } }
    if (raw.startsWith("'")) return raw.slice(1, -1);
    if (raw.startsWith('(')) return 0;
    return raw;
  }

  private sliceSetClause(sql: string): string {
    const lower = sql.toLowerCase();
    const setStart = lower.indexOf('set') + 3;
    const whereStart = lower.indexOf('where');
    return sql.slice(setStart, whereStart === -1 ? sql.length : whereStart);
  }

  private storeFor(table: string): Map<string, Row> | null {
    switch (table) {
      case 'sany_members': return this.members;
      case 'sany_tasks': return this.tasks;
      case 'sany_task_assignments': return this.assignments;
      case 'sany_task_submissions': return this.submissions;
      case 'sany_task_closures': return this.closures;
      case 'sany_task_events': return this.events;
      case 'sany_documents': return this.documents;
      case 'sany_fields': return this.fields;
      case 'sany_issues': return this.issues;
      case 'sany_outputs': return this.outputs;
      case 'sany_output_versions': return this.versions;
      case 'sany_feedback': return this.feedback;
      default: return null;
    }
  }

  private conflictCheck(table: string, columns: string[], params: unknown[]): ((row: Row) => boolean) | null {
    const at = (name: string): unknown => {
      const index = columns.indexOf(name);
      return index === -1 ? undefined : params[index];
    };
    if (table === 'sany_members') return row => row.project_id === at('project_id') && row.emp_no === at('emp_no');
    if (table === 'sany_tasks') return row => row.project_id === at('project_id') && row.code === at('code');
    if (table === 'sany_task_assignments') return row => row.task_id === at('task_id') && row.member_id === at('member_id');
    if (table === 'sany_issues') return row => row.project_id === at('project_id') && row.code === at('code');
    if (table === 'sany_outputs') return row => row.project_id === at('project_id') && row.output_key === at('output_key');
    if (table === 'sany_output_versions') return row => row.output_id === at('output_id') && row.version_no === at('version_no');
    return null;
  }

  private applyDefaults(table: string, row: Row): void {
    const defaults: Record<string, Record<string, unknown>> = {
      sany_members: { color: '#3a4a63', joined_on: this.now().slice(0, 10), status: '在职', identity_id: null },
      sany_tasks: { task_type: 'T-BG', task_type_name: '成长型业务', assigned_at: this.now().slice(0, 10), status: '待上传', planning_period: '', individual_note: '', closed_at: null, created_at: this.now(), updated_at: this.now() },
      sany_task_assignments: { status: 'assigned', individual_note: '', assigned_at: this.now(), accepted_at: null, submitted_at: null, closed_at: null },
      sany_task_submissions: { status: 'submitted', deliverables: [], material_ids: [], output_refs: [], field_snapshot: [], reviewer_note: '', submitted_at: this.now(), reviewed_at: null, created_at: this.now() },
      sany_task_closures: { submission_id: null, note: '', checks: {}, created_at: this.now() },
      sany_task_events: { assignment_id: null, from_status: null, to_status: null, detail: {}, created_at: this.now() },
      sany_documents: { ext: 'pdf', size_label: '', color: '#3a4a63', page_count: 0, claim_count: 0, field_count: 0, created_at: this.now() },
      sany_fields: { field_type: 'text', ai_content: '', confidence: 0, source: '', status: 'pending', human_content: null, gap: '', removed: false, removed_reason: null, is_custom: false, updated_at: this.now() },
      sany_issues: { level: '一般', detail: '', owner_name: '', status: '待补充', sort_order: 0 },
      sany_outputs: { description: '', note: '', sort_order: 0 },
      sany_output_versions: { created_by: '', status: '待审核', summary: '', changes: '', size_label: '', file_name: '', audit: null, page_names: [], created_at: this.now() },
      sany_feedback: { author_name: '', created_at: this.now() },
    };
    for (const [column, value] of Object.entries(defaults[table] ?? {})) {
      if (row[column] === undefined) row[column] = value;
    }
    for (const column of ['requirements', 'deliverables', 'material_ids', 'output_refs', 'field_snapshot', 'detail', 'decisions', 'delivery_checks', 'page_names', 'checks']) {
      if (typeof row[column] === 'string') {
        try { row[column] = JSON.parse(row[column] as string); } catch { /* keep raw string */ }
      }
    }
  }

  async connect(): Promise<{ query: (sql: string, params?: readonly unknown[]) => Promise<QueryResult>; release: () => void }> {
    return { query: (sql, params) => this.query(sql, params), release: () => undefined };
  }
}
