/**
 * 语言学习课程数据（MVP）：本地静态数据，零成本起步。
 * 结构：3 语种 × 3 级 × 每级 2 课 × 每课 6 词；后续可迁云数据库（结构保持一致）。
 */

export interface LearnWord {
  /** 全局唯一：{lang}-{level}-{course}-{n} */
  id: string;
  /** 单词/短语 */
  term: string;
  /** 读音（日语假名 / 韩语罗马音 / 英语音标） */
  reading?: string;
  /** 中文释义 */
  meaning: string;
  /** 例句（目标语言） */
  example: string;
  /** 例句中文 */
  exampleCn: string;
}

export interface LearnCourse {
  id: string;
  title: string;
  theme: string;
  words: LearnWord[];
}

export interface LearnLevel {
  id: string;
  name: string;
  desc: string;
  courses: LearnCourse[];
}

export type LearnLangId = 'en' | 'ja' | 'ko';

export interface LearnLang {
  id: LearnLangId;
  name: string;
  accent: string;
  levels: LearnLevel[];
}

const w = (
  lang: string,
  level: string,
  course: number,
  n: number,
  term: string,
  meaning: string,
  example: string,
  exampleCn: string,
  reading?: string
): LearnWord => ({
  id: `${lang}-${level}-${course}-${n}`,
  term,
  reading,
  meaning,
  example,
  exampleCn
});

