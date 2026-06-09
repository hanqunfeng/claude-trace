#!/usr/bin/env bash
# 发布 @hanqunfeng/claude-trace 到 npm（使用 ~/.npmrc 中的 Access Token）
# 用法:
#   ./scripts/publish.sh              发布当前版本（不升版本号）
#   ./scripts/publish.sh patch        升补丁版本后发布 (x.y.Z)
#   ./scripts/publish.sh minor        升次版本后发布 (x.Y.0)
#   ./scripts/publish.sh major        升主版本后发布 (X.0.0)
#   ./scripts/publish.sh --check      仅运行检查，不发布
#   ./scripts/publish.sh --dry-run      检查 + npm pack 预览，不发布

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

NPM_USER="hanqunfeng"
PACKAGE="@hanqunfeng/claude-trace"

log() { echo "==> $*"; }
die() { echo "错误: $*" >&2; exit 1; }

usage() {
	cat <<EOF
用法: $0 [patch|minor|major|--check|--dry-run]

  (无参数)    发布 package.json 中的当前版本
  patch       升补丁版本后发布
  minor       升次版本后发布
  major       升主版本后发布
  --check     仅运行发布前检查
  --dry-run   检查并预览打包内容，不发布

前置条件: ~/.npmrc 已配置 Bypass 2FA 的 Access Token
  npm config set //registry.npmjs.org/:_authToken=你的token
  npm whoami   # 应输出 hanqunfeng

详见 PUBLISHING.md
EOF
}

check_npm_auth() {
	local user
	user=$(npm whoami 2>/dev/null) || die "npm 未认证。请先配置 Token:
  npm config set //registry.npmjs.org/:_authToken=你的token
详见 PUBLISHING.md"
	[[ "$user" == "$NPM_USER" ]] || die "当前 npm 用户为 '$user'，需要 '$NPM_USER'"
	log "npm 用户: $user"
}

check_git_clean() {
	if [[ -n "$(git status --porcelain 2>/dev/null)" ]]; then
		die "工作区有未提交的更改，请先 commit 或 stash"
	fi
	log "git 工作区干净"
}

check_not_already_published() {
	local version published
	version=$(node -p "require('./package.json').version")
	published=$(npm view "$PACKAGE" version 2>/dev/null || echo "")
	if [[ "$published" == "$version" ]]; then
		die "版本 $version 已在 npm 上发布。请先用 patch/minor/major 升版本，或手动修改 package.json"
	fi
	log "将发布新版本: $version（npm 当前最新: ${published:-无}）"
}

run_checks() {
	log "运行 typecheck..."
	npm run typecheck

	log "构建项目..."
	npm run build

	log "验证 CLI..."
	node dist/cli.js --help >/dev/null

	log "预览发布包..."
	npm pack --dry-run
}

bump_version() {
	local level="$1"
	log "升级版本 ($level)..."
	npm version "$level" -m "chore: release v%s"
}

push_git() {
	if ! git rev-parse --git-dir >/dev/null 2>&1; then
		log "非 git 仓库，跳过 push"
		return
	fi
	log "推送到远程..."
	git push origin HEAD
	git push origin --tags
}

do_publish() {
	log "发布到 npm..."
	npm publish --access public
}

verify_publish() {
	local version published
	version=$(node -p "require('./package.json').version")
	log "验证 npm 上的版本..."
	published=$(npm view "$PACKAGE" version)
	[[ "$published" == "$version" ]] || die "发布验证失败: npm=$published, 本地=$version"
	log "发布成功: $PACKAGE@$version"
	echo ""
	echo "  npm:  https://www.npmjs.com/package/${PACKAGE#@}"
	echo "  安装: npm install -g $PACKAGE"
}

main() {
	local arg="${1:-}"

	case "$arg" in
		-h | --help)
			usage
			exit 0
			;;
		--check)
			check_npm_auth
			run_checks
			log "检查通过"
			exit 0
			;;
		--dry-run)
			check_npm_auth
			run_checks
			log "dry-run 完成，未发布"
			exit 0
			;;
		"" | patch | minor | major)
			;;
		*)
			usage
			exit 1
			;;
	esac

	check_npm_auth
	check_git_clean
	run_checks

	if [[ "$arg" == "patch" || "$arg" == "minor" || "$arg" == "major" ]]; then
		bump_version "$arg"
		push_git
	else
		check_not_already_published
	fi

	do_publish
	verify_publish
}

main "$@"
