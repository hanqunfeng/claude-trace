# GitHub Actions Workflow 详细指南

本文面向第一次接触 GitHub Actions 的开发者，从基本概念、YAML 语法和变量表达式开始，逐步介绍 CI、测试矩阵、缓存、构建产物、发布、OIDC、安全和排错。最后会逐段解释本项目的 `ci.yml` 与 `publish.yml`。

文档依据 2026-07-11 可用的 GitHub、Node.js 和 npm 官方资料编写。平台行为和 Action 版本可能继续变化，应以文末官方文档为最终依据。

> 文档中的示例需要放在仓库的 `.github/workflows/` 目录中，例如 `.github/workflows/ci.yml`。  
> GitHub Actions 会执行代码和第三方 Action，复制示例前应根据项目实际情况调整权限、Node.js 版本和命令。

## 目录

1. [GitHub Actions 是什么](#一github-actions-是什么)
2. [最小可运行示例](#二最小可运行示例)
3. [Workflow、Job、Step、Action 和 Runner](#三workflowjobstepaction-和-runner)
4. [Workflow 顶层语法](#四workflow-顶层语法)
5. [触发事件 on](#五触发事件-on)
6. [权限 permissions 与 GITHUB_TOKEN](#六权限-permissions-与-github_token)
7. [并发控制 concurrency](#七并发控制-concurrency)
8. [Job 语法](#八job-语法)
9. [Step 语法](#九step-语法)
10. [变量、Context 和表达式](#十变量context-和表达式)
11. [环境变量、配置变量和 Secret](#十一环境变量配置变量和-secret)
12. [条件执行 if](#十二条件执行-if)
13. [Job 依赖和输出](#十三job-依赖和输出)
14. [Matrix 测试矩阵](#十四matrix-测试矩阵)
15. [缓存 Cache](#十五缓存-cache)
16. [构建产物 Artifact](#十六构建产物-artifact)
17. [容器和服务数据库](#十七容器和服务数据库)
18. [手动、定时和外部触发](#十八手动定时和外部触发)
19. [复用 Workflow 和 Composite Action](#十九复用-workflow-和-composite-action)
20. [Environment、部署审批和 OIDC](#二十environment部署审批和-oidc)
21. [安全最佳实践](#二十一安全最佳实践)
22. [调试与排错](#二十二调试与排错)
23. [常用完整模板](#二十三常用完整模板)
24. [本项目 CI 工作流解析](#二十四本项目-ci-工作流解析)
25. [本项目 npm OIDC 发布工作流解析](#二十五本项目-npm-oidc-发布工作流解析)
26. [常见问题](#二十六常见问题)
27. [官方参考资料](#二十七官方参考资料)

---

## 一、GitHub Actions 是什么

GitHub Actions 是 GitHub 内置的自动化平台。代码推送、Pull Request、标签、Release、Issue、定时任务或人工点击按钮，都可以触发自动任务。

常见用途：

- 每次提交后运行类型检查、格式检查和单元测试。
- 在 Linux、Windows、macOS 或不同 Node.js 版本上测试。
- 构建前端、后端、桌面应用或 Docker 镜像。
- 将测试报告、安装包等保存为 Artifact。
- 发布 npm 包、GitHub Release、Docker 镜像。
- 部署到云服务器、Kubernetes、静态网站或 GitHub Pages。
- 自动添加标签、回复 Issue、检查依赖和执行安全扫描。

基本执行过程：

```text
GitHub 事件
  └─ Workflow 工作流
      ├─ Job A
      │   ├─ Step 1
      │   ├─ Step 2
      │   └─ Step 3
      └─ Job B
          ├─ Step 1
          └─ Step 2
```

工作流文件本身属于仓库代码，应像源代码一样接受评审。

---

## 二、最小可运行示例

创建 `.github/workflows/hello.yml`：

```yaml
name: Hello

on:
  push:

jobs:
  say-hello:
    runs-on: ubuntu-latest
    steps:
      - name: Print message
        run: echo "Hello, GitHub Actions!"
```

含义：

1. `name: Hello`：Actions 页面显示的工作流名称。
2. `on.push`：任意分支收到 push 时触发。
3. `jobs`：定义工作流中的任务。
4. `say-hello`：Job 的内部 ID，可以自定义。
5. `runs-on`：Job 在 GitHub 托管的 Ubuntu Runner 中运行。
6. `steps`：Job 内按顺序执行的步骤。
7. `run`：在 Runner 的 Shell 中执行命令。

推送该文件后，可以在仓库的 **Actions** 页面查看运行记录和日志。

---

## 三、Workflow、Job、Step、Action 和 Runner

### 3.1 Workflow

Workflow 是一个 YAML 文件，描述什么时候运行以及运行什么。文件只能位于：

```text
.github/workflows/*.yml
.github/workflows/*.yaml
```

子目录中的 YAML 不会被当作 Workflow：

```text
.github/workflows/release/npm.yml  # 不会作为工作流加载
```

### 3.2 Job

Job 是一组在同一 Runner 中执行的步骤。同一个 Job 的 Step：

- 共享工作目录。
- 共享该 Job 中创建的文件。
- 默认按声明顺序执行。
- 任一步失败后，后续普通步骤默认跳过。

不同 Job：

- 默认并行执行。
- 通常运行在不同的全新 Runner 中。
- 不会自动共享文件或环境变量。
- 需要通过 `needs` 设置顺序，通过 Artifact 共享文件。

### 3.3 Step

Step 是 Job 中的单个操作，有两种主要形式：

```yaml
# 执行 Shell 命令
- name: Run tests
  run: npm test

# 调用已有 Action
- name: Checkout source
  uses: actions/checkout@v6
```

一个 Step 不能同时使用 `run` 和 `uses`。

### 3.4 Action

Action 是可复用的自动化组件。例如：

- `actions/checkout`：检出仓库代码。
- `actions/setup-node`：安装并配置 Node.js。
- `actions/cache`：缓存依赖或构建数据。
- `actions/upload-artifact`：上传构建产物。

引用格式：

```yaml
uses: owner/repository@ref
```

其中 `ref` 可以是标签、分支或完整 commit SHA：

```yaml
uses: actions/checkout@v6
uses: owner/action@main
uses: owner/action@8f4b7f...完整的40位SHA
```

安全性最高的是固定到完整 commit SHA。标签更易读、更易升级，但标签指向理论上可以改变。

### 3.5 Runner

Runner 是执行 Job 的机器。GitHub 托管 Runner 常用标签：

```yaml
runs-on: ubuntu-latest
runs-on: windows-latest
runs-on: macos-latest
```

也可以使用自托管 Runner：

```yaml
runs-on: [self-hosted, linux, x64]
```

注意：

- GitHub 托管 Runner 通常是一次性的虚拟环境。
- 不要假设上一次 Workflow 创建的文件还存在。
- `ubuntu-latest` 会随 GitHub 更新，不代表永久固定的 Ubuntu 版本。
- 对环境高度敏感时可以使用明确的 Runner 标签或容器。

---

## 四、Workflow 顶层语法

一个较完整的结构如下：

```yaml
name: CI
run-name: CI for ${{ github.ref_name }} by @${{ github.actor }}

on:
  push:
    branches: [main]
  pull_request:

permissions:
  contents: read

env:
  NODE_VERSION: "24"

defaults:
  run:
    shell: bash

concurrency:
  group: ci-${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true

jobs:
  test:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v6
      - run: npm test
```

### 4.1 `name`

Actions 页面中的工作流名称：

```yaml
name: Continuous Integration
```

省略时，GitHub 通常显示文件路径。

### 4.2 `run-name`

单次运行记录的动态名称：

```yaml
run-name: Deploy ${{ inputs.environment }} by @${{ github.actor }}
```

### 4.3 `env`

定义整个 Workflow 可用的环境变量：

```yaml
env:
  NODE_ENV: test
  CI: "true"
```

### 4.4 `defaults`

为所有 `run` Step 设置默认 Shell 或工作目录：

```yaml
defaults:
  run:
    shell: bash
    working-directory: ./backend
```

`defaults.run` 中不能使用 Context 或表达式。

---

## 五、触发事件 `on`

### 5.1 任意 push

```yaml
on:
  push:
```

简写：

```yaml
on: push
```

多个简单事件：

```yaml
on: [push, pull_request]
```

### 5.2 限定分支

```yaml
on:
  push:
    branches:
      - main
      - "release/**"
```

只忽略某些分支：

```yaml
on:
  push:
    branches-ignore:
      - "docs/**"
```

同一个事件中不能同时使用 `branches` 和 `branches-ignore`。需要混合规则时，在 `branches` 中使用 `!`：

```yaml
on:
  push:
    branches:
      - "**"
      - "!experimental/**"
```

负模式顺序有意义：后面的匹配可以改变前面的结果。

### 5.3 标签触发

```yaml
on:
  push:
    tags:
      - "v*"
```

匹配示例：

```text
v1.0.0       匹配
v3.0.12      匹配
release-1.0  不匹配
```

更严格的模式：

```yaml
tags:
  - "v[0-9]+.[0-9]+.[0-9]+"
```

GitHub 的过滤模式是 glob，不是完整正则表达式；复杂版本校验仍应在 Step 中执行。

### 5.4 路径过滤

只在源码改变时运行：

```yaml
on:
  push:
    paths:
      - "src/**"
      - "package.json"
      - "package-lock.json"
      - ".github/workflows/ci.yml"
```

忽略纯文档修改：

```yaml
on:
  pull_request:
    paths-ignore:
      - "**/*.md"
      - "docs/**"
```

同时配置分支和路径时，两者必须都匹配：

```yaml
on:
  push:
    branches: [main]
    paths:
      - "src/**"
```

注意：如果分支保护规则把某个 Workflow 设为必需检查，路径过滤导致它完全不运行时，该检查可能一直显示 Pending。此时可以让 Workflow 总是触发，再在 Job 中通过 `if` 决定是否执行。

### 5.5 Pull Request

```yaml
on:
  pull_request:
    branches: [main]
    types: [opened, synchronize, reopened, ready_for_review]
```

常见 `types`：

- `opened`：PR 新建。
- `synchronize`：PR 分支出现新提交。
- `reopened`：重新打开。
- `closed`：关闭或合并。
- `ready_for_review`：Draft 转为可评审。

仅在 PR 被合并后执行：

```yaml
on:
  pull_request:
    types: [closed]

jobs:
  after-merge:
    if: github.event.pull_request.merged == true
    runs-on: ubuntu-latest
    steps:
      - run: echo "PR merged"
```

`pull_request_target` 与 `pull_request` 不同。它在目标仓库默认分支的安全上下文中运行，可能拥有 Secret 和写权限。不要在 `pull_request_target` 中检出并执行不受信任的 PR 代码。

### 5.6 Release

```yaml
on:
  release:
    types: [published]
```

适合在 GitHub Release 发布后上传资源或同步到其他平台。

### 5.7 多事件不同配置

只要其中一个事件触发就会运行：

```yaml
on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
  workflow_dispatch:
```

---

## 六、权限 `permissions` 与 `GITHUB_TOKEN`

每次 Workflow 运行时，GitHub 自动创建短期 `GITHUB_TOKEN`。它只对当前仓库和本次运行有效，任务结束后失效。

### 6.1 最小只读权限

```yaml
permissions:
  contents: read
```

检出代码通常只需要 `contents: read`。

### 6.2 禁用全部默认权限

```yaml
permissions: {}
```

随后在具体 Job 中按需授权：

```yaml
jobs:
  test:
    permissions:
      contents: read
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6

  release:
    permissions:
      contents: write
    runs-on: ubuntu-latest
    steps:
      - run: gh release create v1.0.0 --generate-notes
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

### 6.3 常用权限

```yaml
permissions:
  contents: write         # 创建标签或 Release；write 已包含 read
  pull-requests: write    # 评论、标记 PR
  issues: write           # 创建或修改 Issue
  packages: write         # 发布 GitHub Packages / GHCR
  actions: read           # 读取 Actions 信息
  checks: write           # 创建检查结果
  security-events: write  # 上传代码扫描结果
  id-token: write         # 请求 OIDC 身份令牌
```

以上是权限名称展示，不代表一个普通 Job 应同时拥有全部权限。实际工作流应只声明当前 Job 必需的最少几项。

只要显式设置了某些权限，未列出的权限通常会变成 `none`。

### 6.4 使用 Token

```yaml
- name: Create release
  run: gh release create "$TAG" --generate-notes
  env:
    GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

即使没有显式把 Token 传给第三方 Action，Action 仍可能通过 `github.token` 获取它，因此最小权限非常重要。

---

## 七、并发控制 `concurrency`

并发组用于避免同一类任务同时运行。

```yaml
concurrency:
  group: ci-${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true
```

变量含义：

- `github.workflow`：Workflow 的 `name`，例如 `CI`。
- `github.ref`：完整 Git 引用，例如 `refs/heads/main`、`refs/pull/123/merge` 或 `refs/tags/v3.0.12`。
- `github.ref_name`：简短名称，例如 `main` 或 `v3.0.12`。

main 分支示例：

```text
ci-CI-refs/heads/main
```

同一个 PR 连续推送多次时：

```yaml
cancel-in-progress: true
```

旧 CI 会被取消，只保留最新提交的 CI，节约时间。

发布任务一般不应中途取消：

```yaml
concurrency:
  group: publish-${{ github.ref }}
  cancel-in-progress: false
```

否则可能出现“npm 已发布，但 GitHub Release 尚未创建”这种不完整状态。

按部署环境分组：

```yaml
concurrency:
  group: deploy-${{ inputs.environment }}
  cancel-in-progress: false
```

注意：

- 同一并发组最多有一个 Running 和一个 Pending 运行。
- 并发组名称不区分大小写。
- GitHub 不保证同组 Pending 任务的执行顺序。

---

## 八、Job 语法

### 8.1 Job ID 与显示名称

```yaml
jobs:
  unit-test:
    name: Unit tests on Node.js 24
    runs-on: ubuntu-latest
    steps:
      - run: npm test
```

- `unit-test` 是内部 ID，用于 `needs.unit-test`。
- `name` 是 Actions 页面显示名称。

Job ID 建议只使用字母、数字、`-` 和 `_`。

### 8.2 选择 Runner

```yaml
jobs:
  linux:
    runs-on: ubuntu-latest

  windows:
    runs-on: windows-latest

  mac:
    runs-on: macos-latest
```

### 8.3 超时

```yaml
jobs:
  test:
    runs-on: ubuntu-latest
    timeout-minutes: 20
```

应为可能卡住的网络、测试和部署 Job 设置合理超时。

### 8.4 Job 级环境变量和权限

```yaml
jobs:
  test:
    permissions:
      contents: read
    env:
      NODE_ENV: test
    runs-on: ubuntu-latest
    steps:
      - run: npm test
```

### 8.5 Job 默认 Shell 和目录

```yaml
jobs:
  backend:
    defaults:
      run:
        shell: bash
        working-directory: backend
    runs-on: ubuntu-latest
    steps:
      - run: npm ci
      - run: npm test
```

---

## 九、Step 语法

### 9.1 执行单行和多行命令

```yaml
- name: Single command
  run: npm test

- name: Multiple commands
  run: |
    npm ci
    npm run typecheck
    npm test
```

### 9.2 指定 Shell

```yaml
- run: echo "bash"
  shell: bash

- run: Write-Output "PowerShell"
  shell: pwsh

- run: |
    print("Python")
  shell: python
```

不同 Runner 的默认 Shell 不完全相同。跨平台 Workflow 最好显式指定。

### 9.3 指定工作目录

```yaml
- name: Test frontend
  working-directory: frontend
  run: |
    npm ci
    npm test
```

### 9.4 调用 Action 并传参

```yaml
- name: Setup Node.js
  uses: actions/setup-node@v6
  with:
    node-version: "24"
    cache: npm
    cache-dependency-path: |
      package-lock.json
      frontend/package-lock.json
```

`with` 支持哪些参数由该 Action 的 `action.yml` 定义，应查阅对应仓库文档。

### 9.5 Step ID 和输出

```yaml
- name: Read version
  id: package
  run: echo "version=$(node -p "require('./package.json').version")" >> "$GITHUB_OUTPUT"

- name: Print version
  run: echo "Version is ${{ steps.package.outputs.version }}"
```

`id` 是表达式引用名，不是显示名称。

### 9.6 超时和允许失败

```yaml
- name: Optional audit
  continue-on-error: true
  timeout-minutes: 5
  run: npm audit
```

`continue-on-error` 应谨慎使用，否则真正的问题可能被隐藏。

---

## 十、变量、Context 和表达式

表达式写在：

```yaml
${{ ... }}
```

### 10.1 常用 Context

#### `github`

当前仓库、事件和运行信息：

```yaml
- run: |
    echo "repository=${{ github.repository }}"
    echo "actor=${{ github.actor }}"
    echo "sha=${{ github.sha }}"
    echo "ref=${{ github.ref }}"
    echo "ref_name=${{ github.ref_name }}"
    echo "event=${{ github.event_name }}"
    echo "run_id=${{ github.run_id }}"
    echo "attempt=${{ github.run_attempt }}"
```

常见值：

```text
github.repository = hanqunfeng/claude-trace
github.actor      = 触发任务的 GitHub 用户
github.sha        = 当前提交 SHA
github.ref        = refs/heads/main 或 refs/tags/v3.0.12
github.ref_name   = main 或 v3.0.12
github.workflow   = Workflow 的 name
github.job        = 当前 Job ID
```

#### `env`

读取 YAML 中定义的环境变量：

```yaml
env:
  APP_NAME: demo

steps:
  - run: echo "${{ env.APP_NAME }}"
```

Shell 内也可使用：

```yaml
- run: echo "$APP_NAME"
```

#### `vars`

读取仓库、组织或 Environment 配置变量：

```yaml
- run: echo "Region=${{ vars.DEPLOY_REGION }}"
```

`vars` 不是 Secret，会显示在日志和界面中。

#### `secrets`

读取加密 Secret：

```yaml
- run: ./deploy.sh
  env:
    API_TOKEN: ${{ secrets.API_TOKEN }}
```

#### `runner`

Runner 信息：

```yaml
- run: |
    echo "OS=${{ runner.os }}"
    echo "Arch=${{ runner.arch }}"
    echo "Temp=${{ runner.temp }}"
```

#### `job`

```yaml
- if: always()
  run: echo "Job status=${{ job.status }}"
```

#### `steps`

```yaml
- id: tests
  continue-on-error: true
  run: npm test

- run: |
    echo "outcome=${{ steps.tests.outcome }}"
    echo "conclusion=${{ steps.tests.conclusion }}"
```

- `outcome`：应用 `continue-on-error` 之前的原始结果。
- `conclusion`：应用之后的最终结果。

#### `needs`

```yaml
- run: echo "${{ needs.build.outputs.artifact-name }}"
```

#### `matrix`

```yaml
- run: echo "Node.js ${{ matrix.node }}"
```

#### `inputs`

手动触发或复用 Workflow 的输入：

```yaml
- run: echo "Environment=${{ inputs.environment }}"
```

### 10.2 运算符

```yaml
if: github.ref == 'refs/heads/main'
if: github.ref != 'refs/heads/main'
if: success() && github.actor != 'dependabot[bot]'
if: failure() || cancelled()
if: !cancelled()
```

在 YAML 中以 `!` 开头容易被当成 YAML Tag，最好保留 `${{ }}`：

```yaml
if: ${{ !cancelled() }}
```

### 10.3 常用函数

```yaml
if: startsWith(github.ref, 'refs/tags/v')
if: endsWith(github.event.head_commit.message, '[deploy]')
if: contains(github.event.pull_request.labels.*.name, 'ready')
if: contains(fromJSON('["push","workflow_dispatch"]'), github.event_name)
```

JSON 转换：

```yaml
env:
  CONTINUE: "true"
  TIMEOUT: "10"

continue-on-error: ${{ fromJSON(env.CONTINUE) }}
timeout-minutes: ${{ fromJSON(env.TIMEOUT) }}
```

调试 Context：

```yaml
- name: Dump GitHub context
  env:
    GITHUB_CONTEXT: ${{ toJSON(github) }}
  run: echo "$GITHUB_CONTEXT"
```

不要随意输出完整 `secrets`、Token 或包含敏感请求信息的 Context。

---

## 十一、环境变量、配置变量和 Secret

### 11.1 作用域优先级

环境变量可定义在 Workflow、Job 或 Step：

```yaml
env:
  LEVEL: workflow

jobs:
  example:
    env:
      LEVEL: job
    runs-on: ubuntu-latest
    steps:
      - run: echo "$LEVEL" # 输出 job
      - env:
          LEVEL: step
        run: echo "$LEVEL" # 输出 step
```

越具体的作用域优先级越高。

### 11.2 跨 Step 设置环境变量

```yaml
- name: Set variable
  run: echo "BUILD_VERSION=1.2.3" >> "$GITHUB_ENV"

- name: Read variable
  run: echo "$BUILD_VERSION"
```

写入 `$GITHUB_ENV` 后只对后续 Step 生效，当前 Step 中不会自动出现新值。

### 11.3 添加 PATH

```yaml
- run: echo "$HOME/.local/bin" >> "$GITHUB_PATH"
```

### 11.4 Secret

在仓库的 **Settings → Secrets and variables → Actions** 中配置：

```yaml
env:
  DEPLOY_TOKEN: ${{ secrets.DEPLOY_TOKEN }}
```

注意：

- Secret 不应直接写入仓库。
- GitHub 会尝试遮蔽日志中的 Secret 原值，但不要依赖遮蔽来弥补主动输出。
- 来自 Fork 的 `pull_request` 默认无法读取普通 Secret。
- Dependabot 触发的工作流也受到 Secret 和 Token 权限限制。
- Secret 不能可靠地直接用于 `if`，可以先映射到 Job 环境变量。

示例：

```yaml
jobs:
  deploy:
    env:
      HAS_TOKEN: ${{ secrets.DEPLOY_TOKEN }}
    runs-on: ubuntu-latest
    steps:
      # env Context 可以用于 Step 的 if，但不能用于 jobs.<job_id>.if。
      - if: env.HAS_TOKEN != ''
        run: ./deploy.sh
        env:
          DEPLOY_TOKEN: ${{ secrets.DEPLOY_TOKEN }}
```

---

## 十二、条件执行 `if`

### 12.1 分支和标签条件

```yaml
if: github.ref == 'refs/heads/main'
```

```yaml
if: startsWith(github.ref, 'refs/tags/v')
```

### 12.2 事件条件

```yaml
if: github.event_name == 'workflow_dispatch'
```

### 12.3 Job 成功、失败或取消

默认相当于 `success()`：

```yaml
- run: echo "Only on success"
  if: success()
```

失败时上传日志：

```yaml
- name: Upload failure logs
  if: failure()
  uses: actions/upload-artifact@v4
  with:
    name: failure-logs
    path: logs/
```

无论前面结果如何都执行清理：

```yaml
- name: Cleanup
  if: always()
  run: ./cleanup.sh
```

更适合多数清理和汇总任务的写法：

```yaml
if: ${{ !cancelled() }}
```

`always()` 在任务被取消时仍可能执行，某些网络操作会拖延取消过程。

### 12.4 Draft PR 跳过测试

```yaml
jobs:
  test:
    if: github.event_name != 'pull_request' || github.event.pull_request.draft == false
    runs-on: ubuntu-latest
    steps:
      - run: npm test
```

---

## 十三、Job 依赖和输出

### 13.1 `needs`

Job 默认并行。使用 `needs` 设置依赖：

```yaml
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: npm run build

  deploy:
    needs: build
    runs-on: ubuntu-latest
    steps:
      - run: ./deploy.sh
```

依赖多个 Job：

```yaml
deploy:
  needs: [lint, test, build]
```

### 13.2 Step 输出传给 Job

```yaml
jobs:
  prepare:
    runs-on: ubuntu-latest
    outputs:
      version: ${{ steps.package.outputs.version }}
    steps:
      - uses: actions/checkout@v6
      - id: package
        run: echo "version=$(node -p "require('./package.json').version")" >> "$GITHUB_OUTPUT"

  publish:
    needs: prepare
    runs-on: ubuntu-latest
    steps:
      - run: echo "Publishing ${{ needs.prepare.outputs.version }}"
```

输出适合少量文本。文件应通过 Artifact 传递。

### 13.3 多行输出

```yaml
- id: notes
  run: |
    {
      echo "body<<EOF"
      echo "Line 1"
      echo "Line 2"
      echo "EOF"
    } >> "$GITHUB_OUTPUT"
```

如果内容可能包含 `EOF`，应使用随机且不会出现在内容中的分隔符。

---

## 十四、Matrix 测试矩阵

### 14.1 Node.js 多版本

```yaml
jobs:
  test:
    strategy:
      matrix:
        node: ["20", "22", "24"]
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - uses: actions/setup-node@v6
        with:
          node-version: ${{ matrix.node }}
      - run: npm ci
      - run: npm test
```

该配置创建 3 个并行 Job。

### 14.2 多操作系统和多版本

```yaml
strategy:
  matrix:
    os: [ubuntu-latest, windows-latest, macos-latest]
    node: ["20", "24"]

runs-on: ${{ matrix.os }}
```

一共创建 `3 × 2 = 6` 个 Job。

### 14.3 排除组合

```yaml
strategy:
  matrix:
    os: [ubuntu-latest, windows-latest, macos-latest]
    node: ["20", "24"]
    exclude:
      - os: macos-latest
        node: "20"
```

### 14.4 添加特殊组合

```yaml
strategy:
  matrix:
    node: ["20", "24"]
    include:
      - node: "24"
        experimental: true
```

### 14.5 失败策略

```yaml
strategy:
  fail-fast: false
  max-parallel: 3
  matrix:
    node: ["18", "20", "22", "24"]
```

- `fail-fast: true`：一个普通矩阵 Job 失败后，取消其他进行中的矩阵 Job。
- `fail-fast: false`：让所有组合都运行完，便于看到完整兼容性结果。
- `max-parallel`：限制同时运行数量。

实验版本允许失败：

```yaml
continue-on-error: ${{ matrix.experimental }}
strategy:
  matrix:
    node: ["20", "24"]
    experimental: [false]
    include:
      - node: "25"
        experimental: true
```

---

## 十五、缓存 Cache

缓存用于复用依赖下载数据，提高后续 Workflow 速度。缓存不是构建产物，也不能保证永久存在。

### 15.1 setup-node 自动缓存 npm

```yaml
- uses: actions/setup-node@v6
  with:
    node-version: "24"
    cache: npm
    cache-dependency-path: package-lock.json

- run: npm ci
```

`setup-node` 缓存 npm 的全局下载缓存，不直接缓存 `node_modules`。`npm ci` 仍会根据 lockfile 创建干净依赖树。

Monorepo 多个 lockfile：

```yaml
cache-dependency-path: |
  package-lock.json
  frontend/package-lock.json
```

### 15.2 actions/cache

```yaml
- name: Cache build data
  uses: actions/cache@v4
  with:
    path: .cache
    key: ${{ runner.os }}-build-${{ hashFiles('package-lock.json') }}
    restore-keys: |
      ${{ runner.os }}-build-
```

### 15.3 缓存键

好的 Key 通常包含：

- 操作系统。
- 运行时版本。
- lockfile 哈希。
- 必要时加入配置版本。

```yaml
key: npm-${{ runner.os }}-node-${{ matrix.node }}-${{ hashFiles('**/package-lock.json') }}
```

### 15.4 缓存安全

- 不要缓存 Secret、Token、`.npmrc` 认证文件。
- Fork PR 可能读取基础分支创建的缓存。
- 不可信代码可能尝试缓存投毒。
- 发布任务优先考虑禁用缓存，以降低供应链风险。
- Cache 命中不代表可以跳过 `npm ci` 或完整性检查。

---

## 十六、构建产物 Artifact

Artifact 用于保存或跨 Job 传递文件，例如：

- 编译结果。
- 测试报告。
- 覆盖率报告。
- 安装包。
- 失败日志。

### 16.1 上传

```yaml
- name: Upload dist
  uses: actions/upload-artifact@v4
  with:
    name: dist
    path: dist/
    if-no-files-found: error
    retention-days: 7
```

### 16.2 下载

```yaml
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - run: npm run build
      - uses: actions/upload-artifact@v4
        with:
          name: dist
          path: dist/

  deploy:
    needs: build
    runs-on: ubuntu-latest
    steps:
      - uses: actions/download-artifact@v4
        with:
          name: dist
          path: dist/
      - run: ls -R dist
```

### 16.3 Cache 与 Artifact 的区别

- Cache：优化速度，可被后续运行复用，可能被清理，不适合发布交付。
- Artifact：保存本次运行结果，可下载或供后续 Job 使用，有明确保留期限。

---

## 十七、容器和服务数据库

### 17.1 Job 运行在容器中

```yaml
jobs:
  test:
    runs-on: ubuntu-latest
    container:
      image: node:24-bookworm
    steps:
      - uses: actions/checkout@v6
      - run: npm ci
      - run: npm test
```

### 17.2 PostgreSQL 服务

```yaml
jobs:
  integration-test:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:17
        env:
          POSTGRES_USER: test
          POSTGRES_PASSWORD: test
          POSTGRES_DB: app_test
        ports:
          - 5432:5432
        options: >-
          --health-cmd "pg_isready"
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5
    env:
      DATABASE_URL: postgresql://test:test@localhost:5432/app_test
    steps:
      - uses: actions/checkout@v6
      - run: npm ci
      - run: npm run test:integration
```

### 17.3 Redis 服务

```yaml
services:
  redis:
    image: redis:7
    ports:
      - 6379:6379
    options: >-
      --health-cmd "redis-cli ping"
      --health-interval 10s
      --health-timeout 5s
      --health-retries 5
```

服务容器主要用于 Linux Runner。真实项目应固定合适的镜像版本，避免 `latest` 引入意外变化。

---

## 十八、手动、定时和外部触发

### 18.1 手动触发 `workflow_dispatch`

```yaml
on:
  workflow_dispatch:
    inputs:
      environment:
        description: Deployment environment
        required: true
        type: choice
        options:
          - staging
          - production
      dry_run:
        description: Only show planned changes
        required: true
        default: true
        type: boolean
```

使用输入：

```yaml
- run: |
    echo "environment=${{ inputs.environment }}"
    echo "dry_run=${{ inputs.dry_run }}"
```

常用输入类型：

- `string`
- `boolean`
- `choice`
- `number`
- `environment`

命令行触发：

```bash
gh workflow run deploy.yml \
  -f environment=staging \
  -f dry_run=true
```

### 18.2 定时任务

```yaml
on:
  schedule:
    - cron: "0 2 * * 1"
```

表示每周一 UTC 02:00。Cron 字段：

```text
┌──────── 分钟 0-59
│ ┌────── 小时 0-23
│ │ ┌──── 日期 1-31
│ │ │ ┌── 月份 1-12
│ │ │ │ ┌ 星期 0-6（0 是周日）
│ │ │ │ │
0 2 * * 1
```

注意：

- GitHub Actions Cron 使用 UTC。
- 最短间隔通常为 5 分钟。
- 高峰期可能延迟，不适合秒级准时任务。
- Scheduled Workflow 使用默认分支上的 Workflow 文件。

多个时间表可以读取触发它的表达式：

```yaml
on:
  schedule:
    - cron: "0 2 * * 1"
    - cron: "0 2 * * 5"

steps:
  - if: github.event.schedule == '0 2 * * 5'
    run: echo "Friday task"
```

### 18.3 外部触发 `repository_dispatch`

```yaml
on:
  repository_dispatch:
    types: [rebuild]
```

调用 API：

```bash
gh api repos/OWNER/REPO/dispatches \
  -f event_type=rebuild \
  -F 'client_payload[version]=1.2.3'
```

读取数据：

```yaml
- run: echo "${{ github.event.client_payload.version }}"
```

### 18.4 一个 Workflow 完成后触发

```yaml
on:
  workflow_run:
    workflows: ["CI"]
    types: [completed]

jobs:
  report:
    if: github.event.workflow_run.conclusion == 'success'
    runs-on: ubuntu-latest
    steps:
      - run: echo "CI succeeded"
```

`workflow_run` 可能拥有比原 Workflow 更高的权限。不要让低权限、不可信 Workflow 通过 Artifact、Cache 或输出向高权限 Workflow 注入可执行内容。

---

## 十九、复用 Workflow 和 Composite Action

### 19.1 可复用 Workflow

被调用文件 `.github/workflows/reusable-test.yml`：

```yaml
name: Reusable test

on:
  workflow_call:
    inputs:
      node-version:
        description: Node.js version
        required: false
        default: "24"
        type: string
    secrets:
      npm-token:
        required: false

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - uses: actions/setup-node@v6
        with:
          node-version: ${{ inputs.node-version }}
      - run: npm ci
      - run: npm test
```

调用：

```yaml
jobs:
  test:
    uses: ./.github/workflows/reusable-test.yml
    with:
      node-version: "24"
    secrets: inherit
```

跨仓库调用：

```yaml
jobs:
  test:
    uses: owner/automation/.github/workflows/node-test.yml@v1
    with:
      node-version: "24"
```

调用可复用 Workflow 的 `uses` 位于 Job 级别，不放在 `steps` 中。

### 19.2 可复用 Workflow 输出

```yaml
on:
  workflow_call:
    outputs:
      version:
        description: Package version
        value: ${{ jobs.prepare.outputs.version }}

jobs:
  prepare:
    outputs:
      version: ${{ steps.package.outputs.version }}
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - id: package
        run: echo "version=$(node -p "require('./package.json').version")" >> "$GITHUB_OUTPUT"
```

调用方：

```yaml
jobs:
  prepare:
    uses: ./.github/workflows/version.yml

  print:
    needs: prepare
    runs-on: ubuntu-latest
    steps:
      - run: echo "${{ needs.prepare.outputs.version }}"
```

### 19.3 Composite Action

适合复用一组 Step。创建 `.github/actions/setup-project/action.yml`：

```yaml
name: Setup project
description: Install Node.js and project dependencies

inputs:
  node-version:
    description: Node.js version
    required: false
    default: "24"

runs:
  using: composite
  steps:
    - uses: actions/setup-node@v6
      with:
        node-version: ${{ inputs.node-version }}
        cache: npm
    - run: npm ci
      shell: bash
```

调用本地 Composite Action 前必须先检出仓库：

```yaml
steps:
  - uses: actions/checkout@v6
  - uses: ./.github/actions/setup-project
    with:
      node-version: "24"
  - run: npm test
```

选择建议：

- 复用整个 Job 或标准发布流程：Reusable Workflow。
- 在多个 Job 中复用若干 Step：Composite Action。
- 只复用一行命令：Shell/npm script 通常更简单。

---

## 二十、Environment、部署审批和 OIDC

### 20.1 Environment

仓库可配置 `staging`、`production` 等 Environment：

```yaml
jobs:
  deploy:
    environment:
      name: production
      url: https://example.com
    runs-on: ubuntu-latest
    steps:
      - run: ./deploy.sh
```

Environment 可配置：

- 审批人。
- 等待时间。
- 允许部署的分支或标签。
- Environment 专属 Secret 和变量。

生产部署示例：

```yaml
on:
  workflow_dispatch:
    inputs:
      environment:
        type: environment
        required: true

jobs:
  deploy:
    environment: ${{ inputs.environment }}
    runs-on: ubuntu-latest
    steps:
      - run: ./deploy.sh
```

### 20.2 OIDC 是什么

传统发布需要把长期 Token 保存为 Secret。OIDC 的流程是：

```text
Workflow
  → GitHub 签发短期身份令牌
  → npm / 云平台验证仓库、工作流、分支或 Environment
  → 平台签发短期权限或直接允许发布
```

优势：

- 不保存长期发布凭证。
- 凭证只在本次 Job 中短期有效。
- 平台可以限制仓库、Workflow、分支和 Environment。
- 降低 Token 泄漏及轮换成本。

### 20.3 OIDC 基础权限

```yaml
permissions:
  contents: read
  id-token: write
```

`id-token: write` 只允许请求 OIDC Token，并不会自动赋予修改仓库或云资源的权限。

### 20.4 npm Trusted Publishing

```yaml
name: Publish

on:
  push:
    tags: ["v*"]

permissions:
  contents: read
  id-token: write

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - uses: actions/setup-node@v6
        with:
          node-version: "24"
          registry-url: https://registry.npmjs.org
          package-manager-cache: false
      - run: npm ci
      - run: npm test
      - run: npm publish --access public
```

还必须在 npmjs.com 包设置中配置 Trusted Publisher，确保以下信息一致：

- GitHub owner / organization。
- Repository。
- Workflow 文件名。
- 可选的 Environment。
- Allowed action 是 `npm publish`。

npm Trusted Publishing 当前要求 Node.js `>= 22.14.0`、npm `>= 11.5.1`，并使用受支持的云托管 Runner。本项目的 Node.js 24 满足要求，工作流还会显式检查 npm 最低版本。OIDC 发布会自动生成 provenance。

### 20.5 GitHub Release 权限

如果发布后还要创建 GitHub Release：

```yaml
permissions:
  contents: write
  id-token: write
```

可以拆成两个 Job，让 npm 发布 Job 不拥有仓库写权限：

```yaml
jobs:
  publish:
    permissions:
      contents: read
      id-token: write
    runs-on: ubuntu-latest
    steps:
      - run: npm publish

  release:
    needs: publish
    permissions:
      contents: write
    runs-on: ubuntu-latest
    steps:
      - run: gh release create "${{ github.ref_name }}" --generate-notes
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

---

## 二十一、安全最佳实践

### 21.1 最小权限

```yaml
permissions:
  contents: read
```

只在需要的 Job 中增加 `write`。

### 21.2 固定第三方 Action

最严格方式：

```yaml
uses: third-party/action@完整40位commitSHA # v2.3.1
```

GitHub 官方也建议固定 Action 到完整 SHA。Dependabot 可帮助更新 Action 版本。

`.github/dependabot.yml` 示例：

```yaml
version: 2
updates:
  - package-ecosystem: github-actions
    directory: /
    schedule:
      interval: weekly
```

### 21.3 不要把不可信输入直接拼入 Shell

危险：

```yaml
- run: echo "${{ github.event.pull_request.title }}"
```

攻击者可能构造包含 Shell 语法的 PR 标题。

更安全：

```yaml
- env:
    PR_TITLE: ${{ github.event.pull_request.title }}
  run: printf '%s\n' "$PR_TITLE"
```

表达式由 GitHub 在脚本执行前替换；通过环境变量传递可以避免内容被解释成脚本源码。

### 21.4 谨慎使用 `pull_request_target`

可以安全用于：

- 添加标签。
- 评论 PR。
- 检查 PR 元数据。

不要：

- 检出 Fork PR 的 HEAD 后运行其脚本。
- 安装 Fork 修改过的依赖。
- 把高权限 Token 交给不可信代码。

### 21.5 不记录 Secret

避免：

```yaml
- run: env
- run: echo "${{ secrets.DEPLOY_TOKEN }}"
- run: curl -v -H "Authorization: Bearer $TOKEN" ...
```

### 21.6 审查依赖安装脚本

`npm ci` 可能执行依赖的生命周期脚本。发布任务应：

- 使用提交到仓库的 lockfile。
- 审查 lockfile 变化。
- 使用 Dependabot/Renovate。
- 根据 npm 版本采用脚本 allowlist 等安全机制。
- 避免发布阶段动态安装未固定的 `latest` 工具。

### 21.7 限制超时和并发

```yaml
timeout-minutes: 20
```

既避免无限等待，也减少异常任务消耗。

### 21.8 Environment 审批

生产部署使用受保护 Environment，并要求人工审批。即使 Workflow 被错误触发，也不会立即部署。

### 21.9 Fork、Artifact 和 Cache

来自不可信代码的 Artifact 或 Cache 也可能包含恶意内容。高权限 Workflow 不应下载并执行低权限 Workflow 产生的任意二进制或脚本。

---

## 二十二、调试与排错

### 22.1 查看日志

在 GitHub 仓库 Actions 页面中：

1. 选择 Workflow。
2. 选择某次运行。
3. 选择 Job。
4. 展开失败 Step。

使用 GitHub CLI：

```bash
gh run list
gh run view RUN_ID
gh run view RUN_ID --log
gh run view RUN_ID --log-failed
gh run watch RUN_ID
```

### 22.2 重新运行

```bash
gh run rerun RUN_ID
gh run rerun RUN_ID --failed
```

重新运行时：

- `github.run_id` 不变。
- `github.run_attempt` 增加。
- 使用原运行对应的 commit。

### 22.3 输出调试信息

```yaml
- name: Debug
  run: |
    echo "event=${{ github.event_name }}"
    echo "ref=${{ github.ref }}"
    echo "sha=${{ github.sha }}"
    echo "runner=${{ runner.os }}/${{ runner.arch }}"
```

创建 Repository Secret：

```text
ACTIONS_STEP_DEBUG=true
```

可启用更详细的 Step 调试日志。需要时临时开启，排查后删除。

### 22.4 Job Summary

```yaml
- name: Write summary
  run: |
    {
      echo "## Test result"
      echo ""
      echo "- Node.js: $(node --version)"
      echo "- Status: passed"
    } >> "$GITHUB_STEP_SUMMARY"
```

Summary 会显示在运行概览页面，比在长日志中查找结果更方便。

### 22.5 本地检查 YAML

基础语法检查：

```bash
ruby -e 'require "yaml"; YAML.load_file(".github/workflows/ci.yml", aliases: true)'
```

更推荐安装 `actionlint`：

```bash
brew install actionlint
actionlint
```

普通 YAML 解析器只能检查 YAML 是否有效，无法完整理解 GitHub Actions 的 Context、Action 参数和事件语义。

### 22.6 为什么 Workflow 没有触发

检查：

- 文件是否位于 `.github/workflows/`。
- Workflow 是否已存在于默认分支。
- 分支、标签和路径过滤是否匹配。
- YAML 是否有效。
- 仓库是否禁用了 Actions。
- Fork Workflow 是否等待维护者批准。
- commit message 是否使用了跳过 CI 的标记。
- 定时 Workflow 是否因仓库长期无活动而被禁用。

### 22.7 为什么 Secret 是空的

常见原因：

- Secret 名称拼写错误。
- Fork PR 不提供 Secret。
- Dependabot 运行受到限制。
- 使用的是 Environment Secret，但 Job 没有声明对应 `environment`。
- Secret 只配置在组织中，但仓库未被授权使用。

### 22.8 为什么后续 Job 找不到文件

每个 Job 通常使用不同 Runner。使用 Artifact：

```yaml
# Job A
- uses: actions/upload-artifact@v4
  with:
    name: build
    path: dist/

# Job B
- uses: actions/download-artifact@v4
  with:
    name: build
```

### 22.9 为什么环境变量在下一步不存在

普通 Shell `export` 只影响当前 Step：

```yaml
- run: export VERSION=1.0.0
- run: echo "$VERSION" # 空
```

应写入：

```yaml
- run: echo "VERSION=1.0.0" >> "$GITHUB_ENV"
```

---

## 二十三、常用完整模板

### 23.1 Node.js CI

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

permissions:
  contents: read

concurrency:
  group: ci-${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true

jobs:
  test:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v6

      - uses: actions/setup-node@v6
        with:
          node-version: "24"
          cache: npm

      - run: npm ci
      - run: npm run typecheck
      - run: npm test
      - run: npm run build
```

### 23.2 多平台测试

```yaml
name: Cross-platform CI

on: [push, pull_request]

permissions:
  contents: read

jobs:
  test:
    name: ${{ matrix.os }} / Node.js ${{ matrix.node }}
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, windows-latest, macos-latest]
        node: ["20", "24"]
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v6
      - uses: actions/setup-node@v6
        with:
          node-version: ${{ matrix.node }}
          cache: npm
      - run: npm ci
      - run: npm test
```

### 23.3 构建并保存 Artifact

```yaml
name: Build

on:
  push:
    branches: [main]

permissions:
  contents: read

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - uses: actions/setup-node@v6
        with:
          node-version: "24"
          cache: npm
      - run: npm ci
      - run: npm run build
      - uses: actions/upload-artifact@v4
        with:
          name: application-${{ github.sha }}
          path: dist/
          if-no-files-found: error
          retention-days: 14
```

### 23.4 手动部署

```yaml
name: Deploy

on:
  workflow_dispatch:
    inputs:
      environment:
        description: Target environment
        required: true
        type: environment

permissions:
  contents: read

concurrency:
  group: deploy-${{ inputs.environment }}
  cancel-in-progress: false

jobs:
  deploy:
    environment: ${{ inputs.environment }}
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v6
      - run: ./scripts/deploy.sh
        env:
          DEPLOY_TOKEN: ${{ secrets.DEPLOY_TOKEN }}
```

### 23.5 Docker 发布到 GHCR

```yaml
name: Publish image

on:
  push:
    tags: ["v*"]

permissions:
  contents: read
  packages: write

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6

      - name: Login to GHCR
        uses: docker/login-action@固定的完整commitSHA
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Build and push
        uses: docker/build-push-action@固定的完整commitSHA
        with:
          context: .
          push: true
          tags: ghcr.io/${{ github.repository }}:${{ github.ref_name }}
```

实际使用时把占位符替换为官方发布页对应版本的完整 SHA。

### 23.6 PR 失败时上传日志

```yaml
name: Test with diagnostics

on:
  pull_request:

permissions:
  contents: read

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - run: npm ci
      - run: npm test
      - name: Upload logs after failure
        if: failure()
        uses: actions/upload-artifact@v4
        with:
          name: test-logs-${{ github.run_id }}
          path: logs/
          if-no-files-found: ignore
```

---

## 二十四、本项目 CI 工作流解析

文件：`.github/workflows/ci.yml`

### 24.1 触发条件

```yaml
on:
  push:
    branches:
      - main
      - master
  pull_request:
```

含义：

- push 到 `main` 或 `master` 时运行。
- Pull Request 的默认活动类型（`opened`、`synchronize`、`reopened`）会触发。
- 普通功能分支 push 不会直接触发，但该分支创建 PR 后会触发。
- 标签 push 不会触发，因为 `push` 已配置 `branches`。

### 24.2 并发组

```yaml
concurrency:
  group: ci-${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true
```

例如 PR #123：

```text
ci-CI-refs/pull/123/merge
```

PR 新增提交时，旧 CI 会被取消，只验证最新提交。

### 24.3 Job

```yaml
jobs:
  test:
    runs-on: ubuntu-latest
```

只有一个名为 `test` 的 Job，所有步骤在同一 Ubuntu Runner 中按顺序运行。

### 24.4 检出代码

```yaml
- name: Checkout
  uses: actions/checkout@v5
```

Runner 初始没有仓库源码，所以多数构建 Job 的第一步是 checkout。

### 24.5 Node.js 和缓存

```yaml
- name: Setup Node.js
  uses: actions/setup-node@v5
  with:
    node-version: "20"
    cache: npm
    cache-dependency-path: |
      package-lock.json
      frontend/package-lock.json
```

含义：

- 使用 Node.js 20。
- 缓存 npm 下载数据。
- 根项目或前端 lockfile 改变时，缓存键会相应变化。

截至 2026 年 7 月，Node.js 20 已于 2026-03-24 EOL，不再接收官方安全更新。当前 CI 应升级到仍受支持的 Node.js 22 或 24。此外，本项目 `package.json` 声明 `node >=16`，但 Node.js 16 早已 EOL，当前 CI 也没有验证最低版本兼容性；维护者应重新评估最低版本，或者用 Matrix 明确测试所有仍承诺支持的版本。

### 24.6 安装依赖

```yaml
- name: Install dependencies
  run: |
    npm ci
    npm ci --prefix frontend
```

根项目和 `frontend` 是两个 npm 项目，所以分别执行 `npm ci`。

### 24.7 验证链

```yaml
- run: npm run typecheck
- run: npm run test:unit
- run: npm run build
- run: node dist/cli/cli.js --help
```

顺序含义：

1. Typecheck：只检查 TypeScript 类型。
2. Unit tests：运行单元测试。
3. Build：编译后端并构建前端。
4. Smoke test：确认构建后的主 CLI 至少能够启动并输出帮助。

任一步退出码非 0，Job 和 Workflow 都会失败。

### 24.8 当前实现与安全最佳实践的差距

当前 `ci.yml` 是对实际文件的解释，不等于本指南推荐的最严格配置：

- 没有显式声明 `permissions: contents: read`，建议补充以固定最小权限。
- `actions/checkout@v5` 和 `actions/setup-node@v5` 使用可移动的主版本标签；高安全要求下应固定完整 commit SHA，并用 Dependabot 管理升级。
- Node.js 20 已 EOL，应升级到 Node.js 22/24 或建立受支持版本 Matrix。

---

## 二十五、本项目 npm OIDC 发布工作流解析

文件：`.github/workflows/publish.yml`

### 25.1 整体流程

```text
推送 vX.Y.Z 标签
  → 检出标签代码
  → 配置 Node.js/npm
  → 校验 npm 版本
  → 校验标签与 package.json 版本
  → 安装依赖
  → typecheck、测试、构建、smoke test
  → npm pack --dry-run
  → npm publish 触发 prepublishOnly，再次 clean/build
  → npm OIDC 发布
  → 查询 npm 注册表确认版本
  → 创建 GitHub Release
```

### 25.2 为什么只允许标签触发

```yaml
on:
  push:
    tags:
      - "v*"
```

版本标签是不可混淆的发布意图。普通 push 和 PR 不会意外发布 npm 包。

### 25.3 权限

```yaml
permissions:
  contents: write
  id-token: write
```

- `contents: write`：GitHub CLI 创建 Release。
- `id-token: write`：npm Trusted Publishing 获取 GitHub OIDC 身份。

这是当前实现，不是最小权限范例。权限位于 Workflow 顶层，因此安装依赖、执行测试和 `npm publish` 的整个 Job 都同时拥有仓库写权限和 OIDC 权限；`actions/checkout` 默认还会把 GitHub 凭据持久化到本地 Git 配置。

更严格的设计是拆成两个 Job：

- npm 发布 Job：`contents: read`、`id-token: write`，checkout 设置 `persist-credentials: false`。
- GitHub Release Job：只授予 `contents: write`，并通过 `needs` 等待 npm 发布成功。
- 对所有 Action 固定完整 commit SHA。

### 25.4 为什么发布不自动取消

```yaml
concurrency:
  group: publish-${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: false
```

每个标签是独立并发组。同一标签重复触发时，新运行不会取消正在发布的旧运行，降低任务被中途截断的风险。

但该配置不是全局发布锁：

- 不同标签拥有不同并发组，因此可以同时发布。
- 后完成的任务会设置 npm 默认的 `latest` dist-tag，乱序完成可能让 `latest` 指向非预期版本。
- 同组只保证最多一个 Running 和一个 Pending；更多新运行可能替换已有 Pending，且不保证 FIFO 顺序。

如果要求所有版本严格串行，可以使用不包含 `github.ref` 的包级并发组，例如 `publish-claude-trace`。GitHub 原生并发组仍不是可靠 FIFO 队列；严格的发布队列还需要受保护 Environment 或外部发布协调机制。

### 25.5 为什么发布任务关闭缓存

```yaml
package-manager-cache: false
```

CI 缓存强调速度，发布强调供应链可预测性。发布任务从 lockfile 和注册表重新安装依赖，可以减少缓存投毒或陈旧缓存影响。

### 25.6 npm OIDC 版本检查

工作流读取 `npm --version`，要求至少 `11.5.1`。npm Trusted Publishing 还要求 Node.js `>= 22.14.0` 和受支持的云托管 Runner；本项目使用 Node.js 24 和 GitHub 托管 Ubuntu Runner，满足这些条件。版本过低不会识别 Trusted Publishing，即使 npm 网站和 GitHub 权限都配置正确，也会认证失败。

### 25.7 标签与包版本校验

```text
标签 v3.0.12 + package.json 3.0.12 = 允许
标签 v3.0.13 + package.json 3.0.12 = 拒绝
```

这可以避免 GitHub Release 标签、npm 包版本和源码版本彼此不一致。

### 25.8 发布前检查

本项目发布 Workflow 重复执行 CI 核心检查。即使本地脚本或普通 CI 被跳过，发布任务本身也不会未经验证直接发布。

`npm pack --dry-run` 会列出发布前预计进入包内的文件，用来发现：

- `dist` 是否缺失。
- `package.json.files` 是否错误。
- 是否意外包含日志、凭证或无关大文件。

它并不保证预览内容与真正发布的内容逐字节一致。本项目定义了：

```json
"prepublishOnly": "npm run clean && npm run build"
```

因此随后的 `npm publish` 会再次删除 `dist` 并重新构建。前面的 smoke test 和 pack 预览验证的是第一次构建，真正发布的是第二次构建结果。要求严格可复现时，应考虑只构建和打包一次，验证生成的 tarball 后直接发布该 tarball。

### 25.9 npm 发布

```yaml
run: npm publish --access public
```

- Scoped package 默认可能是 restricted，因此显式指定 `--access public`。
- 没有 `NPM_TOKEN`。
- npm CLI 根据 GitHub OIDC 环境自动完成认证。
- Trusted Publishing 自动生成 provenance。
- 执行发布前，npm 会运行本项目的 `prepublishOnly`，即再次 `clean` 和 `build`。

### 25.10 注册表确认

npm 发布接口成功后，公开查询可能有短暂延迟。工作流最多查询 10 次，每次等待 3 秒，确认：

```text
npm view @hanqunfeng/claude-trace version
```

返回值与 `package.json.version` 一致。

### 25.11 GitHub Release

工作流先检查同标签 Release 是否已存在，因此 Release Step 自身重复执行时可以跳过已有 Release。不存在时：

- 标题使用版本标签。
- GitHub 自动生成变更说明。
- 在说明顶部追加全局安装命令。

GitHub CLI 使用本次运行自动生成的短期 `GITHUB_TOKEN`，无需 Personal Access Token。

需要区分“重试 Release Step”和“重跑整个 Job”：整个 Job 并非幂等。版本已经成功发布后，重新运行会在 `npm publish` 处因版本已存在而失败，无法执行后面的 Release Step。若要支持发布恢复，工作流应在发布前查询目标版本；版本已存在时跳过 npm publish，并继续验证及创建缺失的 GitHub Release。

---

## 二十六、常见问题

### Q1：`name`、Job ID、Step name 有什么区别？

```yaml
name: CI             # Workflow 名称
jobs:
  test:              # Job ID
    name: Unit Test  # Job 显示名称
    steps:
      - name: Run    # Step 显示名称
        run: npm test
```

### Q2：为什么 `run` 之前通常要 checkout？

Runner 默认没有仓库文件。`actions/checkout` 把对应 commit 检出到 `$GITHUB_WORKSPACE`。

### Q3：不同 Step 是否共享文件？

同一 Job 中共享。不同 Job 通常不共享，需要 Artifact。

### Q4：不同 Step 是否共享 `export` 的环境变量？

不共享。写入 `$GITHUB_ENV` 才能传给后续 Step。

### Q5：`${{ }}` 和 `$VAR` 有什么区别？

- `${{ }}`：由 GitHub Actions 在 Step 运行前求值。
- `$VAR`：由 Linux/macOS Shell 在运行时读取。
- PowerShell 通常使用 `$env:VAR`。

### Q6：为什么连续 push 后旧 CI 被取消？

Workflow 设置了相同 `concurrency.group` 和 `cancel-in-progress: true`。

### Q7：为什么发布 Workflow 不取消旧任务？

发布包含不可逆的外部操作。中途取消可能导致 npm、GitHub Release 状态不一致。

### Q8：为什么 Job 默认并行？

没有 `needs` 依赖的 Job 彼此独立。使用：

```yaml
job-b:
  needs: job-a
```

即可改成串行依赖。

### Q9：Action 的 `@v6` 是 npm 版本吗？

不是。它是 Action 仓库的 Git 标签。`actions/setup-node@v6` 表示 setup-node Action v6，`node-version: "24"` 才是 Node.js 版本。

### Q10：Workflow 可以修改仓库吗？

可以，但必须给 `GITHUB_TOKEN` 对应写权限，例如 `contents: write`。分支保护规则仍可能限制直接 push。

### Q11：为什么 Fork PR 读取不到 Secret？

这是安全设计，防止外部贡献者修改 Workflow 后输出或上传 Secret。

### Q12：`npm ci` 和 `npm install` 在 CI 中如何选择？

有 lockfile 时优先 `npm ci`：

- 按 lockfile 严格安装。
- 不修改 lockfile。
- 依赖不一致时直接失败。
- 更适合可重复构建。

### Q13：可以在本地完整模拟 GitHub Actions 吗？

可以使用第三方工具做部分模拟，但 Runner 镜像、权限、OIDC、Secret、GitHub 事件和托管服务无法保证完全一致。最终仍应以 GitHub Actions 实际运行结果为准。

### Q14：修改 Workflow 后如何安全验证？

1. 运行 YAML/actionlint 检查。
2. 先在功能分支通过 `pull_request` 验证低权限 CI。
3. 为部署流程增加 `workflow_dispatch` 的 dry-run 输入。
4. 使用 staging Environment。
5. 对发布流程严格校验标签和版本。
6. 不要用真实版本反复测试不可撤销的 npm publish。

---

## 二十七、官方参考资料

- [GitHub Actions 文档](https://docs.github.com/actions)
- [Workflow 语法](https://docs.github.com/actions/using-workflows/workflow-syntax-for-github-actions)
- [触发 Workflow 的事件](https://docs.github.com/actions/using-workflows/events-that-trigger-workflows)
- [表达式](https://docs.github.com/actions/learn-github-actions/expressions)
- [Context 参考](https://docs.github.com/actions/learn-github-actions/contexts)
- [依赖缓存](https://docs.github.com/actions/using-workflows/caching-dependencies-to-speed-up-workflows)
- [Artifact](https://docs.github.com/actions/using-workflows/storing-workflow-data-as-artifacts)
- [复用 Workflow](https://docs.github.com/actions/using-workflows/reusing-workflows)
- [OIDC 参考](https://docs.github.com/actions/reference/openid-connect-reference)
- [使用 GITHUB_TOKEN](https://docs.github.com/actions/security-guides/automatic-token-authentication)
- [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/)

GitHub Actions 和各个 Action 会持续更新。编写新 Workflow 或升级主要版本时，应重新查看官方文档及对应 Action 的 Release Notes。
