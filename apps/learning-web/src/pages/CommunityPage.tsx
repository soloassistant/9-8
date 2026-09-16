import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Achievement, CommunityPost } from '@learning/core';
import { useLearning } from '../app/App';

function relativeTime(iso: string): string {
  const hours = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 3600000));
  if (hours < 1) return '刚刚';
  if (hours < 24) return hours + ' 小时前';
  return Math.floor(hours / 24) + ' 天前';
}

export function CommunityPage() {
  const { repository, refresh } = useLearning();
  const [achievements, setAchievements] = useState<Achievement[]>([]);
  const [posts, setPosts] = useState<CommunityPost[]>([]);
  const [name, setName] = useState('我');
  const [draft, setDraft] = useState('');
  const [editingName, setEditingName] = useState(false);
  const [notice, setNotice] = useState('');

  const reload = () => {
    setAchievements(repository.getAchievements());
    setPosts(repository.getCommunityPosts());
    setName(repository.getLearnerName());
  };

  useEffect(reload, [repository]);

  const submit = () => {
    if (!draft.trim()) {
      setNotice('先写下一点今天的学习感受吧。');
      return;
    }
    repository.addPost({ text: draft });
    setDraft('');
    setNotice('已发布到打卡墙。');
    reload();
    refresh();
  };

  const saveName = () => {
    repository.setLearnerName(name);
    setEditingName(false);
    reload();
    refresh();
  };

  const like = (id: string) => {
    repository.toggleLike(id);
    reload();
    refresh();
  };

  const unlocked = achievements.filter((item) => item.unlockedAt).length;
  const streak = repository.getStreak();

  return (
    <>
      <section className="community-head"><div><Link className="back-link light-link" to="/">← 返回学习地图</Link><p className="eyebrow">A small step, shared</p><h1>把坚持变成<br /><em>彼此看得见的光。</em></h1><p>这里是学习者的轻量打卡墙。首期使用演示内容和本地数据，先验证分享与激励是否让学习更容易持续。</p></div><div className="community-stat"><strong>🔥 {streak}</strong><span>连续学习天数</span><small>{unlocked}/{achievements.length} 个成就已解锁</small></div></section>
      <section className="profile-card section"><div className="avatar">{name.slice(0, 1)}</div><div className="profile-copy">{editingName ? <div className="name-edit"><input autoFocus maxLength={12} value={name} onChange={(event) => setName(event.target.value)} onKeyDown={(event) => event.key === 'Enter' && saveName()} /><button onClick={saveName}>保存</button></div> : <button className="profile-name" onClick={() => setEditingName(true)}>{name} <span>编辑</span></button>}<p>今天也给自己留一点学习时间。</p></div><span className="profile-label">学习者档案</span></section>
      <section className="achievement-section section"><div className="section-heading"><div><p className="eyebrow">Keep going</p><h2>成就徽章墙</h2></div><span className="section-note">{unlocked} / {achievements.length} 已解锁</span></div><div className="achievement-grid">{achievements.map((item) => <div className={item.unlockedAt ? 'achievement unlocked' : 'achievement'} key={item.id}><span className="achievement-icon">{item.icon}</span><strong>{item.name}</strong><small>{item.unlockedAt ? item.desc : item.progress + '%'}</small></div>)}</div></section>
      <section className="wall-section section"><div className="section-heading"><div><p className="eyebrow">Community wall</p><h2>今日打卡</h2></div><span className="section-note">演示内容会明确标记</span></div><div className="post-composer"><textarea maxLength={200} placeholder="今天学会了什么？写下一句话吧……" value={draft} onChange={(event) => setDraft(event.target.value)} /><div className="composer-bottom"><span>{draft.length}/200</span><button className="button button-dark" onClick={submit}>发布打卡 →</button></div>{notice && <p className="notice">{notice}</p>}</div><div className="post-list">{posts.map((post) => <article className="post" key={post.id}><div className="post-avatar">{post.name.slice(0, 1)}</div><div className="post-content"><div className="post-meta"><strong>{post.name}</strong><span>· {post.langName}</span>{post.demo && <small className="demo-label">演示内容</small>}<time>{relativeTime(post.at)}</time></div><p>{post.text}</p><button className={post.liked ? 'like-button liked' : 'like-button'} onClick={() => like(post.id)}>{post.liked ? '❤️' : '🤍'} {post.likes}</button></div></article>)}</div></section>
    </>
  );
}
