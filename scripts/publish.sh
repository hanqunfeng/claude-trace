#!/usr/bin/env bash
# 发布 @hanqunfeng/claude-trace 到 npm（使用 ~/.npmrc 中的 Access Token）
# 用法:
#   ./scripts/publish.sh              发布当前版本（不升版本号）
#   ./scripts/publish.sh patch        升补丁版本后发布 (x.y.Z)
#   ./scripts/publish.sh minor        升次版本后发布 (x.Y.0)
#   ./scripts/publish.sh major        升主版本后发布 (X.0.0)
#   ./scripts/publish.sh --check      仅运行检查，不发布
#   ./scripts/publish.sh --dry-run    检查 + npm pack 预览，不发布
#   ./scripts/publish.sh --no-github  跳过 GitHub Release
#   ./scripts/publish.sh --github-notes FILE  使用指定 Markdown 作为 Release 说明

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

NPM_USER="hanqunfeng"
PACKAGE="@hanqunfeng/claude-trace"
SKIP_GITHUB=false
GITHUB_NOTES_FILE=""
NETWORK_MAX_ATTEMPTS=10
NETWORK_RETRY_DELAY=3

log() { echo "==> $*"; }
die() { echo "错误: $*" >&2; exit 1; }
warn() { echo "警告: $*" >&2; }

retry_network() {
	local desc="$1"
	shift
	local attempt
	for ((attempt = 1; attempt <= NETWORK_MAX_ATTEMPTS; attempt++)); do
		if "$@"; then
			return 0
		fi
		if [[ $attempt -lt $NETWORK_MAX_ATTEMPTS ]]; then
			log "网络操作失败，重试 ($attempt/$NETWORK_MAX_ATTEMPTS): $desc"
			sleep "$NETWORK_RETRY_DELAY"
		fi
	done
	return 1
}

usage() {
	cat <<EOF
用法: $0 [patch|minor|major] [选项]

  (无参数)           发布 package.json 中的当前版本
  patch              升补丁版本后发布
  minor              升次版本后发布
  major              升主版本后发布
  --check            仅运行发布前检查
  --dry-run          检查并预览打包内容，不发布
  --no-github        跳过 GitHub Release 创建
  --github-notes FILE  使用指定 Markdown 文件作为 Release 说明

选项可与 patch/minor/major 组合，顺序不限。

前置条件:
  npm: ~/.npmrc 已配置 Bypass 2FA 的 Access Token（npm whoami → hanqunfeng）
  GitHub: 已安装并登录 gh CLI（gh auth login）

详见 PUBLISHING.md
EOF
}

get_package_version() {
	node -p "require('./package.json').version"
}

get_version_tag() {
	echo "v$(get_package_version)"
}

resolve_github_repo() {
	node -p "
		const u = require('./package.json').repository?.url || '';
		const m = u.match(/github\\.com[:\\/](.+?)\\.git\$/) || u.match(/github\\.com[:\\/](.+)\$/);
		m ? m[1] : 'hanqunfeng/claude-trace';
	"
}

check_npm_auth() {
	local user
	user=$(npm whoami 2>/dev/null) || die "npm 未认证。请先配置 Token:
  npm config set //registry.npmjs.org/:_authToken=你的token
详见 PUBLISHING.md"
	[[ "$user" == "$NPM_USER" ]] || die "当前 npm 用户为 '$user'，需要 '$NPM_USER'"
	log "npm 用户: $user"
}

check_gh_auth() {
	command -v gh >/dev/null 2>&1 || die "未安装 GitHub CLI。请安装: https://cli.github.com/"
	gh auth status >/dev/null 2>&1 || die "GitHub CLI 未登录。请运行: gh auth login"
	log "GitHub CLI 已认证"
}

check_git_clean() {
	if [[ -n "$(git status --porcelain 2>/dev/null)" ]]; then
		die "工作区有未提交的更改，请先 commit 或 stash"
	fi
	log "git 工作区干净"
}

check_not_already_published() {
	local version published
	version=$(get_package_version)
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
	retry_network "git push origin HEAD" git push origin HEAD \
		|| die "git push 失败（已重试 $NETWORK_MAX_ATTEMPTS 次）"
	retry_network "git push origin --tags" git push origin --tags \
		|| die "git push --tags 失败（已重试 $NETWORK_MAX_ATTEMPTS 次）"
}

