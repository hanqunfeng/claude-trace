#!/usr/bin/env bash
# Trigger OIDC publish for @hanqunfeng/claude-trace via GitHub Actions.
# Local machine only runs checks, bumps version, and pushes tags — npm publish
# happens in .github/workflows/publish.yml using npm Trusted Publishing (OIDC).
#
# Usage:
#   ./scripts/publish-oidc.sh              Push current version tag (no bump)
#   ./scripts/publish-oidc.sh patch        Bump patch, push commit + tag
#   ./scripts/publish-oidc.sh minor        Bump minor, push commit + tag
#   ./scripts/publish-oidc.sh major        Bump major, push commit + tag
#   ./scripts/publish-oidc.sh --check      Local checks only
#   ./scripts/publish-oidc.sh --dry-run    Checks + show planned actions
#   ./scripts/publish-oidc.sh --no-watch   Push without waiting for Actions
#
# See PUBLISHING-OIDC.md

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PACKAGE="@hanqunfeng/claude-trace"
GITHUB_REPO="hanqunfeng/claude-trace"
WORKFLOW_FILE="publish.yml"
NETWORK_MAX_ATTEMPTS=10
NETWORK_RETRY_DELAY=3
WATCH_WORKFLOW=true

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

  (无参数)         推送当前 package.json 版本对应的 vX.Y.Z 标签，触发 OIDC 发布
  patch            升补丁版本后推送 (x.y.Z)
  minor            升次版本后推送 (x.Y.0)
  major            升主版本后推送 (X.0.0)
  --check          仅运行本地发布前检查
  --dry-run        检查并预览将执行的操作，不推送
  --no-watch       推送后不等待 GitHub Actions 完成

选项可与 patch/minor/major 组合，顺序不限。

前置条件:
  Git: 工作区干净，已配置 origin 远程
  GitHub CLI: 已安装并登录 (gh auth login)，用于监控发布进度
  npm Trusted Publisher: 已在 npmjs.com 配置 publish.yml

本地不会执行 npm publish，发布由 GitHub Actions 通过 OIDC 完成。
详见 PUBLISHING-OIDC.md
EOF
}

get_package_version() {
	node -p "require('./package.json').version"
}

get_version_tag() {
	echo "v$(get_package_version)"
}

check_gh_auth() {
	command -v gh >/dev/null 2>&1 || die "未安装 GitHub CLI。请安装: https://cli.github.com/"
	gh auth status >/dev/null 2>&1 || die "GitHub CLI 未登录。请运行: gh auth login"
	log "GitHub CLI 已认证"
}

check_git_repo() {
	git rev-parse --git-dir >/dev/null 2>&1 || die "当前目录不是 git 仓库"
}

check_git_clean() {
	if [[ -n "$(git status --porcelain 2>/dev/null)" ]]; then
		die "工作区有未提交的更改，请先 commit 或 stash"
	fi
	log "git 工作区干净"
}

check_on_main_branch() {
	local branch
	branch="$(git branch --show-current 2>/dev/null || true)"
	if [[ -n "$branch" && "$branch" != "main" && "$branch" != "master" ]]; then
		warn "当前分支为 '$branch'，建议在 main 分支发布"
	fi
}

check_remote_configured() {
	git remote get-url origin >/dev/null 2>&1 || die "未配置 origin 远程"
	log "origin: $(git remote get-url origin)"
}

check_not_already_published() {
	local version published
	version=$(get_package_version)
	published=$(npm view "$PACKAGE" version 2>/dev/null || echo "")
	if [[ "$published" == "$version" ]]; then
		die "版本 $version 已在 npm 上发布。请先用 patch/minor/major 升版本"
	fi
	log "将发布新版本: $version（npm 当前最新: ${published:-无}）"
}

check_trusted_publisher_hint() {
	log "发布将由 GitHub Actions (${WORKFLOW_FILE}) 通过 OIDC 完成"
	log "请确认 npm 已配置 Trusted Publisher: ${GITHUB_REPO} / ${WORKFLOW_FILE}"
}

run_checks() {
	log "运行 typecheck..."
	npm run typecheck

	log "构建项目..."
	npm run build

	log "运行单元测试..."
	npm run test:unit

	log "验证 CLI..."
	node dist/cli/cli.js --help >/dev/null

	log "预览发布包..."
	npm pack --dry-run
}

bump_version() {
	local level="$1"
	log "升级版本 ($level)..."
	npm version "$level" -m "chore: release v%s"
}

