# TrustMRR `/api/search` 接口说明

> 数据来源：站点搜索页 `https://trustmrr.com/search` 实际发出的 `POST /api/search` 请求（见仓库 `searchHttp.text`）。
> 抓包时间：约 2026-08-17。下列枚举与结构以该文件中的 4 种排序场景 + 一份响应样例为准。
> 必传约束来自业务确认：`sortBy`、`limit`、`page` 必传；其余均可省略。

## 一、接口概览

| 项 | 值 |
|---|---|
| URL | `https://trustmrr.com/api/search` |
| Method | `POST` |
| Content-Type | `application/json` |
| 页面入口 | `https://trustmrr.com/search` |
| 鉴权 | 抓包请求带站点 Cookie（登录态）。未登录是否可用未在本次样例中验证。 |

请求体为 JSON 对象。搜索页默认 `limit=24`；业务侧确认 **`limit` 最大 100**。

---

## 二、请求参数

### 2.1 必传

| 字段 | 类型 | 样例 | 含义 |
|---|---|---|---|
| `page` | number | `1` | 页码，从 1 开始。 |
| `limit` | number | `24` | 每页条数。搜索页默认 24，**最大 100**。 |
| `sortBy` | string | `"latest"` | 排序方式，见下表。 |

**`sortBy` 已观测取值：**

| 值 | 含义（结合响应推断） |
|---|---|
| `latest` | 按最新（新上架 / 新收录）排序 |
| `growth` | 按 30 天增长率 `growth30d` 排序 |
| `mrr` | 按当前 MRR `currentMrr` 排序 |
| `revenue` | 按累计总营收 `currentTotalRevenue` 排序 |

本次抓包 4 个请求仅 `sortBy` 不同，其余筛选条件相同。响应样例中前几条 `currentTotalRevenue` 递减（464 万 → 455 万 → 424 万…），对应 `sortBy=revenue`。

升序 / 降序没有独立字段，站点行为均为**从高到低（或从新到旧）**。

### 2.2 可选筛选

不传表示不按该维度过滤。范围类字段均为 `{ min, max }` 对象。

| 字段 | 类型 | 样例 | 含义 | 对应响应字段 |
|---|---|---|---|---|
| `growthRate` | `{ min: number, max: number }` | `{ "min": 0, "max": 88 }` | 30 天增长率区间，单位为百分比数值（88 ≈ 88%） | `growth30d` |
| `mrr` | `{ min: number, max: number }` | `{ "min": 0, "max": 66666 }` | 当前月经常性收入区间（美元） | `currentMrr` |
| `revenue` | `{ min: number, max: number }` | `{ "min": 0, "max": 7777777 }` | 累计总营收区间（美元） | `currentTotalRevenue` |
| `xFollowerCount` | `{ min: number, max: number }` | `{ "min": 0, "max": 9999999 }` | X（Twitter）粉丝数区间 | `xFollowerCount` |
| `categories` | string[] | `["analytics"]` | 按**站点分类 slug** 过滤，可多选 | `userCategorySlug` |
| `targetAudience` | string[] | `["B2B", "B2C"]` | 目标受众，可多选 | 详情里是字符串 `targetAudience`，列表响应未返回该字段 |
| `foundedDate` | `{ min: string, max: string }` | 见下方说明 | 成立日期区间 | 详情字段 `foundedDate`；列表响应未返回 |

**`categories` 取值：** 与站点分类页 slug 一致，例如 `analytics`、`ai`、`saas`、`developer-tools`、`marketing`。完整清单见 `data/raw/categories.json` / `packages/core/src/const.js` 的 `CATEGORIES`。

**`targetAudience` 已观测取值：** `B2B`、`B2C`。是否还有 `B2B2C` 等未在本次抓包中出现。

**`foundedDate` 说明：** 结构是日期字符串的 `min` / `max`。抓包值为 `"2-01-01"` / `"-2-12-31"`，明显不像完整 ISO 日期（详情页是 `2024-07-01T00:00:00.000Z`）。更可能是搜索页日期控件拷出来的残缺值，或某种相对年份写法。对接时建议按 **`YYYY-MM-DD` 或 ISO 日期** 实测一组再固化。

