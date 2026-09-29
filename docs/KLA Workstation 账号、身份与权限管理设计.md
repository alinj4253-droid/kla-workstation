# KLA Workstation 账号、身份与权限管理设计

> 状态注记（对齐）：本文是身份/账号/权限的概念设计与决策依据；表命名（`user_accounts`/`identities`/`organization_members`/`organization_roles`/`organization_entitlements`）已被《FULL_STACK_IMPLEMENTATION_SPEC.md》§5.1 采纳为实现规格，字段与接口细节以该文为准。sub2api 账号与工作身份的映射依赖本文模型，见《DESIGN_SUB2API_COMPUTE_PLATFORM.md》§3。

## 1\. 核心原则



账号表示“谁在登录”，身份表示“用户当前以谁的身份工作”。账号不直接绑定单一企业；一个账号可以拥有个人身份、多个企业身份。切换身份后，服务端重新建立权限上下文，权限、工作区、项目、群聊、文件、知识、记忆和权益均隔离。



```Plain Text
user_accounts 1 -- N identities
identities 1 -- 0..1 organization_members
organization_members N -- 1 organizations
organizations 1 -- N organization_roles
organization_roles N -- N permissions
```



## 2\. 用户账号与身份



`user_accounts` 只保存登录主体：



```Plain Text
id, email, phone, password_hash, nickname, avatar, status,
email_verified, phone_verified, last_login_at, created_at, updated_at
```



账号状态：`active`、`pending_verification`、`locked`、`disabled`、`deleted`。密码使用 Argon2id 或 bcrypt 哈希，账号禁用后所有会话和刷新令牌立即失效。



`identities` 保存工作身份：



```Plain Text
id, user_id, identity_type, display_name, avatar, status, is_default,
created_at, updated_at
```



身份类型：`personal`、`enterprise`、`external`、`service`。当前 MVP 使用个人身份和企业身份。每个身份独立关联工作区、项目、群聊、文件、知识、记忆、智能体、模型用量、角色和审计记录。



## 3\. 企业和成员



`organizations`：



```Plain Text
id, name, short_name, business_license_no, business_license_hash,
status, owner_member_id, created_at, updated_at
```



创建企业必须提交企业名称和营业执照号/统一社会信用代码，需做唯一性校验；普通成员只看脱敏值，完整值仅授权管理员和 KLA 后台可见。



`organization_members`：



```Plain Text
id, organization_id, user_id, identity_id, member_no, department_id,
job_title, status, joined_at, left_at, created_at, updated_at
```



成员状态为 `pending`、`active`、`suspended`、`removed`。加入企业会新增企业身份，不会覆盖个人身份；退出企业后企业身份置为 `removed`。



创建企业流程：创建企业、成员关系、企业身份、管理员角色、默认工作区和企业知识区。加入企业流程：邀请码/邀请/申请审核后创建成员关系和企业成员身份，默认分配成员角色。



## 4\. 角色、权限和权益



每个企业默认有不可修改、不可删除的“企业管理员”和“企业成员”角色。管理员负责成员、角色、工作区、项目、企业知识、智能体授权、模型用量和安全设置；成员只能访问被授权资源。



自定义角色表：



```Plain Text
organization_roles(id, organization_id, name, description, is_system,
status, created_by, created_at, updated_at)
permissions(id, resource, action, scope)
role_permissions(role_id, permission_id)
member_roles(member_id, role_id, assigned_by, assigned_at)
```



权限采用“资源 \+ 动作 \+ 范围”，例如 `project.view`、`conversation.send`、`knowledge.search`、`agent.use`、`skill.manage`、`file.download`、`meeting.create`、`operation.execute`、`model.use`、`usage.view`。范围为 `own`、`assigned`、`project`、`department`、`organization`、`all`。多个角色默认取权限并集，必要时支持显式 deny。



权益与权限分开：



```Plain Text
organization_entitlements(
organization_id, plan_code, token_quota, token_used, storage_quota,
member_limit, project_limit, agent_limit, concurrency_limit,
model_scope_json, knowledge_quota, expires_at, status)
```



角色决定“能不能做”，权益决定“能用多少”。到期、冻结或超额时，服务端拒绝新增任务和资源操作。



## 5\. 身份管理



设置 \-\> 身份管理展示个人身份及所有企业身份，支持切换身份、设置默认登录身份、查看状态、退出企业和刷新权限。



切换必须执行：



```Plain Text
撤销旧身份上下文 -> 清理敏感缓存 -> 校验新身份
-> 加载新角色、权限和权益 -> 加载工作区/项目/群聊
-> 创建身份会话 -> 写入审计事件
```



客户端可以传递 `X-Identity-Id`，但服务端必须根据 Session 重新生成 `userId`、`identityId`、`organizationId`、`memberId`、`roles`、`permissions`、`resourceScopes` 和 `entitlements`。



## 6\. KLA 管理后台



平台后台独立于企业管理员，拥有最高平台权限，可查询、禁用和恢复用户账号/身份，审核、冻结和解冻企业，转移企业管理员，配置 Token、有效期、容量、模型范围和成员上限，并禁用高风险技能、MCP 或外部渠道。



```Plain Text
admin_users
admin_roles
admin_role_permissions
account_suspensions
identity_suspensions
organization_entitlements
admin_audit_logs
```



平台管理员的所有高权限操作写入不可由普通业务用户删除的审计日志。



## 7\. 服务端鉴权和业务接入



统一流程：



```Plain Text
验证 Session -> 确认当前身份 -> 获取租户成员关系
-> 加载角色权限 -> 校验资源归属和数据范围
-> 校验企业权益 -> 执行业务 -> 写入审计
```



权限必须覆盖工作区、项目、文件、知识、群聊、附件、智能体、技能、MCP、操作平台、会议、模型、算力、任务、成果、记忆和外部渠道。智能体加入群聊不等于获得群聊全部资源；每次读取或调用都要同时满足当前用户身份、智能体授权和资源权限。



## 8\. 隔离和实施顺序



- 个人文件不会自动进入企业工作区；

- 不同企业知识、项目、群聊完全隔离；

- 企业权限不能带入个人身份；

- 退出企业或禁用身份后立即失去访问权；

- 客户端隐藏菜单不能代替服务端鉴权；

- 文件和知识检索先权限过滤，再全文/向量检索。

    

实施顺序：账号和身份 \-\> 企业成员关系 \-\> 管理员/成员系统角色 \-\> 权限字典和自定义角色 \-\> 工作区/项目/群聊/知识接入 \-\> 智能体、技能、MCP、会议接入 \-\> 企业权益 \-\> 平台后台和审计。

