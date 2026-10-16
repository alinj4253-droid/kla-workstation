# L2｜项目理解

目标：在动手分析前先建立项目的心智模型——它是什么技术栈、由哪些模块构成、模块之间怎么连、从哪里进入。

## 1. 读取项目

优先运行 `scripts/scan_project.py <项目路径> --json` 获取机械性事实，避免手工遍历：

- 目录树（受忽略规则约束，见 L1）。
- 文件数量、代码行数、按扩展名 / 语言分布。
- 技术栈探测结果（标志文件 + 扩展名）。
- 测试文件清单与测试框架线索。
- 入口文件候选与依赖清单。

脚本输出后，按需人工打开关键文件确认，不要仅凭文件名下结论。

## 2. 识别技术栈

以下标志文件出现即作为强信号，逐级确认：

| 标志文件 | 技术栈 |
|---|---|
| `package.json` / `pnpm-lock.yaml` / `yarn.lock` | Node.js / JS / TS |
| `requirements.txt` / `pyproject.toml` / `setup.py` / `Pipfile` | Python |
| `pom.xml` / `build.gradle(.kts)` | Java / Kotlin（JVM） |
| `go.mod` | Go |
| `Cargo.toml` | Rust |
| `composer.json` | PHP |
| `*.csproj` / `*.sln` | .NET / C# |
| `Gemfile` | Ruby |
| `CMakeLists.txt` / `Makefile` | C / C++ |
| `Dockerfile` / `docker-compose.yml` | 容器化 |
| `.github/workflows/` / `.gitlab-ci.yml` / `Jenkinsfile` | CI/CD |

框架细分（读取依赖清单确定）：前端（React/Vue/Angular/Svelte）、后端（Express/NestJS/FastAPI/Django/Spring Boot/Gin）、测试（Jest/Vitest/Pytest/JUnit/Go test）、构建（Vite/Webpack/Rollup）。

同时确认：包管理器、运行时版本约束（engines / .nvmrc / .python-version）、脚本命令（build / test / lint）。

## 3. 梳理目录结构

按职责给目录分类，而不是逐层罗列：

- **入口层**：应用启动、路由注册、CLI 入口、任务调度。
- **业务 / 领域层**：核心逻辑所在，通常与产品功能对应。
- **数据访问层**：ORM / DAO / Repository / Schema / Migration。
- **接口层**：HTTP 路由、RPC、GraphQL、消息消费。
- **公共 / 基础设施层**：工具、配置、日志、中间件、错误处理。
- **测试层**：单元 / 集成 / E2E，及其与源码的对应关系。

对每层指出：是否存在、大致规模、是否有明确边界（有无循环依赖、跨层直连）。

## 4. 分析模块关系

1. **入口定位**：从入口文件出发（`main.*`、`index.*`、`app.*`、`server.*`、框架约定的入口如 `src/main.ts`、`manage.py`）。
2. **依赖方向**：沿 import / require / package 引用绘制模块依赖。重点找：
   - 循环依赖（A→B→A）。
   - 高扇入模块（被大量引用的公共模块，改动影响面大）。
   - 高扇出模块（依赖过多，职责可能过载）。
   - 越层调用（如接口层直接访问数据库层）。
3. **调用链**：对关键功能，从入口追到出参，标出经过的模块与关键函数。指定功能点分析（T3）必须产出至少一条完整调用链。
4. **数据流**：核心数据的来源、变更点、持久化位置、对外暴露点。
5. **边界与契约**：对外接口（HTTP 路径 / RPC 方法 / 事件名）、入参与返回值、错误约定。

## 5. 按需深入代码

L3 每发现一个疑点，回到本层做定向深读：

- 只读与疑点直接相关的文件与调用链，不全文通读大文件。
- 读文件时记录：职责一句话、对外接口、可疑点及其行号。
- 大文件用检索定位（搜函数名 / 关键字 / import），再局部精读，不要盲目整文件载入。

## 6. 产出：项目地图

进入 L3 前形成简要"项目地图"：

```
技术栈：
包管理器 / 运行时：
目录职责分层：
入口：
关键模块（高扇入 / 高扇出 / 循环依赖）：
核心调用链（1–3 条）：
测试现状（框架 / 覆盖模块 / 明显缺口）：
```
