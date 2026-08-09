import type { MockSnapshot } from './MockConsole.ts';

/**
 * The mock desk's face.
 *
 * The skeleton is rendered here, once, because the desk's shape is fixed by
 * configuration and never changes while the page is open. The browser only
 * fills in values, which keeps the client free of any templating and — more to
 * the point — free of a second copy of the decibel curve: every number shown is
 * one the server worked out. A view that could disagree with the server about
 * what -9 dB is would be worse than no view at all.
 */
export function mockPage(snapshot: MockSnapshot): string {
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>X32 목업</title>
<style>
:root {
  color-scheme: light dark;
  --kr: 'Apple SD Gothic Neo', 'Noto Sans KR', system-ui, sans-serif;
  --mono: ui-monospace, 'SF Mono', SFMono-Regular, Menlo, Consolas, monospace;
  --bg: #F1F4F9; --panel: #FFFFFF; --well: #E4E9F1; --slot: #D8DFEA;
  --line: rgba(20, 26, 40, 0.10);
  --ink: #1B2029; --mut: #5C6675; --fnt: #929BAB;
  --go: #16A34A; --go-soft: rgba(22, 163, 74, 0.13);
  --hold: #C2740A; --hold-soft: rgba(194, 116, 10, 0.12);
  --seg-idle: #C3CFE3;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0F1216; --panel: #161B22; --well: #10151B; --slot: #232B35;
    --line: rgba(255, 255, 255, 0.08);
    --ink: #E9EDF4; --mut: #8B95A7; --fnt: #5B6675;
    --go: #22C55E; --go-soft: rgba(34, 197, 94, 0.16);
    --hold: #F5A524; --hold-soft: rgba(245, 165, 36, 0.10);
    --seg-idle: #38465C;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; padding: 22px; background: var(--bg); color: var(--ink);
  font-family: var(--kr); font-size: 15px; -webkit-font-smoothing: antialiased;
}
.desk { max-width: 760px; margin: 0 auto; display: grid; gap: 16px; }
.num { font-variant-numeric: tabular-nums; }

.head { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.head h1 { font-size: 17px; margin: 0; font-weight: 700; }
.head .spacer { flex: 1; }
/* Where a panel would reach this server. It is the whole reason this page can
   exist, and on a laptop that moves between networks it is also the one thing
   on screen that goes stale on its own — so it is pushed, not printed once. */
.where { display: flex; gap: 6px; flex-wrap: wrap; }
.where code {
  font-family: var(--mono); font-size: 12px; padding: 3px 8px; border-radius: 6px;
  background: var(--well); color: var(--mut); user-select: all; cursor: text;
}
.live { font-size: 13px; color: var(--mut); display: inline-flex; align-items: center; gap: 6px; }
.live::before { content: ''; width: 8px; height: 8px; border-radius: 50%; background: var(--fnt); }
.live.on { color: var(--go); }
.live.on::before { background: var(--go); }

button {
  font: inherit; font-size: 13.5px; font-weight: 600; white-space: nowrap;
  padding: 7px 13px; border-radius: 8px; cursor: pointer;
  background: var(--panel); color: var(--ink); border: 1px solid var(--line);
}
button:active { transform: translateY(1px); }

.card { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 16px 18px; }

/* ---- channel strips ---- */
/* Note: a group is one thing the panel offers, however many channels are behind
   it, so the space between two groups has to read as larger than the space
   between one group's channels — otherwise three faders look like three inputs. */
.strips { display: flex; gap: 34px; flex-wrap: wrap; }
.group { display: grid; gap: 9px; padding-left: 18px; border-left: 1px solid var(--line); }
.group:first-child { padding-left: 0; border-left: 0; }
.group__name { font-size: 13px; font-weight: 700; color: var(--mut); }
.group__ch { display: flex; gap: 16px; }

.strip { display: grid; justify-items: center; gap: 7px; }
/* Colour is state: a fader that is sounding is green, one that is not is not. */
.fader {
  writing-mode: vertical-lr; direction: rtl;
  width: 30px; height: 132px; margin: 0; accent-color: var(--seg-idle); cursor: ns-resize;
}
.fader.on { accent-color: var(--go); }
.strip .db { font-family: var(--mono); font-size: 13px; font-weight: 600; }
.lamp {
  min-width: 58px; padding: 5px 8px; font-size: 12.5px; text-align: center;
  background: var(--well); color: var(--fnt); border-color: transparent;
}
.lamp.on { background: var(--go-soft); color: var(--go); }
.addr { font-family: var(--mono); font-size: 11px; color: var(--fnt); }

/* ---- masters ---- */
.masters { display: grid; gap: 13px; }
.master { display: grid; grid-template-columns: 92px 1fr 74px; gap: 13px; align-items: center; }
.master__n { font-size: 13.5px; font-weight: 600; color: var(--mut); }
.master__n b { display: block; font-family: var(--mono); font-size: 10.5px; font-weight: 400; color: var(--fnt); }
/* The masters carry a level, not a state, so they stay the colour of ink —
   green and amber are kept for what is sounding and what is holding. */
.master input[type=range] { width: 100%; margin: 0; accent-color: var(--mut); cursor: ew-resize; }
.master .db { font-family: var(--mono); font-size: 13.5px; font-weight: 600; text-align: right; }
.gate { width: 100%; background: var(--hold-soft); color: var(--hold); border-color: transparent; }
.gate.free { background: var(--go-soft); color: var(--go); }

/* ---- wire log ---- */
.log { padding: 0; overflow: hidden; }
.log__h {
  display: flex; align-items: center; gap: 10px;
  padding: 12px 18px; border-bottom: 1px solid var(--line);
  font-size: 13px; font-weight: 700; color: var(--mut);
}
.log__b { max-height: 340px; overflow-y: auto; }
table { width: 100%; border-collapse: collapse; font-family: var(--mono); font-size: 12.5px; }
td { padding: 5px 10px; border-bottom: 1px solid var(--line); white-space: nowrap; }
tr:last-child td { border-bottom: 0; }
.t { color: var(--fnt); width: 1%; }
.a { width: 99%; }
.v, .d { text-align: right; width: 1%; }
.d { color: var(--mut); }
.f { width: 1%; }
.f span { font-family: var(--kr); font-size: 11px; font-weight: 700; padding: 2px 7px; border-radius: 999px; }
.f .server { background: var(--go-soft); color: var(--go); }
.f .desk { background: var(--hold-soft); color: var(--hold); }
.gap td { text-align: center; color: var(--fnt); font-family: var(--kr); font-size: 11.5px; background: var(--well); }
.empty { padding: 22px; text-align: center; color: var(--fnt); font-size: 13px; }
</style>
</head>
<body>
<main class="desk">
  <div class="head">
    <h1>X32 목업</h1>
    <span class="live" id="live">끊김</span>
    <span class="where" id="where"></span>
    <span class="spacer"></span>
    <button id="clear">로그 지우기</button>
  </div>

  <section class="card strips">
${snapshot.inputs.map(strips).join('\n')}
  </section>

  <section class="card masters">
    <div class="master">
      <div class="master__n">뮤트 그룹 1<b>${snapshot.muteGroup.address}</b></div>
      <button class="gate" id="gate" data-gate="${snapshot.muteGroup.address}">걸림</button>
      <div class="db"></div>
    </div>
${master('매트릭스 1', snapshot.matrix)}
${master('메인', snapshot.main)}
  </section>

  <section class="card log">
    <div class="log__h">전선 — 데스크가 받은 것</div>
    <div class="log__b" id="logBody"></div>
  </section>
</main>

<script>
var live = document.getElementById('live');
var where = document.getElementById('where');
var logBody = document.getElementById('logBody');
var dragging = null;

function post(path, body) {
  return fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {})
  });
}