do_publish() {
	log "发布到 npm..."
	npm publish --access public
}

verify_publish() {
	local version published attempt
	version=$(get_package_version)
	log "验证 npm 上的版本..."
	for ((attempt = 1; attempt <= NETWORK_MAX_ATTEMPTS; attempt++)); do
		published=$(npm view "$PACKAGE" version --prefer-online 2>/dev/null || echo "")
		if [[ "$published" == "$version" ]]; then
			log "发布成功: $PACKAGE@$version"
			echo ""
			echo "  npm:  https://www.npmjs.com/package/${PACKAGE#@}"
			echo "  安装: npm install -g $PACKAGE"
			return 0
		fi
		if [[ $attempt -lt $NETWORK_MAX_ATTEMPTS ]]; then
			log "等待 npm 注册表同步 ($attempt/$NETWORK_MAX_ATTEMPTS): npm=$published, 本地=$version"
			sleep "$NETWORK_RETRY_DELAY"
		fi
	done
	die "发布验证失败: npm=$published, 本地=$version（已重试 $NETWORK_MAX_ATTEMPTS 次）"
}

remote_has_tag() {
	local tag="$1" output
	output=$(git ls-remote --tags origin "refs/tags/${tag}" 2>&1) || return 2
	if echo "$output" | grep -q "refs/tags/${tag}"; then
		return 0
	fi
	return 1
}

gh_release_exists() {
	local tag="$1" repo="$2" err rc=0
	err=$(gh release view "$tag" --repo "$repo" 2>&1) || rc=$?
	if [[ $rc -eq 0 ]]; then
		return 0
	fi
	if echo "$err" | grep -qiE 'release not found|could not find'; then
		return 1
	fi
	return 2
}

ensure_git_tag() {
	local tag="$1" attempt remote_status
	if git rev-parse "$tag" >/dev/null 2>&1; then
		log "git tag $tag 已存在"
	else
		log "创建 git tag $tag..."
		git tag "$tag"
	fi
	for ((attempt = 1; attempt <= NETWORK_MAX_ATTEMPTS; attempt++)); do
		remote_has_tag "$tag"
		remote_status=$?
		if [[ $remote_status -eq 0 ]]; then
			log "远程 tag $tag 已存在"
			return 0
		fi
		if [[ $remote_status -eq 1 ]]; then
			log "推送 tag $tag 到远程..."
			if retry_network "推送 tag $tag" git push origin "$tag"; then
				return 0
			fi
			die "推送 tag $tag 失败（已重试 $NETWORK_MAX_ATTEMPTS 次）"
		fi
		if [[ $attempt -lt $NETWORK_MAX_ATTEMPTS ]]; then
			log "检查远程 tag 失败，重试 ($attempt/$NETWORK_MAX_ATTEMPTS): $tag"
			sleep "$NETWORK_RETRY_DELAY"
		fi
	done
	die "检查远程 tag $tag 失败（已重试 $NETWORK_MAX_ATTEMPTS 次）"
}

build_release_notes() {
	local tag="$1" repo="$2" notes_file="$3"
	{
		echo "## Install"
		echo '```bash'
		echo "npm install -g $PACKAGE"
		echo '```'
		echo ""
		if [[ -n "$GITHUB_NOTES_FILE" ]]; then
			[[ -f "$GITHUB_NOTES_FILE" ]] || die "Release 说明文件不存在: $GITHUB_NOTES_FILE"
			cat "$GITHUB_NOTES_FILE"
		else
			local generated prev_tag attempt
			generated=""
			for ((attempt = 1; attempt <= NETWORK_MAX_ATTEMPTS; attempt++)); do
				generated=$(gh api "repos/${repo}/releases/generate-notes" \
					-f "tag_name=${tag}" \
					-f "target_commitish=HEAD" \
					--jq .body 2>/dev/null || true)
				if [[ -n "$generated" ]]; then
					break
				fi
				if [[ $attempt -lt $NETWORK_MAX_ATTEMPTS ]]; then
					log "生成 Release 说明失败，重试 ($attempt/$NETWORK_MAX_ATTEMPTS)"
					sleep "$NETWORK_RETRY_DELAY"
				fi
			done
			if [[ -n "$generated" ]]; then
				echo "$generated"
			else
				prev_tag=$(git describe --tags --abbrev=0 "${tag}^" 2>/dev/null || echo "")
				if [[ -n "$prev_tag" ]]; then
					git log "${prev_tag}..HEAD" --pretty=format:'- %s (%h)'
				else
					git log -20 --pretty=format:'- %s (%h)'
				fi
				echo ""
			fi
		fi
	} >"$notes_file"
}

