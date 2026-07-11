#!/usr/bin/env bash
# 通过 GitHub Actions 为 @hanqunfeng/claude-trace 触发 OIDC 发布。
# 本地只负责检查代码、提升版本和推送标签；真正的 npm publish 由
# .github/workflows/publish.yml 使用 npm Trusted Publishing（OIDC）完成。
#
# 用法:
#   ./scripts/publish-oidc.sh              推送当前版本标签（不提升版本）
#   ./scripts/publish-oidc.sh patch        提升补丁版本并推送 commit + 标签
#   ./scripts/publish-oidc.sh minor        提升次版本并推送 commit + 标签
#   ./scripts/publish-oidc.sh major        提升主版本并推送 commit + 标签
#   ./scripts/publish-oidc.sh --check      只执行本地检查
#   ./scripts/publish-oidc.sh --dry-run    检查并显示计划操作
#   ./scripts/publish-oidc.sh --no-watch   推送后不等待 Actions
#
# 详细说明见 doc/publishing/oidc.md。

# 遇到命令失败、未定义变量或管道中任一命令失败时立即退出。
set -euo pipefail

# 无论从哪个目录调用脚本，都切换到仓库根目录执行 npm、git 和 gh 命令。
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# npm 包名、GitHub 仓库和负责发布的工作流文件名。
PACKAGE="@hanqunfeng/claude-trace"
GITHUB_REPO="hanqunfeng/claude-trace"
WORKFLOW_FILE="publish.yml"
# 网络查询和推送统一最多尝试 10 次，每次间隔 3 秒。
NETWORK_MAX_ATTEMPTS=10
NETWORK_RETRY_DELAY=3
# 默认等待工作流结束；--no-watch 会把该开关改为 false。
WATCH_WORKFLOW=true

# 输出普通进度信息，并使用统一前缀方便阅读日志。
log() { echo "==> $*"; }

# 将致命错误写入标准错误并立即终止脚本。
die() { echo "错误: $*" >&2; exit 1; }

# 将非致命警告写入标准错误，但允许脚本继续执行。
warn() { echo "警告: $*" >&2; }

# 执行可能因网络波动失败的命令，并按统一次数和间隔进行重试。
# 第一个参数是日志中的操作说明，剩余参数组成真正要执行的命令。
# 命令成功时返回 0；耗尽重试次数后返回 1。
retry_network() {
	local desc="$1"
	# 移除说明参数，使 "$@" 只保留命令及其参数。
	shift
	local attempt
	for ((attempt = 1; attempt <= NETWORK_MAX_ATTEMPTS; attempt++)); do
		# 使用 "$@" 保留每个参数的原始边界，避免空格导致参数被错误拆分。
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

# 输出命令行用法、选项组合方式和 OIDC 发布的前置条件。
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
详见 doc/publishing/oidc.md
EOF
}

# 从 package.json 读取当前版本号，例如 3.0.12。
get_package_version() {
	node -p "require('./package.json').version"
}

# 将 package.json 版本转换成 Git 标签格式，例如 3.0.12 转为 v3.0.12。
get_version_tag() {
	echo "v$(get_package_version)"
}

# 检查 GitHub CLI 是否已安装并登录。
# gh 用于查找和监控由标签触发的 GitHub Actions 工作流。
check_gh_auth() {
	command -v gh >/dev/null 2>&1 || die "未安装 GitHub CLI。请安装: https://cli.github.com/"
	gh auth status >/dev/null 2>&1 || die "GitHub CLI 未登录。请运行: gh auth login"
	log "GitHub CLI 已认证"
}

# 确认当前目录属于 Git 仓库；OIDC 流程依赖 commit 和标签触发工作流。
check_git_repo() {
	git rev-parse --git-dir >/dev/null 2>&1 || die "当前目录不是 git 仓库"
}

