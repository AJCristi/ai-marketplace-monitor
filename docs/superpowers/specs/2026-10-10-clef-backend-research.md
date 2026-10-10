# Research: Can Cloudflare Clef replace or front the LLM rating step?

**Date:** 2026-10-10
**Scope:** Cloudflare Workers AI hosted `@cf/cloudflare/clef` and `@cf/cloudflare/clef-flash` as documented on 2026-10-10 (after the 2026-10-09 Clef-flash price/context change); Hugging Face open weights. Excludes Clef-omni audio/video, RL fine-tuning, and TypeSafe Jev itself.
**Decision supported:** Whether to add a Clef backend to `src/ai_marketplace_monitor/ai.py` to speed up listing rating, with LLM summaries only for listings that pass.

## Answer

Yes, it is feasible with no new dependency. Clef is a plain authenticated JSON-over-HTTPS call that returns typed probabilities, accepts up to 4 embedded images, and is cheap enough that Clef-flash fits the Workers AI free allocation for hundreds of listings per day. The main gaps are that it never produces text (no AI comment) and that its rate limits are undocumented. Confidence: high on API shape and pricing, medium on real-world latency and rating quality for marketplace listings.

## Findings

### Models

- Clef is a 27B multimodal decision model with a 65,536-token hosted context. It costs $0.24 per M input tokens, and output is not charged. [Workers AI: clef](https://developers.cloudflare.com/workers-ai/models/clef/)
- Clef-flash is a 9B "fast multimodal decision model" with a 24,576-token hosted context. It costs $0.038 per M input tokens, and output is not charged. [Workers AI: clef-flash](https://developers.cloudflare.com/workers-ai/models/clef-flash/)
- On 2026-10-09, Cloudflare cut Clef-flash from $0.09 to $0.038 per M and its hosted context from 64k to 24k. Self-hosted weights were trained for 256k. [Cloudflare blog, 2026-10-09](https://blog.cloudflare.com/clef-faster-cheaper-multimodal/)
- Hosted Clef median latency is now about 152 ms at ~800 input tokens and about 305 ms at ~3,400 tokens, down from 262 ms and 616 ms. [Cloudflare blog, 2026-10-09](https://blog.cloudflare.com/clef-faster-cheaper-multimodal/)
- At launch, Cloudflare's own benchmark run gave Clef-flash a median of 38.8 ms and a p95 of 122.4 ms. Clef had a median of 209.3 ms. These are internal numbers. [Cloudflare blog, 2026-10-01](https://blog.cloudflare.com/clef-decision-models/)
- Cloudflare calls both models "fully Jev-API compatible". Clef-flash scores below Clef on some benchmarks, for example CLINC150+OOS at 66.77 vs. 97.43 macro-F1, and Cloudflare says it is "still early". [Cloudflare blog, 2026-10-01](https://blog.cloudflare.com/clef-decision-models/)

### REST API

- The endpoint is `POST https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/run/@cf/cloudflare/clef-flash` with `Authorization: Bearer <token>`. The official example uses `requests`. [Workers AI: clef-flash](https://developers.cloudflare.com/workers-ai/models/clef-flash/)
- The token needs the Workers AI Read and Workers AI Edit permissions. The response envelope is `{result, success, errors, messages}`. [Workers AI REST API](https://developers.cloudflare.com/workers-ai/get-started/rest-api/)
- The request body is:
  - `model` (required), either `"clef"` or `"clef-flash"`
  - `state` (required), a string or JSON that is truncated to fit
  - `questions`, 1 to 64 entries keyed by an id of up to 100 characters (`[A-Za-z0-9_.-]`)
  - `images` (optional)

  [Input schema](https://developers.cloudflare.com/workers-ai/models/clef-flash/schema-input.json)
- The question types are:
  - `noul`: needs `instructions`, with optional `criteria.true` and `criteria.false`
  - `choice`: needs `criteria`, an object of 2 to 255 options
  - `score`: needs `criteria`, an array of 2 to 10 levels, lowest first, indexed from 0

  [Input schema](https://developers.cloudflare.com/workers-ai/models/clef-flash/schema-input.json)
- Each item in `images` is either a `data:image/(png|jpeg|webp);base64,...` URL or `{content_type, base64}`. The limits are 4 images, 4 MiB and 16 MP each, 8 MiB decoded in total, and a 13 MiB request body. Remote URLs are rejected. [Input schema](https://developers.cloudflare.com/workers-ai/models/clef-flash/schema-input.json)
- Image tokens: the image is resized to sides that are multiples of 32 px (about 1 MP at most), each 32×32 block costs one token, each image adds 3 marker tokens, and each image is capped at 1,024 tokens. Images and questions count against the context, and the request fails if they exceed it. [Workers AI: clef-flash](https://developers.cloudflare.com/workers-ai/models/clef-flash/)
- The answers are:
  - `noul`: a probability from 0 to 1
  - `choice`: `choice`, `probabilities` and `confidence`
  - `score`: a float `score` that can land between levels, plus `legend`, `probabilities` and `confidence`

  `usage` has `input_tokens` and `output_tokens`. [Output schema](https://developers.cloudflare.com/workers-ai/models/clef-flash/schema-output.json)

### Pricing and limits

- The free allocation is 10,000 Neurons per day. Above that, the Workers Paid plan charges $0.011 per 1,000 Neurons. Clef-flash costs 3,455 Neurons per M input tokens and Clef costs 21,818. Page updated 2026-10-09. [Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/)
- Rate limits are listed per task type, for example Text Classification at 2,000 requests per minute and Text Generation at 300. The page has no entry for Clef or decision models, and it notes that beta models may have lower limits. [Workers AI limits](https://developers.cloudflare.com/workers-ai/platform/limits/)
- In the logged-in dashboard model catalog (checked 2026-10-10):
  - `clef` and `clef-flash` are labeled task type "Text Generation" and "Cloudflare-hosted".
  - Neither has a "Beta" tag, though another model in the catalog does.
  - Both are shown with "65,536 max context". For Clef-flash this conflicts with the 24,576 on its docs page and in the 2026-10-09 blog post.
  - The Workers plans page shows the Free plan with 10,000 Neurons per day for Workers AI, and the Paid plan at $0.011 per 1,000 Neurons.

### Self-hosting

- Clef-flash is post-trained from Qwen3.5-9B under Apache-2.0. It was tested on a single H200. It can be served with SGLang (`/v1/systemone`), vLLM or Docker Model Runner, and community quantizations are linked. [HF: Cloudflare/clef-flash](https://huggingface.co/Cloudflare/clef-flash)
- Clef is post-trained from Qwen3.8-27B under Apache-2.0, with BF16 safetensors. [HF: Cloudflare/clef](https://huggingface.co/Cloudflare/clef)

### Local code (current state)

- `AIBackend.evaluate()` returns `AIResponse(score: int 1–5, comment: str)`. Its `conclusion`, `style` and `stars` assume integer 1–5 values. `get_prompt()` builds one text prompt from item and marketplace config (`ai.py`).
- `evaluate()` sends no photos today. Only `chat()` attaches photos, as `data:image/webp;base64` URLs (`ai.py`).
- `requests` is already a runtime dependency (`pyproject.toml`).

## Inference

- **Cost:** a typical listing is about 600 text tokens plus up to 4 images at about 1,024 tokens each, so roughly 4.7k input tokens. That works out to about $0.00018 per listing on Clef-flash. The free 10k Neurons per day covers about 2.9M Clef-flash tokens, which is roughly 600 listings per day with 4 photos, or several thousand text-only. On Clef it is about 100 listings per day with photos.
- **Rating mapping:** a `score` question with 5 levels mirrors the current rubric, so `round(score) + 1` keeps `AIResponse.score` as an int from 1 to 5 and leaves the matches UI, notifications and cache unchanged.
- **Photos:** the existing WebP bytes and data-URL formatting from `chat()` can be reused for `images`.
- **Extra checks:** `noul` questions can run in the same call at no extra request cost, for example "scam/external-link risk", "matches search intent" and "price below typical market".
- **No comment:** Clef returns no text, so `AIResponse.comment` must be either a short summary built from the answers (for example "Score 4.3/5 · scam risk 3%") or written by an existing LLM backend only for listings above a threshold. The second option is the requested "LLM only for passing listings" split.
- **Context:** Clef-flash's 24k context is enough. Even 4 images plus a long description stay under about 10k tokens.
- **Fit:** a Clef backend is another `AIBackend` subclass plus a new `AIServiceProvider` entry. It needs `account_id` (or a full `base_url`) and `api_key`, which the existing `AIConfig` fields and secret masking already cover.
- **Self-hosting:** not practical for typical users. It needs a large GPU, and the hosted free tier makes it unnecessary.

## Uncertainty

- Rate limits for Clef are undocumented. The dashboard classifies Clef as "Text Generation", so the 300 requests-per-minute Text Generation default probably applies, but this is unconfirmed. Even so, 300 per minute is far above the monitor's listing throughput.
- The hosted Clef-flash context is either 24,576 (docs and blog) or 65,536 (dashboard). Plan for 24,576 until a real call shows otherwise.
- Latency figures come from Cloudflare and were not measured on marketplace listings. Clef-flash latency after the 2026-10-09 serving change is not published.
- Rating quality against the current LLM is unknown. Clef-flash trails Clef noticeably on some benchmarks. A side-by-side run on cached listings is needed before making it the default.
- No source or dashboard label says Clef needs the Workers Paid plan, and the Free plan includes the 10,000 Neuron daily allocation. Free-plan REST access is still unconfirmed until a real call succeeds.
- A secondary report says self-hosting needs about 41 GB of VRAM for Clef-flash and about 85 GB for Clef. No primary source confirms this ([The Register](https://www.theregister.com/a/5300649)).
- The models are a few days old (launched 2026-10-01 and repriced 2026-10-09), so the API and prices may still change.

## Recommendation

Add an opt-in `Cloudflare` AI provider that uses Clef-flash by default:

1. Build each request with `get_prompt`-derived state and up to 4 listing photos.
2. Ask a 5-level `score` question plus a small set of configurable `noul` checks.
3. Map the score to the existing 1–5 `AIResponse`.
4. Fill `comment` from the answers. Optionally call a configured LLM backend for the comment only when the score reaches the notify threshold.

Validate it against the current LLM on a fixed set of cached listings before recommending it as the default. Keep the existing LLM backends unchanged for chat.

## Sources

- [Workers AI model: clef](https://developers.cloudflare.com/workers-ai/models/clef/) - Cloudflare, accessed 2026-10-10
- [Workers AI model: clef-flash](https://developers.cloudflare.com/workers-ai/models/clef-flash/) - Cloudflare, accessed 2026-10-10
- [clef-flash input schema](https://developers.cloudflare.com/workers-ai/models/clef-flash/schema-input.json) - Cloudflare, accessed 2026-10-10
- [clef-flash output schema](https://developers.cloudflare.com/workers-ai/models/clef-flash/schema-output.json) - Cloudflare, accessed 2026-10-10
- [Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/) - Cloudflare, updated 2026-10-09
- [Workers AI limits](https://developers.cloudflare.com/workers-ai/platform/limits/) - Cloudflare, accessed 2026-10-10
- [Workers AI REST API get started](https://developers.cloudflare.com/workers-ai/get-started/rest-api/) - Cloudflare, accessed 2026-10-10
- [Introducing Clef](https://blog.cloudflare.com/clef-decision-models/) - Cloudflare blog, 2026-10-01
- [Clef-omni, faster Clef, cheaper Clef-flash](https://blog.cloudflare.com/clef-faster-cheaper-multimodal/) - Cloudflare blog, 2026-10-09
- [HF: Cloudflare/clef](https://huggingface.co/Cloudflare/clef) - Cloudflare, accessed 2026-10-10
- [HF: Cloudflare/clef-flash](https://huggingface.co/Cloudflare/clef-flash) - Cloudflare, accessed 2026-10-10
- [The Register coverage](https://www.theregister.com/a/5300649) - secondary, used only for unconfirmed VRAM figures
