/* 气泡皮肤的样式：手机页、电脑页、给陪伴会话看效果的预览页共用。服务端给的清单里颜色都过过白名单，这里只负责拼。
   背景画在 ::before 上，跟着「气泡透明度」变淡、字不淡；角上的装饰画在 ::after 上，只放在一组消息的第一个气泡。
   描边默认是实线（内描边）。皮肤里写了 borderStyle: 'dashed' 就是虚线：浏览器自带的 dashed 定不了线段长短，所以在 ::before 上垫一张内联 SVG，
   画一个跟气泡一样大、圆角一样的圆角矩形，用 stroke-dasharray 画虚线（borderDash：线段长和间隔，单位像素，比如 "8 5"，不写是 6 4）。
   线宽 2、一半在气泡外面被裁掉，看到的是贴着里边的 1px，气泡大小不变。
   一组消息的第一个气泡，说话那一侧的上角是小圆角：SVG 里用 mask 把那个角盖掉，另画一段同样小圆角的线。 */
function skinRules(sk, scope, token) {
  const skinUrl = u => (u.startsWith('/api/') ? u + '?t=' + encodeURIComponent(token) : u);
  const out = [], BUB = ':not(.stk):not(.pics):not(.files):not(.act)';
  const ink = c => `--ink: ${c}; --ink-2: color-mix(in srgb, ${c} 72%, transparent); color: ${c};`;
  const dashed = s => !!(s.border && s.borderStyle === 'dashed');
  const dashOf = s => {
    const m = /^\s*(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)\s*$/.exec(String(s.borderDash || ''));
    const c = v => Math.min(40, Math.max(1, v));
    return m ? `${c(+m[1])} ${c(+m[2])}` : '6 4';
  };
  /* 虚线那张 SVG（一层背景）。r：圆角；small：这个气泡哪个上角是小圆角（at: 'tl' / 'tr'）、多大（h），普通气泡不传 */
  const dashLayer = (s, r, small) => {
    const st = `fill='none' stroke='${s.border}' stroke-width='2' stroke-dasharray='${dashOf(s)}'`;
    let body = `<rect width='100%' height='100%' rx='${r}' ${st}/>`;
    if (small && small.h < r) {
      const h = small.h, tl = small.at === 'tl';
      const hole = tl ? `<rect width='${r}' height='${r}'/>` : `<svg x='100%' overflow='visible'><rect x='-${r}' width='${r}' height='${r}'/></svg>`;
      const corner = tl ? `<path d='M0 ${r}V${h}A${h} ${h} 0 0 1 ${h} 0H${r}' ${st}/>` : `<svg x='100%' overflow='visible'><path d='M-${r} 0H-${h}A${h} ${h} 0 0 1 0 ${h}V${r}' ${st}/></svg>`;
      body = `<mask id='m'><rect width='100%' height='100%' fill='#fff'/><g fill='#000'>${hole}</g></mask><rect width='100%' height='100%' rx='${r}' ${st} mask='url(#m)'/>${corner}`;
    }
    return `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg'>${body}</svg>`)}") 0 0 / 100% 100% no-repeat, `;
  };
  const fill = (s, r, small) => `background: ${dashed(s) ? dashLayer(s, r, small) : ''}${s.texture ? `url("${skinUrl(s.texture)}") 0 0 / ${s.textureSize || 64}px auto repeat, ` : ''}${s.bg}; box-shadow: ${s.border && !dashed(s) ? `inset 0 0 0 1px ${s.border}` : 'none'};`;
  for (const k of ['me', 'ai']) {
    const s = sk[k], sel = `${scope} .mrow.${k} .bub${BUB}`, head = `${scope} .mrow.${k}.head .bub${BUB}`, r = s.radius ?? 20;
    const small = { at: k === 'ai' ? 'tl' : 'tr', h: Math.min(r, 6) };
    out.push(`${sel} { position: relative; isolation: isolate; background: none !important; border: 0 !important; box-shadow: none !important; border-radius: ${r}px; ${ink(s.ink)} }`);
    out.push(`${sel}::before { content: ""; position: absolute; inset: 0; z-index: -1; border-radius: inherit; pointer-events: none; opacity: var(--bub-a, 1); ${fill(s, r)} }`);
    out.push(`${head} { border-top-${k === 'ai' ? 'left' : 'right'}-radius: ${small.h}px; }`);
    if (dashed(s) && small.h < r) out.push(`${head}::before { ${fill(s, r, small)} }`);   // 虚线也要跟着那个小圆角走
    if (s.corner) {
      const sz = s.cornerSize || 28, at = s.cornerAt || 'tr', off = -Math.round(sz * 0.32);
      out.push(`${head}::after { content: ""; position: absolute; ${at[0] === 't' ? 'top' : 'bottom'}: ${off}px; ${at[1] === 'l' ? 'left' : 'right'}: ${off}px; width: ${sz}px; height: ${sz}px; pointer-events: none; background: url("${skinUrl(s.corner)}") center / contain no-repeat; }`);
    }
    const d = sk.dark?.[k];
    if (d) {
      const sd = { ...s, ...d };
      const body = pre => `${pre}${sel} { ${ink(d.ink)} } ${pre}${sel}::before { ${fill(sd, r)} }` + (dashed(sd) && small.h < r ? ` ${pre}${head}::before { ${fill(sd, r, small)} }` : '');
      out.push(`@media (prefers-color-scheme: dark) { ${body(':root:not([data-theme="light"]) ')} }`, body(':root[data-theme="dark"] '));
    }
  }
  return out.join('\n');
}
