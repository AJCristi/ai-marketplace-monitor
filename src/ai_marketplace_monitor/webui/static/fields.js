const BUILT_IN_REGIONS = [
  "usa", "usa_full", "can", "mex", "bra", "arg",
  "aus", "aus_miles", "nzl", "ind", "gbr", "fra", "spa",
];

const OV = "Can be overridden per-item in [item.*] sections.";

const CATEGORIES = [
  { value: "", label: "(any)" },
  { value: "vehicles", label: "Vehicles" },
  { value: "propertyrentals", label: "Property rentals" },
  { value: "apparel", label: "Apparel" },
  { value: "electronics", label: "Electronics" },
  { value: "entertainment", label: "Entertainment" },
  { value: "family", label: "Family" },
  { value: "freestuff", label: "Free stuff" },
  { value: "free", label: "Free" },
  { value: "garden", label: "Garden" },
  { value: "hobbies", label: "Hobbies" },
  { value: "homegoods", label: "Home goods" },
  { value: "homeimprovement", label: "Home improvement" },
  { value: "homesales", label: "Home sales" },
  { value: "musicalinstruments", label: "Musical instruments" },
  { value: "officesupplies", label: "Office supplies" },
  { value: "petsupplies", label: "Pet supplies" },
  { value: "sportinggoods", label: "Sporting goods" },
  { value: "tickets", label: "Tickets" },
  { value: "toys", label: "Toys" },
  { value: "videogames", label: "Video games" },
];

