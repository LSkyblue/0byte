/* cdp.mjs 的场景例子：按手机打开测试服务里 id 是 demo 的会话，点开「＋」截一张，再打开表情包截一张。
   跑法：先用测试配置在另一个端口起一份服务（比如 PORT=5199 node server.mjs），把下面的钥匙换成终端里打印的那条，
   再 SHOT_DIR=/tmp/shots node tools/cdp.mjs tools/scene-example.mjs */
const U = 'http://127.0.0.1:5199/?t=把这里换成终端里打印的钥匙';
export default async p => {
  await p.mobileMode();
  await p.goto(U + '#chat=demo', 2500);
  await p.tap('#plusBtn', 700);
  await p.shot('plus.png');
  await p.tap('#stkBtn', 700);
  await p.shot('stickers.png');
  console.log('表情包面板开着吗：', await p.js(`return !document.getElementById('stkSheet').hidden;`));
};
