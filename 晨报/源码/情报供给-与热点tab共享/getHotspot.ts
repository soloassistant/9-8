import dayjs from 'dayjs';
import type { HotspotNews } from '../types';

/** mock 配图生成地址（仅 H5 预览示意；真实端用 RSS 抽取的真实封面图） */
const mockImage = (prompt: string) =>
  `https://trae-api-cn.mchost.guru/api/ide/v1/text_to_image?prompt=${encodeURIComponent(prompt)}&image_size=landscape_4_3`;

const MOCK_NEWS: Array<[string, string, string, string[], string, string?]> = [
  ['微信小程序新增 AI 能力接口，开发者可一键接入大模型', '小程序基础库新增 wx.createAICapability 接口，官方直连多家已备案大模型，按调用量计费，冷启动成本进一步降低。', '微信开放社区', ['科技', '小程序'], mockImage('smartphone screen showing AI assistant chat interface, WeChat mini program, clean tech illustration, blue tones'), '独立开发者接入大模型的门槛和成本双降，值得关注。'],
  ['2026 全球开发者大会：端侧模型成为主旋律', '多家厂商展示 3B 级端侧模型，手机本地跑通语音助手与摘要生成，隐私与延迟优势明显。', '少数派', ['科技', 'AI'], mockImage('mobile chip with glowing neural network, on-device AI, tech illustration, futuristic'), '端侧模型落地意味着 AI 功能可离线、低延迟使用。'],
  ['研究发现：任务清单能降低焦虑，但前提是"写得具体"', '心理学团队实验显示，把"处理项目"改写成"下午 3 点给客户发确认邮件"，完成率提升 42%。', '36氪', ['效率', '健康'], mockImage('hand writing a detailed to-do checklist on paper notebook, minimal flat illustration, warm morning light'), '一条立刻可用的效率技巧，改写待办措辞即可见效。'],
  ['个人开发者如何用好订阅制：前 100 个付费用户从哪来', '样本访谈 30 位独立开发者：垂直社群冷启动 + 免费额度留住核心用户，是最稳的两条路径。', '爱范儿', ['商业', '独立开发'], mockImage('independent developer workspace with laptop and coffee, subscription growth chart, flat illustration')],
  ['多家航司上线"当日错峰票价"，早七晚九航班便宜三成', '错峰出行工具热度上涨，通勤式差旅人群成为新客群。', '澎湃新闻', ['生活', '出行'], mockImage('airplane flying above clouds at dawn, flight ticket and boarding pass, travel illustration')]
];

/** mock: getHotspot —— 今日热点资讯（真实端走 webSearch 云函数 RSS 聚合，必须标注来源） */
export default function getHotspot(): HotspotNews[] {
  return MOCK_NEWS.map((row, i) => ({
    id: `news-mock-${i + 1}`,
    title: row[0],
    summary: row[1],
    source: row[2],
    tags: row[3],
    image: row[4],
    createTime: dayjs().subtract(i * 2, 'hour').toISOString(),
    whyItMatters: row[5]
  }));
}
