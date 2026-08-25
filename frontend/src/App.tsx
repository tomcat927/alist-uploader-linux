import { useEffect, useState } from 'react';
import { api } from './api';
import { DEFAULT_APP_CONFIG, normalizeAppConfig, type AddToQueueResult, type AppConfig, type FsEntry, type UploadState, type UploadTask } from './types';
import './App.css';

type Tab = 'queue' | 'files' | 'history' | 'settings';

const formatBytes = (n: number) => {
  if (!n) return '-';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log2(n) / 10), units.length - 1);
  return `${(n / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
};

const statusLabel: Record<string, string> = { pending: '等待', uploading: '上传中', completed: '完成', failed: '失败', cancelled: '已取消' };

function App() {
  const [tab, setTab] = useState<Tab>('queue');
  const [queue, setQueue] = useState<UploadTask[]>([]);
  const [history, setHistory] = useState<UploadTask[]>([]);
  const [config, setConfig] = useState<AppConfig>(DEFAULT_APP_CONFIG);
  const [form, setForm] = useState<AppConfig>(DEFAULT_APP_CONFIG);
  const [uploadState, setUploadState] = useState<UploadState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [roots, setRoots] = useState<FsEntry[]>([]);
  const [currentPath, setCurrentPath] = useState('/');
  const [entries, setEntries] = useState<FsEntry[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [alistTarget, setAlistTarget] = useState('/');
  const [browsing, setBrowsing] = useState(false);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'ok' | 'err'>('idle');
  const [historyRetryIds, setHistoryRetryIds] = useState<Set<string>>(new Set());

  const fail = (e: unknown) => { setError(e instanceof Error ? e.message : String(e)); };
  const flashNotice = (msg: string) => { setNotice(msg); setTimeout(() => setNotice(''), 4000); };

  const loadDir = async (path: string) => {
    setBrowsing(true); setError('');
    try {
      const list = await api<FsEntry[]>('GET', `/api/fs/list?path=${encodeURIComponent(path)}`);
      setEntries(list); setCurrentPath(path);
    } catch (e) { fail(e); }
    setBrowsing(false);
  };

  const refreshData = async () => {
    try {
      const [q, h, us] = await Promise.all([
        api<UploadTask[]>('GET', '/api/queue'),
        api<UploadTask[]>('GET', '/api/history'),
        api<UploadState>('GET', '/api/upload/state'),
      ]);
      setQueue(q); setHistory(h); setUploadState(us);
    } catch (e) { fail(e); }
  };

  useEffect(() => {
    const init = async () => {
      try {
        const [cfg, fsRoots] = await Promise.all([
          api<AppConfig>('GET', '/api/config').catch(() => DEFAULT_APP_CONFIG),
          api<FsEntry[]>('GET', '/api/fs/roots').catch(() => []),
        ]);
        const normalized = normalizeAppConfig(cfg);
        setConfig(normalized); setForm(normalized);
        setAlistTarget(normalized.upload.last_alist_path || '/');
        setRoots(fsRoots);
        await loadDir('/');
        await refreshData();
      } catch (e) { fail(e); }
      setLoading(false);
    };
    init();
    const timer = setInterval(refreshData, 2000);
    return () => clearInterval(timer);
  }, []);

  const startUpload = async () => {
    setError('');
    try { await api('POST', '/api/upload/start'); } catch (e) { fail(e); }
  };
  const pauseUpload = async () => {
    try { await api('POST', '/api/upload/pause'); } catch (e) { fail(e); }
  };
  const clearQueue = async () => {
    try { await api('DELETE', '/api/queue'); flashNotice('队列已清空'); } catch (e) { fail(e); }
  };
  const removeTask = async (id: string) => {
    try { await api('DELETE', `/api/queue/${encodeURIComponent(id)}`); } catch (e) { fail(e); }
  };
  const retryTask = async (id: string) => {
    try {
      await api('POST', `/api/retry/${encodeURIComponent(id)}`);
      setHistoryRetryIds(prev => new Set(prev).add(id));
      setTimeout(() => setHistoryRetryIds(prev => { const n = new Set(prev); n.delete(id); return n; }), 3000);
    } catch (e) { fail(e); }
  };

  const toggleSelect = (entry: FsEntry) => {
    setSelected(prev => { const n = new Set(prev); n.has(entry.path) ? n.delete(entry.path) : n.add(entry.path); return n; });
  };
  const addSelected = async () => {
    if (!alistTarget || alistTarget === '/') { flashNotice('请先选择 Alist 目标目录（不能是根目录）'); return; }
    const paths = [...selected];
    if (!paths.length) { flashNotice('请先选择文件或目录'); return; }
    setError('');
    const warnings: string[] = [];
    for (const filePath of paths) {
      try {
        const result = await api<AddToQueueResult>('POST', '/api/queue', { file_path: filePath, alist_path: alistTarget });
        warnings.push(...result.warnings);
      } catch (e) { fail(e); }
    }
    flashNotice(warnings.length ? `已加入队列（${warnings.length} 条提示）` : `已加入队列`);
    setSelected(new Set());
    setTab('queue');
  };

  const handleSaveConfig = async () => {
    setSaveStatus('idle');
    try {
      await api('PUT', '/api/config', form);
      setConfig(normalizeAppConfig(form));
      setSaveStatus('ok');
      setTimeout(() => setSaveStatus('idle'), 3000);
    } catch (e) { fail(e); setSaveStatus('err'); }
  };
  const handleLogin = async () => {
    try {
      await api<string>('POST', '/api/alist/login', { base_url: form.alist.base_url, username: form.alist.username, password: form.alist.password });
      flashNotice('登录成功');
      const cfg = await api<AppConfig>('GET', '/api/config');
      const normalized = normalizeAppConfig(cfg);
      setConfig(normalized); setForm(normalized);
    } catch (e) { fail(e); }
  };
  const handleTest = async () => {
    try {
      const ok = await api<boolean>('POST', '/api/alist/test', { config: form });
      flashNotice(ok ? '连接成功' : 'Token 无效或未登录');
    } catch (e) { fail(e); }
  };

  if (loading) return <div className="loading">加载中...</div>;

  const isUp = uploadState?.is_uploading ?? false;
  const isStopping = uploadState?.is_stopping ?? false;

  return (
    <div className="app">
      <header className="header">
        <div className="header-left">
          <h1>Alist Uploader</h1>
          <span className={`status-dot ${isUp ? 'up' : isStopping ? 'stopping' : 'idle'}`} />
          <span className="status-label">{isUp ? '上传中' : isStopping ? '停止中' : '空闲'}</span>
        </div>
        <nav className="tabs">
          {(['queue', 'files', 'history', 'settings'] as Tab[]).map(t => (
            <button key={t} className={`tab ${tab === t ? 'active' : ''}`} onClick={() => setTab(t)}>
              {{ queue: '队列', files: '文件', history: '历史', settings: '设置' }[t]}
            </button>
          ))}
        </nav>
      </header>

      {(error || notice) && <div className={`banner ${error ? 'error' : 'notice'}`}>{error || notice}</div>}

      <main className="main">
        {tab === 'queue' && (
          <div className="panel">
            <div className="toolbar">
              <input className="path-input" value={alistTarget} onChange={e => setAlistTarget(e.target.value)} placeholder="Alist 目标路径" />
              <button className="btn" onClick={() => setTab('files')}>浏览磁盘</button>
              <button className="btn primary" onClick={startUpload} disabled={isUp}>开始上传</button>
              <button className="btn" onClick={pauseUpload} disabled={!isUp}>暂停</button>
              <button className="btn danger" onClick={clearQueue}>清空队列</button>
            </div>
            {queue.length === 0 ? <div className="empty">队列为空</div> : (
              <div className="list">
                {queue.map(task => (
                  <div key={task.id} className="row">
                    <div className="row-main">
                      <span className="row-name">{task.file.name}</span>
                      <span className="row-meta">{formatBytes(task.file.size)} → {task.alist_path}</span>
                      <span className={`badge ${task.status}`}>{statusLabel[task.status]}</span>
                      {task.status === 'uploading' && <span className="progress">{task.progress}%{task.speed > 0 ? ` (${formatBytes(task.speed)}/s)` : ''}</span>}
                      {task.error && <span className="error-text">{task.error}</span>}
                    </div>
                    <button className="btn small" onClick={() => removeTask(task.id)} disabled={task.status === 'uploading'}>删除</button>
                  </div>
                ))}
              </div>
            )}
            {isUp && <div className="upload-summary">已上传 {uploadState?.tasks_uploaded ?? 0} / 失败 {uploadState?.tasks_failed ?? 0}</div>}
          </div>
        )}

        {tab === 'files' && (
          <div className="panel">
            <div className="toolbar">
              <div className="roots">
                {roots.map(r => <button key={r.path} className="btn small" onClick={() => loadDir(r.path)}>{r.name}</button>)}
              </div>
            </div>
            <div className="path-bar">
              <input className="path-input" value={currentPath} onChange={e => setCurrentPath(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') loadDir(currentPath); }} />
              <button className="btn small" onClick={() => loadDir(currentPath)}>进入</button>
            </div>
            <div className="toolbar">
              <span className="select-info">已选 {selected.size} 项</span>
              <input className="path-input" value={alistTarget} onChange={e => setAlistTarget(e.target.value)} placeholder="Alist 目标路径" />
              <button className="btn primary small" onClick={addSelected} disabled={selected.size === 0 || !alistTarget || alistTarget === '/'}>加入队列</button>
            </div>
            {browsing ? <div className="empty">加载中...</div> : (
              <div className="list">
                {entries.map(entry => (
                  <div key={entry.path} className="row file-row" onClick={() => entry.is_dir && loadDir(entry.path)}>
                    <input type="checkbox" checked={selected.has(entry.path)} onChange={() => toggleSelect(entry)} onClick={e => e.stopPropagation()} />
                    <span className={`file-icon ${entry.is_dir ? 'dir' : 'file'}`}>{entry.is_dir ? '📁' : '📄'}</span>
                    <span className="row-name">{entry.name}</span>
                    <span className="row-meta">{entry.is_dir ? '-' : formatBytes(entry.size)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {tab === 'history' && (
          <div className="panel">
            {history.length === 0 ? <div className="empty">暂无历史记录</div> : (
              <div className="list">
                {history.map(task => (
                  <div key={task.id} className="row">
                    <div className="row-main">
                      <span className="row-name">{task.file.name}</span>
                      <span className="row-meta">{formatBytes(task.file.size)} → {task.alist_path}</span>
                      <span className={`badge ${task.status}`}>{statusLabel[task.status]}</span>
                      {task.duration && <span className="row-meta">耗时 {task.duration}s</span>}
                      {task.error && <span className="error-text">{task.error}</span>}
                    </div>
                    {task.status === 'failed' && (
                      <button className="btn small" onClick={() => retryTask(task.id)} disabled={historyRetryIds.has(task.id)}>
                        {historyRetryIds.has(task.id) ? '已加入队列' : '重试'}
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {tab === 'settings' && (
          <div className="panel settings">
            <section>
              <h3>Alist 连接</h3>
              <label>服务地址 <input value={form.alist.base_url} onChange={e => setForm({ ...form, alist: { ...form.alist, base_url: e.target.value } })} /></label>
              <label>用户名 <input value={form.alist.username} onChange={e => setForm({ ...form, alist: { ...form.alist, username: e.target.value } })} /></label>
              <label>密码 <input type="password" value={form.alist.password} onChange={e => setForm({ ...form, alist: { ...form.alist, password: e.target.value } })} /></label>
              <label>Token <input value={form.alist.token} onChange={e => setForm({ ...form, alist: { ...form.alist, token: e.target.value } })} /></label>
              <div className="actions">
                <button className="btn" onClick={handleTest}>测试连接</button>
                <button className="btn primary" onClick={handleLogin}>登录</button>
              </div>
            </section>
            <section>
              <h3>上传配置</h3>
              <label>并发数 <input type="number" min={1} max={10} value={form.upload.concurrency} onChange={e => setForm({ ...form, upload: { ...form.upload, concurrency: parseInt(e.target.value) || 1 } })} /></label>
              <label>最大重试 <input type="number" min={0} max={20} value={form.upload.max_retries} onChange={e => setForm({ ...form, upload: { ...form.upload, max_retries: parseInt(e.target.value) || 5 } })} /></label>
              <label>上传方式 <select value={form.upload.upload_method} onChange={e => setForm({ ...form, upload: { ...form.upload, upload_method: e.target.value } })}><option value="stream">Stream</option><option value="form">Form</option></select></label>
              <label><input type="checkbox" checked={form.upload.as_task} onChange={e => setForm({ ...form, upload: { ...form.upload, as_task: e.target.checked } })} /> 使用 Alist 后台任务</label>
              <label>限速 (MB/s) <input type="number" min={0} max={1000} step={0.1} value={form.upload.speed_limit / 1000000} onChange={e => setForm({ ...form, upload: { ...form.upload, speed_limit: Math.round((parseFloat(e.target.value) || 0) * 1000000) } })} /></label>
            </section>
            <section>
              <h3>通知</h3>
              <label><input type="checkbox" checked={form.upload.notification?.enabled ?? false} onChange={e => setForm({ ...form, upload: { ...form.upload, notification: { enabled: e.target.checked, webhook_url: form.upload.notification?.webhook_url || '', channels: ['feishu'] } } })} /> 启用飞书通知</label>
              {form.upload.notification?.enabled && <label>Webhook URL <input value={form.upload.notification?.webhook_url || ''} onChange={e => setForm({ ...form, upload: { ...form.upload, notification: { ...form.upload.notification!, webhook_url: e.target.value } } })} /></label>}
            </section>
            <section>
              <h3>历史记录</h3>
              <label>保留天数 <input type="number" min={1} max={365} value={form.history.retention_days} onChange={e => setForm({ ...form, history: { ...form.history, retention_days: parseInt(e.target.value) || 30 } })} /></label>
            </section>
            <div className="actions">
              <button className="btn primary" onClick={handleSaveConfig}>保存配置</button>
              {saveStatus === 'ok' && <span className="ok">已保存</span>}
              {saveStatus === 'err' && <span className="err">保存失败</span>}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

export default App;
