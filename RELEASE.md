# 开发与发布指南（RELEASE NOTES）

## 项目概览

- 名称：`pi-provider-claude-code-hub`
- 源码目录：`E:\pi extension\pi-provider-claude-code-hub`
- GitHub：https://github.com/ChinkInArmor/pi-provider-claude-code-hub （main）
- npm：https://www.npmjs.com/package/pi-provider-claude-code-hub
- pi 安装来源：`npm:pi-provider-claude-code-hub@0.1.0`（settings.json 中**钉住版本**，发布新版本后需手动更新）

## 常用命令

```powershell
npm test                 # 单元测试（node --test，当前 12 个）
npm run typecheck        # tsc --noEmit
npm pack --dry-run       # 检查发布内容（files: index.ts / README.md / README.en.md / LICENSE）
```

## 发布流程

1. 修改 `index.ts` / `index.test.ts` / README
2. `npm test` 和 `npm run typecheck` 全部通过
3. `npm version patch`（或 minor）——**必须升版本**，npm 拒绝重复发布同一版本
4. `git add -A; git commit -m "..."`，然后推送提交和 tag：`git push origin main --tags`（HTTPS 偶尔断连，失败可用 API 方式，见历史会话）
5. 推 tag 触发 `.github/workflows/publish.yml`，GitHub Actions 自动完成双轨发布（npmjs + GitHub Packages），无需手动登录 npm
6. 等待 Actions 运行完成 + npmmirror 镜像同步（通常几分钟）
7. 更新 pi 钉住版本：`pi install npm:pi-provider-claude-code-hub@<新版本>`
8. 验证：`pi -p "Reply exactly OK."` 和 `pi --list-models | Select-String MyCCH`

## 双轨发布（GitHub Actions）

- 发布由 `.github/workflows/publish.yml` 完成：推送 `v*` tag（`npm version patch` 会自动打 tag）时，依次发布到：
  1. npmjs.com（主，供 `pi install npm:pi-provider-claude-code-hub` 使用，行为不变）
  2. GitHub Packages（镜像，包名 `@ChinkInArmor/pi-provider-claude-code-hub`，自动关联本仓库）
- 首次配置：GitHub 仓库 Settings → Secrets and variables → Actions 添加 `NPM_TOKEN`（npmjs.com Access Tokens 中 bypass 2FA 的 publish token）；GitHub Packages 用自动注入的 `GITHUB_TOKEN`，无需配置
- 发布失败处理：到仓库 Actions 页面看日志。若 npmjs 已发布成功但 GitHub Packages 失败，**不要直接重跑**（npmjs 会因版本重复报错），应 `npm version patch` 升版本后推新 tag，或用 PAT 手动补发 `npm publish --registry=https://npm.pkg.github.com`

## 真实运行环境（谨慎，不要随意修改）

- 扩展配置：`C:\Users\HP\.pi\agent\extensions\provider-claude-code-hub.json`
  （网关地址 baseUrl、modelOverrides、modelAliases、splitProtocols）
- 凭据：`C:\Users\HP\.pi\agent\auth.json` 中 `MyCCH`（API key，**敏感**）
- 模型缓存：`C:\Users\HP\.pi\agent\models-store.json`（`MyCCH` 键）
- pi 已安装的 npm 副本：`C:\Users\HP\.pi\agent\npm\node_modules\pi-provider-claude-code-hub`（由 pi 管理，不要手改）

## 本地验证新代码的推荐方式

- 单元测试已覆盖 URL 归一化、模型列表解析、元数据匹配、缓存合并、overrides 等核心逻辑
- **避免同时加载 npm 版和本地版**（会重复注册 `MyCCH` Provider 导致冲突）
- 需要真实网关验证时：用 node 脚本直接 `import` 本地 `index.ts`，构造 mock pi API + `FileModelsStore`，调用 `refreshModels`（参考历史会话的 harness 脚本方式）
- 完整端到端验证：临时把 settings.json 的包源换成本地路径，测完再换回 npm 钉住版本

## 安全提醒

- 不要向仓库提交 `auth.json`、真实网关地址、API key
- README 中的 `hub.example.com` 只是占位示例
- npm token 一旦泄露，立即在 npmjs.com → Access Tokens 删除

## 已知网络环境

- `github.com:443`（HTTPS）经常断连，`api.github.com` 和 `ssh.github.com:443` 相对稳定
- npm 配置 registry 为 npmmirror 镜像，发布必须显式 `--registry=https://registry.npmjs.org`
