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
4. `git add -A; git commit -m "..."`，推送 GitHub（HTTPS 偶尔断连，可用 API 方式，见历史会话）
5. `npm publish --registry=https://registry.npmjs.org`（需要 npm 账号认证；若提示 2FA，需要 OTP 验证码或 bypass 2FA 的 token）
6. 等待 npmmirror 镜像同步（通常几分钟）
7. 更新 pi 钉住版本：`pi install npm:pi-provider-claude-code-hub@<新版本>`
8. 验证：`pi -p "Reply exactly OK."` 和 `pi --list-models | Select-String MyCCH`

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
