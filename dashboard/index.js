import React from 'react';

const h = React.createElement;

const styles = `
.ac-root{--ac-border:#d8dde5;--ac-muted:#667085;--ac-soft:#f6f7f9;--ac-ink:#182230;--ac-accent:#1769e0;color:var(--ac-ink);font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;letter-spacing:0}
.ac-root *{box-sizing:border-box}.ac-root button,.ac-root input{font:inherit;letter-spacing:0}.ac-root button{cursor:pointer}.ac-root button:disabled{cursor:not-allowed;opacity:.55}
.ac-topline{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:0 0 16px;border-bottom:1px solid var(--ac-border)}
.ac-service{display:flex;align-items:center;gap:9px;font-size:13px;color:var(--ac-muted)}.ac-dot{width:9px;height:9px;border-radius:50%;background:#98a2b3;box-shadow:0 0 0 3px #f2f4f7}.ac-dot.is-online{background:#159455;box-shadow:0 0 0 3px #e6f6ed}.ac-service strong{color:var(--ac-ink);font-weight:650}
.ac-top-actions{display:flex;align-items:center;gap:8px}.ac-button{height:34px;border:1px solid var(--ac-border);border-radius:6px;background:#fff;color:#344054;padding:0 12px;font-weight:600;font-size:13px}.ac-button:hover{background:#f8fafc}.ac-button.is-primary{border-color:var(--ac-accent);background:var(--ac-accent);color:#fff}.ac-button.is-danger{color:#b42318}.ac-icon-button{width:34px;padding:0;font-size:17px}
.ac-error{margin:14px 0 0;border-left:3px solid #d92d20;background:#fff4f2;color:#912018;padding:10px 12px;font-size:13px}.ac-layout{display:grid;grid-template-columns:minmax(240px,300px) minmax(0,1fr);min-height:580px}
.ac-sidebar{border-right:1px solid var(--ac-border);padding:18px 18px 18px 0;min-width:0}.ac-sidebar-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px}.ac-sidebar-head h2{font-size:14px;line-height:20px;margin:0;font-weight:700}.ac-count{display:inline-flex;min-width:24px;height:22px;align-items:center;justify-content:center;border-radius:11px;background:#eef2f6;color:#475467;font-size:12px;font-weight:700}
.ac-session-list{display:flex;flex-direction:column;gap:6px}.ac-session{width:100%;text-align:left;border:1px solid transparent;border-radius:6px;background:transparent;padding:10px 11px;color:inherit}.ac-session:hover{background:var(--ac-soft)}.ac-session.is-active{border-color:#b9d4fb;background:#edf5ff}.ac-session-title{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:13px;font-weight:680;line-height:19px}.ac-session-meta{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:3px;color:var(--ac-muted);font-size:12px;line-height:17px}.ac-empty{padding:36px 18px;text-align:center;color:var(--ac-muted);font-size:13px;line-height:1.6}.ac-main{padding:18px 0 18px 22px;min-width:0}
.ac-session-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:16px}.ac-session-head h2{font-size:18px;line-height:25px;margin:0 0 3px;font-weight:720}.ac-session-sub{margin:0;color:var(--ac-muted);font-size:12px}.ac-mode{display:inline-flex;border:1px solid var(--ac-border);border-radius:6px;padding:3px;background:#f7f8fa}.ac-mode button{height:29px;border:0;border-radius:4px;background:transparent;color:#667085;padding:0 12px;font-size:12px;font-weight:650}.ac-mode button.is-active{background:#fff;color:#182230;box-shadow:0 1px 2px rgba(16,24,40,.12)}
.ac-workspace{display:grid;grid-template-columns:minmax(0,1fr);gap:14px}.ac-workspace.has-pages{grid-template-columns:minmax(180px,230px) minmax(0,1fr)}.ac-pages{border:1px solid var(--ac-border);border-radius:6px;overflow:hidden;background:#fff}.ac-pages-title{padding:11px 12px;border-bottom:1px solid var(--ac-border);font-size:12px;font-weight:700;color:#475467}.ac-page-list{display:flex;flex-direction:column;padding:5px}.ac-page{border:0;border-radius:4px;background:transparent;padding:9px;text-align:left;color:inherit}.ac-page:hover{background:var(--ac-soft)}.ac-page.is-active{background:#edf5ff}.ac-page-title{display:block;font-size:12px;font-weight:650;line-height:18px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.ac-page-url{display:block;margin-top:2px;color:var(--ac-muted);font-size:11px;line-height:16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ac-view{min-width:0}.ac-view-toolbar{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:9px}.ac-view-state{display:flex;align-items:center;gap:8px;color:#475467;font-size:12px}.ac-live{display:inline-flex;align-items:center;gap:6px;font-weight:650}.ac-live:before{content:"";width:7px;height:7px;border-radius:50%;background:#159455}.ac-view-actions{display:flex;align-items:center;gap:7px;flex-wrap:wrap;justify-content:flex-end}.ac-control{display:inline-flex;align-items:center;gap:7px;height:34px;border:1px solid var(--ac-border);border-radius:6px;background:#fff;padding:0 10px;color:#344054;font-size:12px;font-weight:600}.ac-control input{accent-color:var(--ac-accent)}
.ac-screen{position:relative;width:100%;aspect-ratio:16/10;min-height:380px;max-height:calc(100vh - 330px);border:1px solid #202632;border-radius:6px;overflow:hidden;background:#11151b}.ac-screen iframe{display:block;width:100%;height:100%;border:0;background:#11151b}.ac-screen-empty{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:24px;text-align:center;color:#c7cdd6;font-size:13px;line-height:1.6}.ac-footnote{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:8px;color:var(--ac-muted);font-size:11px}.ac-token{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
@media(max-width:900px){.ac-layout{grid-template-columns:1fr}.ac-sidebar{border-right:0;border-bottom:1px solid var(--ac-border);padding-right:0}.ac-session-list{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr))}.ac-main{padding-left:0}.ac-workspace.has-pages{grid-template-columns:1fr}.ac-pages{max-height:220px;overflow:auto}}
@media(max-width:620px){.ac-topline,.ac-session-head,.ac-view-toolbar{align-items:stretch;flex-direction:column}.ac-top-actions,.ac-view-actions{justify-content:flex-start}.ac-screen{min-height:280px}.ac-mode{align-self:flex-start}}
`;

