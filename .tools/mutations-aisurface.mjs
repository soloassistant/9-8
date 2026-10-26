// 变异用例：AI 入口面（harness: .tools/verify-ai-surface.js）
//
// 运行方式：
//   node .tools/mutation-verify.mjs .tools/mutations-aisurface.mjs
//
// 这条门禁守的是「AI 入口不许长回来」。它的价值全在**能抓到回潮**：
// 如果变异把这些入口重新装回去、门禁却仍全绿，那这条门禁就只是一段自述。
// 所以每条用例都真的把某个入口装回去，断言必须变红。
//
// ⚠️ 锚点一律不带换行：本仓工作区是 CRLF，锚点里写 \n 会匹配 0 次（框架判 ERROR）。
export default [
  {
    // 守 B1：把全局悬浮球挂回 app.tsx（任何页都能唤起的第二入口）
    label: '把全局 AI 悬浮球挂回 app.tsx（第二入口回潮）',
    file: 'src/app.tsx',
    from: '{!consentAgreed ? <ConsentGate',
    to: '<AiAssistant />{!consentAgreed ? <ConsentGate',
    cmd: 'node .tools/verify-ai-surface.js'
  },
  {
    // 守 B4/D3：「我的」页的 AI 助手入口被改指别处（用户就再也进不去对话页）
    label: '「我的」页 AI 助手入口改指我的页自身（对话页变成不可达）',
    file: 'src/pages/mine/index.tsx',
    from: "Taro.navigateTo({ url: '/pages/assistant/index' })",
    to: "Taro.navigateTo({ url: '/pages/mine/index' })",
    cmd: 'node .tools/verify-ai-surface.js'
  },
  {
    // 守 A1/C1：晨报页重新引用语音按钮（底部输入条回潮的第一块砖）
    label: '晨报页重新 import VoiceButton（底部输入条回潮）',
    file: 'src/pages/briefing/index.tsx',
    from: 'import { apiGetBriefing, apiApplyPlan,',
    to: "import VoiceButton from '@/components/VoiceButton';import { apiGetBriefing, apiApplyPlan,",
    cmd: 'node .tools/verify-ai-surface.js'
  },
  {
    // 守 A4：晨报页重新直接发起 AI 对话
    label: '晨报页重新调用 apiChat（阅读页又变成 AI 对话入口）',
    file: 'src/pages/briefing/index.tsx',
    from: "const [quoteInput, setQuoteInput] = useState('');",
    to: "const [quoteInput, setQuoteInput] = useState('');const _ai = () => apiChat('x', 'text');",
    cmd: 'node .tools/verify-ai-surface.js'
  },
  {
    // 守 A2：快捷指令 chip 回潮
    label: '晨报页加回快捷指令常量 QUICK_COMMANDS',
    file: 'src/pages/briefing/index.tsx',
    from: "const [quoteInput, setQuoteInput] = useState('');",
    to: "const QUICK_COMMANDS = ['安排日程'];const [quoteInput, setQuoteInput] = useState('');",
    cmd: 'node .tools/verify-ai-surface.js'
  },
  {
    // 守 E1：整页模式默认收起 —— 没有悬浮球可点，用户进来面对一个空页面
    label: '整页模式默认收起（进页面看不到对话框）',
    file: 'src/components/AiAssistant/index.tsx',
    from: 'useState(embedded)',
    to: 'useState(false)',
    cmd: 'node .tools/verify-ai-surface.js'
  },
  {
    // 守 E4：引导气泡（同一件事的第三个入口）回潮
    label: '加回引导气泡状态（第三个入口回潮）',
    file: 'src/components/AiAssistant/index.tsx',
    from: "const [input, setInput] = useState('');",
    to: "const hintBubble = true;const [input, setInput] = useState('');",
    cmd: 'node .tools/verify-ai-surface.js'
  }
];
