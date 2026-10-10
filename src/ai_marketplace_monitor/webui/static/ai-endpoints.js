import {esc, filled, list} from './console-model.js';

// Mirrors each backend's built-in base_url and default_model in ai.py.
export const PROVIDER_DEFAULTS = {
  openai: {base_url: 'https://api.openai.com/v1', model: 'gpt-4o'},
  anthropic: {base_url: 'https://api.anthropic.com', model: 'claude-sonnet-4-20250514'},
  deepseek: {base_url: 'https://api.deepseek.com', model: 'deepseek-chat'},
  gemini: {base_url: 'https://generativelanguage.googleapis.com/v1beta/openai/', model: 'gemini-2.5-flash'},
  ollama: {base_url: 'Required, e.g. http://localhost:11434/v1', model: 'Required, e.g. deepseek-r1:14b', required: true},
  cloudflare: {base_url: 'Workers AI URL built from the account ID', model: 'clef-flash'},
};

export const aiProvider = (config, name) => String(config?.provider || name || '').toLowerCase();

export function endpointPlaceholder(key, provider) {
  const value = PROVIDER_DEFAULTS[provider]?.[key];
  if (!value) return '';
  return PROVIDER_DEFAULTS[provider].required || provider === 'cloudflare' && key === 'base_url' ? value : `Default: ${value}`;
}

export function aiUsage(config, name) {
  const uses = [];
  for (const [market, settings] of Object.entries(config.marketplace || {})) if (list(settings?.ai).includes(name)) uses.push(`marketplace ${market}`);
  for (const [item, settings] of Object.entries(config.item || {})) if (list(settings?.ai).includes(name)) uses.push(`search ${item}`);
  for (const [other, settings] of Object.entries(config.ai || {})) if (settings?.comment_ai === name) uses.push(`comment AI for ${other}`);
  return uses;
}

export function aiUsageText(config, name) {
  const uses = aiUsage(config, name);
  return uses.length ? `Used by ${uses.join(', ')}` : 'Not named by a marketplace or search; tried in order when no AI list is set';
}

export function modelStatusText(result) {
  return result.checked
    ? `Connected · ${result.models.length} models`
    : `${result.models.join(', ')} · fixed list; run AI test to check the connection`;
}

export function endpointStatusHtml(status) {
  if (!status) return '';
  if (status.busy) return '<span class="d">Checking…</span>';
  if (status.error) return `<span class="err">${esc(status.error)}</span>`;
  return `<span class="${status.checked ? 'ok' : 'd'}">${esc(modelStatusText(status))}</span>`;
}

export function endpointFieldHtml({key, id, value, provider}) {
  const input = `<input class="in mono" id="${id}" data-value="${key}" type="text" value="${esc(value)}" placeholder="${esc(endpointPlaceholder(key, provider))}"${key === 'model' ? ' style="flex:1"' : ''}>`;
  if (key !== 'model') return input;
  return `<div class="row wr">${input}<button class="btn q sm" type="button" data-fetch-models>Fetch models</button></div>`+
    `<span class="sel" id="ai-model-pick" hidden><select aria-label="Fetched models"></select></span><p class="hint" id="ai-model-status" aria-live="polite"></p>`;
}

export const listModels = (json, body) => json('/api/ai/models', {method: 'POST', body: JSON.stringify(body)});

export function bindEndpointForm({root, json, form, onModels}) {
  const pick = root.querySelector('#ai-model-pick');
  const status = root.querySelector('#ai-model-status');
  const model = root.querySelector('#field-model');
  const button = root.querySelector('[data-fetch-models]');
  if (!pick || !status || !model || !button) return;
  pick.querySelector('select').onchange = event => {
    if (!event.target.value) return;
    model.value = event.target.value;
    model.dispatchEvent(new Event('input', {bubbles: true}));
  };
  button.onclick = async () => {
    const body = {name: form.name, provider: root.querySelector('#provider-choice')?.value || aiProvider(form.fields, form.name), base_url: root.querySelector('#field-base_url')?.value ?? ''};
    if (filled(form.changes.api_key)) body.api_key = form.changes.api_key;
    button.disabled = true; status.className = 'hint'; status.textContent = 'Fetching models…';
    try {
      const result = await listModels(json, body);
      pick.querySelector('select').innerHTML = `<option value="">Choose one of ${result.models.length} models…</option>` + result.models.map(name => `<option value="${esc(name)}" ${name === model.value ? 'selected' : ''}>${esc(name)}</option>`).join('');
      pick.hidden = !result.models.length;
      status.textContent = modelStatusText(result);
      onModels?.(form.name, result);
    } catch (error) {
      pick.hidden = true; status.className = 'hint err'; status.textContent = error.message;
      onModels?.(form.name, {error: error.message});
    } finally {
      button.disabled = false;
    }
  };
}

export function resetEndpointForm(root, provider) {
  for (const key of ['model', 'base_url']) {
    const input = root.querySelector(`#field-${key}`);
    if (input) input.placeholder = endpointPlaceholder(key, provider);
  }
  const pick = root.querySelector('#ai-model-pick');
  if (pick) pick.hidden = true;
  const status = root.querySelector('#ai-model-status');
  if (status) status.textContent = '';
}