function send(address, value) { post('/mock/set', { address: address, value: value }); }

document.getElementById('clear').onclick = function () { post('/mock/clear'); };

/* Note: a lamp and a gate are the desk's own switches, so pressing one sends
   the value the desk would hold — not a request the server may refuse. */
Array.prototype.forEach.call(document.querySelectorAll('.lamp'), function (lamp) {
  lamp.onclick = function () { send(lamp.dataset.on, lamp.classList.contains('on') ? 0 : 1); };
});
var gate = document.getElementById('gate');
gate.onclick = function () { send(gate.dataset.gate, gate.classList.contains('free') ? 1 : 0); };

Array.prototype.forEach.call(document.querySelectorAll('input[type=range]'), function (fader) {
  fader.oninput = function () { dragging = fader.dataset.fader; send(fader.dataset.fader, Number(fader.value)); };
  fader.onchange = function () { dragging = null; };
  fader.onblur = function () { dragging = null; };
});

function fader(f) {
  var el = document.querySelector('[data-fader="' + f.address + '"]');
  if (el && dragging !== f.address) el.value = f.level;
  var out = document.querySelector('[data-db="' + f.address + '"]');
  if (out) out.textContent = f.db.toFixed(1) + ' dB';
}

function clock(at) {
  var d = new Date(at);
  function two(n) { return String(n).padStart(2, '0'); }
  return two(d.getHours()) + ':' + two(d.getMinutes()) + ':' + two(d.getSeconds())
    + '.' + String(d.getMilliseconds()).padStart(3, '0');
}

