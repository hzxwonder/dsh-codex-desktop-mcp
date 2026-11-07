import { App } from '@modelcontextprotocol/ext-apps';

const app = new App({ name: 'DSH Progress', version: '0.1.0' });
const status = document.getElementById('status');
const list = document.getElementById('events');
const pause = document.getElementById('pause');
const updated = document.getElementById('updated');
const labels = { waiting: '等待委派任务', running: '正在执行', completed: '执行完成', failed: '执行失败', cancelled: '已取消', timed_out: '执行超时', output_limit: '输出达到上限' };
let context;
let sequence = 0;
let paused = false;
let active = false;
let timer;
let connected = false;

const showStatus = (message) => { if (status.textContent !== message) status.textContent = message; };
const theme = (ctx) => { document.documentElement.style.colorScheme = ctx?.theme === 'dark' ? 'dark' : 'light'; };
app.onhostcontextchanged = theme;
app.ontoolresult = ({ _meta }) => {
  if (!_meta?.dshProgress?.view_token) return;
  context = _meta.dshProgress;
  sequence = 0;
  list.replaceChildren();
  refresh();
};

async function refresh() {
  if (!connected || !context || paused || active || document.hidden) return;
  active = true;
  try {
    const result = await app.callServerTool({
      name: 'read_dsh_progress',
      arguments: { ...context, after_seq: sequence },
    });
    if (result.isError || !result._meta?.dshProgress) {
      showStatus('进度记录已过期或连接不可用');
      clearInterval(timer);
      return;
    }
    const progress = result._meta.dshProgress;
    for (const event of progress.events) {
      const row = document.createElement('li');
      const label = document.createElement('div');
      label.className = 'label';
      label.textContent = new Date(event.time).toLocaleTimeString() + ' · ' + event.type;
      const text = document.createElement('pre');
      text.textContent = event.message;
      row.append(label, text);
      list.append(row);
    }
    while (list.children.length > 200) list.firstElementChild.remove();
    sequence = progress.next_seq;
    showStatus(labels[progress.status] ?? '执行结束');
    if (progress.events.length) updated.textContent = '最近更新 ' + new Date().toLocaleTimeString();
    if (!['waiting', 'running'].includes(progress.status)) {
      clearInterval(timer);
      pause.disabled = true;
    }
  } catch {
    showStatus('连接暂时中断，正在重试');
  } finally { active = false; }
}

pause.addEventListener('click', () => {
  paused = !paused;
  pause.textContent = paused ? '继续更新' : '暂停更新';
  pause.setAttribute('aria-pressed', String(paused));
  if (paused) showStatus('已暂停显示，任务继续运行');
  else refresh();
});
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
window.addEventListener('pagehide', () => clearInterval(timer));

try {
  await app.connect();
  connected = true;
  theme(app.getHostContext());
  timer = setInterval(refresh, 1000);
  showStatus('等待委派任务');
  refresh();
} catch {
  showStatus('此客户端尚未连接进度卡片');
  pause.disabled = true;
}