export const LEARN_LANGS: LearnLang[] = [
  {
    id: 'en',
    name: '英语',
    accent: '#4A90D9',
    levels: [
      {
        id: 'en-a1',
        name: '入门 A1',
        desc: '零基础起步，掌握高频问候与基础表达',
        courses: [
          {
            id: 'en-a1-1',
            title: '问候与自我介绍',
            theme: '第一次见面就能开口',
            words: [
              w('en', 'a1', 1, 1, 'hello', '你好', 'Hello, nice to meet you!', '你好，很高兴认识你！'),
              w('en', 'a1', 1, 2, 'name', '名字', 'My name is Lily.', '我的名字叫莉莉。'),
              w('en', 'a1', 1, 3, 'thanks', '谢谢', 'Thanks for your help.', '谢谢你的帮助。'),
              w('en', 'a1', 1, 4, 'please', '请', 'Please sit down.', '请坐。'),
              w('en', 'a1', 1, 5, 'sorry', '对不起', 'Sorry, I am late.', '对不起，我迟到了。'),
              w('en', 'a1', 1, 6, 'goodbye', '再见', 'Goodbye, see you tomorrow!', '再见，明天见！')
            ]
          },
          {
            id: 'en-a1-2',
            title: '数字与时间',
            theme: '报时问路都能应付',
            words: [
              w('en', 'a1', 2, 1, 'one', '一', 'I have one question.', '我有一个问题。'),
              w('en', 'a1', 2, 2, 'two', '二', 'Two coffees, please.', '请给我两杯咖啡。'),
              w('en', 'a1', 2, 3, 'time', '时间', 'What time is it?', '现在几点？'),
              w('en', 'a1', 2, 4, 'today', '今天', 'Today is Monday.', '今天是星期一。'),
              w('en', 'a1', 2, 5, 'tomorrow', '明天', 'See you tomorrow.', '明天见。'),
              w('en', 'a1', 2, 6, 'week', '星期/周', 'I will finish it this week.', '我这周会完成它。')
            ]
          }
        ]
      },
      {
        id: 'en-a2',
        name: '进阶 A2',
        desc: '生活场景对话，吃住行全覆盖',
        courses: [
          {
            id: 'en-a2-1',
            title: '餐厅点餐',
            theme: '出国吃饭不慌张',
            words: [
              w('en', 'a2', 1, 1, 'menu', '菜单', 'Can I see the menu?', '我能看看菜单吗？'),
              w('en', 'a2', 1, 2, 'order', '点单', 'I would like to order now.', '我现在想点餐。'),
              w('en', 'a2', 1, 3, 'bill', '账单', 'Could we have the bill, please?', '请给我们账单好吗？'),
              w('en', 'a2', 1, 4, 'delicious', '美味的', 'The soup is delicious.', '这个汤很美味。'),
              w('en', 'a2', 1, 5, 'water', '水', 'A glass of water, please.', '请给我一杯水。'),
              w('en', 'a2', 1, 6, 'recommend', '推荐', 'What do you recommend?', '你有什么推荐？')
            ]
          },
          {
            id: 'en-a2-2',
            title: '问路与交通',
            theme: '迷路也能顺利到达',
            words: [
              w('en', 'a2', 2, 1, 'left', '左', 'Turn left at the corner.', '在拐角左转。'),
              w('en', 'a2', 2, 2, 'right', '右', 'The bank is on your right.', '银行在你的右边。'),
              w('en', 'a2', 2, 3, 'station', '车站', 'Where is the nearest station?', '最近的车站在哪？'),
              w('en', 'a2', 2, 4, 'ticket', '票', 'I need a ticket to London.', '我需要一张去伦敦的票。'),
              w('en', 'a2', 2, 5, 'bus', '公交', 'The bus comes every ten minutes.', '公交每十分钟一班。'),
              w('en', 'a2', 2, 6, 'far', '远的', 'Is it far from here?', '离这里远吗？')
            ]
          }
        ]
      },
      {
        id: 'en-b1',
        name: '冲刺 B1',
        desc: '职场与深度表达，沟通更自信',
        courses: [
          {
            id: 'en-b1-1',
            title: '职场沟通',
            theme: '会议邮件都用得上',
            words: [
              w('en', 'b1', 1, 1, 'schedule', '安排/日程', 'Let us schedule a meeting.', '我们安排一个会议吧。'),
              w('en', 'b1', 1, 2, 'deadline', '截止日期', 'The deadline is Friday.', '截止日期是周五。'),
              w('en', 'b1', 1, 3, 'confirm', '确认', 'Please confirm the plan.', '请确认这个计划。'),
              w('en', 'b1', 1, 4, 'progress', '进展', 'How is the project going?', '项目进展如何？'),
              w('en', 'b1', 1, 5, 'feedback', '反馈', 'Thanks for your feedback.', '谢谢你的反馈。'),
              w('en', 'b1', 1, 6, 'achievement', '成果', 'This is a great achievement.', '这是一个了不起的成果。')
            ]
          },
          {
            id: 'en-b1-2',
            title: '旅行计划',
            theme: '深度游自由行必备',
            words: [
              w('en', 'b1', 2, 1, 'reservation', '预订', 'I have a reservation tonight.', '我今晚有一个预订。'),
              w('en', 'b1', 2, 2, 'itinerary', '行程', 'Our itinerary includes three cities.', '我们的行程包含三个城市。'),
              w('en', 'b1', 2, 3, 'passport', '护照', 'Keep your passport safe.', '保管好你的护照。'),
              w('en', 'b1', 2, 4, 'departure', '出发', 'The departure time changed.', '出发时间变了。'),
              w('en', 'b1', 2, 5, 'exchange', '兑换', 'Where can I exchange money?', '我在哪里可以换钱？'),
              w('en', 'b1', 2, 6, 'souvenir', '纪念品', 'I bought some souvenirs.', '我买了一些纪念品。')
            ]
          }
        ]
      }
    ]
  },
  {
    id: 'ja',
    name: '日语',
    accent: '#E8636F',
    levels: [
      {
        id: 'ja-a1',
        name: '入门 N5',
        desc: '五十音起步，掌握基础寒暄',
        courses: [
          {
            id: 'ja-a1-1',
            title: '寒暄与问候',
            theme: '开口第一句',
            words: [
              w('ja', 'a1', 1, 1, 'こんにちは', '你好（白天）', 'こんにちは、田中さん。', '你好，田中先生。', 'konnichiwa'),
              w('ja', 'a1', 1, 2, 'ありがとう', '谢谢', 'ありがとうございます。', '非常感谢。', 'arigatou'),
              w('ja', 'a1', 1, 3, 'すみません', '对不起/劳驾', 'すみません、駅はどこですか。', '请问，车站在哪里？', 'sumimasen'),
              w('ja', 'a1', 1, 4, 'おはよう', '早上好', 'おはようございます。', '早上好。（礼貌体）', 'ohayou'),
              w('ja', 'a1', 1, 5, 'さようなら', '再见', 'さようなら、また明日。', '再见，明天见。', 'sayounara'),
              w('ja', 'a1', 1, 6, 'はじめまして', '初次见面', 'はじめまして、李です。', '初次见面，我姓李。', 'hajimemashite')
            ]
          },
          {
            id: 'ja-a1-2',
            title: '数字与购物',
            theme: '买东西会用数字',
            words: [
              w('ja', 'a1', 2, 1, 'いち', '一', 'いち、に、さん。', '一、二、三。', 'ichi'),
              w('ja', 'a1', 2, 2, 'これ', '这个', 'これをください。', '请给我这个。', 'kore'),
              w('ja', 'a1', 2, 3, 'いくら', '多少钱', 'これはいくらですか。', '这个多少钱？', 'ikura'),
              w('ja', 'a1', 2, 4, 'お金', '钱', 'お金が足りません。', '钱不够了。', 'okane'),
              w('ja', 'a1', 2, 5, '高い', '贵的', 'これは少し高いです。', '这个有点贵。', 'takai'),
              w('ja', 'a1', 2, 6, '安い', '便宜的', 'この店は安いです。', '这家店很便宜。', 'yasui')
            ]
          }
        ]
      },
      {
        id: 'ja-a2',
        name: '进阶 N4',
        desc: '生活场景日语，便利店到车站',
        courses: [
          {
            id: 'ja-a2-1',
            title: '便利店日语',
            theme: '店员说的都能听懂',
            words: [
              w('ja', 'a2', 1, 1, '袋', '袋子', '袋はいりますか。', '需要袋子吗？（店员常用语）', 'fukuro'),
              w('ja', 'a2', 1, 2, '温める', '加热', 'これを温めてください。', '请帮我加热这个。', 'atatameru'),
              w('ja', 'a2', 1, 3, '箸', '筷子', '箸を二本ください。', '请给我两双筷子。', 'hashi'),
              w('ja', 'a2', 1, 4, 'レジ', '收银台', 'レジはあちらです。', '收银台在那边。', 'reji'),
              w('ja', 'a2', 1, 5, '領収書', '收据', '領収書をお願いします。', '麻烦给我收据。', 'ryoushuusho'),
              w('ja', 'a2', 1, 6, 'ポイント', '积分', 'ポイントカードはありますか。', '有积分卡吗？', 'pointo')
            ]
          },
          {
            id: 'ja-a2-2',
            title: '乘车出行',
            theme: '电车新干线不迷路',
            words: [
              w('ja', 'a2', 2, 1, '電車', '电车', '次の電車は十時です。', '下一班电车是十点。', 'densha'),
              w('ja', 'a2', 2, 2, '切符', '车票', '切符を買いました。', '我买了车票。', 'kippu'),
              w('ja', 'a2', 2, 3, '乗り換え', '换乘', '次は乗り換えです。', '下一站要换乘。', 'norikae'),
              w('ja', 'a2', 2, 4, '出口', '出口', '出口はどこですか。', '出口在哪里？', 'deguchi'),
              w('ja', 'a2', 2, 5, '遅刻', '迟到', '電車が遅れて遅刻しました。', '电车晚点所以迟到了。', 'chikoku'),
              w('ja', 'a2', 2, 6, '地図', '地图', '地図を見せてください。', '请给我看地图。', 'chizu')
            ]
          }
        ]
      },
      {
        id: 'ja-b1',
        name: '冲刺 N3',
        desc: '商务与深度表达，进阶自由对话',
        courses: [
          {
            id: 'ja-b1-1',
            title: '商务寒暄',
            theme: '职场第一印象',
            words: [
              w('ja', 'b1', 1, 1, 'お世話になる', '承蒙关照', 'いつもお世話になっております。', '一直以来承蒙关照。', 'osewa'),
              w('ja', 'b1', 1, 2, 'よろしく', '请多关照', '今後ともよろしくお願いします。', '今后也请多多关照。', 'yoroshiku'),
              w('ja', 'b1', 1, 3, '打ち合わせ', '碰头会', '明日打ち合わせがあります。', '明天有一个碰头会。', 'uchiawase'),
              w('ja', 'b1', 1, 4, '提出', '提交', '資料を提出しました。', '资料已提交。', 'teishutsu'),
              w('ja', 'b1', 1, 5, '確認', '确认', 'ご確認をお願いします。', '麻烦您确认。', 'kakunin'),
              w('ja', 'b1', 1, 6, '検討', '研究/斟酌', '検討してみます。', '我们研究一下。', 'kentou')
            ]
          },
          {
            id: 'ja-b1-2',
            title: '旅行安排',
            theme: '自由行深度表达',
            words: [
              w('ja', 'b1', 2, 1, '予約', '预约', 'ホテルを予約しました。', '我预订了酒店。', 'yoyaku'),
              w('ja', 'b1', 2, 2, '日程', '日程', '日程を立てましょう。', '我们来定日程吧。', 'nittei'),
              w('ja', 'b1', 2, 3, '観光', '观光', '京都で観光しました。', '在京都观光了。', 'kankou'),
              w('ja', 'b1', 2, 4, 'お土産', '伴手礼', 'お土産を買いました。', '买了伴手礼。', 'omiyage'),
              w('ja', 'b1', 2, 5, '流水/温泉', '温泉', '温泉に入りました。', '泡了温泉。', 'onsen'),
              w('ja', 'b1', 2, 6, '案内', '向导/指引', '道を案内してください。', '请给我带路。', 'annai')
            ]
          }
        ]
      }
    ]
  },
  {
    id: 'ko',
    name: '韩语',
    accent: '#7C6FE0',
    levels: [
      {
        id: 'ko-a1',
        name: '入门 1 级',
        desc: '韩语字母起步，掌握基础问候',
        courses: [
          {
            id: 'ko-a1-1',
            title: '问候与介绍',
            theme: '开口第一句',
            words: [
              w('ko', 'a1', 1, 1, '안녕하세요', '你好', '안녕하세요, 김선생님.', '你好，金老师。', 'annyeonghaseyo'),
              w('ko', 'a1', 1, 2, '감사합니다', '谢谢', '감사합니다.', '谢谢您。', 'gamsahamnida'),
              w('ko', 'a1', 1, 3, '죄송합니다', '对不起', '늦어서 죄송합니다.', '来晚了很抱歉。', 'joesonghamnida'),
              w('ko', 'a1', 1, 4, '이름', '名字', '이름이 뭐예요?', '你叫什么名字？', 'ireum'),
              w('ko', 'a1', 1, 5, '만나서 반갑습니다', '很高兴见到你', '만나서 반갑습니다.', '很高兴见到你。', 'mannaseo'),
              w('ko', 'a1', 1, 6, '안녕히 가세요', '再见（对走的人）', '안녕히 가세요.', '慢走，再见。', 'annyeonghi')
            ]
          },
          {
            id: 'ko-a1-2',
            title: '数字与购物',
            theme: '砍价付钱都方便',
            words: [
              w('ko', 'a1', 2, 1, '하나', '一', '하나, 둘, 셋.', '一、二、三。', 'hana'),
              w('ko', 'a1', 2, 2, '이거', '这个', '이거 주세요.', '请给我这个。', 'igeo'),
              w('ko', 'a1', 2, 3, '얼마', '多少钱', '이거 얼마예요?', '这个多少钱？', 'eolma'),
              w('ko', 'a1', 2, 4, '돈', '钱', '돈이 없어요.', '没有钱了。', 'don'),
              w('ko', 'a1', 2, 5, '비싸요', '贵', '너무 비싸요.', '太贵了。', 'bissayo'),
              w('ko', 'a1', 2, 6, '싸요', '便宜', '여기가 싸요.', '这里便宜。', 'ssayo')
            ]
          }
        ]
      },
      {
        id: 'ko-a2',
        name: '进阶 2 级',
        desc: '生活场景韩语，吃饭出行都会说',
        courses: [
          {
            id: 'ko-a2-1',
            title: '餐厅点餐',
            theme: '吃遍韩国不踩坑',
            words: [
              w('ko', 'a2', 1, 1, '메뉴', '菜单', '메뉴 좀 주세요.', '请给我菜单。', 'menyu'),
              w('ko', 'a2', 1, 2, '주문', '点单', '주문할게요.', '我要点餐。', 'jumun'),
              w('ko', 'a2', 1, 3, '맵다', '辣', '이 요리는 매워요?', '这道菜辣吗？', 'maepda'),
              w('ko', 'a2', 1, 4, '물', '水', '물 좀 주세요.', '请给我水。', 'mul'),
              w('ko', 'a2', 1, 5, '계산', '结账', '계산할게요.', '我要结账。', 'gyesan'),
              w('ko', 'a2', 1, 6, '맛있다', '好吃', '정말 맛있어요!', '真好吃！', 'masitda')
            ]
          },
          {
            id: 'ko-a2-2',
            title: '交通出行',
            theme: '地铁公交随便坐',
            words: [
              w('ko', 'a2', 2, 1, '지하철', '地铁', '지하철로 가요.', '坐地铁去。', 'jihacheol'),
              w('ko', 'a2', 2, 2, '표', '票', '표를 샀어요.', '我买好票了。', 'pyo'),
              w('ko', 'a2', 2, 3, '환승', '换乘', '여기서 환승해요.', '在这里换乘。', 'hwanseung'),
              w('ko', 'a2', 2, 4, '출구', '出口', '3번 출구로 나가요.', '从 3 号口出去。', 'chulgu'),
              w('ko', 'a2', 2, 5, '길', '路', '길을 잃었어요.', '我迷路了。', 'gil'),
              w('ko', 'a2', 2, 6, '얼마나', '多久/多少', '공항까지 얼마나 걸려요?', '到机场要多久？', 'eolmana')
            ]
          }
        ]
      },
      {
        id: 'ko-b1',
        name: '冲刺 3 级',
        desc: '职场与旅行深度表达',
        courses: [
          {
            id: 'ko-b1-1',
            title: '职场韩语',
            theme: '韩国职场混得开',
            words: [
              w('ko', 'b1', 1, 1, '회의', '会议', '오후에 회의가 있어요.', '下午有个会议。', 'hoeui'),
              w('ko', 'b1', 1, 2, '보고서', '报告', '보고서를 제출했어요.', '报告已提交。', 'bogoseo'),
              w('ko', 'b1', 1, 3, '확인', '确认', '다시 확인할게요.', '我再确认一下。', 'hwagin'),
              w('ko', 'b1', 1, 4, '마감', '截止', '마감일은 금요일이에요.', '截止日是周五。', 'magam'),
              w('ko', 'b1', 1, 5, '협조', '配合', '협조해 주셔서 감사합니다.', '感谢您的配合。', 'hyeopjo'),
              w('ko', 'b1', 1, 6, '성과', '成果', '좋은 성과를 냈어요.', '取得了好成果。', 'seonggwa')
            ]
          },
          {
            id: 'ko-b1-2',
            title: '旅行计划',
            theme: '自由行深度表达',
            words: [
              w('ko', 'b1', 2, 1, '예약', '预订', '호텔을 예약했어요.', '我预订了酒店。', 'yeyak'),
              w('ko', 'b1', 2, 2, '일정', '日程', '일정을 짜세요.', '来排一下日程吧。', 'iljeong'),
              w('ko', 'b1', 2, 3, '관광', '观光', '경복궁에서 관광했어요.', '在景福宫观光了。', 'gwangwang'),
              w('ko', 'b1', 2, 4, '기념품', '纪念品', '기념품을 샀어요.', '买了纪念品。', 'ginyeompum'),
              w('ko', 'b1', 2, 5, '환전', '换钱', '어디서 환전해요?', '在哪里换钱？', 'hwanjeon'),
              w('ko', 'b1', 2, 6, '안내', '指引', '길을 안내해 주세요.', '请给我指路。', 'annae')
            ]
          }
        ]
      }
    ]
  }
];

export function findCourse(courseId: string): { lang: LearnLang; level: LearnLevel; course: LearnCourse } | null {
  for (const lang of LEARN_LANGS) {
    for (const level of lang.levels) {
      const course = level.courses.find((c) => c.id === courseId);
      if (course) return { lang, level, course };
    }
  }
  return null;
}