const FORM_SCHEMAS = {
  "marketplace.facebook": [
    { key: "username", label: "Facebook username (email)", type: "text",
      help: "Your Facebook login email." },
    { key: "password", label: "Facebook password", type: "password",
      help: "Leave blank to keep the current password." },
    { key: "login_wait_time", label: "Login wait time (seconds)", type: "number",
      help: "Seconds to wait after Facebook login for 2FA / captcha. Default: 60." },
    { key: "language", label: "Language", type: "text", advanced: true,
      help: "Non-English Facebook locale — must match a [translation.*] section." },

    { key: "search_city", label: "Search city", type: "text",
      help: "City code from the Facebook Marketplace URL (lowercase, e.g. 'houston')." },
    { key: "search_region", label: "Search region", type: "select",
      options: [{ value: "", label: "(none)" }].concat(
        BUILT_IN_REGIONS.map((r) => ({ value: r, label: r }))
      ),
      help: "Pre-defined region (expands to multiple cities)." },

    // ---- Filters (advanced, overridable) ----
    { key: "category", label: "Category", type: "select", advanced: true,
      options: CATEGORIES, help: "Marketplace listing category." },
    { key: "condition", label: "Condition", type: "checkboxes", advanced: true,
      options: [
        { value: "new", label: "New" },
        { value: "used_like_new", label: "Used — like new" },
        { value: "used_good", label: "Used — good" },
        { value: "used_fair", label: "Used — fair" },
      ],
      help: "Filter by item condition. " + OV },
    { key: "availability", label: "Availability", type: "checkboxes", advanced: true,
      options: [
        { value: "all", label: "All" },
        { value: "in", label: "In stock" },
        { value: "out", label: "Out of stock" },
      ] },
    { key: "date_listed", label: "Date listed", type: "checkboxes", advanced: true,
      options: [
        { value: "1", label: "Last 24 hours" },
        { value: "7", label: "Last 7 days" },
        { value: "30", label: "Last 30 days" },
      ] },
    { key: "delivery_method", label: "Delivery method", type: "checkboxes", advanced: true,
      options: [
        { value: "local_pick_up", label: "Local pick-up" },
        { value: "shipping", label: "Shipping" },
      ] },
    { key: "seller_locations", label: "Seller locations", type: "text", advanced: true,
      help: "Comma-separated location names to filter by." },
    { key: "exclude_sellers", label: "Exclude sellers", type: "text", advanced: true,
      help: "Comma-separated seller names to skip." },
    { key: "keywords", label: "Keywords (include)", type: "text", advanced: true,
      help: "Boolean expression, e.g. 'drone AND (DJI OR Orqa)'" },
    { key: "antikeywords", label: "Anti-keywords (exclude)", type: "text", advanced: true,
      help: "Boolean expression for exclusion." },

    // ---- Pricing ----
    { key: "min_price", label: "Min price", type: "text", advanced: true,
      help: "e.g. '50' or '50 USD'" },
    { key: "max_price", label: "Max price", type: "text", advanced: true,
      help: "e.g. '300' or '300 USD'" },

    // ---- Location ----
    { key: "radius", label: "Search radius (km)", type: "text", advanced: true,
      help: "Comma-separated radius per city (must match search_city count)." },
    { key: "currency", label: "Currency", type: "text", advanced: true,
      help: "Comma-separated currency code per city, e.g. 'USD, CAD'." },

    // ---- AI evaluation ----
    { key: "ai", label: "AI backends", type: "text", advanced: true,
      help: "Comma-separated [ai.*] names." },
    { key: "rating", label: "AI rating threshold", type: "text", advanced: true,
      help: "1–5 (or two values: initial, subsequent)." },
    { key: "prompt", label: "AI prompt", type: "textarea", advanced: true,
      help: "Custom evaluation prompt (replaces default)." },
    { key: "extra_prompt", label: "Extra prompt", type: "textarea", advanced: true,
      help: "Additional text appended before the rating prompt." },
    { key: "rating_prompt", label: "Rating prompt", type: "textarea", advanced: true,
      help: "Custom rating instructions (replaces default 1–5 scale)." },

    // ---- Notification ----
    { key: "notify", label: "Notify users", type: "text", advanced: true,
      help: "Comma-separated [user.*] names. Default: all users." },

    // ---- Schedule ----
    { key: "search_interval", label: "Search interval", type: "text", advanced: true,
      help: "Duration, e.g. '30m', '1h'. Default: 30 min." },
    { key: "max_search_interval", label: "Max search interval", type: "text", advanced: true,
      help: "Upper bound for random interval jitter." },
    { key: "start_at", label: "Start at", type: "text", advanced: true,
      help: "Comma-separated time patterns: 'HH:MM', '*:MM', '*:*:SS'." },
  ],

  // ---- Item form ----
  // Matched by prefix "item" — see the lookup logic below.
  "item.*": [
    { key: "search_phrases", label: "Search phrases", type: "text",
      help: "Comma-separated. e.g. 'gopro hero 11, gopro hero 12'" },
    { key: "description", label: "Description (helps AI)", type: "textarea",
      help: "Free-text description of what you want. The AI uses this to evaluate listings." },
    { key: "marketplace", label: "Marketplace", type: "text", advanced: true,
      help: "Which [marketplace.*] to search. Default: first defined marketplace." },

    { key: "search_city", label: "Search city", type: "text",
      help: "Override marketplace's search city for this item." },
    { key: "search_region", label: "Search region", type: "select",
      options: [{ value: "", label: "(inherit from marketplace)" }].concat(
        BUILT_IN_REGIONS.map((r) => ({ value: r, label: r }))
      ) },
    { key: "min_price", label: "Min price", type: "text",
      help: "e.g. '50' or '50 USD'" },
    { key: "max_price", label: "Max price", type: "text",
      help: "e.g. '300' or '300 USD'" },
    { key: "category", label: "Category", type: "select", advanced: true,
      options: CATEGORIES },
    { key: "condition", label: "Condition", type: "checkboxes", advanced: true,
      options: [
        { value: "new", label: "New" },
        { value: "used_like_new", label: "Used — like new" },
        { value: "used_good", label: "Used — good" },
        { value: "used_fair", label: "Used — fair" },
      ] },
    { key: "availability", label: "Availability", type: "checkboxes", advanced: true,
      options: [
        { value: "all", label: "All" },
        { value: "in", label: "In stock" },
        { value: "out", label: "Out of stock" },
      ] },
    { key: "date_listed", label: "Date listed", type: "checkboxes", advanced: true,
      options: [
        { value: "1", label: "Last 24 hours" },
        { value: "7", label: "Last 7 days" },
        { value: "30", label: "Last 30 days" },
      ] },
    { key: "delivery_method", label: "Delivery method", type: "checkboxes", advanced: true,
      options: [
        { value: "local_pick_up", label: "Local pick-up" },
        { value: "shipping", label: "Shipping" },
      ] },
    { key: "keywords", label: "Keywords (include)", type: "text", advanced: true,
      help: "Boolean expression, e.g. 'drone AND (DJI OR Orqa)'" },
    { key: "antikeywords", label: "Anti-keywords (exclude)", type: "text", advanced: true },
    { key: "seller_locations", label: "Seller locations", type: "text", advanced: true,
      help: "Comma-separated." },
    { key: "exclude_sellers", label: "Exclude sellers", type: "text", advanced: true },
    { key: "notify", label: "Notify users", type: "text", advanced: true,
      help: "Comma-separated [user.*] names. Default: inherit from marketplace." },
    { key: "ai", label: "AI backends", type: "text", advanced: true },
    { key: "rating", label: "AI rating threshold", type: "text", advanced: true,
      help: "1–5 (or initial,subsequent)." },
    { key: "prompt", label: "AI prompt", type: "textarea", advanced: true },
    { key: "extra_prompt", label: "Extra prompt", type: "textarea", advanced: true },
    { key: "rating_prompt", label: "Rating prompt", type: "textarea", advanced: true },
    { key: "search_interval", label: "Search interval", type: "text", advanced: true,
      help: "Duration, e.g. '30m', '1h'." },
    { key: "max_search_interval", label: "Max search interval", type: "text", advanced: true },
    { key: "start_at", label: "Start at", type: "text", advanced: true,
      help: "Comma-separated time patterns." },
  ],

  // ---- User form ----
  "user.*": [
    { key: "pushbullet_token", label: "Pushbullet token", type: "password",
      help: "Get your token from pushbullet.com → Settings → Access tokens." },
    { key: "pushover_user_key", label: "Pushover user key", type: "password" },
    { key: "pushover_api_token", label: "Pushover API token", type: "password" },
    { key: "telegram_token", label: "Telegram bot token", type: "password",
      help: "Format: 123456789:ABCdef..." },
    { key: "telegram_chat_id", label: "Telegram chat ID", type: "text",
      help: "Numeric ID or @username." },
    { key: "ntfy_server", label: "ntfy server URL", type: "text",
      help: "e.g. https://ntfy.sh" },
    { key: "ntfy_topic", label: "ntfy topic", type: "text" },
    { key: "email", label: "Email address", type: "text",
      help: "Comma-separated list of recipient addresses." },
    { key: "smtp_server", label: "SMTP server", type: "text", advanced: true },
    { key: "smtp_port", label: "SMTP port", type: "number", advanced: true,
      help: "Default: 587" },
    { key: "smtp_username", label: "SMTP username", type: "text", advanced: true },
    { key: "smtp_password", label: "SMTP password (app password)", type: "password", advanced: true },
    { key: "smtp_from", label: "SMTP from address", type: "text", advanced: true },
    { key: "notify_with", label: "Notification sections", type: "text", advanced: true,
      help: "Comma-separated [notification.*] section names for shared credentials." },
    { key: "remind", label: "Remind interval", type: "text", advanced: true,
      help: "Resend after this interval, e.g. '1d', '6h'. Default: one-time." },
  ],

  // ---- AI backend form ----
  "ai.*": [
    { key: "api_key", label: "API key", type: "password",
      help: "If left blank, the env var for the provider is used (e.g. ${OPENAI_API_KEY}, ${ANTHROPIC_API_KEY}, ${DEEPSEEK_API_KEY})." },
    { key: "model", label: "Model", type: "text",
      help: "e.g. 'gpt-4o', 'deepseek-chat', 'deepseek-r1:14b', 'claude-sonnet-4-20250514'" },
    { key: "provider", label: "Provider override", type: "text", advanced: true,
      help: "Override the provider (auto-detected from section name). Only needed for custom OpenAI-compatible endpoints." },
    { key: "base_url", label: "Base URL", type: "text", advanced: true,
      help: "Custom API endpoint. Required for Ollama (e.g. http://localhost:11434/v1)." },
    { key: "timeout", label: "Timeout (seconds)", type: "number", advanced: true },
    { key: "max_retries", label: "Max retries", type: "number", advanced: true,
      help: "Default: 10" },
  ],
};