create_github_release() {
	if [[ "$SKIP_GITHUB" == "true" ]]; then
		log "跳过 GitHub Release (--no-github)"
		return
	fi
	if ! git rev-parse --git-dir >/dev/null 2>&1; then
		log "非 git 仓库，跳过 GitHub Release"
		return
	fi

	check_gh_auth

	local tag repo notes_file
	tag=$(get_version_tag)
	repo=$(resolve_github_repo)

	ensure_git_tag "$tag"

	log "检查 GitHub Release $tag..."
	local attempt release_status=1
	for ((attempt = 1; attempt <= NETWORK_MAX_ATTEMPTS; attempt++)); do
		gh_release_exists "$tag" "$repo" && release_status=0 || release_status=$?
		if [[ $release_status -eq 0 ]]; then
			log "GitHub Release $tag 已存在，跳过"
			echo "  GitHub: https://github.com/${repo}/releases/tag/${tag}"
			return 0
		fi
		if [[ $release_status -eq 1 ]]; then
			break
		fi
		if [[ $attempt -lt $NETWORK_MAX_ATTEMPTS ]]; then
			log "检查 GitHub Release 失败，重试 ($attempt/$NETWORK_MAX_ATTEMPTS): $tag"
			sleep "$NETWORK_RETRY_DELAY"
		fi
	done
	if [[ $release_status -eq 2 ]]; then
		warn "无法确认 GitHub Release 状态（已重试 $NETWORK_MAX_ATTEMPTS 次），尝试创建..."
	fi

	notes_file=$(mktemp)
	build_release_notes "$tag" "$repo" "$notes_file"

	log "创建 GitHub Release $tag..."
	if ! retry_network "创建 GitHub Release $tag" gh release create "$tag" \
		--repo "$repo" \
		--title "$tag" \
		--notes-file "$notes_file"; then
		rm -f "$notes_file"
		warn "GitHub Release 创建失败（已重试 $NETWORK_MAX_ATTEMPTS 次）"
		warn "npm 包可能已成功发布，请稍后手动执行:"
		warn "  gh release create $tag --repo $repo --title $tag --generate-notes"
		return 0
	fi
	rm -f "$notes_file"

	log "GitHub Release 已创建"
	echo "  GitHub: https://github.com/${repo}/releases/tag/${tag}"
}

main() {
	local mode="" bump=""

	while [[ $# -gt 0 ]]; do
		case "$1" in
			-h | --help)
				usage
				exit 0
				;;
			--check)
				mode="check"
				;;
			--dry-run)
				mode="dry-run"
				;;
			--no-github)
				SKIP_GITHUB=true
				;;
			--github-notes)
				shift
				[[ $# -gt 0 ]] || die "--github-notes 需要文件路径"
				GITHUB_NOTES_FILE="$1"
				;;
			patch | minor | major)
				[[ -z "$bump" ]] || die "不能同时指定多个版本级别: $bump 和 $1"
				bump="$1"
				;;
			*)
				die "未知参数: $1（使用 --help 查看用法）"
				;;
		esac
		shift
	done

	case "$mode" in
		check)
			check_npm_auth
			[[ "$SKIP_GITHUB" != "true" ]] && check_gh_auth
			run_checks
			log "检查通过"
			exit 0
			;;
		dry-run)
			check_npm_auth
			run_checks
			log "dry-run 完成，未发布"
			exit 0
			;;
		"")
			;;
		*)
			die "内部错误: 未知模式 $mode"
			;;
	esac

	check_npm_auth
	check_git_clean
	run_checks

	if [[ "$bump" == "patch" || "$bump" == "minor" || "$bump" == "major" ]]; then
		bump_version "$bump"
		push_git
	else
		check_not_already_published
	fi

	do_publish
	verify_publish
	create_github_release
}

main "$@"