### 2.3 完整请求体示例

```json
{
  "page": 1,
  "limit": 24,
  "sortBy": "revenue",
  "growthRate": { "min": 0, "max": 88 },
  "mrr": { "min": 0, "max": 66666 },
  "revenue": { "min": 0, "max": 7777777 },
  "xFollowerCount": { "min": 0, "max": 9999999 },
  "categories": ["analytics"],
  "targetAudience": ["B2B", "B2C"],
  "foundedDate": { "min": "2020-01-01", "max": "2026-12-31" }
}
```

仅必传时：

```json
{
  "page": 1,
  "limit": 100,
  "sortBy": "latest"
}
```

本次抓包**没有**独立关键词字段（如 `q` / `query` / `keyword`）。若搜索页有文本框，未出现在这 4 个请求里。

---

## 三、响应结构

顶层只有两个字段：

```json
{
  "startups": [ /* StartupListItem */ ],
  "pagination": {
    "total": 381,
    "page": 1,
    "pages": 16
  }
}
```

### 3.1 `pagination`

| 字段 | 类型 | 样例 | 含义 |
|---|---|---|---|
| `total` | number | `381` | 命中总数（筛选后） |
| `page` | number | `1` | 当前页，与请求 `page` 对应 |
| `pages` | number | `16` | 总页数。样例中 `ceil(381 / 24) = 16`，与请求 `limit` 一致 |

翻页：`page` 从 1 递增，直到 `page > pages`。

### 3.2 `startups[]` 列表项

列表是**详情页的瘦身投影**，没有官网、国家、成立日期、AI 富化、技术栈等。完整字段见 `docs/startup-fields.md`。

| 字段 | 类型 | 是否总出现 | 含义 |
|---|---|---|---|
| `_id` | string | 是 | MongoDB 风格主键 |
| `name` | string | 是 | 企业名称 |
| `slug` | string | 是 | URL 标识，详情页为 `/startup/{slug}` |
| `icon` | string | 是 | Logo URL（Stripe files 或 CloudFront） |
| `description` | string | 是 | 一句话描述 |
| `brandingPrimaryColor` | string \| null | 是 | 品牌主色 hex；无品牌色时为 `null` |
| `brandingSecondaryColor` | string \| null | 是 | 品牌辅色 hex；可为 `null` |
| `xHandle` | string | 是 | X 账号（不含 `@`） |
| `xProfilePicture` | string | 是 | X 头像 URL |
| `xFollowerCount` | number | 是 | X 粉丝数 |
| `currentTotalRevenue` | number | 是 | 累计总营收（美元，可带小数） |
| `currentMrr` | number | 是 | 当前 MRR（美元）。可为 `0`（非订阅/未同步） |
| `growth30d` | number | 是 | 近 30 天增长率（百分比数值，如 `80.87` 表示约 +80.87%）。可为 `0` |
| `userCategorySlug` | string | 是 | 站点分类 slug，对应请求 `categories` |
| `categorySlug` | string \| null | 是 | 另一套类目（更像支付/行业类，如 `software` / `services` / `digital` / `apps`），**不是**搜索筛选用的分类；可为 `null` |
| `isMerchantOfRecord` | boolean | 是 | 是否为记录商户 |
| `stealthMode` | boolean | 是 | 隐身模式 |
| `onSale` | boolean | 是 | 是否挂牌出售 |
| `askingPrice` | number \| null | 否 | 挂牌要价（美元）。`onSale=true` 时一般有数字；`onSale=false` 时可能缺省、或为 `null` |

**`userCategorySlug` vs `categorySlug`：**

| | `userCategorySlug` | `categorySlug` |
|---|---|---|
| 用途 | 站点搜索/导航分类 | 更像 Stripe/业务类型 |
| 样例 | `analytics`、`education`、`marketing` | `software`、`services`、`hotels`、`other` |
| 与请求 `categories` | 直接对应 | 不对应 |

### 3.3 列表项 JSON 示例

