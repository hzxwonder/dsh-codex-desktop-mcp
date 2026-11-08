import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { PROTOCOLS, DEFAULT_PROTOCOL, normalizeBaseUrl, resolveProviderSettings, discoverModels, testConnection } from './provider.js';

const clean = (value) => String(value).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '?');

export function maskApiKey(value) {
  if (!value) return '未设置';
  if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value)) return '[REDACTED]';
  const masked = value.length >= 12 ? `********${value.slice(-4)}` : '********';
  return masked === value ? '[REDACTED]' : masked;
}

function question(prompt, hidden = false) {
  if (!process.stdin.isTTY) throw new Error('配置向导需要交互式终端。请在终端运行 dsh-codex-desktop-mcp setup。');
  const output = hidden ? new Writable({ write(_chunk, _encoding, done) { done(); } }) : process.stdout;
  const input = createInterface({ input: process.stdin, output, terminal: true, historySize: 0 });
  if (hidden) process.stdout.write(prompt);
  return new Promise((accept, reject) => {
    input.once('SIGINT', () => { input.close(); reject(new Error('配置已取消，尚未保存。')); });
    input.once('close', () => reject(new Error('输入已关闭，尚未保存。')));
    input.question(hidden ? '' : prompt, (answer) => {
      accept(answer);
      input.close();
      if (hidden) process.stdout.write('\n');
    });
  });
}

async function progress(label, operation) {
  const frames = ['|', '/', '-', '\\'];
  let frame = 0;
  process.stdout.write(`${label} ${frames[frame]}`);
  const timer = setInterval(() => process.stdout.write(`\r\u001b[2K${label} ${frames[++frame % frames.length]}`), 120);
  try { return await operation(AbortSignal.timeout(45000)); }
  finally { clearInterval(timer); process.stdout.write('\r\u001b[2K'); }
}

