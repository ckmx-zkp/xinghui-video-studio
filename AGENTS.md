# Xinghui Video Studio Agent Guide

## Project goal

Build a local-first video production workspace whose core interaction follows MiniMax Design:

1. Inspiration and requirement discovery.
2. Agent insight and task decomposition.
3. Multiple meaningful options for the user at every decision stage.
4. A continuous production canvas for brief, concepts, storyboard, assets, generation, review, and delivery.
5. Reusable local assets and production methods.
6. Explicit review gates before generation and final delivery.

The product is not a one-shot prompt-to-video form. The director must contribute a professional opinion, explain the tradeoff, and offer 2-4 distinct choices while still accepting free-form input.

## Canonical workspace

- Active development branch: `company`.
- Main application: `video-studio/`.
- `xinghui_PWA/` is a separate nested repository. Do not edit, delete, stage, or use it as the implementation source unless the user explicitly requests that repository.
- Runtime data belongs under `outputs/` and must never be committed.

## Workflow invariants

The project phase is server-owned:

`discovery -> brief_review -> concept_selection -> storyboard_review -> quality_review -> ready_to_generate -> generating -> delivery_review -> delivered`

- The language model may recommend actions but may not bypass a phase gate.
- Chat must never directly start video generation or merging.
- Cloud generation requires an explicit UI confirmation including the exact quota count.
- Brief confirmation, concept selection, storyboard confirmation, quality approval, generation, and delivery approval use separate server endpoints.
- Returning for revision must invalidate downstream approval state without deleting source assets.
- Existing `project.json` files must be normalized on load so schema additions remain backward compatible.
- Images attached in the composer must be persisted as project assets and included in the current MiniMax user turn as multimodal `image_url` content. Never imply that the director saw an image when only its filename or upload state was available.

## Director response contract

Director responses are JSON with:

- `say`: concise conversational response.
- `insight`: the director's professional judgment and reasoning.
- `choices`: 2-4 distinct options containing `label`, `description`, and the complete `reply` to send when chosen.
- `actions`: only actions permitted for the current phase.

Do not replace real choices with yes/no variants. A choice must materially change story, audience, visual language, pacing, sound, or execution strategy.

## Architecture

- `video-studio/server.mjs`: Express routes, MiniMax/Hailuo/ComfyUI clients, orchestration, and FFmpeg delivery.
- `video-studio/director.mjs`: director contract, brief readiness, response parsing, and shot selection.
- `video-studio/projects.mjs`: backward-compatible local project and asset persistence.
- `video-studio/src/App.tsx`: React production workspace and review interactions.
- `video-studio/public/`: PWA assets.

Keep API keys server-side. Never print `.env`, tokens, credentials, reference images, or user project content in logs or tests.

## Validation

Run from `video-studio/`:

```powershell
npm.cmd ci
npm.cmd run build
npm.cmd run lint
npm.cmd test
node --check server.mjs
node --check director.mjs
node --check projects.mjs
```

- Tests must cover phase gates and the `insight + choices` contract without requiring a GPU.
- Mocked ComfyUI tests prove orchestration only. Report local H3 output as validated only after testing on the GPU host.
- Do not submit real cloud video jobs during routine tests; they consume quota.
- After UI changes, verify desktop and mobile layouts in a browser and check console errors.

## Deployment

Use `依赖与部署.md` as the deployment source of truth. The Web/Agent layer and GPU/H3 layer can be validated separately. Missing local H3 resources must produce an explicit unavailable state, not break the creative planning workflow.
