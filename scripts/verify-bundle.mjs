/* ==========================================================================
 * verify-bundle.mjs — .tabpilot 容器格式的正确性检验
 *
 * packBundle / unpackBundle 是纯函数（只用 TextEncoder，不碰 DOM），
 * 所以脱离 jsdom 也能验证。重点不是"能打包"，而是这几个容易出错的地方：
 *
 *   1. 二进制载荷里本身就含换行符 0x0a —— 容器靠"第二个换行"定位头部结束，
 *      如果实现写成了"找第一个换行后的内容到下一个换行"，遇到带 0x0a 的
 *      音频字节就会错位。
 *   2. 长度按字节还是按字符 —— 元信息里有中文文件名时，
 *      JSON 头部本身是多字节的，Chain string length 会算错偏移，后面的音频就整体错位。
 *   3. 截断、篡改 magic、段长度越界，都要给出可诊断的报错而不是静默产出垃圾。
 *
 * 之所以单独一个脚本：这些畸形输入的构造在页面级回归里很难表达，
 * 而纯函数测起来又极快，可以大量覆盖。
 *
 * 运行：npm run verify:bundle
 * ========================================================================== */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', 'public', 'js', 'image-tab.js'), 'utf8');

/** 从源码里按花括号配平抠出指定函数（避免手工维护副本导致与实际实现漂移） */
function extract(name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('找不到函数: ' + name);
  let depth = 0;
  for (let p = src.indexOf('{', start); p < src.length; p++) {
    if (src[p] === '{') depth++;
    else if (src[p] === '}') { depth--; if (depth === 0) return src.slice(start, p + 1); }
  }
  throw new Error('花括号未配平: ' + name);
}

const NAMES = ['packBundle', 'bundleBytes', 'isBundle', 'unpackBundle'];
const MAGIC = src.match(/const BUNDLE_MAGIC = '([^']+)'/)[1];
const code = 'const BUNDLE_MAGIC = ' + JSON.stringify(MAGIC) + ';\n' +
  NAMES.map(extract).join('\n');
const SL = new Function(code + '\nreturn {' + NAMES.join(',') + '};')();
const { packBundle, bundleBytes, isBundle, unpackBundle } = SL;

const R = [];
function ok(name, cond, extra) {
  R.push((cond ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? '  [' + extra + ']' : ''));
}
/** 断言某个操作会抛错，且错误信息里带上关键字 */
function throws(label, fn, keyword) {
  let msg = '';
  try { fn(); } catch (e) { msg = e && e.message ? e.message : String(e); }
  ok(label, msg.indexOf(keyword) >= 0, msg || '(没有抛错)');
}
/** 只要求"确实抛错"：具体措辞不重要，重要的是绝不静默返回残缺数据 */
function throwsAny(label, fn) {
  let msg = '';
  try { fn(); } catch (e) { msg = e && e.message ? e.message : String(e); }
  ok(label, msg !== '', msg || '(没有抛错)');
}

const enc = new TextEncoder();

/** 造一段"音频"字节：刻意混入 0x0a 换行、0x00 空字节和 0xff，覆盖各种边界情况 */
function fakeAudio(len) {
  const u = new Uint8Array(len);
  for (let i = 0; i < len; i++) u[i] = (i * 37 + (i % 13)) & 0xff;
  u[0] = 0x0a; u[1] = 0x00; u[2] = 0xff; u[3] = 0x0a;
  u[len - 1] = 0x0a;
  return u;
}

console.log('=== .tabpilot 容器格式检验 ===');

/* ---- 单段往返 ---- */
{
  const proj = JSON.stringify({ app: 'TabPilot', pages: [{ src: 'data:image/png;base64,AAAA', bands: [{ y0: 0, y1: 10, bars: 4 }] }] });
  const packed = packBundle([{ key: 'project', data: proj, meta: { type: 'application/json' } }]);
  const raw = bundleBytes(packed);

  ok('单段：头部以 magic 开头', isBundle(raw));
  ok('单段：总长 = 头部 + 载荷', raw.length === enc.encode(packed.headText).length + enc.encode(proj).length,
    raw.length);

  const back = unpackBundle(raw);
  ok('单段：head.app 正确', back.head.app === 'TabPilot');
  ok('单段：head.version 为 1', back.head.version === 1);
  ok('单段：project 内容逐字还原', new TextDecoder().decode(back.parts.project.bytes) === proj);
  ok('单段：meta 透传', back.parts.project.meta.type === 'application/json');
  ok('单段：只声明了一段', back.head.parts.length === 1);
}