export async function runTerminalSetup({ settings, apiKey = '', existing = false, io = {} }) {
  const ask = io.ask ?? question;
  const log = io.log ?? console.log;
  const run = io.progress ?? progress;
  const draft = { ...settings };
  let key = apiKey;
  const errorText = (error) => {
    const message = String(error?.message ?? error);
    return clean(key ? message.split(key).join('[REDACTED]') : message);
  };
  const protocol = () => PROTOCOLS.find((item) => item.id === draft.protocol);
  const summary = () => {
    log('\n配置汇总（密钥不会明文显示）');
    log(`  1. 接口类型: ${protocol()?.label ?? clean(draft.protocol)}`);
    log(`  2. Base URL: ${clean(draft.baseUrl)}`);
    log(`  3. API Key: ${maskApiKey(key)}`);
    log(`  4. 模型: ${draft.model ? clean(draft.model) : '待选择'}`);
  };
  const chooseProtocol = async () => {
    log('\n第一层：选择接口协议');
    PROTOCOLS.forEach((item, index) => log(`  ${index + 1}. ${item.label}`));
    const current = Math.max(0, PROTOCOLS.findIndex((item) => item.id === (draft.protocol || DEFAULT_PROTOCOL)));
    for (;;) {
      const answer = (await ask(`接口 [${current + 1}]: `)).trim();
      const index = answer ? Number(answer) - 1 : current;
      if (Number.isInteger(index) && PROTOCOLS[index]) {
        const selected = PROTOCOLS[index];
        if (draft.protocol !== selected.id) {
          draft.protocol = selected.id;
          draft.baseUrl = selected.defaultBaseUrl;
          draft.model = '';
        }
        return;
      }
      log('请输入列表中的编号。');
    }
  };
  const chooseUrl = async () => {
    log('\n第二层：输入 API 根地址，不是具体的推理端点。');
    for (;;) {
      const value = (await ask(`Base URL [${draft.baseUrl || protocol().defaultBaseUrl}]: `)).trim() || draft.baseUrl || protocol().defaultBaseUrl;
      try {
        const normalized = normalizeBaseUrl(value, protocol().defaultBaseUrl);
        if (draft.baseUrl !== normalized) draft.model = '';
        draft.baseUrl = normalized;
        return;
      } catch (error) { log(errorText(error)); }
    }
  };
  const chooseKey = async () => {
    log(`\n第三层：输入 API Key。目标服务: ${clean(draft.baseUrl)}`);
    if (key) log('回车表示保留已保存的密钥，并授权将它用于上方服务；也可以输入新密钥。');
    for (;;) {
      const value = (await ask(`API Key${key ? ` [${maskApiKey(key)}，回车保留]` : ''}: `, true)).trim();
      if (value && /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value)) { log('API Key 必须是单行文本。'); continue; }
      if (value) key = value;
      if (key) return;
      log('API Key 不能为空。');
    }
  };
  const manualModel = async () => {
    for (;;) {
      const id = (await ask(`模型 ID${draft.model ? ` [${clean(draft.model)}]` : ''}: `)).trim() || draft.model;
      if (!id || /[\u0000-\u001f\u007f]/.test(id)) { log('请输入有效的模型 ID。'); continue; }
      draft.model = id;
      return true;
    }
  };
  const chooseModel = async () => {
    let models;
    try {
      models = await run('正在获取当前凭据可见的模型', (signal) => discoverModels({ ...draft, apiKey: key, signal }));
      if (!models.length) throw new Error('服务没有返回可选择的模型。');
    } catch (error) {
      log(`模型探测失败: ${errorText(error)}`);
      log('请检查协议、地址和 Key。部分网关不提供模型列表，可手工填写 ID 后进行真实测试。');
      const action = (await ask('输入 m 手工填写模型，或回车返回配置汇总: ')).trim().toLowerCase();
      return action === 'm' ? manualModel() : false;
    }
    let page = 0;
    const pageSize = 15;
    for (;;) {
      const pages = Math.ceil(models.length / pageSize);
      log(`\n选择模型：共 ${models.length} 个，第 ${page + 1}/${pages} 页`);
      models.slice(page * pageSize, (page + 1) * pageSize).forEach((model, index) => {
        log(`  ${page * pageSize + index + 1}. ${clean(model.id)}${model.id === draft.model ? ' [当前]' : ''}`);
      });
      log('  n 下一页 / p 上一页 / m 手工输入 / q 返回汇总');
      const answer = (await ask(`模型编号${draft.model && models.some((model) => model.id === draft.model) ? ' [回车保留当前]' : ''}: `)).trim();
      if (!answer && draft.model && models.some((model) => model.id === draft.model)) return true;
      if (answer === 'q') return false;
      if (answer === 'm') return manualModel();
      if (answer === 'n') { page = Math.min(pages - 1, page + 1); continue; }
      if (answer === 'p') { page = Math.max(0, page - 1); continue; }
      const index = Number(answer) - 1;
      if (Number.isInteger(index) && models[index]) { draft.model = models[index].id; return true; }
      log('请输入有效编号，或使用 n/p 切换页面。');
    }
  };
  const verify = async () => {
    if (!key) { log('请先设置 API Key。'); return null; }
    if (!draft.model && !await chooseModel()) return null;
    summary();
    log('将向上方服务发送一次最小模型请求，可能产生少量 API 费用。');
    try {
      const canonical = resolveProviderSettings(draft);
      await run('正在测试模型连接', (signal) => testConnection({ ...canonical, apiKey: key, signal }));
      log('✅ Connection successful!');
      return { settings: canonical, apiKey: key };
    } catch (error) {
      log(`连接失败: ${errorText(error)}`);
      log('尚未保存。请在配置汇总中选择要修改的项目。');
      return null;
    }
  };

  log('DeepSeek Harness MCP 终端配置');
  if (!existing) {
    await chooseProtocol();
    await chooseUrl();
    await chooseKey();
    draft.model = '';
    if (await chooseModel()) {
      const result = await verify();
      if (result) return result;
    }
  }
  for (;;) {
    summary();
    log('  5. 重新探测模型并选择');
    log('  6. 测试并保存');
    log('  q. 退出，不保存');
    const action = (await ask('选择操作 [6]: ')).trim().toLowerCase() || '6';
    if (action === 'q') throw new Error('配置已取消，尚未保存。');
    if (action === '1') await chooseProtocol();
    else if (action === '2') await chooseUrl();
    else if (action === '3') await chooseKey();
    else if (action === '4') await manualModel();
    else if (action === '5') await chooseModel();
    else if (action === '6') {
      const result = await verify();
      if (result) return result;
    } else log('请输入 1–6 或 q。');
  }
}