ensure_local_tag() {
	local tag="$1"
	if git rev-parse "$tag" >/dev/null 2>&1; then
		log "本地 tag $tag 已存在"
		return
	fi
	log "创建本地 tag $tag..."
	git tag "$tag"
}

remote_has_tag() {
	local tag="$1" output
	output=$(git ls-remote --tags origin "refs/tags/${tag}" 2>&1) || return 2
	if echo "$output" | grep -q "refs/tags/${tag}"; then
		return 0
	fi
	return 1
}

push_git() {
	local tag="$1"
	log "推送 commit 到 origin..."
	retry_network "git push origin HEAD" git push origin HEAD \
		|| die "git push 失败（已重试 $NETWORK_MAX_ATTEMPTS 次）"

	if remote_has_tag "$tag"; then
		warn "远程 tag $tag 已存在，跳过 git push --tags"
		return
	fi

	log "推送 tag $tag 到 origin..."
	retry_network "git push origin $tag" git push origin "$tag" \
		|| die "git push tag $tag 失败（已重试 $NETWORK_MAX_ATTEMPTS 次）"
}

watch_workflow() {
	local tag="$1" run_id attempt=0
	log "等待 GitHub Actions 工作流启动..."
	while ((attempt < 30)); do
		run_id=$(gh run list \
			--repo "$GITHUB_REPO" \
			--workflow "$WORKFLOW_FILE" \
			--branch "$tag" \
			--limit 1 \
			--json databaseId,status,conclusion \
			--jq '.[0].databaseId // empty' 2>/dev/null || true)
		if [[ -n "$run_id" ]]; then
			break
		fi
		sleep 2
		((attempt += 1))
	done

	if [[ -z "$run_id" ]]; then
		warn "未找到对应的工作流运行，请手动查看:"
		warn "  gh run list --repo $GITHUB_REPO --workflow $WORKFLOW_FILE"
		return 0
	fi

	log "监控工作流运行 #$run_id ..."
	if gh run watch "$run_id" --repo "$GITHUB_REPO" --exit-status; then
		log "GitHub Actions 发布成功"
	else
		die "GitHub Actions 发布失败。查看日志: gh run view $run_id --repo $GITHUB_REPO --log-failed"
	fi
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
			echo "  npm:     https://www.npmjs.com/package/${PACKAGE#@}"
			echo "  GitHub:  https://github.com/${GITHUB_REPO}/releases/tag/v${version}"
			echo "  安装:    npm install -g $PACKAGE"
			return 0
		fi
		if [[ $attempt -lt $NETWORK_MAX_ATTEMPTS ]]; then
			log "等待 npm 注册表同步 ($attempt/$NETWORK_MAX_ATTEMPTS): npm=$published, 本地=$version"
			sleep "$NETWORK_RETRY_DELAY"
		fi
	done
	warn "npm 版本尚未同步到 $version，请稍后执行: npm view $PACKAGE version"
}

print_summary() {
	local tag="$1"
	echo ""
	echo "已触发 OIDC 发布:"
	echo "  标签:     $tag"
	echo "  工作流:   .github/workflows/${WORKFLOW_FILE}"
	echo "  操作面板: https://github.com/${GITHUB_REPO}/actions/workflows/${WORKFLOW_FILE}"
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
			--no-watch)
				WATCH_WORKFLOW=false
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
			run_checks
			log "检查通过"
			exit 0
			;;
		dry-run)
			check_git_repo
			check_git_clean
			run_checks
			if [[ -n "$bump" ]]; then
				log "[dry-run] 将执行: npm version $bump -m \"chore: release v%s\""
			else
				log "[dry-run] 将推送 tag: $(get_version_tag)"
			fi
			log "[dry-run] 将执行: git push origin HEAD && git push origin <tag>"
			log "[dry-run] GitHub Actions 将自动发布到 npm 并创建 Release"
			exit 0
			;;
		"")
			;;
		*)
			die "内部错误: 未知模式 $mode"
			;;
	esac

	check_git_repo
	check_git_clean
	check_on_main_branch
	check_remote_configured
	check_gh_auth
	check_trusted_publisher_hint
	run_checks

	if [[ "$bump" == "patch" || "$bump" == "minor" || "$bump" == "major" ]]; then
		bump_version "$bump"
	else
		check_not_already_published
	fi

	local tag
	tag=$(get_version_tag)
	ensure_local_tag "$tag"
	push_git "$tag"
	print_summary "$tag"

	if [[ "$WATCH_WORKFLOW" == "true" ]]; then
		watch_workflow "$tag"
		verify_publish
	else
		log "已跳过工作流监控 (--no-watch)"
	fi
}

main "$@"
