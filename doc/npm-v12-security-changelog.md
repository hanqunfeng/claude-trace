# npm v12 安装时安全策略与 GAT bypass2fa 弃用说明

> 原文：[npm install-time security and GAT bypass2fa deprecation](https://github.blog/changelog/2026-07-08-npm-install-time-security-and-gat-bypass2fa-deprecation/)  
> 发布日期：2026-07-08

## 概述

npm v12 已正式发布并标记为 `latest`。本次大版本包含两项重要变化：

1. **启用安装时安全默认策略**（2026 年 6 月已预告）
2. **开始弃用最敏感的 2FA 绕过型 Granular Access Token（GAT）用法**

---

## 一、安装时安全默认策略（npm v12 起生效）

自 npm v12 起，以下在 `npm install` 时**曾经自动执行**的行为，改为**默认关闭、需显式开启**：

| 行为 | 新默认值 | 说明 |
|------|----------|------|
| 生命周期脚本 | `allowScripts` 默认 **off** | `preinstall` / `install` / `postinstall` 及隐式 `node-gyp` 构建不再自动运行，除非显式允许 |
| Git 依赖 | `--allow-git` 默认 **none** | 直接或通过传递依赖引用的 Git 依赖不再解析，除非显式允许 |
| 远程 URL 依赖 | `--allow-remote` 默认 **none** | 来自远程 URL（如 https tarball）的依赖不再解析，除非显式允许 |

### 迁移建议

- 上述选项自 **npm 11.16.0+** 起已在警告模式下可用，升级 v12 前可先适配。
- 审查并批准可信脚本：

  ```bash
  npm approve-scripts --allow-scripts-pending
  ```

- 将生成的允许列表提交到 `package.json` 中。

### 延伸阅读

- [Upcoming breaking changes for npm v12](https://github.com/npm/cli/issues)（官方迁移说明）
- [npm v12 社区讨论](https://github.com/orgs/community/discussions)（提问与反馈）

---

## 二、2FA 绕过 GAT：账户敏感操作将不再跳过 2FA

配置了 **bypass 2FA** 的 npm Granular Access Token（GAT），在变更 rollout 后将**无法**再执行敏感的账户、包和组织管理操作。这些操作**必须**通过交互式 2FA 完成。

### 受影响的操作

- 创建或删除 Token
- 生成恢复码、修改密码、邮箱、个人资料或 2FA 配置
- 修改包的访问权限、维护者或 Trusted Publishing 配置
- 管理组织/团队成员及其包权限

### 时间线

- **预计生效：2026 年 8 月初**

### 迁移建议

- 停止使用 2FA-bypass Token 执行上述操作
- 改为在浏览器中交互式完成，并完成 2FA 验证

---

## 三、2FA 绕过 GAT：将失去直接发布能力

在上述变更之后，2FA-bypass Token 还将**失去直接 `npm publish` 的能力**。

### 变更后的发布能力

| 仍可用 | 不可用 |
|--------|--------|
| 读取私有包 | 直接发布到 npm |
| 暂存（stage）一次发布 | — |

暂存发布模式下，包**只有在人工完成 2FA 审批后**才会变为公开。

### 时间线

- **预计生效：2027 年 1 月左右**

### 迁移建议

自动化发布应迁移至：

1. **Trusted Publishing（OIDC）** — 推荐，无需长期有效的 publish Token  
   - 本项目已采用，见 [OIDC 发布流程](./publishing/oidc.md)
2. **Staged Publishing + 人工 2FA 审批** — 作为过渡方案

GitHub/npm 将在未来数月内提供更多迁移工具与指南，并在后续社区讨论中发布详细迁移文档。

---

## 对本项目的关联

| 变更 | 影响 |
|------|------|
| npm v12 安装脚本默认关闭 | 若 CI/本地 `npm install` 依赖 postinstall 脚本，需运行 `npm approve-scripts` 并提交 allowlist |
| GAT bypass2fa 弃用 | 若仍用长期 Token 本地发布，应迁移至 OIDC；本项目 [OIDC 发布流程](./publishing/oidc.md) 已覆盖推荐路径 |
| 直接 publish Token 弃用 | `scripts/publish.sh` 等传统 Token 发布方式需逐步淘汰，优先使用 `.github/workflows/publish.yml` |

---

## 参考链接

- [原文 Changelog](https://github.blog/changelog/2026-07-08-npm-install-time-security-and-gat-bypass2fa-deprecation/)
- [npm Trusted Publishing 文档](https://docs.npmjs.com/trusted-publishers)
- 社区讨论：原文底部 "Follow along and ask questions in the community discussion"