```json
{
  "_id": "691d9998375e3b94ffe6af7b",
  "name": "DataFast",
  "icon": "https://d21oz30g4w22sz.cloudfront.net/logos/datafast-fa461188-bc0c-4ab5-8e62-e48e4bac891d.png",
  "description": "Revenue-first analytics for startup founders",
  "brandingPrimaryColor": "#e16540",
  "brandingSecondaryColor": "#e16540",
  "xHandle": "marclou",
  "categorySlug": "software",
  "currentTotalRevenue": 252290.1,
  "currentMrr": 26389.58,
  "slug": "datafast",
  "isMerchantOfRecord": false,
  "stealthMode": false,
  "xFollowerCount": 371475,
  "userCategorySlug": "analytics",
  "onSale": false,
  "askingPrice": null,
  "xProfilePicture": "https://pbs.twimg.com/profile_images/2081903460199641088/YZJqLn39.jpg",
  "growth30d": 1.276931840901791
}
```

在售企业会多出要价，例如：

```json
{
  "onSale": true,
  "askingPrice": 1250000,
  "slug": "conductor"
}
```

---

## 四、请求字段 ↔ 响应字段

| 请求 | 作用 | 列表里能看到的结果 |
|---|---|---|
| `page` / `limit` | 分页 | `pagination.page`；`startups.length ≤ limit` |
| `sortBy=latest` | 按新到旧 | 列表顺序变化（本文件未附该排序的响应） |
| `sortBy=growth` | 按增长率 | `growth30d` 从高到低（推断） |
| `sortBy=mrr` | 按 MRR | `currentMrr` 从高到低（推断） |
| `sortBy=revenue` | 按总营收 | 样例中 `currentTotalRevenue` 从高到低 |
| `growthRate` | 过滤增长率 | 命中项 `growth30d` 应落在区间内 |
| `mrr` | 过滤 MRR | `currentMrr` |
| `revenue` | 过滤总营收 | `currentTotalRevenue` |
| `xFollowerCount` | 过滤粉丝数 | `xFollowerCount` |
| `categories` | 过滤站点分类 | `userCategorySlug` ∈ 传入数组 |
| `targetAudience` | 过滤受众 | 列表无此字段，需看详情 |
| `foundedDate` | 过滤成立时间 | 列表无此字段，需看详情 |

---

## 五、与详情接口的差异

搜索列表**没有**以下详情常见字段（详见 `docs/startup-fields.md`）：

- 身份与地理：`website`、`country`、`foundedDate`、`location`
- 同步与排名：`createdAt`、`updatedAt`、`rank`、`cachedRank`、`currentLast30DaysRevenue`
- 出售细节：`askingPriceHistory`、`firstListedForSaleAt`
- 富化：`aiEnrichment`、`techStack`、`marketingChannels`、`cofounders`

需要这些时：用列表拿到 `slug`，再请求详情页 `/startup/{slug}`。

---

## 六、调用注意

1. **分页**：`pages = ceil(total / limit)`。`limit=100` 可减少请求次数。
2. **筛选全开时命中变少**：样例在 analytics + 增长率/MRR/营收/粉丝/受众/成立日期同时过滤后，`total=381`。
3. **`growth30d` 与 `cachedGrowth30d`**：列表用 `growth30d`；详情文档里是 `cachedGrowth30d`。语义都是 30 天增长，字段名不同，对接时不要混用。
4. **金额单位**：请求区间与响应均为**美元数字**，不是美分。
5. **不要把抓包 Cookie 写进脚本**：`searchHttp.text` 含登录 Cookie，文档不收录；采集时按现有爬虫方式处理即可。

---

## 七、抓包场景对照

`searchHttp.text` 中 4 个请求的差异只有 `sortBy`：

| 场景 | `sortBy` |
|---|---|
| 1 | `latest` |
| 2 | `growth` |
| 3 | `mrr` |
| 4 | `revenue`（文中附带的响应） |

公共筛选：`growthRate.min/max`、`mrr.min/max`、`revenue.min/max`、`xFollowerCount.min/max`、`categories=["analytics"]`、`targetAudience=["B2B","B2C"]`、`foundedDate.min/max`，以及 `page=1`、`limit=24`。
