import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useLearning } from '../app/App';

export function CoursePage() {
  const { courseId } = useParams();
  const { repository, refresh } = useLearning();
  const found = useMemo(() => repository.getCourse(courseId || ''), [repository, courseId]);
  const [index, setIndex] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [finished, setFinished] = useState(false);
  const [learned, setLearned] = useState<Set<string>>(
    () => new Set(repository.getCourseProgress(courseId || '').learned)
  );

  useEffect(() => {
    setIndex(0);
    setFlipped(false);
    setFinished(false);
    setLearned(new Set(repository.getCourseProgress(courseId || '').learned));
  }, [repository, courseId]);

  if (!found) {
    return <section className="empty-panel"><span className="empty-icon">📖</span><h1>找不到这门课程</h1><p>课程可能已经移动，回到学习地图重新选择吧。</p><Link className="button button-dark" to="/">返回学习地图</Link></section>;
  }

  const { course, lang } = found;
  const word = course.words[index];
  const markWord = (known: boolean) => {
    if (!word) return;
    const next = new Set(learned);
    if (known) next.add(word.id);
    else next.delete(word.id);
    setLearned(next);
    repository.markWords(course.id, [word.id], known);
    if (next.size >= course.words.length) repository.completeCourse(course.id, true);
    refresh();
    if (index >= course.words.length - 1) setFinished(true);
    else {
      setIndex(index + 1);
      setFlipped(false);
    }
  };

  if (finished || !word) {
    return (
      <section className="finish-panel">
        <span className="finish-emoji">🎉</span>
        <p className="eyebrow">Session complete</p>
        <h1>这一轮学习完成了</h1>
        <p className="finish-result">你掌握了 <strong>{learned.size}/{course.words.length}</strong> 个词</p>
        <p className="finish-copy">不必一次记住所有内容。今天留下的痕迹，会成为下一次复习的起点。</p>
        <div className="button-row"><button className="button button-light" onClick={() => { setIndex(0); setFlipped(false); setFinished(false); }}>再来一轮</button><Link className="button button-dark" to="/">回到课程地图</Link></div>
      </section>
    );
  }

  return (
    <section className="study-shell">
      <Link className="back-link" to="/">← 返回学习地图</Link>
      <div className="study-heading"><div><p className="eyebrow">{lang.name} · {course.theme}</p><h1>{course.title}</h1></div><span className="study-counter">{index + 1} / {course.words.length}</span></div>
      <div className="study-progress"><span style={{ width: ((index + 1) / course.words.length) * 100 + '%', background: lang.accent }} /></div>
      <button className={flipped ? 'word-card flipped' : 'word-card'} onClick={() => setFlipped((value) => !value)} aria-label="点击翻卡">
        {!flipped ? <><span className="word-term" style={{ color: lang.accent }}>{word.term}</span>{word.reading && <span className="word-reading">{word.reading}</span>}<span className="flip-hint">点击卡片查看释义</span></> : <><span className="word-meaning">{word.meaning}</span><span className="word-example">{word.example}</span><span className="word-example-cn">{word.exampleCn}</span></>}
      </button>
      <div className="study-actions"><button className="button button-light" onClick={() => markWord(false)}>还不熟</button><button className="button button-accent" style={{ background: lang.accent }} onClick={() => markWord(true)}>已经掌握</button></div>
      <p className="mastery-note">本轮已掌握 {learned.size} / {course.words.length} 个词</p>
    </section>
  );
}
