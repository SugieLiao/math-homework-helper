# 数学家（math-helper）

> 产品名「数学家」。Cloudflare 上的 Worker / D1 / R2 资源名仍是 `math-helper*`，改名会断掉 `kids.liaohao.cc/math` 的路由，所以技术侧保持不变。

拍照批改小学数学作业 + 举一反三练习系统。线上地址：`https://kids.liaohao.cc/math/`

## 它能做什么

1. **拍照交作业** —— 手机拍下作业，自动逐题识别题干和孩子的作答，并把每道题的**作答区域裁剪成图片**保存。
   一次可以拍多页（最多 8 页），**按题目所在的页去裁**（第 2 页的题就从第 2 页裁），不会串页。
   万一题目和图对不上，作业详情页的「🖼 重裁题目截图」可以按库里记的位置重新裁一遍，不用重批。
2. **判对错** —— 逐题给出 ✅/❌，错题给出**错因分析**和**正确推导过程**。
3. **举一反三** —— 任意一道题（无论对错）都能一键生成 6 道同类题，家长勾选要练的题。
4. **打印练习** —— 打印页留足**书写空白区**，带题号（母题 X-变式 N），方便回批时定位。
5. **拍照回批** —— 从母题页的「拍照交答案」上传，系统自动识别是哪道变式题、判对错。
6. **掌握度归集** —— 母题页实时显示：是否过关、举一反三选了几题 / 做了几题 / 做对几题。
   - 母题做错 → 需要**另外做对 2 道**同类题才算过关；
   - 母题做对 → 显示已过关，但若变式题做错，变成「母题过关 · 举一反三未过关」，同样要**再做对 2 道**才完全过关。
7. **人工改判** —— 母题和每一道举一反三题都可以手动改判对错 / 重置状态，AI 说了不算，家长说了算。
   作业详情页还支持**勾一批题批量判对 / 批量判错**（只翻对错，不用补错因和正确答案，题干原文也不动）。
   另外**只有错题才显示作答截图**，做对的题不再占版面。
8. **待组卷 → 组卷** —— 在作业详情页 / 错题本里勾题点「加入组卷」，在母题页的「举一反三」里勾变式题点「＋ 加入组卷」，
   都先攒进「待组卷」（母题和变式题可以混着攒）；到「组卷」页勾好题目，点「组卷」弹出设置弹窗：可选 **只用原题** 或
   **举一反三**（每道题出 1~5 道，可勾选是否带上原题），再定顺序 / 乱序，选教材（必选）、单元、课文（可选），确认后一次出卷。
   卷子出完立刻变成一份「未作答」的作业，同时出现在组卷板块和作业列表里；打印、交答案、批改都在卷子页完成，不再有单独的打印入口。

## 技术栈

- **前端**：原生 HTML/CSS/ES Module，无构建步骤，直接由 Worker 以静态资源发布。
- **后端**：Cloudflare Worker（`src/worker.ts`），D1 存结构化数据，R2 存图片。
- **大模型**：任意 OpenAI 兼容接口（默认火山方舟豆包视觉模型），用于读图批改、出同类题、批改变式题。API Key 存在 D1 里，**不进代码、不进仓库**。

## 目录

```
src/worker.ts            Worker 主程序 + 全部 API
src/prompts.ts           大模型提示词
schema.sql               D1 表结构
migrate_*.sql            已有库的增量迁移（新建库直接跑 schema.sql 即可，不用跑迁移）
public/math/             前端页面
wrangler.toml            Cloudflare 配置（路由 /math/*、D1、R2）
```

## 线上环境（已部署）

| 项 | 值 |
|---|---|
| 访问地址 | `https://kids.liaohao.cc/math/` |
| Worker | `math-helper`（Zone `liaohao.cc` 下的路由） |
| D1 | `math-helper-db` · `b9aa60f6-04e0-4c58-a357-5db289214ed7` |
| R2 | `math-helper-images` |
| 路由 | `kids.liaohao.cc/math`、`/math/*`、`/app/*`、`/api/*`、`/*` |

## 部署步骤

```bash
npm install

# 1) 建 D1 数据库，把返回的 database_id 填回 wrangler.toml
npx wrangler d1 create math-helper-db

# 2) 建 R2 桶（wrangler.toml 里已写死 bucket_name: math-helper-images）
npx wrangler r2 bucket create math-helper-images

# 3) 初始化表结构
npm run db:init

# 4) 部署（wrangler.toml 里的 routes 会一并发布）
npm run deploy
```

### 路由绑定

`kids.liaohao.cc` 上已有一条 Cloudflare 保留记录 `AAAA 100::`（Worker 路由专用，开启代理）。
`wrangler deploy` 会按 `wrangler.toml` 的 `routes` 自动发布；若令牌没有 Zone 路由权限，可用 API 手工绑定：

```bash
ZONE_ID=<liaohao.cc 的 zone id>
curl -X POST "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/workers/routes" \
  -H "Authorization: Bearer $CF_TOKEN" -H "Content-Type: application/json" \
  -d '{"pattern":"kids.liaohao.cc/math/*","script":"math-helper"}'
```

> 注意：`POST /accounts/:id/workers/domains`（Worker 自定义域名）只接受 Cloudflare **全局 API Key**，
> API Token / OAuth 都会返回 `10405 Method not allowed`，所以这里用「DNS 记录 + Zone 路由」的方式绑定。

