# BlockTurf：Vercel 网页 + Render 联机服务

当前游戏是原生 HTML/CSS/JS，`server.js` 使用常驻 Node.js 进程和 SSE 推送房间状态。Vercel 只负责静态前端，Render 负责联机 API。不需要改动游戏的房间协议。

## 1. 先部署 Render（联机服务器）

在 [Render Dashboard](https://dashboard.render.com/) 选择 **New → Blueprint**，授权并选择此 GitHub 仓库。Render 会读取根目录的 `render.yaml`，建立名为 `sti348-blockturf-online` 的 Node.js Web Service。

也可以手动选择 **New → Web Service**，配置：
- Runtime：Node
- Build Command：`npm install --omit=dev`
- Start Command：`npm start`
- Plan：Free（仅用于测试；长期运行建议付费常驻实例）
- Health Check Path：`/api/info`

部署后，记下 Render 分配的**实际 HTTPS 地址**（示例：`https://sti348-blockturf-online.onrender.com`，具体以控制台为准），打开：

```
https://<实际 Render 地址>/api/info
```

应返回包含 `"blokus":1` 的 JSON。Render 地址本身也可以直接打开游戏并远程联机。

## 2. 然后部署 Vercel（公开网页入口）

打开 [Vercel New Project](https://vercel.com/new)，从 GitHub 导入 `sti348/Blokus`。

- 选取已包含本部署配置的分支（合并 PR 后使用仓库默认分支）。
- Framework Preset：Other（`vercel.mjs` 也会自动设置）。
- Root Directory：仓库根目录。
- 不需要手动填写 Build Command 或 Output Directory；`vercel.mjs` 会使用 `node scripts/build-static.mjs` 生成 `dist/`。
- **部署之前**在 Environment Variables 添加：
  - Name：`BLOKUS_API_ORIGIN`
  - Value：步骤 1 Render 服务的真实 HTTPS 根地址（例如 `https://sti348-blockturf-online.onrender.com`，不含 `/api`）
  - Environment：Production 和 Preview 都选中（如需预览联机）。
- 点击 Deploy。未设置 `BLOKUS_API_ORIGIN` 时构建会主动报错，避免出现「网页已上线但联机不可用」的假成功。

Vercel 通过 `/api/:path*` 外部 rewrite 转发到 Render 的同路径 API，因此网页里的 `fetch('api/...')` 和 `EventSource('api/...')` 不需要更换地址，也无需让浏览器跨域访问 Render。

## 3. 联机验收

1. 在 Vercel 地址访问 `/api/info`，应返回 `"blokus":1`。
2. 第一台设备打开 Vercel 游戏网址，切到 Online，创建房间并获取 5 位房间码。
3. 第二台设备（另一浏览器或无痕窗口）打开**同一个 Vercel 网址**，输入房间码加入。
4. 两台设备分别选位置、开始对局并落一手棋，确认房间状态和走棋实时同步。特别检查 SSE 连接经过 Vercel 外部重写后能否持续推送。
5. 刷新其中一台浏览器确认能重新连接；再检查电脑回合以及离房等操作。

## 限制与运维

- **Render Free 不适合稳定生产联机**：闲置 15 分钟会休眠，唤醒可能约一分钟；重启、休眠或重新部署会丢失保存在 Node.js 内存中的房间。活跃 SSE 的服务端心跳不是传入请求，不能据此保证实例永远在线。
- 即使升级常驻实例，当前房间依旧只保存在内存；重新部署/进程重启仍会清空房间。要跨重启保留对局需再接数据库或 Redis。
- 多个后端实例需要共享房间存储与消息广播，当前应只用单实例。
- Vercel 与 Render 的 GitHub 自动部署应指向仓库默认分支。每次提交上线时，正在进行的游戏可能因后端重启而中断。
- 启用大模型转发 `LLM_PROXY=1` 会让后端代表客户端发起外部请求，建议在增加目标限制和滥用防护前维持默认关闭。
- 前端构建只发布 `index.html`、`css/` 和 `js/`，不会公开 `server.js`、测试代码或配置文件。

## 本地快速检查

```bash
npm test
node scripts/build-static.mjs
BLOKUS_API_ORIGIN=https://example.onrender.com node -e "import('./vercel.mjs').then(m => console.log(m.config.rewrites))"
npm start
```

查看 [Vercel rewrites](https://vercel.com/docs/routing/rewrites) 和 [Render free 服务限制](https://render.com/docs/free)。
