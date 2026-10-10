# vendor/shengxinmai —— 这是「省心买」的只读副本，不要在这里改功能

## 它是什么

`私人晨报助理` 的 H5 端要把「省心买」（比价与出行助手）作为**同源子页**挂在 `/sxm/` 下，
所以把它的**静态发布白名单 13 个文件**原样收进本仓库。构建时由
`.tools/copy-assets.js` 拷到 `dist/sxm/`（见该文件里的 `sxm` job）。

## 出处（可核对）

| 项 | 值 |
|---|---|
| 上游仓库 | `https://github.com/soloassistant/shengxinmai.git` |
| 本目录取材时的 commit | `7cfe525`（`docs: 2026-10-09 发布记录（含白名单修复的发布与验证结果）`） |
| 取材时上游工作区 | 干净（`git status --porcelain` 无输出） |
| 取材时线上 Pages | `https://soloassistant.github.io/shengxinmai/` |
| `app.js` sha1 前 12 位 | `563fe0ae12e9` —— **本地、线上 Pages 两侧一致**，故这份副本确实是当时线上的那一版 |

文件清单取自上游 `server/lib/static-whitelist.js` 的 `STATIC_WHITELIST`（13 项），
不手工增删 —— 上游那份白名单与它的 Pages 部署 workflow 是同一份真相，两边漂移就是 bug。

## 怎么核对这份副本没被动过

```bash
# ① 与上游本地仓库逐文件比对（上游路径可能要按机器调整）
SRC="/c/Users/geral/WorkBuddy/2026-09-24-16-20-44/shengxinmai"
for f in $(ls vendor/shengxinmai | grep -v PROVENANCE); do
  cmp -s "$SRC/$f" "vendor/shengxinmai/$f" && echo "✅ $f" || echo "❌ $f 已漂移"
done

# ② 与线上 Pages 比对（不需要上游仓库）
curl -sS -L https://soloassistant.github.io/shengxinmai/app.js | sha1sum | cut -c1-12   # 应为 563fe0ae12e9

# ③ 校验构建产物确实拷全了
ls dist/sxm | wc -l    # 应为 13
```

## 两条「不要自作聪明」的规矩

1. **不要在这里改功能**。要改就回上游仓库改、发版，然后重新拷贝这 13 个文件并更新本文件里的 commit 与指纹。
   在这里改会造成悄无声息的第二份真相。
2. **不要「修正」`index.html` 里钉死的域名**（`og:url` / `og:image` / `twitter:image` / `canonical`
   都指向 `https://soloassistant.github.io/shengxinmai/`）。
   我一开始以为这是要改成新挂载域名的 bug —— **是我想错了**。上游 `index.html:8-19` 已经写明理由：
   社交平台爬虫不跑浏览器、没有 base URL，`og:*` 必须是**绝对** URL；而两套部署里
   GitHub Pages 是**耐久**的那套，沙箱部署被回收的话已发出去的分享卡片会一起掉图。
   把域名改成本应用的沙箱域，恰好会踩中它刻意避开的那个坑。

## 已知行为差异（挂到本应用下之后）

- 省心买前端所有网络请求都是**根路径** `/api/health`、`/api/compare`、`/api/basket`、
  `/api/metrics`、`/api/flights`。挂到 `/sxm/` 之后这些请求会打到**本应用的根**，那里只有
  `/api/hotspot.json` 和 `/api/hotspot`，其余 404。
- 结算是**符合预期**的：省心买前端探测不到 `/api/health` 就会置 `SERVER_OK=false`，
  自动降级为「手动比价」（把各平台搜索页摆好、不显示任何价格）。这与它自己挂在
  GitHub Pages 上的行为**完全一致**（Pages 也没有后端），所以挂载不会引入新的坏状态。
- 因此 `dist/sxm/` 不是「带后端的省心买」。要真比价，得另外部署它的零依赖 Node 后端
  并配上联盟密钥（那是一条独立的事，见 `拿密钥作战单.md`）。