## 使用配置

打开 `/math/#/settings`：

- 服务商预设选「火山方舟 · 豆包」，粘贴 API Key；
- 模型填 **`doubao-seed-2-0-mini-260428`**（预置推理接入点，不用自己建接入点）；也可以填控制台里自己创建的推理接入点 ID（`ep-` 开头）；
- 设置年级（影响出题难度和讲解口吻）；
- 可选设置「家庭口令」，防止作业照片被别人看到。

### 双模型槽位：视觉 / 文本分开配

应用里有两类大模型调用，可以分别指向不同厂商，方便对比效果和控制成本：

| 槽位 | 干什么 | 是否必须看图 |
|---|---|---|
| **视觉模型**（主槽位） | 读作业照片、逐题识别、判对错、错因分析、批改变式题 | 必须 |
| **文本 / 推理模型**（可选槽位） | 生成举一反三的同类题 | 不需要 |

文本槽位**留空就自动回落用视觉模型**。想分开对比的话，比如「视觉用免费的智谱 `glm-4.6v-flash`，出题用百炼 `qwen3-vl-plus`」，就在文本槽位单独填。想停用，把文本槽位的模型名清空即可。

> DeepSeek 官方接口只处理文字、不支持图片，所以做不了「读照片批改」这一环。如果你在视觉槽位填了 DeepSeek，应用会直接给出明确报错而不是静默失败。

### 模型源库：多家配置同时保存，随时切换

设置页的「模型源库」可以保存任意多个模型源（智谱 / 百炼 / 火山 / 硅基流动 / 混元 / OpenAI 各存一条），
**互不覆盖**。每条源有独立的名字、接口地址、Key、模型和用途（视觉 / 文本），
点「启用为视觉」或「启用为文本」即可切换当前生效的那家，批改和出题就跟着换，不用重填 Key。

数据表 `llm_profiles`，settings 表用 `active_vision_profile` / `active_text_profile` 指向当前启用的源。
旧的单一配置（settings 表 base_url/api_key/model）会在首次访问时自动迁移成一条源，历史数据不丢。

### 换一家大模型（豆包积分用不了时的备选）

设置页的「服务商预设」已内置六家，换一家只要改预设 + 填 Key，其他不用动：

| 服务商 | 接口地址 | 推荐模型 | 费用 |
|---|---|---|---|
| **智谱 GLM** | `https://open.bigmodel.cn/api/paas/v4` | `glm-4.6v-flash` | **视觉模型永久免费、不限量**（注册实名后还送约 2000 万 token） |
| 阿里云百炼 | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen3-vl-plus`、`qwen3-vl-flash` | 新用户有免费额度，之后按量计费，视觉识别质量第一梯队 |
| 火山方舟 · 豆包 | `https://ark.cn-beijing.volces.com/api/v3` | `doubao-seed-2-0-mini-260428` | 按量计费，预置接入点不用自己建 |
| 硅基流动 | `https://api.siliconflow.cn/v1` | `Qwen/Qwen2.5-VL-72B-Instruct` | 有免费档模型，也有极便宜的付费模型 |
| 腾讯混元 | `https://api.hunyuan.cloud.tencent.com/v1` | `hunyuan-vision` | 按量计费 |
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` | 需代理，美元计费 |

> 兼容性已处理：智谱传图片要**裸 base64**（不能带 `data:image/jpeg;base64,` 前缀），Worker 会按接口地址自动判断格式，用户不用管。

### 怎么拿豆包的 API Key

1. 打开 <https://console.volcengine.com/ark>，用手机号 / 抖音 / 头条账号登录。
2. 完成**个人实名认证**（控制台会提示），按提示开通方舟服务（按量计费，新用户有免费额度）。
3. 左侧 **API Key 管理** → **创建 API Key** → 起个名字 → 创建。
   ⚠️ Key 明文**只显示一次**，当场复制保存好。
4. 回到 `/math/#/settings` 粘贴 Key、确认模型名，点「测试连接」，显示「连接正常」就可以用了。

费用参考（批改一次作业约几张图）：豆包 2.0 mini 输入 ¥0.2 / 百万 tokens、输出 ¥2 / 百万 tokens，日常家用每月基本是几毛到几块钱。

## API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET/POST | `/math/api/settings` | 读取 / 保存配置 |
| POST | `/math/api/test-model` | 测试大模型连通性 |
| POST | `/math/api/homework/upload` | 上传作业照片 |
| POST | `/math/api/homework/:id/grade` | 批改（识别题目 + 判对错 + 分析） |
| POST | `/math/api/questions/:id/answer-image` | 上传作答裁剪图 |
| GET | `/math/api/submissions` `/:id` | 作业列表 / 详情 |
| GET | `/math/api/questions` `/:id` | 题目列表 / 详情（含掌握度） |
| PATCH | `/math/api/questions/:id` | **人工改判母题** |
| POST | `/math/api/questions/:id/variants/generate` | 生成举一反三 |
| POST | `/math/api/variants/select` | 勾选要练的题 |
| PATCH | `/math/api/variants/:id` | **人工改判变式题** |
| POST | `/math/api/questions/:id/variant-answer` | 拍照回批举一反三 |
| GET | `/math/api/img?key=` | 读取 R2 图片 |