/* A pause between two messages is the thing worth seeing here — the main fader
   waits for the matrix to land — so anything longer than a stray millisecond is
   drawn as its own row rather than left to be worked out from the timestamps. */
var GAP_MS = 150;

function drawLog(journal) {
  if (!journal.length) {
    logBody.innerHTML = '<div class="empty">아직 아무것도 오지 않았어요</div>';
    return;
  }
  var rows = '';
  for (var i = 0; i < journal.length; i++) {
    var m = journal[i];
    if (i > 0) {
      var gap = m.at - journal[i - 1].at;
      if (gap >= GAP_MS) rows += '<tr class="gap"><td colspan="5">── ' + (gap / 1000).toFixed(2) + '초 기다림 ──</td></tr>';
    }
    rows += '<tr><td class="t">' + clock(m.at) + '</td>'
      + '<td class="a">' + m.address + '</td>'
      + '<td class="v">' + m.value + '</td>'
      + '<td class="d">' + (m.db === null ? '' : m.db.toFixed(1) + ' dB') + '</td>'
      + '<td class="f"><span class="' + m.from + '">' + (m.from === 'server' ? '서버' : '데스크') + '</span></td></tr>';
  }
  var stuck = logBody.scrollTop + logBody.clientHeight >= logBody.scrollHeight - 24;
  logBody.innerHTML = '<table>' + rows + '</table>';
  if (stuck) logBody.scrollTop = logBody.scrollHeight;
}

function render(s) {
  for (var i = 0; i < s.inputs.length; i++) {
    var channels = s.inputs[i].channels;
    for (var j = 0; j < channels.length; j++) {
      var ch = channels[j];
      var lamp = document.querySelector('[data-on="' + ch.onAddress + '"]');
      lamp.classList.toggle('on', ch.on);
      lamp.textContent = ch.on ? '켜짐' : '꺼짐';
      var slider = document.querySelector('[data-fader="' + ch.fader.address + '"]');
      slider.classList.toggle('on', ch.on);
      fader(ch.fader);
    }
  }
  gate.classList.toggle('free', !s.muteGroup.engaged);
  gate.textContent = s.muteGroup.engaged ? '걸림' : '해제';
  fader(s.matrix);
  fader(s.main);
  drawLog(s.journal);
}

var stream = new EventSource('/mock/events');
stream.onopen = function () { live.textContent = '연결됨'; live.classList.add('on'); };
stream.onerror = function () { live.textContent = '끊김'; live.classList.remove('on'); };
stream.onmessage = function (event) { render(JSON.parse(event.data)); };
stream.addEventListener('where', function (event) {
  var addresses = JSON.parse(event.data);
  var next = addresses.map(function (a) { return '<code>' + a + '</code>'; }).join('');
  if (where.innerHTML !== next) where.innerHTML = next;
});
</script>
</body>
</html>`;
}

function strips(input: MockSnapshot['inputs'][number]): string {
  return `    <div class="group">
      <div class="group__name">${input.label}</div>
      <div class="group__ch">
${input.channels.map(strip).join('\n')}
      </div>
    </div>`;
}

function strip(channel: MockSnapshot['inputs'][number]['channels'][number]): string {
  return `        <div class="strip">
          <input type="range" class="fader" min="0" max="1" step="0.001" data-fader="${channel.fader.address}" value="${channel.fader.level}">
          <div class="db num" data-db="${channel.fader.address}"></div>
          <button class="lamp" data-on="${channel.onAddress}">꺼짐</button>
          <div class="addr">${shortAddress(channel.fader.address)}</div>
        </div>`;
}

function master(name: string, fader: MockSnapshot['matrix']): string {
  return `    <div class="master">
      <div class="master__n">${name}<b>${fader.address}</b></div>
      <input type="range" min="0" max="1" step="0.001" data-fader="${fader.address}" value="${fader.level}">
      <div class="db num" data-db="${fader.address}"></div>
    </div>`;
}

/** `/auxin/05/mix/fader` is the channel called `auxin/05`; the rest is the same every time. */
function shortAddress(address: string): string {
  return address.replace(/^\//, '').replace(/\/mix\/fader$/, '');
}