/* ---- 两段：文本 + 二进制（带换行字节） ---- */
{
  const proj = JSON.stringify({ app: 'TabPilot', pages: [] });
  const aud = fakeAudio(5000);
  const packed = packBundle([
    { key: 'project', data: proj, meta: { type: 'application/json' } },
    { key: 'audio', data: aud, meta: { mime: 'audio/mpeg', name: 'backing.mp3', offset: -120 } },
  ]);
  const raw = bundleBytes(packed);
  const back = unpackBundle(raw);

  ok('两段：工程段还原', new TextDecoder().decode(back.parts.project.bytes) === proj);
  ok('两段：音频长度一致', back.parts.audio.bytes.length === aud.length,
    back.parts.audio.bytes.length);
  let same = true;
  for (let i = 0; i < aud.length; i++) if (back.parts.audio.bytes[i] !== aud[i]) { same = false; break; }
  ok('两段：音频字节逐字节相同（载荷含 0x0a/0x00/0xff 仍不错位）', same);
  ok('两段：音频 meta 透传', back.parts.audio.meta.mime === 'audio/mpeg' && back.parts.audio.meta.name === 'backing.mp3');
  ok('两段：偏移为负数也能原样保留', back.parts.audio.meta.offset === -120, back.parts.audio.meta.offset);
}

/* ---- 多字节字符：中文文件名不能让后面的二进制段错位 ---- */
{
  const proj = JSON.stringify({ app: 'TabPilot', pages: [], settings: { title: '天空之城' } });
  const aud = fakeAudio(2048);
  const packed = packBundle([
    { key: 'project', data: proj, meta: { type: 'application/json' } },
    { key: 'audio', data: aud, meta: { name: '我的伴奏 — 录音室版.mp3' } },
  ]);
  const raw = bundleBytes(packed);

  // 头部字符串长度 ≠ 字节数，若实现按 String.length 算偏移，这里必然错
  const headBytes = enc.encode(packed.headText).length;
  ok('多字节：头部字节数大于字符数（这条不成立的话本用例就失去意义）',
    headBytes > packed.headText.length, 'bytes=' + headBytes + ' chars=' + packed.headText.length);

  const back = unpackBundle(raw);
  ok('多字节：中文名透传正确', back.parts.audio.meta.name === '我的伴奏 — 录音室版.mp3',
    back.parts.audio.meta.name);
  let same = true;
  for (let i = 0; i < aud.length; i++) if (back.parts.audio.bytes[i] !== aud[i]) { same = false; break; }
  ok('多字节：中文元信息之后音频仍逐字节对齐', same);
}

/* ---- 空段 ---- */
{
  const packed = packBundle([
    { key: 'project', data: '{"app":"TabPilot"}', meta: {} },
    { key: 'audio', data: new Uint8Array(0), meta: { name: 'x.mp3' } },
  ]);
  const back = unpackBundle(bundleBytes(packed));
  ok('空段：长度 0 的段可被解析出来', back.parts.audio && back.parts.audio.bytes.length === 0);
  ok('空段：不影响相邻段的还原', new TextDecoder().decode(back.parts.project.bytes) === '{"app":"TabPilot"}');
}

/* ---- 畸形输入 ---- */
{
  const big = bundleBytes(packBundle([
    { key: 'project', data: '{"app":"TabPilot"}', meta: {} },
    { key: 'audio', data: fakeAudio(1000), meta: {} },
  ]));

  // 关键在于"不许静默返回残缺数据"：宁可抛错也不要把半段 JSON 当成工程用
  throws('畸形：截到 magic 之前就被认出来', () => unpackBundle(big.slice(0, 5)), '不是 .tabpilot');
  throwsAny('畸形：截断一半一定抛错（不会返回残缺数据）', () => unpackBundle(big.slice(0, 400)));
  throws('畸形：尾部被截掉会报段越界', () => unpackBundle(big.slice(0, big.length - 200)), '段越界');
  throws('畸形：magic 被改动会认出不是容器',
    () => { const b = big.slice(); b[0] = 0x58; return unpackBundle(b); }, '不是 .tabpilot');
  throwsAny('畸形：乱码文件不会被当成容器读出数据', () => unpackBundle(fakeAudio(3000)));

  // 未来版本必须给出明确提示，而不是硬解出一个错乱的工程
  const future = enc.encode(
    MAGIC + '\n' + JSON.stringify({ app: 'TabPilot', format: 'tabpilot', version: 2, parts: [] }) + '\n');
  throws('畸形：未来版本给出明确提示', () => unpackBundle(future), '不支持的容器版本');

  // 段长度被改大：越过文件尾部
  const evil = big.slice();
  const head = JSON.parse(new TextDecoder().decode(big).split('\n')[1]);
  head.parts[0].len = 999999;
  const headStr = JSON.stringify(head);
  const rebuilt = new Uint8Array(enc.encode(MAGIC + '\n' + headStr + '\n').length + 2000);
  rebuilt.set(enc.encode(MAGIC + '\n' + headStr + '\n'), 0);
  throws('畸形：段长度被篡改会报越界', () => unpackBundle(rebuilt), '段越界');

  ok('畸形：普通 JSON 文件不会被误认成容器', !isBundle(enc.encode('{"app":"TabPilot"}')));
  ok('畸形：空文件不会被误认成容器', !isBundle(new Uint8Array(0)));
}

const fails = R.filter((r) => r.startsWith('FAIL'));
console.log(R.join('\n'));
console.log('=== 断言汇总：' + (R.length - fails.length) + ' 通过 / ' + fails.length + ' 失败 ===');
if (fails.length) process.exit(1);
