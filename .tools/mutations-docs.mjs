// 变异用例：文档与现实一致性门禁（harness: .tools/verify-docs.mjs）
//
// 与其它 mutations-*.mjs 同一套契约：
//   · from 必须在目标文件里**正好出现一次**（否则框架判 ERROR，不动文件）；
//   · 目标文件必须没有未提交改动（先 commit 再跑）；
//   · cmd 指向的 harness 基线必须为绿。
//
// 这三条都是**真实发生过的错**，不是编的：
//   ① 仓库 2026-10-21 从 D:/Agent 迁到 D:/Agent/晨报，AGENTS.md 的项目根没跟着改；
//   ② MEMORY.md 长期写着「H5 是 mock 数据」，而 H5 早已接 WorkBuddy 云库；
//   ③ 文档里写过 `deploy-gh-pages.ps1` 这种**仓库里从来不存在**的脚本，让人白找一轮。
export default [
  {
    // 行为后果：新来的人（或 agent）照文档 cd 到 D:/Agent 干活，在别的项目目录里构建晨报。
    // 哪条变红：B1 文档声明的项目根必须等于 git rev-parse --show-toplevel。
    label: '项目根写回迁移前的裸 D:/Agent（迁移后忘了同步）',
    file: 'AGENTS.md',
    from: '- **项目根**：`D:/Agent/晨报`',
    to: '- **项目根**：`D:/Agent`',
    cmd: 'node .tools/verify-docs.mjs'
  },
  {
    // 行为后果：新人对 `.tools/` 里新增脚本一律 `git add -f`，一旦遇到"新建子目录"才发现
    // 真正该做的是补 `.gitignore` 白名单 —— 而 `-f` 会掩盖"忘了补白名单"这件事。
    // 哪条变红：B5 文档不许声称「新增文件需 git add -f」。
    // ⚠️ 这条特意不用 MEMORY.md 做靶：MEMORY.md 被 .gitignore 忽略、CI 里不存在，
    //    拿它做变异锚点在 CI 会直接 ERROR（本地却绿），是最难查的那种"环境相关假绿"。
    label: '文档写回「.tools 新增文件需 git add -f」（会掩盖漏补白名单）',
    file: 'AGENTS.md',
    from: '直接 `git add` 即可，**不需要 `-f`**',
    to: '`git add` 时需 `-f`（新增文件需 `git add -f`）',
    cmd: 'node .tools/verify-docs.mjs'
  },
  {
    // 行为后果：照文档敲的命令找不到文件，白跑一轮还以为环境坏了。
    // 哪条变红：A3 文档里 node 直调的脚本必须存在。
    label: '命令清单里写成不存在的脚本名（打错一个字母）',
    file: 'AGENTS.md',
    from: 'node .tools/cdp-probe.mjs <url> <w> <h>',
    to: 'node .tools/cdp-probe-typo.mjs <url> <w> <h>',
    cmd: 'node .tools/verify-docs.mjs'
  }
];