export { FORM_SCHEMAS, BUILT_IN_REGIONS };

// Keep the original field definitions and add the options the console exposes.
const statusField = {key:'enabled', label:'Status', type:'boolean', help:'Disabled sections stay in config.toml.'};
const sortField = {key:'sort_by', label:'Sort order', type:'select', advanced:true, options:[{value:'suggested',label:'Suggested'},{value:'new',label:'Newest first'},{value:'price_ascend',label:'Price: low to high'},{value:'price_descend',label:'Price: high to low'},{value:'distance_ascend',label:'Distance: nearest first'}]};
const notificationMore = [
  statusField,
  {key:'message_format',label:'Message format',type:'select',advanced:true,options:['plain_text','markdown','html'].map(value=>({value,label:value}))},
  {key:'with_description',label:'Description length',type:'number',advanced:true,help:'Blank or 1 includes the full description; 0 excludes it; larger numbers limit its length.'},
  {key:'max_retries',label:'Maximum retries',type:'number',advanced:true,help:'Default: 5.'},
  {key:'retry_delay',label:'Retry delay (seconds)',type:'number',advanced:true,help:'Default: 60.'},
  {key:'rate_limit_enabled',label:'Rate limiting',type:'boolean',advanced:true},
  {key:'instance_rate_limit',label:'Seconds between sends',type:'number',advanced:true},
  {key:'global_rate_limit',label:'Messages per second',type:'number',advanced:true},
  {key:'pushbullet_proxy_type',label:'Pushbullet proxy type',type:'text',advanced:true},
  {key:'pushbullet_proxy_server',label:'Pushbullet proxy server',type:'text',advanced:true},
];
FORM_SCHEMAS['item.*'].unshift(statusField);
FORM_SCHEMAS['item.*'].push(sortField);
FORM_SCHEMAS['marketplace.facebook'].unshift(statusField);
FORM_SCHEMAS['marketplace.facebook'].push(sortField);
FORM_SCHEMAS['ai.*'].unshift(statusField);
FORM_SCHEMAS['user.*'].push(...notificationMore);
FORM_SCHEMAS['notification.*'] = FORM_SCHEMAS['user.*'].filter(field => !['notify_with','remind'].includes(field.key));
FORM_SCHEMAS.monitor = [
  {key:'image_matching',label:'Automatic image matching',type:'boolean',help:'Compare saved listing photos for reused images, distinctive item details and matching plates. Off by default.'},
  {key:'image_matching_ai',label:'Image matching AI',type:'text',help:'Name of an OpenAI-compatible AI section, for example mimo. Set its model to mimo-v2.6-pro and its base URL to https://api.xiaomimimo.com/v1.'},
  {key:'image_matching_daily_budget',label:'Daily image matching budget (USD)',type:'number',help:'Shared by automatic and manual checks; resets at midnight UTC. Set a positive amount before running checks.'},
  {key:'image_matching_input_cost',label:'Input cost per million tokens (USD)',type:'number',advanced:true,help:'Default: 0.435 for MiMo V2.6 Pro. Update when your provider pricing changes.'},
  {key:'image_matching_output_cost',label:'Output cost per million tokens (USD)',type:'number',advanced:true,help:'Default: 0.87 for MiMo V2.6 Pro. Budget accounting uses these configured rates.'},
  {key:'proxy_server',label:'Proxy servers',type:'list',help:'One or more http:// or https:// URLs.'},
  {key:'proxy_bypass',label:'Bypass',type:'text'},
  {key:'proxy_username',label:'Proxy username',type:'password'},
  {key:'proxy_password',label:'Proxy password',type:'password'},
];
FORM_SCHEMAS['region.*'] = [
  {key:'full_name',label:'Full name',type:'text'},
  {key:'search_city',label:'Cities',type:'list'},
  {key:'city_name',label:'City names',type:'list'},
  {key:'radius',label:'Radius per city (km)',type:'numberlist',help:'One radius per city, or one value for every city. Default: 500 km.'},
  {key:'currency',label:'Currency per city',type:'list',help:'For example USD, CAD. One value applies to every city.'},
  statusField,
];
for (const field of FORM_SCHEMAS['ai.*']) {
  if (field.key === 'api_key') field.help = 'Use an environment reference such as ${OPENAI_API_KEY}, or replace the saved key. Saving does not test the key.';
  if (field.key === 'model') field.help = 'Blank uses the provider default, except Ollama which requires a model.';
}
for (const schema of Object.values(FORM_SCHEMAS)) {
  for (const field of schema) {
    if (['availability','date_listed','delivery_method'].includes(field.key)) field.type = 'firstlater';
    if (field.key === 'date_listed' && !field.options.some(option => option.value === '0')) field.options.unshift({value:'0', label:'Any time'});
    if (field.key === 'delivery_method' && !field.options.some(option => option.value === 'all')) field.options.unshift({value:'all',label:'Any delivery method'});
    if (['search_phrases','seller_locations','exclude_sellers','search_city','search_region','start_at','email','notify_with'].includes(field.key)) field.type = 'list';
    if (['keywords','antikeywords'].includes(field.key)) field.help = 'Boolean expression, for example camera AND (Canon OR Nikon). One expression per line.';
  }
}

for (const schema of Object.values(FORM_SCHEMAS)) for (const field of schema) {
  if (['username','smtp_username'].includes(field.key)) field.type = 'password';
  if (field.key === 'marketplace') field.help = 'Default: first defined marketplace.';
}

for(const key of ['item.*','marketplace.facebook']){
 FORM_SCHEMAS[key].push({key:'city_name',label:'City display names',type:'list',advanced:true,help:'Optional display names, one per search city.'});
 for(const field of FORM_SCHEMAS[key])if(field.key==='currency')field.type='list';
 for(const field of FORM_SCHEMAS[key])if(field.key==='radius')field.type='numberlist';
}
