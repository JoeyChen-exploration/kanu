# 卡奴（Kanu）

跑在 Discord 里的卡牌经营小游戏（Discord Activity）。玩家在空间站下层区开一间卡牌店：抽卡进货、鉴定真伪、卖给 NPC 顾客，凑每周上涨的摊位费，最终买下整间店。赛季内赚到的信用点可以单向兑换成旺财（oceania-bot）的服务器金币。

> 状态：设计阶段，代码还没开工（下一步是 SRS 里程碑 M0：跑通登录）。

## 文档

| 文件 | 内容 |
| --- | --- |
| [docs/DESIGN.md](docs/DESIGN.md) | 游戏设计：规则和全部数值，规则以它为准 |
| [docs/SRS.md](docs/SRS.md) | 需求规格：架构、需求编号（FR-xxx）、接口、数据表、里程碑 M0–M7 |
| [docs/OWNER-QUESTIONS.md](docs/OWNER-QUESTIONS.md) | 发给服主的说明和待确认问题（金币兑换、旺财接口、部署、Discord 应用） |
| [CLAUDE.md](CLAUDE.md) | 给协作者和 AI 助手的规矩（服务器权威、隐藏属性不出服务器、数值只放 balance.ts 等） |

## 系统组成

```
Discord 客户端 ──iframe──> Discord 代理 (<client_id>.discordsays.com)
                               │ URL Mapping
                               ▼
                         cloudflared 隧道
                               ▼
                 卡奴服务器 (Node.js 22 + Fastify + SQLite)
                   │                        │
                   │ /wallet/* + Bearer      │ Bot REST：播报、私信
                   ▼                        ▼
       旺财 oceania-bot control-server   Discord API
       （127.0.0.1，同一台机器）
```

- **卡奴 Activity**（`packages/client`）：Vite + React + `@discord/embedded-app-sdk`，只负责显示和发请求。
- **卡奴服务器**（`packages/server`）：持有全部游戏状态、随机数和规则；Discord 登录、定时任务、频道通知。
- **旺财钱包接口**：在 oceania-bot 加 `POST /wallet/cardshop-redeem`，以 PR 提交到 oceania-bot 仓库（见 SRS 6.3、6.4）。

## 计划中的目录结构

```
kanu/
├── docs/                 # DESIGN.md、SRS.md
├── packages/
│   ├── shared/           # balance.ts（全部数值）、types.ts（前后端共用类型）
│   ├── server/           # auth / game（纯函数）/ db / routes / jobs / wallet / notify
│   └── client/           # discord.ts、api.ts、pages/
├── scripts/sim.ts        # 经济模拟
└── data/                 # SQLite 和备份（不进 git）
```

## 本地开发

需要 Node.js 22+。三个仓库放在同一个父目录下：

```
父目录/
├── kanu/             # 本仓库
├── oceania-bot/      # 旺财（BobZhu99/oceania-bot）
└── wangcai-cards/    # 旺财牌局，Activity 登录和钱包对接可以参考
```

```bash
cp .env.example .env   # 填 Discord 应用、会话密钥、旺财接口等，见 SRS 第 10 节
npm install
npm run dev            # 前端 + 服务器 + 隧道（脚手架搭好后可用）
npm test               # 单元测试
npm run sim            # 经济模拟，改了 balance.ts 必跑
```

联调金币兑换时，用旺财的 `node scripts/wallet-flow-drill.mjs --serve` 起一个本地 control-server，不要连生产钱包。卡奴不 import 旺财的任何代码，只通过 HTTP 调 `/wallet/*`。

## 路线图

1. **MVP**：正规卡包、一个 53 张的系列、三种鉴定、四类 NPC 顾客、房租与破产、金币兑换、管理工具。
2. **风险与抓捕**：黑市卡包、卡贩、便衣、治安巡查、信誉、新闻事件。
3. **多人**：担保交易、集市、全服市场价、排行榜、完整 8 周赛季。
4. **深度**：图鉴套装、派系、合成、执照、第二个系列。

详见 DESIGN 第 12 节和 SRS 第 9 节。