function serviceOpenUrl(report) {
  const value = report?.openUrl || report?.urls?.openUrl;
  return typeof value === 'string' && value ? value : null;
}

function serviceOnline(report) {
  const status = String(report?.status || '').toLowerCase();
  return status === 'online' || status === 'running' || report?.healthy === true;
}

function shortId(value) {
  if (!value) return '-';
  return value.length > 14 ? `${value.slice(0, 8)}...${value.slice(-4)}` : value;
}

function relativeTime(value) {
  const timestamp = typeof value === 'number' ? value : Date.parse(value || '');
  if (!Number.isFinite(timestamp)) return '刚刚';
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return `${seconds} 秒前`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.round(hours / 24)} 天前`;
}

function sessionPresentation(browserSession, botmuxSession) {
  const sessionId = browserSession.botmuxSessionId || '';
  const title = botmuxSession?.title || botmuxSession?.chatDisplayName || shortId(sessionId || browserSession.token);
  const meta = [
    botmuxSession?.botName,
    botmuxSession?.cliId,
    relativeTime(botmuxSession?.lastMessageAt || browserSession.updatedAt),
  ].filter(Boolean).join(' · ');
  return { title, meta: meta || `Browser ${shortId(browserSession.token)}` };
}

function brokerUrl(baseUrl, pathname) {
  const url = new URL(pathname.replace(/^\//, ''), baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
  return url.toString();
}

async function fetchJson(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal, cache: 'no-store' });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body?.error || `HTTP ${response.status}`);
    return body;
  } finally {
    clearTimeout(timer);
  }
}

export default class AgentChromeDashboard extends React.Component {
  constructor(props) {
    super(props);
    this.state = {
      loading: true,
      service: null,
      browserSessions: [],
      botmuxSessions: [],
      selectedToken: null,
      error: null,
      pending: null,
      copied: false,
    };
    this.refresh = this.refresh.bind(this);
  }

  componentDidMount() {
    this.refresh();
    this.pollTimer = setInterval(() => this.refresh(true), 3000);
  }

  componentWillUnmount() {
    clearInterval(this.pollTimer);
    clearTimeout(this.copyTimer);
  }

  async refresh(silent = false) {
    if (!silent) this.setState({ loading: true, error: null });
    try {
      const service = await this.props.api.getServiceStatus();
      const openUrl = serviceOpenUrl(service);
      const [browserBody, botmuxBody] = await Promise.all([
        openUrl ? fetchJson(brokerUrl(openUrl, '/sessions')) : Promise.resolve([]),
        fetchJson('/api/sessions'),
      ]);
      const browserSessions = Array.isArray(browserBody) ? browserBody : [];
      const botmuxSessions = Array.isArray(botmuxBody?.sessions) ? botmuxBody.sessions : [];
      this.setState(previous => ({
        loading: false,
        service,
        browserSessions,
        botmuxSessions,
        selectedToken: browserSessions.some(item => item.token === previous.selectedToken)
          ? previous.selectedToken
          : browserSessions[0]?.token || null,
        error: null,
      }));
    } catch (error) {
      this.setState({ loading: false, error: error instanceof Error ? error.message : String(error) });
    }
  }

  currentSession() {
    return this.state.browserSessions.find(item => item.token === this.state.selectedToken) || null;
  }

  currentBotmuxSession(browserSession) {
    return this.state.botmuxSessions.find(item => item.sessionId === browserSession?.botmuxSessionId) || null;
  }

  async mutate(label, pathname, body) {
    const openUrl = serviceOpenUrl(this.state.service);
    if (!openUrl) return;
    this.setState({ pending: label, error: null });
    try {
      const next = await fetchJson(brokerUrl(openUrl, pathname), {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      this.setState(previous => ({
        browserSessions: previous.browserSessions.map(item => item.token === next.token ? next : item),
        pending: null,
      }));
    } catch (error) {
      this.setState({ pending: null, error: error instanceof Error ? error.message : String(error) });
    }
  }

  setMode(mode) {
    const session = this.currentSession();
    if (!session || session.mode === mode) return;
    this.mutate('mode', `/s/${encodeURIComponent(session.token)}/view-mode`, { mode });
  }

  selectPage(targetId) {
    const session = this.currentSession();
    if (!session) return;
    this.mutate('page', `/s/${encodeURIComponent(session.token)}/free-target`, { targetId });
  }

  async setWritable(writable) {
    const session = this.currentSession();
    const openUrl = serviceOpenUrl(this.state.service);
    if (!session || !openUrl) return;
    const mode = session.mode === 'free' ? 'free' : 'follow';
    this.setState({ pending: 'writable', error: null });
    try {
      await fetchJson(brokerUrl(openUrl, `/s/${encodeURIComponent(session.token)}/viewonly?mode=${mode}&on=${writable ? 0 : 1}`));
      await this.refresh(true);
      this.setState({ pending: null });
    } catch (error) {
      this.setState({ pending: null, error: error instanceof Error ? error.message : String(error) });
    }
  }

  async copyUrl(url) {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      this.setState({ copied: true });
      clearTimeout(this.copyTimer);
      this.copyTimer = setTimeout(() => this.setState({ copied: false }), 1600);
    } catch (error) {
      this.setState({ error: error instanceof Error ? error.message : '复制失败' });
    }
  }

  renderSessionList(botmuxById) {
    if (this.state.loading && this.state.browserSessions.length === 0) {
      return h('div', { className: 'ac-empty' }, '正在读取 Agent Chrome 会话...');
    }
    if (this.state.browserSessions.length === 0) {
      return h('div', { className: 'ac-empty' }, '暂无活跃浏览器会话。Agent 首次调用浏览器工具后，会话会出现在这里。');
    }
    return h('div', { className: 'ac-session-list' }, this.state.browserSessions.map(session => {
      const presentation = sessionPresentation(session, botmuxById.get(session.botmuxSessionId));
      return h('button', {
        className: `ac-session${session.token === this.state.selectedToken ? ' is-active' : ''}`,
        key: session.token,
        type: 'button',
        onClick: () => this.setState({ selectedToken: session.token }),
      },
      h('span', { className: 'ac-session-title' }, presentation.title),
      h('span', { className: 'ac-session-meta' }, presentation.meta));
    }));
  }

  renderPages(session) {
    const pages = Array.isArray(session.pages) ? session.pages : [];
    return h('aside', { className: 'ac-pages' },
      h('div', { className: 'ac-pages-title' }, `页面 ${pages.length}`),
      pages.length === 0
        ? h('div', { className: 'ac-empty' }, '暂无可浏览页面')
        : h('div', { className: 'ac-page-list' }, pages.map(page => h('button', {
          className: `ac-page${page.targetId === session.free?.targetId ? ' is-active' : ''}`,
          key: page.targetId,
          type: 'button',
          disabled: this.state.pending === 'page',
          onClick: () => this.selectPage(page.targetId),
        },
        h('span', { className: 'ac-page-title' }, page.title || '未命名页面'),
        h('span', { className: 'ac-page-url' }, page.url || 'about:blank')))));
  }

  renderMain(botmuxById) {
    const session = this.currentSession();
    if (!session) return h('main', { className: 'ac-main' }, h('div', { className: 'ac-empty' }, '选择一个会话查看浏览器画面。'));
    const botmuxSession = botmuxById.get(session.botmuxSessionId);
    const presentation = sessionPresentation(session, botmuxSession);
    const mode = session.mode === 'free' ? 'free' : 'follow';
    const view = mode === 'free' ? session.free : session.follow;
    const pages = Array.isArray(session.pages) ? session.pages : [];
    const selectedPage = pages.find(page => page.targetId === view?.targetId);
    const writable = view?.viewonly === false;
    return h('main', { className: 'ac-main' },
      h('div', { className: 'ac-session-head' },
        h('div', null,
          h('h2', null, presentation.title),
          h('p', { className: 'ac-session-sub' }, `${botmuxSession?.botName || '未知 Bot'} · ${botmuxSession?.cliId || 'CLI'} · Session ${shortId(session.botmuxSessionId || session.token)}`)),
        h('div', { className: 'ac-mode', role: 'group', 'aria-label': '浏览模式' },
          h('button', { type: 'button', className: mode === 'follow' ? 'is-active' : '', disabled: this.state.pending === 'mode', onClick: () => this.setMode('follow') }, '跟随 Agent'),
          h('button', { type: 'button', className: mode === 'free' ? 'is-active' : '', disabled: this.state.pending === 'mode', onClick: () => this.setMode('free') }, '自由浏览'))),
      h('div', { className: `ac-workspace${mode === 'free' ? ' has-pages' : ''}` },
        mode === 'free' ? this.renderPages(session) : null,
        h('section', { className: 'ac-view' },
          h('div', { className: 'ac-view-toolbar' },
            h('div', { className: 'ac-view-state' },
              view?.novncUrl ? h('span', { className: 'ac-live' }, mode === 'follow' ? '实时跟随' : '自由浏览') : h('span', null, '画面未就绪'),
              selectedPage?.title ? h('span', null, `· ${selectedPage.title}`) : null),
            h('div', { className: 'ac-view-actions' },
              h('label', { className: 'ac-control' },
                h('input', { type: 'checkbox', checked: writable, disabled: !view?.novncUrl || this.state.pending === 'writable', onChange: event => this.setWritable(event.target.checked) }),
                '允许操作'),
              h('button', { className: 'ac-button', type: 'button', disabled: !view?.novncUrl, onClick: () => this.copyUrl(view?.novncUrl) }, this.state.copied ? '已复制' : '复制链接'),
              h('button', { className: 'ac-button', type: 'button', disabled: !view?.novncUrl, onClick: () => window.open(view?.novncUrl, '_blank', 'noopener,noreferrer') }, '独立窗口查看 ↗'))),
          h('div', { className: 'ac-screen' }, view?.novncUrl
            ? h('iframe', { src: view.novncUrl, title: `${presentation.title} VNC`, allow: 'clipboard-read; clipboard-write' })
            : h('div', { className: 'ac-screen-empty' }, mode === 'free'
              ? '选择一个已经就绪的页面，系统会创建自由浏览画面。'
              : 'Agent 打开第一个页面后，跟随画面会自动出现。')),
          h('div', { className: 'ac-footnote' },
            h('span', null, mode === 'follow' ? '画面会跟随 Agent 当前操作的页面。' : '页面切换复用同一个 VNC 地址。'),
            h('span', { className: 'ac-token' }, `Browser ${shortId(session.token)}`)))));
  }

  render() {
    const botmuxById = new Map(this.state.botmuxSessions.map(item => [item.sessionId, item]));
    const online = serviceOnline(this.state.service);
    return h('div', { className: 'ac-root' },
      h('style', null, styles),
      h('div', { className: 'ac-topline' },
        h('div', { className: 'ac-service' },
          h('span', { className: `ac-dot${online ? ' is-online' : ''}` }),
          h('strong', null, online ? 'Agent Chrome 服务运行中' : 'Agent Chrome 服务未运行'),
          this.state.service?.pid ? h('span', null, `PID ${this.state.service.pid}`) : null),
        h('div', { className: 'ac-top-actions' },
          h('button', { className: 'ac-button ac-icon-button', type: 'button', title: '刷新', disabled: this.state.loading, onClick: () => this.refresh() }, '↻'))),
      this.state.error ? h('div', { className: 'ac-error', role: 'alert' }, `加载失败：${this.state.error}`) : null,
      h('div', { className: 'ac-layout' },
        h('aside', { className: 'ac-sidebar' },
          h('div', { className: 'ac-sidebar-head' }, h('h2', null, 'Agent 会话'), h('span', { className: 'ac-count' }, this.state.browserSessions.length)),
          this.renderSessionList(botmuxById)),
        this.renderMain(botmuxById)));
  }
}
