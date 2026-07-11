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

# 遇到命令失败、未定义变量或管道中任一命令失败时立即退出，防止带着错误状态继续发布。
set -euo pipefail

# 无论从哪个目录调用脚本，都切换到仓库根目录执行后续 npm 和 git 命令。
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# 发布账号、包名及运行时选项。
NPM_USER="hanqunfeng"
PACKAGE="@hanqunfeng/claude-trace"
SKIP_GITHUB=false
GITHUB_NOTES_FILE=""
# 所有可重试网络操作统一最多尝试 10 次，每次间隔 3 秒。
NETWORK_MAX_ATTEMPTS=10
NETWORK_RETRY_DELAY=3

# 输出普通进度信息，并使用统一前缀方便阅读日志。
log() { echo "==> $*"; }

# 将致命错误写入标准错误并立即终止脚本。
die() { echo "错误: $*" >&2; exit 1; }

# 将非致命警告写入标准错误，但允许脚本继续执行。
warn() { echo "警告: $*" >&2; }

# 执行可能因网络波动失败的命令，并按统一次数和间隔进行重试。
# 第一个参数是用于日志展示的操作说明，剩余参数组成要执行的命令。
# 命令成功时返回 0；耗尽重试次数后返回 1，由调用方决定是否终止发布。
retry_network() {
	local desc="$1"
	# 移除说明参数，使 "$@" 只保留真正要执行的命令及其参数。
	shift
	local attempt
	for ((attempt = 1; attempt <= NETWORK_MAX_ATTEMPTS; attempt++)); do
		# 使用 "$@" 保留每个参数的原始边界，避免路径或参数中的空格被重新拆分。
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

# 输出命令行用法、可组合选项和发布所需的认证条件。
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

详见 doc/publishing/access-token.md
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

# 从 package.json 的 repository.url 中解析 owner/repo。
# URL 无法识别时回退到当前项目的固定仓库 hanqunfeng/claude-trace。
resolve_github_repo() {
	node -p "
		const u = require('./package.json').repository?.url || '';
		const m = u.match(/github\\.com[:\\/](.+?)\\.git\$/) || u.match(/github\\.com[:\\/](.+)\$/);
		m ? m[1] : 'hanqunfeng/claude-trace';
	"
}

# 验证本机 npm Access Token 是否有效，并确认当前账号是预期的发布者。
# npm whoami 失败或账号不匹配时会终止脚本，避免使用错误账号发布。
check_npm_auth() {
	local user
	# 隐藏 npm 自身的认证错误，改为输出包含修复命令的项目提示。
	user=$(npm whoami 2>/dev/null) || die "npm 未认证。请先配置 Token:
  npm config set //registry.npmjs.org/:_authToken=你的token
详见 doc/publishing/access-token.md"
	[[ "$user" == "$NPM_USER" ]] || die "当前 npm 用户为 '$user'，需要 '$NPM_USER'"
	log "npm 用户: $user"
}

# 检查 GitHub CLI 是否已安装并登录，用于查询和创建 GitHub Release。
check_gh_auth() {
	command -v gh >/dev/null 2>&1 || die "未安装 GitHub CLI。请安装: https://cli.github.com/"
	gh auth status >/dev/null 2>&1 || die "GitHub CLI 未登录。请运行: gh auth login"
	log "GitHub CLI 已认证"
}

# 确认 Git 工作区没有已修改、已暂存或未跟踪的文件。
# 版本提交和标签必须基于干净状态，避免遗漏改动或发布不可复现的内容。
check_git_clean() {
	if [[ -n "$(git status --porcelain 2>/dev/null)" ]]; then
		die "工作区有未提交的更改，请先 commit 或 stash"
	fi
	log "git 工作区干净"
}

# 将 package.json 版本与 npm 当前 latest 版本比较，阻止明显的重复发布。
# npm 注册表查询失败时按“尚未发布”处理，真正发布时仍会由 npm 再次校验版本唯一性。
check_not_already_published() {
	local version published
	version=$(get_package_version)
	published=$(npm view "$PACKAGE" version 2>/dev/null || echo "")
	if [[ "$published" == "$version" ]]; then
		die "版本 $version 已在 npm 上发布。请先用 patch/minor/major 升版本，或手动修改 package.json"
	fi
	log "将发布新版本: $version（npm 当前最新: ${published:-无}）"
}

# 依次执行类型检查、完整构建、CLI 启动验证和 npm 包内容预览。
# 任一步失败都会因为 set -e 立即终止，保证不发布未通过检查的代码。
run_checks() {
	log "运行 typecheck..."
	npm run typecheck

	log "构建项目..."
	# 生成 dist 后端文件、复制拦截器脚本，并构建 frontend/dist。
	npm run build

	log "验证 CLI..."
	# 运行最轻量的 --help，确认主 CLI 构建产物可被 Node.js 加载。
	node dist/cli/cli.js --help >/dev/null

	log "预览发布包..."
	# 只展示最终包内容，不生成用于发布的 tarball。
	npm pack --dry-run
}

# 使用 npm version 按 patch/minor/major 提升版本。
# npm version 会同步修改 package.json/package-lock.json，并创建 release commit 和 vX.Y.Z 标签。
bump_version() {
	local level="$1"
	log "升级版本 ($level)..."
	npm version "$level" -m "chore: release v%s"
}

# 将当前 release commit 和本地所有标签推送到 origin。
# 非 Git 仓库中调用时直接跳过；网络失败会按统一策略重试并最终终止发布。
push_git() {
	if ! git rev-parse --git-dir >/dev/null 2>&1; then
		log "非 git 仓库，跳过 push"
		return
	fi
	log "推送到远程..."
	# 先推送当前分支的 HEAD，确保远端已有标签所指向的 release commit。
	retry_network "git push origin HEAD" git push origin HEAD \
		|| die "git push 失败（已重试 $NETWORK_MAX_ATTEMPTS 次）"
	# npm version 创建的版本标签随后推送；该命令也会推送其他尚未上传的本地标签。
	retry_network "git push origin --tags" git push origin --tags \
		|| die "git push --tags 失败（已重试 $NETWORK_MAX_ATTEMPTS 次）"
}

# 使用 ~/.npmrc 中的 Access Token 将 scoped package 公开发布到 npm。
# npm publish 还会自动执行 package.json 中配置的 prepublishOnly 生命周期脚本。
do_publish() {
	log "发布到 npm..."
	npm publish --access public
}

# 轮询 npm 注册表，确认 latest 版本已经同步为本地 package.json 版本。
# 验证成功时输出包页面和安装命令；耗尽重试次数时终止脚本。
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

# 查询指定标签是否已存在于 origin。
# 返回状态：0=标签存在，1=标签不存在，2=远程查询失败。
remote_has_tag() {
	local tag="$1" output
	# 精确查询 refs/tags/<tag>，避免相似标签名称产生误判。
	output=$(git ls-remote --tags origin "refs/tags/${tag}" 2>&1) || return 2
	if echo "$output" | grep -q "refs/tags/${tag}"; then
		return 0
	fi
	return 1
}

# 查询指定仓库中是否已有对应标签的 GitHub Release。
# 返回状态：0=Release 存在，1=明确不存在，2=认证、网络等其他查询错误。
gh_release_exists() {
	local tag="$1" repo="$2" err rc=0
	# 保留 gh 的错误文本，用于区分“确实不存在”和“查询过程失败”。
	err=$(gh release view "$tag" --repo "$repo" 2>&1) || rc=$?
	if [[ $rc -eq 0 ]]; then
		return 0
	fi
	if echo "$err" | grep -qiE 'release not found|could not find'; then
		return 1
	fi
	return 2
}

# 确保版本标签同时存在于本地和 origin，供 GitHub Release 绑定。
# 远程查询失败时重试；远端缺少标签时推送当前本地标签。
ensure_git_tag() {
	local tag="$1" attempt remote_status
	# npm version 通常已经创建标签；不升版本发布时则需要在这里补建。
	if git rev-parse "$tag" >/dev/null 2>&1; then
		log "git tag $tag 已存在"
	else
		log "创建 git tag $tag..."
		git tag "$tag"
	fi
	for ((attempt = 1; attempt <= NETWORK_MAX_ATTEMPTS; attempt++)); do
		# 读取远程标签状态，供下面的存在、不存在和查询失败分支处理。
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

# 生成 GitHub Release 的 Markdown 说明并写入 notes_file。
# 说明始终包含安装命令；正文优先使用 --github-notes 文件，否则调用 GitHub API 自动生成，
# API 持续失败时再回退为上一个标签以来的本地 Git 提交列表。
build_release_notes() {
	local tag="$1" repo="$2" notes_file="$3"
	# 整个命令组统一重定向，确保最终得到一个完整的 Release notes 文件。
	{
		echo "## Install"
		echo '```bash'
		echo "npm install -g $PACKAGE"
		echo '```'
		echo ""
		if [[ -n "$GITHUB_NOTES_FILE" ]]; then
			# 用户显式提供说明时保持文件内容原样追加。
			[[ -f "$GITHUB_NOTES_FILE" ]] || die "Release 说明文件不存在: $GITHUB_NOTES_FILE"
			cat "$GITHUB_NOTES_FILE"
		else
			local generated prev_tag attempt
			generated=""
			for ((attempt = 1; attempt <= NETWORK_MAX_ATTEMPTS; attempt++)); do
				# GitHub 根据当前标签和 HEAD 自动整理 PR、贡献者及变更记录。
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
				# API 不可用时，优先列出上一个版本标签之后的提交。
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

# 为当前 package.json 版本创建 GitHub Release。
# 该步骤支持显式跳过和幂等重试；Release 创建失败只告警，不把已经成功的 npm 发布判为失败。
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

	# GitHub Release 必须绑定远程标签，因此先确保标签已上传。
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

	# 临时文件只用于把生成的 Markdown 交给 gh CLI，成功或失败后都会删除。
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

# 解析命令行参数并编排完整的 Token 发布流程。
# check/dry-run 模式只执行验证；正式模式依次检查、可选升版、推送、npm 发布和创建 Release。
main() {
	local mode="" bump=""

	# 参数顺序不限，但只允许选择一种版本提升级别和一种运行模式。
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

	# 只检查和 dry-run 在此提前结束，不进入任何真实发布操作。
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
		# 升版模式由 npm version 创建 commit/tag，然后先同步到远端。
		bump_version "$bump"
		push_git
	else
		# 不升版时仅确认当前版本尚未作为 latest 发布。
		check_not_already_published
	fi

	# npm 发布成功并完成注册表确认后，再补建 GitHub Release。
	do_publish
	verify_publish
	create_github_release
}

# 将用户传入的全部参数原样交给主函数。
main "$@"
