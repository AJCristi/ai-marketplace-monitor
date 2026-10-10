import {esc} from './console-model.js';

const percent = value => `${Math.round(value * 100)}%`;
const pretty = value => esc(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
const matchKey = row => JSON.stringify([row.marketplace, row.listing_id, row.item]);
const meter = value => `<span class="ai-meter" aria-hidden="true"><span style="width:${percent(value)}"></span></span>`;

export function aiTestFormHtml({backends, matches, selection, busy}) {
  if (!backends.length) return '<p class="sm warn">No enabled AI sections. Add one under <a href="#/settings/ai">AI providers</a>.</p>';
  if (!matches.length) return '<p class="sm d">No saved matches yet. Run a search or add a listing on the Matches page first.</p>';
  return `<form id="ai-test-form" class="sect"><h2>Run a test</h2>`+
    `<div class="f"><label class="l" for="ai-test-backend">AI backend</label><span class="sel"><select id="ai-test-backend">${backends.map(name=>`<option value="${esc(name)}" ${name===selection.backend?'selected':''}>${esc(name)}</option>`).join('')}</select></span></div>`+
    `<div class="f"><label class="l" for="ai-test-match">Saved match</label><span class="sel"><select id="ai-test-match">${matches.map(row=>`<option value="${esc(matchKey(row))}" ${matchKey(row)===selection.match?'selected':''}>${esc(row.title||row.listing_id)} · ${esc(row.item||'added by you')} · ${row.photos?.length||0} photos</option>`).join('')}</select></span></div>`+
    `<label class="row sm"><input type="checkbox" id="ai-test-photos" ${selection.photos?'checked':''}>Send saved photos (up to 4)</label>`+
    `<div class="row wr"><button class="btn p" type="submit" ${busy?'disabled':''}>${busy?'Running…':'Run test'}</button><span class="xs d">Dry run: the result is not cached and nobody is notified.</span></div></form>`;
}

export function decisionsHtml(answers) {
  const rows = Object.entries(answers || {}).map(([key, answer]) => {
    if (answer?.type === 'noul') return `<tr><th scope="row" class="m">${esc(key)}</th><td>yes / no</td><td>${meter(answer.noul)} ${percent(answer.noul)} yes</td></tr>`;
    const levels = Object.entries(answer?.probabilities || {}).map(([option, probability]) =>
      `<li>${meter(probability)} ${percent(probability)} <span class="mu">${esc(answer.legend?.[option] ?? option)}</span></li>`).join('');
    const headline = answer?.type === 'score'
      ? `level ${Number(answer.score).toFixed(2)}`
      : `${esc(answer?.choice ?? '')}`;
    const confidence = typeof answer?.confidence === 'number' ? ` · ${percent(answer.confidence)} confident` : '';
    return `<tr><th scope="row" class="m">${esc(key)}</th><td>${esc(answer?.type || 'unknown')}</td><td><div>${headline}${confidence}</div><ul class="ai-levels">${levels}</ul></td></tr>`;
  });
  return `<table class="ai-decisions"><thead><tr><th scope="col">Question</th><th scope="col">Type</th><th scope="col">Answer</th></tr></thead><tbody>${rows.join('')}</tbody></table>`;
}

export function aiTestResultHtml(trace) {
  if (!trace) return '';
  const response = trace.response;
  const usage = response && typeof response === 'object' ? response.usage : null;
  const rating = Number(trace.rating) || 0;
  const summary = [
    ['Backend', `${esc(trace.backend)} · ${esc(trace.model || 'provider default')}`],
    rating ? ['Rating', `<span class="ai-stars" aria-hidden="true">${'★'.repeat(rating)}${'☆'.repeat(5 - rating)}</span> ${rating}/5 · ${esc(trace.conclusion || '')}`] : null,
    trace.comment ? ['Comment', `${esc(trace.comment)} <span class="xs d">from ${esc(trace.comment_source || trace.backend)}</span>`] : null,
    trace.latency_ms != null ? ['Latency', `${trace.latency_ms} ms`] : null,
    usage ? ['Tokens', `${usage.input_tokens ?? '?'} in · ${usage.output_tokens ?? '?'} out`] : null,
  ].filter(Boolean);
  const steps = (trace.steps || []).map(step => `<li><span class="d">+${step.ms} ms</span> ${esc(step.message)}</li>`).join('');
  const raw = (title, value) => value === undefined ? '' : `<details><summary class="sm">${title}</summary><pre class="raw">${pretty(value)}</pre></details>`;
  return `<section class="sect" aria-live="polite"><h2>Result</h2>${trace.error ? `<p class="err sm" role="alert">${esc(trace.error)}</p>` : ''}`+
    `<dl class="kv">${summary.map(([label, value]) => `<dt>${label}</dt><dd>${value}</dd>`).join('')}</dl></section>`+
    (response?.answers ? `<section class="sect"><h2>Decisions</h2>${decisionsHtml(response.answers)}</section>` : '')+
    `<section class="sect"><h2>Steps</h2><ol class="ai-steps m xs">${steps}</ol></section>`+
    `<section class="sect"><h2>Raw</h2>${raw('Request', trace.request)}${raw('Response', response)}</section>`;
}

export function createAiTestView({json, pageHeader, isActive}) {
  const view = {matches: null, selection: {backend: '', match: '', photos: true}, busy: false, trace: null, error: ''};
  let container = null, backends = [];

  function draw() {
    if (!container || !isActive()) return;
    container.innerHTML = pageHeader('AI test', 'Run an AI backend on a saved match and inspect its decisions, steps and raw exchange.')+
      `<div class="body">${view.error ? `<p class="err sm" role="alert">${esc(view.error)}</p>` : ''}`+
      (view.matches === null ? '<p class="sm d">Loading saved matches…</p>' : aiTestFormHtml({backends, matches: view.matches, selection: view.selection, busy: view.busy}))+
      `${aiTestResultHtml(view.trace)}</div>`;
    const form = container.querySelector?.('#ai-test-form');
    if (!form) return;
    form.querySelector('#ai-test-backend').onchange = event => {view.selection.backend = event.target.value;};
    form.querySelector('#ai-test-match').onchange = event => {view.selection.match = event.target.value;};
    form.querySelector('#ai-test-photos').onchange = event => {view.selection.photos = event.target.checked;};
    form.onsubmit = event => {event.preventDefault(); run();};
  }

  async function run() {
    if (view.busy) return;
    const [marketplace, listing_id, item] = JSON.parse(view.selection.match);
    view.busy = true; view.error = ''; view.trace = null; draw();
    try {
      view.trace = await json('/api/ai/test', {method: 'POST', body: JSON.stringify({backend: view.selection.backend, marketplace, listing_id, item, photos: view.selection.photos})});
    } catch (error) {
      view.error = error.message;
    } finally {
      view.busy = false; draw();
    }
  }

  async function render(target, names) {
    container = target; backends = names;
    if (!backends.includes(view.selection.backend)) view.selection.backend = backends[0] || '';
    draw();
    if (view.matches !== null) return;
    try {
      view.matches = (await json('/api/matches?limit=200&sort=newest')).matches;
    } catch (error) {
      view.error = error.message; view.matches = [];
    }
    if (!view.matches.some(row => matchKey(row) === view.selection.match)) view.selection.match = view.matches[0] ? matchKey(view.matches[0]) : '';
    draw();
  }

  return {render};
}