# 确认 Git 工作区没有已修改、已暂存或未跟踪的文件。
# 这保证版本提交、标签和 Actions 构建的内容与本地检查结果一致。
check_git_clean() {
	if [[ -n "$(git status --porcelain 2>/dev/null)" ]]; then
		die "工作区有未提交的更改，请先 commit 或 stash"
	fi
	log "git 工作区干净"
}

# 检查当前分支是否为 main/master。
# 从其他分支发布只给出警告而不终止，保留特殊情况下的发布能力。
check_on_main_branch() {
	local branch
	# detached HEAD 时分支名为空，不触发非主分支警告。
	branch="$(git branch --show-current 2>/dev/null || true)"
	if [[ -n "$branch" && "$branch" != "main" && "$branch" != "master" ]]; then
		warn "当前分支为 '$branch'，建议在 main 分支发布"
	fi
}

# 确认 origin 远程存在，并输出实际远程地址供发布者复核。
check_remote_configured() {
	git remote get-url origin >/dev/null 2>&1 || die "未配置 origin 远程"
	log "origin: $(git remote get-url origin)"
}

# 将 package.json 版本与 npm 当前 latest 版本比较，阻止明显的重复发布。
# 查询失败时按“未发布”处理，GitHub Actions 中的 npm publish 仍会校验版本唯一性。
check_not_already_published() {
	local version published
	version=$(get_package_version)
	published=$(npm view "$PACKAGE" version 2>/dev/null || echo "")
	if [[ "$published" == "$version" ]]; then
		die "版本 $version 已在 npm 上发布。请先用 patch/minor/major 升版本"
	fi
	log "将发布新版本: $version（npm 当前最新: ${published:-无}）"
}

# 输出 Trusted Publisher 配置提醒。
# npm 网站上的仓库和工作流名称必须与这里完全一致，否则 OIDC 认证会失败。
check_trusted_publisher_hint() {
	log "发布将由 GitHub Actions (${WORKFLOW_FILE}) 通过 OIDC 完成"
	log "请确认 npm 已配置 Trusted Publisher: ${GITHUB_REPO} / ${WORKFLOW_FILE}"
}

# 依次执行类型检查、构建、单元测试、CLI 启动验证和 npm 包内容预览。
# 任一步失败都会因为 set -e 立即退出，阻止标签被推送。
run_checks() {
	log "运行 typecheck..."
	npm run typecheck

	log "构建项目..."
	# 生成 dist 后端文件、复制拦截器脚本，并构建 frontend/dist。
	npm run build

	log "运行单元测试..."
	npm run test:unit

	log "验证 CLI..."
	# 运行最轻量的 --help，确认主 CLI 构建产物可以正常加载。
	node dist/cli/cli.js --help >/dev/null

	log "预览发布包..."
	# 只展示最终 npm 包内容，不执行真实发布。
	npm pack --dry-run
}

# 使用 npm version 按 patch/minor/major 提升版本。
# npm version 会修改 package.json/package-lock.json，并创建 release commit 和 vX.Y.Z 标签。
bump_version() {
	local level="$1"
	log "升级版本 ($level)..."
	npm version "$level" -m "chore: release v%s"
}

# 确保当前版本标签存在于本地。
# npm version 通常已经创建标签；不升版本发布时由此函数补建。
ensure_local_tag() {
	local tag="$1"
	if git rev-parse "$tag" >/dev/null 2>&1; then
		log "本地 tag $tag 已存在"
		return
	fi
	log "创建本地 tag $tag..."
	git tag "$tag"
}

# 查询指定标签是否已存在于 origin。
# 返回状态：0=标签存在，1=标签不存在，2=远程查询失败。
remote_has_tag() {
	local tag="$1" output
	# 精确查询 refs/tags/<tag>，避免相似标签名称造成误判。
	output=$(git ls-remote --tags origin "refs/tags/${tag}" 2>&1) || return 2
	if echo "$output" | grep -q "refs/tags/${tag}"; then
		return 0
	fi
	return 1
}

