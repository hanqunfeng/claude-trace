# OIDC 发布流程（GitHub Actions）

本文档说明如何通过 **npm Trusted Publishing (OIDC)** 发布 `@hanqunfeng/claude-trace`。

本地机器**不执行** `npm publish`，也**不需要** npm Access Token。推送 `v*` 标签后，GitHub Actions 工作流 `.github/workflows/publish.yml` 会自动完成构建、npm 发布和 GitHub Release。

> 传统的 Access Token 本地发布方式见 [Access Token 发布流程](./access-token.md) 与 `scripts/publish.sh`。

## 架构

```
本地 publish-oidc.sh
  → git push + git push tag vX.Y.Z
    → GitHub Actions (publish.yml)
      → typecheck / test / build
      → npm publish（OIDC，无需 NPM_TOKEN）
      → GitHub Release
```

## 一次性配置

### 1. npm Trusted Publisher

在 [npm 包设置](https://www.npmjs.com/package/@hanqunfeng/claude-trace/access) → **Trusted Publisher** → **GitHub Actions** 中配置：

| 字段 | 值 |
|------|-----|
| Organization or user | `hanqunfeng` |
| Repository | `claude-trace` |
| Workflow filename | `publish.yml` |
| Environment name | （留空） |
| Allowed actions | `npm publish` |

> 工作流文件名只填 `publish.yml`，不要写完整路径。

### 2. GitHub CLI

```bash
brew install gh          # macOS
gh auth login
gh auth status           # 应显示已登录
```

### 3. 脚本可执行权限（首次）

```bash
chmod +x scripts/publish-oidc.sh
```

## 标准发布（推荐）

```bash
# 补丁版本（最常用）
npm run publish:oidc:patch

# 或手动分步
git checkout main
git pull
npm run publish:oidc:check    # 可选：本地检查
npm run publish:oidc:patch      # 升版本 → 推送 tag → 监控 Actions
```

脚本会自动：

1. 检查 git 工作区干净
2. 运行 typecheck、单测、构建、pack 预览
3. `npm version patch` 升版本并创建 commit + tag
4. 推送 commit 和 `vX.Y.Z` 标签
5. 监控 GitHub Actions 工作流直到完成
6. 验证 npm 注册表上的版本

## 命令参考

### npm scripts

| 命令 | 说明 |
|------|------|
| `npm run publish:oidc:check` | 仅本地检查 |
| `npm run publish:oidc:dry-run` | 检查 + 预览将执行的操作 |
| `npm run publish:oidc:patch` | 升补丁版本并触发 OIDC 发布 |
| `npm run publish:oidc:minor` | 升次版本并触发 OIDC 发布 |
| `npm run publish:oidc:major` | 升主版本并触发 OIDC 发布 |
| `npm run publish:oidc` | 不升版本，推送当前版本 tag |

### 脚本直接调用

```bash
./scripts/publish-oidc.sh --check
./scripts/publish-oidc.sh --dry-run
./scripts/publish-oidc.sh patch
./scripts/publish-oidc.sh minor
./scripts/publish-oidc.sh major
./scripts/publish-oidc.sh --no-watch patch   # 推送后不等待 Actions
```

## 版本选择

| 变更类型 | 命令 | 示例 |
|----------|------|------|
| Bug 修复 | `npm run publish:oidc:patch` | 3.0.9 → 3.0.10 |
| 新功能（向后兼容） | `npm run publish:oidc:minor` | 3.0.9 → 3.1.0 |
| 破坏性变更 | `npm run publish:oidc:major` | 3.0.9 → 4.0.0 |

## 发布后验证

```bash
npm view @hanqunfeng/claude-trace version
gh run list --repo hanqunfeng/claude-trace --workflow publish.yml --limit 3
gh release view v3.0.10 --repo hanqunfeng/claude-trace
npm install -g @hanqunfeng/claude-trace
claude-trace --help
```

## GitHub Actions 工作流说明

工作流文件：`.github/workflows/publish.yml`

工作流仅由 `v*` 标签推送触发，并同时发布 npm 包和创建 GitHub Release。

### 工作流自动执行

1. 校验 tag 与 `package.json` 版本一致
2. 使用 Node.js 24 自带的兼容 npm，并关闭发布任务的依赖缓存
3. `npm ci`（根目录 + frontend）
4. typecheck、单测、构建和 CLI smoke test
5. 预览 npm 包内容
6. 通过 OIDC 发布到 npm（自动生成 provenance）
7. 验证 npm 注册表版本
8. 创建 GitHub Release（自动生成变更说明）

## 常见问题

### 推送 tag 后 Actions 未启动

- 确认 tag 格式为 `vX.Y.Z`（如 `v3.0.10`）
- 确认 `publish.yml` 已在 `main` 分支
- 查看 Actions 页面是否有权限或规则拦截

### Actions 发布失败：Trusted Publisher 不匹配

错误通常表现为 `E404` 或认证失败。检查 npm Trusted Publisher 配置：

- owner: `hanqunfeng`
- repo: `claude-trace`
- workflow: `publish.yml`（仅文件名）

### tag 与 package.json 版本不一致

```
Tag v3.0.10 does not match package.json version 3.0.9
```

处理：重新执行 `npm version patch` 或手动修正 `package.json` 后重新打 tag。

### 版本已在 npm 上存在

```
版本 3.0.10 已在 npm 上发布。请先用 patch/minor/major 升版本
```

处理：升版本后重新发布，不要重复推送同一版本 tag。

### 需要补建 GitHub Release

若通过 `workflow_dispatch` 发布了 npm 但未创建 Release：

```bash
gh release create v3.0.10 \
  --repo hanqunfeng/claude-trace \
  --title "v3.0.10" \
  --generate-notes
```

## 与本地 Token 发布的对比

| | OIDC（本文档） | Access Token（[access-token.md](./access-token.md)） |
|--|----------------|-------------------------------|
| npm Token | 不需要 | 需要 Bypass 2FA Token |
| 发布执行方 | GitHub Actions | 本地 `npm publish` |
| GitHub Release | 自动（tag 触发） | `publish.sh` 通过 gh CLI |
| 脚本 | `scripts/publish-oidc.sh` | `scripts/publish.sh` |
| 安全性 | 短期 OIDC 凭证 | 长期 Token |

## 相关链接

- npm 包页：https://www.npmjs.com/package/@hanqunfeng/claude-trace
- GitHub Actions：https://github.com/hanqunfeng/claude-trace/actions/workflows/publish.yml
- npm Trusted Publishing 文档：https://docs.npmjs.com/trusted-publishers/
- GitHub OIDC 文档：https://docs.github.com/en/actions/deployment/security-hardening-your-deployments/about-security-hardening-with-openid-connect
