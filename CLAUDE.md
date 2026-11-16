# 卡奴（Kanu）

Discord Activity 卡牌经营游戏：玩家在 Discord 里打开网页小程序，抽卡进货、鉴定真伪、卖给 NPC 顾客、交每周上涨的摊位费。信用点可以单向兑换成旺财（oceania-bot）的服务器金币。

## 先读这两份

- `docs/DESIGN.md`：游戏规则和全部数值，是规则的唯一依据。
- `docs/SRS.md`：架构、需求编号（FR-xxx）、接口、数据表、里程碑 M0–M7。

做任何功能前，先在 SRS 里找到对应的需求编号和里程碑；实现完在提交说明里写上编号。

## 技术栈

- npm workspaces：`packages/shared`（数值和类型）、`packages/server`（Node.js 22 + Fastify + better-sqlite3）、`packages/client`（Vite + React + `@discord/embedded-app-sdk`）。
- TypeScript，测试用 Vitest。
- 部署：和旺财同一台机器，pm2 + cloudflared 隧道。

## 必须遵守

1. **服务器权威**：随机数、价格、规则判断全在服务器。前端只显示和发请求。
2. **隐藏属性不出服务器**：真伪、真实品相、来源、顾客心理价位、便衣身份，永远不能出现在给玩家的响应里（包括错误信息和调试字段）。改了任何返回卡牌或顾客的接口，都要有测试断言这一点。
3. **数值只放 `packages/shared/src/balance.ts`**：不在别处写死数字。改了数值要跑 `npm run sim`，把结果写进提交说明。
4. **游戏逻辑是纯函数**：`packages/server/src/game/` 不碰数据库、不读时钟、不调 `Math.random`，随机源和时间都由调用方传入（学旺财 `wallet-core.js` 的写法）。
5. **写操作都带幂等 key**，信用点和卡牌的变动在一个数据库事务里完成，并写 events_log。
6. **"每天"按悉尼日**（Australia/Sydney），和旺财钱包一致。
7. **金币只能由旺财写**：只通过 `/wallet/*` 接口，见 SRS 6.3。兑换失败只有在旺财明确拒绝时才退信用点。不要 import 旺财（oceania-bot）的任何代码；需要改旺财时，改动提交到 oceania-bot 仓库，和卡奴的提交分开（SRS 6.4）。
8. 前端只请求同源相对路径（`/api/...`）和本服务器的静态资源；Activity 在 Discord 代理后面，外部地址要先配 URL Mapping。
9. 界面全中文，先按手机竖屏 360 px 宽设计。

## 分支和提交

- **不直接改 main**：任何改动先开分支，命名 `<类型>/<简短描述>`，类型用 `feat`（功能）、`fix`（修 bug）、`docs`（文档）、`chore`（配置、脚手架）、`balance`（只改数值），如 `feat/pack-open`、`docs/tech-tree`。
- **一个分支只做一件事**，做完推分支、用 `gh pr create` 开 PR，合进 main 后删分支。不推 main。
- **提交说明**：第一行写清做了什么，正文写 SRS 需求编号（如 `FR-PACK-4`）；改了 balance.ts 附 `npm run sim` 的结果。
- **PR 描述**：做了什么、对应的需求编号和里程碑、跑了哪些测试（`npm test`，碰数值的加 `npm run sim`）、有没有碰金币或隐藏属性。
- **只改 kanu**：旁边的 oceania-bot 和 wangcai-cards 只读。旺财侧的改动到 oceania-bot 仓库单独走分支和 PR（SRS 6.4）。
- 不提交 `.env` 和 `data/`。
- 上面几条由 `.claude/hooks/guard.mjs` 自动拦截：在 main 上改文件或 commit、推 main、写兄弟仓库、提交 `.env` / `data/`。

## 常用命令

- `npm run dev`：本地开发，同时起服务器（4790）和 Vite 前端（5173）
- `npm run tunnel`：另开一个终端，cloudflared 把 5173 暴露成 https 地址，填进 Developer Portal 的 URL Mapping
- `npm test`：单元测试（vitest；Windows 小写盘符的问题由 scripts/test.mjs 处理）
- `npm run typecheck`：三个包的类型检查
- `npm run build`：构建前端到 packages/client/dist，服务器启动时如果有就托管它
- `npm run sim`：经济模拟（M1 加）
