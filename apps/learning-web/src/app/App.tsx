import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import { HashRouter, Link, NavLink, Route, Routes, useLocation } from 'react-router-dom';
import { LocalLearningRepository, type LearningRepository } from '@learning/core';
import { CommunityPage } from '../pages/CommunityPage';
import { CoursePage } from '../pages/CoursePage';
import { HomePage } from '../pages/HomePage';

interface LearningContextValue {
  repository: LearningRepository;
  refresh: () => void;
}

const LearningContext = createContext<LearningContextValue | null>(null);

export function useLearning(): LearningContextValue {
  const value = useContext(LearningContext);
  if (!value) throw new Error('useLearning must be used inside LearningContext');
  return value;
}

function Layout({ children }: { children: ReactNode }) {
  const location = useLocation();
  const isHome = location.pathname === '/';
  return (
    <div className="site-shell">
      <header className="site-header">
        <Link className="brand" to="/">
          <span className="brand-mark">语</span>
          <span>
            <strong>语桥</strong>
            <small>多语种学习平台</small>
          </span>
        </Link>
        <nav className="main-nav" aria-label="主导航">
          <NavLink className={({ isActive }) => (isActive && isHome ? 'nav-link active' : 'nav-link')} to="/">
            学习地图
          </NavLink>
          <NavLink className={({ isActive }) => (isActive ? 'nav-link active' : 'nav-link')} to="/community">
            打卡社区
          </NavLink>
        </nav>
        <span className="demo-pill">Web MVP · 演示模式</span>
      </header>
      <main className="site-main">{children}</main>
      <footer className="site-footer">
        <span>先让学习发生，再让数据变得更聪明。</span>
        <span>本地数据仅保存在当前浏览器</span>
      </footer>
    </div>
  );
}

export default function App() {
  const [revision, setRevision] = useState(0);
  const repository = useMemo(() => new LocalLearningRepository(), []);
  const context = useMemo(
    () => ({ repository, refresh: () => setRevision((value) => value + 1) }),
    [repository, revision]
  );

  return (
    <LearningContext.Provider value={context}>
      {/*
        使用 HashRouter 而非 BrowserRouter：本应用部署在独立静态托管的域名根下，
        没有服务端 rewrite 也能保证任意深链接刷新可用（例：#/course/en-a1-1）。
        代价是 URL 带 #；若后续改用 history 模式，需同时配置托管侧 SPA 回退并移除本注释。
      */}
      <HashRouter>
        <Layout>
          <Routes>
            <Route path="/" element={<HomePage />} />
            <Route path="/course/:courseId" element={<CoursePage />} />
            <Route path="/community" element={<CommunityPage />} />
            <Route path="*" element={<HomePage />} />
          </Routes>
        </Layout>
      </HashRouter>
    </LearningContext.Provider>
  );
}