# 先推送当前 release commit，再推送触发 publish.yml 的版本标签。
# commit 和标签分别推送，确保工作流检出的标签始终指向远端已存在的提交。
push_git() {
	local tag="$1"
	log "推送 commit 到 origin..."
	retry_network "git push origin HEAD" git push origin HEAD \
		|| die "git push 失败（已重试 $NETWORK_MAX_ATTEMPTS 次）"

	# 远端已有同名标签时不重复推送，避免 Git 拒绝并中断后续监控。
	if remote_has_tag "$tag"; then
		warn "远程 tag $tag 已存在，跳过 git push --tags"
		return
	fi

	log "推送 tag $tag 到 origin..."
	retry_network "git push origin $tag" git push origin "$tag" \
		|| die "git push tag $tag 失败（已重试 $NETWORK_MAX_ATTEMPTS 次）"
}

# 等待标签对应的 publish.yml 工作流出现，并持续监控到运行结束。
# 找不到运行时仅警告并返回；找到后工作流失败会使本地脚本以错误状态退出。
watch_workflow() {
	local tag="$1" run_id attempt=0
	log "等待 GitHub Actions 工作流启动..."
	# GitHub 创建工作流记录可能有延迟，因此最多查询 30 次、每次等待 2 秒。
	while ((attempt < 30)); do
		# --branch 对标签运行同样可按标签名筛选；这里只取最新一条运行的数据库 ID。
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
	# --exit-status 使 gh 的退出状态与工作流结论一致，便于可靠判断发布是否成功。
	if gh run watch "$run_id" --repo "$GITHUB_REPO" --exit-status; then
		log "GitHub Actions 发布成功"
	else
		die "GitHub Actions 发布失败。查看日志: gh run view $run_id --repo $GITHUB_REPO --log-failed"
	fi
}

# 轮询 npm 注册表，确认 Actions 发布的 latest 版本已同步为本地版本。
# 注册表延迟不会让脚本失败：耗尽重试后只警告，便于稍后人工复查。
verify_publish() {
	local version published attempt
	version=$(get_package_version)
	log "验证 npm 上的版本..."
	for ((attempt = 1; attempt <= NETWORK_MAX_ATTEMPTS; attempt++)); do
		# prefer-online 尽量绕过本地 npm 缓存，查询注册表的最新结果。
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

# 输出已触发发布的标签、工作流文件和 GitHub Actions 页面地址。
print_summary() {
	local tag="$1"
	echo ""
	echo "已触发 OIDC 发布:"
	echo "  标签:     $tag"
	echo "  工作流:   .github/workflows/${WORKFLOW_FILE}"
	echo "  操作面板: https://github.com/${GITHUB_REPO}/actions/workflows/${WORKFLOW_FILE}"
}

# 解析参数并编排完整的 OIDC 发布流程。
# check/dry-run 模式不修改 Git；正式模式依次检查、可选升版、推送标签并监控 Actions。
main() {
	local mode="" bump=""

	# 参数顺序不限，但只允许一个版本提升级别和一个运行模式。
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

	# check 和 dry-run 在此提前结束，不创建 commit、标签或远程工作流。
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
		# 升版时 npm version 同时创建 release commit 和本地标签。
		bump_version "$bump"
	else
		# 不升版时确认当前版本没有作为 npm latest 发布过。
		check_not_already_published
	fi

	local tag
	tag=$(get_version_tag)
	ensure_local_tag "$tag"
	# 推送标签会触发 .github/workflows/publish.yml 执行真正的 OIDC 发布。
	push_git "$tag"
	print_summary "$tag"

	if [[ "$WATCH_WORKFLOW" == "true" ]]; then
		# 默认等待 Actions 完成，再从 npm 注册表确认公开版本。
		watch_workflow "$tag"
		verify_publish
	else
		log "已跳过工作流监控 (--no-watch)"
	fi
}

# 将用户传入的全部参数原样交给主函数。
main "$@"
