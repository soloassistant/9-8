import { useState, type CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import { getLearningSummary, getRecommendedPath, type LearnLangId } from '@learning/core';
import { useLearning } from '../app/App';

const recommendationLabels = {
  continue: '继续学习',
  review: '间隔复习',
  next: '开启新课'
} as const;

export function HomePage() {
  const { repository, refresh } = useLearning();
  const languages = repository.getLanguages();
  const [langId, setLangId] = useState<LearnLangId>(repository.getActiveLanguage());
  const lang = languages.find((item) => item.id === langId) || languages[0];
  const stats = repository.getLangStats(lang.id);
  const summary = getLearningSummary(repository);
  const path = getRecommendedPath(lang.id, repository);

  const chooseLanguage = (id: LearnLangId) => {
    setLangId(id);
    repository.setActiveLanguage(id);
    refresh();
  };

  return (
    <>
      <section className="hero-panel">
        <div>
          <p className="eyebrow">每天十分钟，打开一扇新世界</p>
          <h1>把“想学一门语言”<br /><em>变成今天的一小步。</em></h1>
          <p className="hero-copy">从高频词和真实场景开始，按自己的节奏积累表达。当前版本无需登录，打开就能体验完整的学习闭环。</p>
        </div>
        <div className="hero-orbit" aria-hidden="true">
          <span className="orbit-word word-one">hello</span>
          <span className="orbit-word word-two">こんにちは</span>
          <span className="orbit-word word-three">안녕</span>
          <span className="orbit-core">学<br />会</span>
        </div>
      </section>

      <section className="language-switcher section">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Choose your path</p>
            <h2>选择你的学习方向</h2>
          </div>
          <span className="section-note">
            三种语言 · {languages.reduce((total, item) => total + item.levels.reduce((sum, level) => sum + level.courses.length, 0), 0)} 门课程 · 立即可试用
          </span>
        </div>
        <div className="language-grid">
          {languages.map((item) => (
            <button
              className={item.id === lang.id ? 'language-card selected' : 'language-card'}
              key={item.id}
              onClick={() => chooseLanguage(item.id)}
              style={{ '--accent': item.accent } as CSSProperties}
            >
              <span className="language-dot" />
              <strong>{item.name}</strong>
              <span>{item.levels.length} 个阶段 · {item.levels.reduce((total, level) => total + level.courses.length, 0)} 门课</span>
            </button>
          ))}
        </div>
      </section>

      <section className="stats-strip section">
        <div className="stat-highlight"><strong>{summary.streak}</strong><span>连续学习天数</span></div>
        <div className="stat-highlight"><strong>{summary.learnedWords}<small>/{summary.totalWords}</small></strong><span>已掌握词汇</span></div>
        <div className="stat-highlight"><strong>{stats.percent}%</strong><span>{lang.name}完成度</span></div>
        <div className="stat-progress">
          <div className="progress-label"><span>{lang.name}学习进度</span><strong>{stats.coursesDone}/{stats.coursesTotal} 课程</strong></div>
          <div className="progress-track"><span style={{ width: stats.percent + '%', background: lang.accent }} /></div>
        </div>
      </section>

      {path.length > 0 && (
        <section className="recommendation section">
          <div className="section-heading compact">
            <div>
              <p className="eyebrow">Your next move</p>
              <h2>为你排好的下一步</h2>
            </div>
            <span className="section-note">根据当前进度动态生成</span>
          </div>
          <div className="recommendation-list">
            {path.map((step, index) => (
              <Link className="recommendation-item" to={'/course/' + step.courseId} key={step.courseId}>
                <span className="recommendation-index" style={{ background: lang.accent }}>{String(index + 1).padStart(2, '0')}</span>
                <span className="recommendation-copy"><strong>{step.title}</strong><small>{step.reason}</small></span>
                <span className="recommendation-type">{recommendationLabels[step.type]} <b>→</b></span>
              </Link>
            ))}
          </div>
        </section>
      )}

      <section className="courses section">
        <div className="section-heading">
          <div>
            <p className="eyebrow">{lang.name} learning map</p>
            <h2>从场景出发，逐级前进</h2>
          </div>
          <span className="section-note">{lang.name} · 当前选择</span>
        </div>
        <div className="level-list">
          {lang.levels.map((level, levelIndex) => (
            <div className="level-row" key={level.id}>
              <div className="level-marker">
                <span>{String(levelIndex + 1).padStart(2, '0')}</span>
                <i />
              </div>
              <div className="level-content">
                <div className="level-title"><h3>{level.name}</h3><p>{level.desc}</p></div>
                <div className="course-grid">
                  {level.courses.map((course) => {
                    const progress = repository.getCourseProgress(course.id);
                    const percent = Math.round((progress.learned.length / course.words.length) * 100);
                    return (
                      <Link className="course-card" to={'/course/' + course.id} key={course.id}>
                        <div className="course-card-top"><span className="course-kicker">{course.words.length} 个词</span>{percent >= 100 && <span className="complete-tag">已完成</span>}</div>
                        <h4>{course.title}</h4>
                        <p>{course.theme}</p>
                        <div className="course-progress"><span style={{ width: percent + '%', background: lang.accent }} /></div>
                        <div className="course-card-bottom"><span>{progress.learned.length}/{course.words.length} 已掌握</span><b>→</b></div>
                      </Link>
                    );
                  })}
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="community-banner section">
        <div><p className="eyebrow">Learn together</p><h2>每一次打卡，都值得被看见。</h2><p>看看其他学习者正在坚持什么，也留下你的第一条学习记录。</p></div>
        <Link className="button button-dark" to="/community">进入打卡社区 <span>→</span></Link>
      </section>
    </>
  );
}
