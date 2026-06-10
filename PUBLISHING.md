# npm 发布流程

本文档说明如何使用 **Access Token** 将 `@hanqunfeng/claude-trace` 发布到 [npm 官方仓库](https://www.npmjs.com/package/@hanqunfeng/claude-trace)。

## 前置条件

| 项目 | 要求 |
|------|------|
| npm 账号 | 用户名须为 `hanqunfeng`（与 scope `@hanqunfeng` 一致） |
| Access Token | 已创建并配置到本地 `~/.npmrc` |
| 包名 | `@hanqunfeng/claude-trace`（作用域包，发布时需 `--access public`） |
| Node.js | >= 16 |

## 一次性配置

### 1. 注册与登录

1. 浏览器打开 [https://www.npmjs.com](https://www.npmjs.com)
2. 没有帐号要先进行注册，用户名须为 `hanqunfeng`（与 scope `@hanqunfeng` 一致）


### 2. 创建 Access Token

1. 打开 [https://www.npmjs.com/settings/hanqunfeng/tokens](https://www.npmjs.com/settings/hanqunfeng/tokens)
2. **Generate New Token** → **创建新的 Access Token** → 填写名称（如 `claude-trace-publish`）
3. 勾选 **Bypass two-factor authentication (2FA)**（发布时必须勾选）
4. **Packages and scopes**：
   - Permissions → **Read and write**
   - Select packages → **Only select packages and scopes** → `@hanqunfeng`
5. 设置 **Expiration Date**，到期后需重新创建 Token
6. 复制生成的 Token（**只显示一次**，请妥善保存）

### 3. 配置本地 Token

将 Token 写入用户级 `~/.npmrc`（不要提交到 git）：

```bash
npm config set //registry.npmjs.org/:_authToken=你的token
```

验证身份：

```bash
npm whoami    # 应输出 hanqunfeng
```

> **安全提示：** 不要将 Token 写入项目目录或提交到 GitHub。若泄露，立即在 npm 网站撤销并重新创建。

### 4. 配置 GitHub CLI（创建 Release 时需要）

发布脚本在 npm 发布成功后会自动在 GitHub 创建 Release。需要安装并登录 [GitHub CLI](https://cli.github.com/)：

```bash
# macOS
brew install gh

# 登录（需有 hanqunfeng/claude-trace 仓库的写权限）
gh auth login
gh auth status    # 应显示已登录
gh repo view hanqunfeng/claude-trace   # 确认可访问仓库
```

若只想发布到 npm、跳过 GitHub Release，使用 `--no-github` 参数（见下方发布脚本说明）。

## 发布包内容

`package.json` 中 `files` 字段控制发布内容，当前包含：

```
dist/**/*                  # 编译后的 CLI、反向代理、拦截器
frontend/dist/**/*         # 前端 CSS + JS bundle
frontend/template.html     # HTML 模板
README.md
README.zh-CN.md
```

**不会发布**源码、`node_modules`、`test/`、`fix/` 等。`prepublishOnly` 会在发布前自动执行 `clean` + `build`。

预览将要发布的文件：

```bash
npm pack --dry-run
```

## 完整发布流程

### 1. 确认代码就绪

```bash
# 安装依赖（仅开发环境需要，发布前 build 会用到 frontend 依赖）
npm run setup

# 类型检查
npm run typecheck

# 手动构建验证（publish 时 prepublishOnly 也会执行）
npm run build

# 本地试跑
node dist/cli.js --help
```

### 2. 更新版本号

遵循 [语义化版本](https://semver.org/lang/zh-CN/)：

| 变更类型 | 命令 | 示例 |
|----------|------|------|
| 补丁（bug 修复） | `npm version patch` | 2.0.2 → 2.0.3 |
| 次版本（新功能，向后兼容） | `npm version minor` | 2.0.2 → 2.1.0 |
| 主版本（破坏性变更） | `npm version major` | 2.0.2 → 3.0.0 |

该命令会同时更新 `package.json` 和 `package-lock.json`，并创建 git tag。

```bash
git add package.json package-lock.json
git commit -m "chore: bump version to x.y.z"
git push && git push --tags
```

### 3. 确认 Token 已配置

```bash
npm whoami    # 应输出 hanqunfeng
```

若输出错误或未登录，重新执行：

```bash
npm config set //registry.npmjs.org/:_authToken=你的token
```

### 4. 发布

```bash
npm publish --access public
```

- `--access public`：作用域包默认为私有，免费账号必须显式公开
- 使用已配置 Bypass 2FA 的 Access Token，**无需** `--otp` 参数

`prepublishOnly` 会自动运行，无需手动 `npm run build`。

### 5. 验证发布

```bash
# 查看 npm 上的版本
npm view @hanqunfeng/claude-trace version

# 全局安装测试
npm install -g @hanqunfeng/claude-trace
claude-trace --help
```

包页面：https://www.npmjs.com/package/@hanqunfeng/claude-trace

## 发布脚本（推荐）

项目提供 `scripts/publish.sh`，自动完成检查、升版本、发布与验证。使用 `~/.npmrc` 中的 Access Token，无需 `--otp`。

### 命令

| 命令 | 说明 |
|------|------|
| `npm run publish:check` | 仅运行发布前检查（typecheck + build + pack 预览） |
| `npm run publish:dry-run` | 同 check，明确标注不发布 |
| `npm run publish:patch` | 升补丁版本 → git push → 发布 → GitHub Release |
| `npm run publish:minor` | 升次版本 → git push → 发布 → GitHub Release |
| `npm run publish:major` | 升主版本 → git push → 发布 → GitHub Release |
| `npm run publish:release` | 发布当前版本（不升版本号）→ GitHub Release |

或直接调用脚本：

```bash
chmod +x scripts/publish.sh   # 首次需要
./scripts/publish.sh patch
./scripts/publish.sh patch --no-github              # 仅发 npm，跳过 GitHub Release
./scripts/publish.sh --github-notes RELEASE.md patch  # 使用自定义 Release 说明
```

### 脚本会自动执行

1. 验证 `npm whoami` 为 `hanqunfeng`
2. 检查 git 工作区无未提交更改
3. `npm run typecheck` + `npm run build` + CLI 冒烟测试
4. `npm pack --dry-run` 预览发布内容
5. （可选）`npm version` 升版本并 push + tags
6. `npm publish --access public`
7. 验证 npm 上的版本与本地一致
8. 创建 GitHub Release（tag 为 `vX.Y.Z`，自动生成变更说明；已存在则跳过）

`npm run publish:check` 会额外验证 `gh auth status`（除非传入 `--no-github`）。

## 快速参考（手动）

```bash
npm run publish:patch      # 推荐：一键发布
# 或手动：
npm run typecheck
npm version patch
git push && git push --tags
npm publish --access public
npm view @hanqunfeng/claude-trace version
```

## 常见问题

### E403：需要 2FA 或 Bypass 2FA 的 Token

```
Two-factor authentication or granular access token with bypass 2fa enabled is required
```

**处理：**

1. 确认账户已开启 2FA
2. 重新创建 Access Token，并勾选 **Bypass two-factor authentication (2FA)**
3. 更新 `~/.npmrc` 中的 `_authToken`

### E401：Token 无效或过期

**处理：** 在 npm 网站撤销旧 Token，创建新 Token 并重新配置：

```bash
npm config set //registry.npmjs.org/:_authToken=新token
```

### E402：需要付费

```
402 Payment Required
```

**处理：** 发布作用域包时缺少 `--access public`。

### E403：无权发布此包

**处理：** 确认 `npm whoami` 为 `hanqunfeng`；Token 的 scope 须包含 `@hanqunfeng`。

### 发布后用户安装失败

确认 `package.json` 中**没有** `postinstall` 脚本。本项目已移除 `postinstall`，改用开发专用的 `npm run setup`，避免用户安装时尝试 `cd frontend && npm install`（发布包中不含 `frontend/package.json`）。

## Token 轮换

Token 到期前：

1. 在 [npm Tokens 页面](https://www.npmjs.com/settings/hanqunfeng/tokens) 创建新 Token
2. 更新本地配置：`npm config set //registry.npmjs.org/:_authToken=新token`
3. 验证：`npm whoami`
4. 撤销旧 Token

## 版本与 Git / GitHub 同步

使用发布脚本时，`patch` / `minor` / `major` 会自动执行 `npm version`、创建 git tag 并 push，npm 发布成功后创建 GitHub Release：

```bash
npm run publish:patch
```

Release 说明默认由 GitHub 根据 commit/PR 自动生成，并在顶部附上 `npm install -g` 安装命令。若需自定义说明，准备 Markdown 文件后：

```bash
./scripts/publish.sh --github-notes RELEASE.md patch
```

Release 页面示例：https://github.com/hanqunfeng/claude-trace/releases

## 相关链接

- npm 包页：https://www.npmjs.com/package/@hanqunfeng/claude-trace
- Token 管理：https://www.npmjs.com/settings/hanqunfeng/tokens
- GitHub 仓库：https://github.com/hanqunfeng/claude-trace
- 用户安装：`npm install -g @hanqunfeng/claude-trace`
